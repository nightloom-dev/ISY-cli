import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { parkAlert } from "../alert.js";
import { parseLines } from "../parser.js";
import { firstLine, firstLines, lastActive, pendingAlertPath } from "../paths.js";
import { redactLines } from "../redact.js";
import type { DiscoveredSession, ParsedSession, SessionFile } from "../types.js";
import { isKimiCliWire, kimiCliWireToClaudeRecords } from "./kimi-cli-wire.js";
import { basicString, hookTables } from "./kimi-config.js";
import type { HookTable } from "./kimi-config.js";
import { toClaudeRecords } from "./kimi-records.js";
import { isKimiWireTranscript, wireToClaudeRecords } from "./kimi-wire.js";
import type { Agent, AgentHook, HookInput } from "./types.js";

/**
 * Where Kimi keeps its state. Two CLIs have shipped under the name: the Python
 * Kimi CLI, archived at 1.52, in `~/.kimi` (`KIMI_SHARE_DIR` moves it), and
 * Kimi Code, the TypeScript CLI that replaced it, in `~/.kimi-code`
 * (`KIMI_CODE_HOME` moves it). A machine that upgraded has both, and sessions
 * in both, so every home that exists is read — taking the first one found left
 * the other CLI's sessions unseen. `KIMI_HOME` pins a single home, which is
 * what tests do.
 */
export function kimiHomes(): string[] {
  const override = process.env.KIMI_HOME;
  if (override) return [override];

  const candidates = [process.env.KIMI_SHARE_DIR || join(homedir(), ".kimi"), kimiCodeHome()];
  const present = [...new Set(candidates)].filter((candidate) => existsSync(candidate));
  return present.length > 0 ? present : [candidates[0]!];
}

function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");
}

/** The home named first — where a message to the user points. */
export function kimiHome(): string {
  return kimiHomes()[0]!;
}

export function kimiConfigPath(home = kimiHome()): string {
  return join(home, "config.toml");
}

/** Every workspace's sessions, whatever Kimi decides to name the folders. */
export function kimiSessionsRoot(home = kimiHome()): string {
  return join(home, "sessions");
}

/**
 * One session on disk, found by reading its own metadata rather than by
 * computing where it ought to be.
 *
 * Kimi has already changed both halves of that layout once — the workspace
 * folder went from a bare hash to `wd_<name>_<hash>` and the hash from MD5 to
 * SHA-256, and the transcript moved from `context.jsonl` beside `state.json`
 * down into `agents/<name>/wire.jsonl`. Anything that derives the path from the
 * working directory is one Kimi release away from silently finding nothing, and
 * finding nothing looks exactly like having no sessions. `state.json` records
 * the `cwd` outright, so matching on it survives any renaming.
 */
interface KimiSession {
  sessionId: string;
  transcript: string;
  /** The session folder: its subagents' logs are in it too. */
  dir: string;
  cwd?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function subdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * The first few lines of a file, enough to tell its format by, and no more:
 * listing reads this for every Kimi CLI session there is, and a whole log read
 * each time made listing cost what every transcript on the machine weighs.
 */
async function head(path: string, count = 3): Promise<string[]> {
  try {
    return await firstLines(path, count);
  } catch {
    return [];
  }
}

/**
 * Where one of Kimi Code's agents keeps its log: `agents/<id>/wire.jsonl` in
 * the session folder, or wherever `state.json` says its home is. The folder
 * comes first, because `state.json` records an absolute path, and a session
 * folder that was moved or copied still holds its logs.
 */
async function agentLog(dir: string, state: Record<string, unknown>, id: string): Promise<string | undefined> {
  const agents = isObject(state.agents) ? state.agents : {};
  const agent = agents[id];
  const homes = [join(dir, "agents", id)];
  if (isObject(agent) && typeof agent.homedir === "string") homes.push(agent.homedir);

  for (const home of homes) if (await isFile(join(home, "wire.jsonl"))) return join(home, "wire.jsonl");
  return undefined;
}

/**
 * The transcript inside a session folder, whichever layout wrote it:
 * - Kimi Code: `agents/main/wire.jsonl` (`main` is the session's own agent; the
 *   rest are subagents, read into it by `subagentLogs`);
 * - Kimi CLI 1.x: `wire.jsonl` beside `state.json`, the whole session as an
 *   event log (`kimi-cli-wire.ts`) — its subagents included;
 * - older builds: `context.jsonl`, the conversation alone.
 */
async function transcriptIn(dir: string, state: Record<string, unknown>): Promise<string | undefined> {
  const main = await agentLog(dir, state, "main");
  if (main) return main;
  if (isKimiCliWire(await head(join(dir, "wire.jsonl")))) return join(dir, "wire.jsonl");
  if (await isFile(join(dir, "context.jsonl"))) return join(dir, "context.jsonl");
  return undefined;
}

/**
 * Every subagent's log in a Kimi Code session, by agent id: each writes its own
 * (`agents/agent-<n>/wire.jsonl`), and the main log only says where it started
 * (`kimi-wire.ts`). Read without them, a session that delegated its edits
 * showed stage 0 none of them. `state.json` lists the agents; a folder it has
 * not caught up with yet is read too, since the log is what the agent did.
 */
async function subagentLogs(dir: string, state: Record<string, unknown>): Promise<Map<string, string[]>> {
  const listed = isObject(state.agents) ? Object.keys(state.agents) : [];
  const ids = [...new Set([...listed, ...(await subdirectories(join(dir, "agents")))])].filter((id) => id !== "main");

  const logs = new Map<string, string[]>();
  for (const id of ids) {
    const log = await agentLog(dir, state, id);
    if (!log) continue;
    try {
      logs.set(id, (await readFile(log, "utf8")).split("\n"));
    } catch {
      continue;
    }
  }
  return logs;
}

/**
 * Every subagent's own log in a Kimi CLI session, by agent id:
 * `subagents/<id>/wire.jsonl`. A background subagent writes only there; the
 * reader tells which of them the session's own log already carries.
 */
async function kimiCliSubagentLogs(dir: string): Promise<Map<string, string[]>> {
  const logs = new Map<string, string[]>();
  for (const id of await subdirectories(join(dir, "subagents"))) {
    try {
      logs.set(id, (await readFile(join(dir, "subagents", id, "wire.jsonl"), "utf8")).split("\n"));
    } catch {
      continue;
    }
  }
  return logs;
}

/** Everything Kimi records about a session outside its transcript. */
async function readState(dir: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, "state.json"), "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the session calls itself: `state.json` first, the folder it sits in
 * second. One rule, because a session listed under one name and parsed under
 * another is a session nothing can match up.
 */
function sessionIdOf(state: Record<string, unknown> | undefined, dir: string): string {
  const id = state?.id;
  return typeof id === "string" && id.length > 0 ? id : basename(dir);
}

/**
 * Which directory each workspace folder belongs to, from `kimi.json` in the
 * home. Kimi CLI names a workspace folder after the MD5 of its path and writes
 * the path itself only there — its `state.json` has no `cwd` at all, so a
 * session of it matched no directory and was never uploaded from one.
 */
async function workspaces(home: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(home, "kimi.json"), "utf8"));
  } catch {
    return found;
  }
  const dirs = isObject(parsed) && Array.isArray(parsed.work_dirs) ? parsed.work_dirs : [];
  for (const entry of dirs) {
    if (!isObject(entry) || typeof entry.path !== "string") continue;
    const hash = createHash("md5").update(entry.path, "utf8").digest("hex");
    // A workspace on another backend is filed as `<kaos>_<md5>`.
    const kaos = typeof entry.kaos === "string" && entry.kaos !== "local" ? `${entry.kaos}_` : "";
    found.set(`${kaos}${hash}`, entry.path);
  }
  return found;
}

/**
 * The working directory Kimi CLI states to the model in its system prompt —
 * the first line of `context.jsonl` — for a session whose home lost `kimi.json`.
 */
async function promptedCwd(dir: string): Promise<string | undefined> {
  const first = await firstLine(join(dir, "context.jsonl")).catch(() => "");
  const stated = /The current working directory is `([^`]+)`/.exec(first);
  return stated?.[1];
}

/** Where the session ran, which is the root every path in it is relative to. */
function recordedCwd(state: Record<string, unknown> | undefined): string | undefined {
  return typeof state?.cwd === "string" ? state.cwd : undefined;
}

/** Where a session ran, by whichever record of it this build keeps. */
async function cwdOfSession(
  dir: string,
  state: Record<string, unknown> | undefined,
  known?: Map<string, string>,
): Promise<string | undefined> {
  return (
    recordedCwd(state) ??
    (known ?? (await workspaces(dirname(dirname(dirname(dir)))))).get(basename(dirname(dir))) ??
    (await promptedCwd(dir))
  );
}

/** A time `state.json` records, as epoch milliseconds: a number, or a date string. */
function epochOf(value: unknown): number | undefined {
  const at = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Up to when a Kimi Code session's logs hold another session's work, if they
 * do. A session Kimi Code imported from Kimi CLI holds that session up to the
 * import (`custom.imported_at`), written again under a new id with the old
 * times or none; a session forked off with `/fork` holds its source up to the
 * fork (`forkedFrom`, created then), every call copied with its time. That
 * part goes up as the session it came from; what came after it is this one's.
 * An import whose time does not read is taken as holding everything.
 */
function copiedUntil(state: Record<string, unknown> | undefined): number | undefined {
  const custom = isObject(state?.custom) ? state.custom : undefined;
  const imported = custom?.imported_from_kimi_cli === true ? (epochOf(custom.imported_at) ?? Infinity) : undefined;
  const forked = typeof state?.forkedFrom === "string" ? epochOf(state.createdAt) : undefined;
  if (imported === undefined && forked === undefined) return undefined;
  return Math.max(imported ?? -Infinity, forked ?? -Infinity);
}

async function modifiedAfter(path: string, at: number): Promise<boolean> {
  try {
    return (await stat(path)).mtimeMs > at;
  } catch {
    return false;
  }
}

async function readSession(dir: string, known: Map<string, string>): Promise<KimiSession | undefined> {
  const state = await readState(dir);
  const transcript = await transcriptIn(dir, state ?? {});
  if (!transcript) return undefined;

  // Kimi CLI writes `state.json` only once a turn completes or a setting
  // changes, so a first turn cancelled, failed or cut off at its step limit
  // leaves none — after edits, as often as not. Its log names the session:
  // the folder is its id. Kimi Code writes `state.json` as it starts, and a
  // folder of its without one is a copy that never finished.
  const kimiCli = transcript === join(dir, "wire.jsonl") || transcript === join(dir, "context.jsonl");
  if (!state && !kimiCli) return undefined;

  // A copy nobody went on with — imported from Kimi CLI, or forked off — is
  // the session it was copied from again. A sweep sent every imported one a
  // second time, and as text alone, since the import keeps no tool calls.
  const copied = copiedUntil(state);
  if (copied !== undefined && !(await modifiedAfter(transcript, copied))) return undefined;

  return { sessionId: sessionIdOf(state, dir), transcript, dir, cwd: await cwdOfSession(dir, state, known) };
}

/**
 * Kimi sessions as the rest of isy sees one: newest first, with the working
 * directory `state.json` recorded already attached, because reading it is what
 * listing a Kimi session costs anyway.
 *
 * Takes the sessions rather than finding them, so a caller that only wants one
 * directory filters first and pays no `stat` for the rest.
 */
async function discovered(sessions: readonly KimiSession[]): Promise<DiscoveredSession[]> {
  const found: DiscoveredSession[] = [];

  for (const session of sessions) {
    try {
      const info = await stat(session.transcript);
      // Size and mtime with the subagents' logs: one sent to the background
      // goes on writing its own after the session's went quiet, and by the
      // session's log alone that work never read as new.
      let sizeBytes = info.size;
      let modified = info.mtimeMs;
      for (const log of await subagentLogPaths(session.dir)) {
        try {
          const agent = await stat(log);
          sizeBytes += agent.size;
          modified = Math.max(modified, agent.mtimeMs);
        } catch {
          continue;
        }
      }
      found.push({
        sessionId: session.sessionId,
        path: session.transcript,
        sizeBytes,
        modifiedAt: new Date(modified),
        activeAt: info.mtime,
        cwd: session.cwd,
      });
    } catch {
      continue;
    }
  }

  found.sort((a, b) => lastActive(b) - lastActive(a));
  return found;
}

/** Every subagent's log in a session folder, whichever Kimi wrote it: `agents/<id>/` or `subagents/<id>/`. */
async function subagentLogPaths(dir: string): Promise<string[]> {
  const logs: string[] = [];
  for (const id of await subdirectories(join(dir, "agents"))) {
    if (id !== "main") logs.push(join(dir, "agents", id, "wire.jsonl"));
  }
  for (const id of await subdirectories(join(dir, "subagents"))) logs.push(join(dir, "subagents", id, "wire.jsonl"));
  return logs;
}

/** Every session on this machine, in every Kimi home, in no particular order. */
async function allSessions(): Promise<KimiSession[]> {
  const found: KimiSession[] = [];

  for (const home of kimiHomes()) {
    const root = kimiSessionsRoot(home);
    const known = await workspaces(home);
    for (const workspace of await subdirectories(root)) {
      const dir = join(root, workspace);
      for (const name of await subdirectories(dir)) {
        const session = await readSession(join(dir, name), known);
        if (session) found.push(session);
      }
    }
  }

  return found;
}

const BEGIN = "# isy:begin — managed by isy, do not edit inside this block";
const END = "# isy:end";
/** What every hook isy writes asks for; Kimi CLI's SessionEnd hooks get five seconds whatever it says. */
const HOOK_TIMEOUT = 30;

/** A path as one word to a POSIX shell, whatever quotes or `$` it holds. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function drainCommand(): string {
  const path = shellQuote(pendingAlertPath());
  return `if [ -s ${path} ]; then cat ${path}; : > ${path}; fi`;
}

/** Whether a home is Kimi Code's rather than the Python Kimi CLI's: they run hooks differently. */
function isKimiCodeHome(home: string): boolean {
  return basename(home) === ".kimi-code" || home === process.env.KIMI_CODE_HOME;
}

/** The commands an older isy wrote for the upload, in any home. */
const OLDER_UPLOADS = [
  "npx isy upload --hook",
  "npx isy upload --hook --agent kimi",
  "npx @nightloom/isy upload --hook --agent kimi",
];

const START_COMMAND = "npx @nightloom/isy check --hook --agent kimi";
const KIMI_CLI_UPLOAD = "exec 3<&0; nohup npx @nightloom/isy upload --hook --agent kimi <&3 >/dev/null 2>&1 &";
const KIMI_CODE_UPLOAD = "npx @nightloom/isy upload --hook --agent kimi";

/**
 * Every command an isy has written into a Kimi config, for either CLI — Kimi
 * Code's migration copies Kimi CLI's hooks into its own config, so either
 * CLI's can turn up in either home.
 */
const ISY_COMMANDS = new Set([
  START_COMMAND,
  "npx isy check --hook --agent kimi",
  KIMI_CLI_UPLOAD,
  KIMI_CODE_UPLOAD,
  ...OLDER_UPLOADS,
  "npx isy upload --silent",
]);

/** The drain of parked alerts, however an isy quoted the path to them. */
const DRAIN = /^if \[ -s .+ \]; then cat .+; : > .+; fi$/;

function isIsyCommand(command: string | undefined): boolean {
  if (command === undefined) return false;
  return ISY_COMMANDS.has(command) || (DRAIN.test(command) && command.includes("pending-alert"));
}

function kimiHooks(home = kimiHome()): AgentHook[] {
  const start: AgentHook = {
    event: "SessionStart",
    command: START_COMMAND,
    superseded: ["npx isy check --hook --agent kimi"],
  };

  if (!isKimiCodeHome(home)) {
    return [
      start,
      // Kimi CLI gives the SessionEnd hooks five seconds between them, whatever
      // `timeout` says, and kills what is still running — an upload is often
      // not done by then. So the hook shell returns at once and the upload
      // outlives it; the payload is handed over on fd 3 first, because a
      // background job's stdin is /dev/null. Its session ids are bare UUIDs,
      // like Claude's, so the command says which CLI it belongs to.
      //
      // No UserPromptSubmit drain here: Kimi CLI shows no hook's stdout at all,
      // so draining parked alerts into it only threw them away.
      //
      // ponytail: POSIX. Kimi CLI runs hooks through the platform shell, cmd.exe
      // on Windows, where this fails and the upload waits for the sweep at the
      // next session start. A `cmd /c start /b` form is the way up if Windows
      // users turn up on a CLI that is no longer released.
      {
        event: "SessionEnd",
        command: KIMI_CLI_UPLOAD,
        superseded: OLDER_UPLOADS,
      },
    ];
  }

  return [
    start,
    // Kimi Code 0.38 sends no `client_type`, so the hook says who fired it.
    {
      event: "SessionEnd",
      command: KIMI_CODE_UPLOAD,
      superseded: OLDER_UPLOADS.slice(0, 2),
    },
    // SessionStart and SessionEnd are observation-only in Kimi Code and their
    // stdout is discarded, so an alert that could not reach the terminal
    // directly is parked in a file. UserPromptSubmit *is* blockable, so its
    // stdout is shown: this drains the backlog. Kept as shell — it runs on every
    // prompt, and `npx @nightloom/isy` would add ~380ms of node startup to each one.
    { event: "UserPromptSubmit", command: drainCommand() },
  ];
}

/** isy's hooks for one home, as the block `installHooks` writes. */
function managedBlock(home: string): string {
  // Basic strings, escaped: a literal string cannot hold a `'`, and the drain
  // carries a path that can.
  const entries = kimiHooks(home)
    .map(
      (hook) =>
        `[[hooks]]\nevent = ${basicString(hook.event)}\ncommand = ${basicString(hook.command)}\ntimeout = ${HOOK_TIMEOUT}`,
    )
    .join("\n\n");
  return `${BEGIN}\n${entries}\n${END}`;
}

/**
 * isy's hook tables in a config: every one whose command an isy wrote, wherever
 * it stands. Not the tables between isy's markers — a Kimi rewrite drops the
 * markers, and a block that lost its end marker would take the user's own
 * hooks after it along.
 */
function isyTables(contents: string): HookTable[] {
  return hookTables(contents).filter((table) => isIsyCommand(table.command));
}

/** isy's marker comment lines, as `[start, stop)` offsets, newline included. */
function markerLines(contents: string): { start: number; stop: number }[] {
  const lines: { start: number; stop: number }[] = [];
  let start = 0;
  while (start < contents.length) {
    const newline = contents.indexOf("\n", start);
    const stop = newline < 0 ? contents.length : newline + 1;
    const line = contents.slice(start, stop).trim();
    if (line === BEGIN || line === END) lines.push({ start, stop });
    start = stop;
  }
  return lines;
}

/** Whether a home's config holds isy's hooks exactly as they should be, and nothing an older isy left. */
function upToDate(ours: readonly HookTable[], desired: readonly AgentHook[]): boolean {
  return (
    ours.length === desired.length &&
    desired.every((hook) =>
      ours.some((table) => table.event === hook.event && table.command === hook.command && table.timeout === HOOK_TIMEOUT),
    )
  );
}

/**
 * The config with isy's tables and markers cut out and `block` written where
 * the first of them stood — at the end when there were none, and nowhere when
 * `block` is undefined. What lies between isy's tables stays unless it is
 * blank: an older isy's block cut short had the user's `[ui]` after it.
 */
function withBlock(contents: string, block: string | undefined): string {
  const cuts = [...isyTables(contents), ...markerLines(contents)].sort((a, b) => a.start - b.start);
  const merged: { start: number; stop: number }[] = [];
  for (const cut of cuts) {
    const last = merged.at(-1);
    if (last && contents.slice(last.stop, cut.start).trim() === "") last.stop = Math.max(last.stop, cut.stop);
    else merged.push({ start: cut.start, stop: cut.stop });
  }

  // A cut leaves the blank lines on both sides of it: one is enough.
  const join = (before: string, after: string): string =>
    before.length === 0 || before.endsWith("\n\n") ? before + after.replace(/^\n+/, "") : before + after;

  let rest = "";
  let at: number | undefined;
  let from = 0;
  for (const cut of merged) {
    rest = join(rest, contents.slice(from, cut.start));
    at ??= rest.length;
    from = cut.stop;
  }
  rest = join(rest, contents.slice(from));
  if (block === undefined) return rest;

  if (at === undefined) {
    const separator = rest.length === 0 || rest.endsWith("\n\n") ? "" : rest.endsWith("\n") ? "\n" : "\n\n";
    return `${rest}${separator}${block}\n`;
  }
  const before = rest.slice(0, at);
  const after = rest.slice(at);
  const lead = before.length === 0 || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const trail = after.length === 0 || after.startsWith("\n") ? "" : "\n";
  return `${before}${lead}${block}\n${trail}${after}`;
}

async function readConfigToml(home = kimiHome()): Promise<string> {
  try {
    return await readFile(kimiConfigPath(home), "utf8");
  } catch (error) {
    // No config yet is an empty one. Anything else is a config that is there
    // and could not be read this time — read as empty, installing over it
    // wrote away every setting in it.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** The lines of Kimi CLI's log that open a session's run, and the ones worth reading in it. */
const RUN_OPENS = /\|\s+-\s+(?:Created new session|Continuing previous session|Resuming session): (\S+)/;
const RUN_MODEL = /\|\s+-\s+Using LLM model: .*?\bmodel='([^']+)'/;
const RUN_AGENT = /\|\s+-\s+Loading agent: (.+)$/;

/**
 * The Kimi CLI version and the model a session last ran with.
 *
 * Neither is in the session: not in `state.json`, not in either log. Kimi CLI's
 * own log (`<home>/logs/kimi.log`, rotated daily, kept ten days) says both, run
 * by run — `Created new session: <id>`, then `Using LLM model: … model='…'` and
 * `Loading agent: <site-packages>/kimi_cli/agents/…`, whose `kimi_cli-<version>.dist-info`
 * beside it names the version installed. The last run of the session wins: a
 * resumed session runs on whatever was configured the day it resumed.
 *
 * ponytail: the version is the package installed now, so a session last run
 * before an upgrade reports the upgrade. Only reachable while the log keeps the
 * run; older sessions go up without either, rather than with a guess.
 */
async function kimiRuntime(home: string, sessionId: string): Promise<{ version?: string; model?: string }> {
  const dir = join(home, "logs");
  let files: { path: string; modified: number }[] = [];
  try {
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".log")) continue;
      const path = join(dir, name);
      files.push({ path, modified: (await stat(path)).mtimeMs });
    }
  } catch {
    return {};
  }
  files = files.sort((a, b) => b.modified - a.modified);

  for (const { path } of files) {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(sessionId)) continue;

    let run: Run | undefined;
    let last: Run | undefined;
    for (const line of text.split("\n")) {
      const opens = RUN_OPENS.exec(line);
      if (opens) {
        const next: Run = { session: opens[1]!, at: Date.parse(line.slice(0, 23).replace(" ", "T")) };
        // Two processes started together write into the one log at once, and
        // the lines that open a run name no session and no process. A run
        // opening before the one before it named its model leaves the lines
        // after both impossible to tell apart: neither run gets them, rather
        // than one getting the other's.
        if (run && run.model === undefined && next.at - run.at < RUNS_OVERLAP_MS) {
          run.tangled = true;
          next.tangled = true;
        }
        run = next;
        if (run.session === sessionId) last = run;
        continue;
      }
      if (!run || run.tangled) continue;
      run.model ??= RUN_MODEL.exec(line)?.[1];
      run.agent ??= RUN_AGENT.exec(line)?.[1];
    }
    if (last?.tangled) return {};
    if (last) return { model: last.model, version: last.agent ? await installedVersion(last.agent) : undefined };
  }
  return {};
}

/** One run as Kimi CLI's log opened it: which session, when, and what it read out after. */
interface Run {
  session: string;
  at: number;
  model?: string;
  agent?: string;
  /** Opened alongside another run, so that the lines after it could be either's. */
  tangled?: boolean;
}

/** How far apart two runs can open and still write the lines after them in turn: one names its model within a second. */
const RUNS_OVERLAP_MS = 10_000;

/** `1.52.0` for an agent file under `…/site-packages/kimi_cli/agents/`, from the dist-info beside the package. */
async function installedVersion(agentFile: string): Promise<string | undefined> {
  const at = agentFile.lastIndexOf("/kimi_cli/");
  if (at < 0) return undefined;
  try {
    for (const name of await readdir(agentFile.slice(0, at))) {
      const found = /^kimi_cli-(.+)\.dist-info$/.exec(name);
      if (found) return found[1];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * The Kimi Code version installed now, from the npm package the `kimi` on PATH
 * belongs to. Like Kimi CLI, Kimi Code writes its version into no session
 * file, and it keeps no log that names it.
 *
 * ponytail: the standalone build (`~/.kimi-code/bin/kimi`, from Kimi's install
 * script) is one binary with no manifest beside it, so its sessions go up
 * without a version. `kimi --version` would say, at the cost of a process on
 * every upload.
 */
async function kimiCodeVersion(): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    let file: string;
    try {
      file = await realpath(join(dir, "kimi"));
      // What a shell runs is the first `kimi` that is a file it may execute: a
      // folder of that name, or a file without the bit, is passed over.
      if (!(await stat(file)).isFile()) continue;
      await access(file, constants.X_OK);
    } catch {
      continue;
    }
    // The first `kimi` on PATH is the one that runs: `<package>/dist/main.mjs` for npm.
    for (let at = dirname(file), depth = 0; depth < 3; at = dirname(at), depth += 1) {
      try {
        const manifest: unknown = JSON.parse(await readFile(join(at, "package.json"), "utf8"));
        if (isObject(manifest) && manifest.name === "@moonshot-ai/kimi-code" && typeof manifest.version === "string") {
          return manifest.version;
        }
      } catch {
        continue;
      }
    }
    return undefined;
  }
  return undefined;
}

/**
 * The session folder for a transcript path. Kimi Code's `wire.jsonl` sits two
 * levels below it (`<session>/agents/<name>/wire.jsonl`); Kimi CLI's `wire.jsonl`
 * and every `context.jsonl` sit directly in it.
 */
function sessionDirFor(path: string): string {
  const dir = dirname(path);
  return basename(path) === "wire.jsonl" && basename(dirname(dir)) === "agents" ? dirname(dirname(dir)) : dir;
}

/**
 * Kimi puts nothing in the transcript itself, so the id and the working
 * directory both come off the `state.json` beside it — read here through the
 * same two rules `readSession` uses, so a session cannot be called one thing
 * when it is listed and another when it is parsed. Without a working directory
 * no path in the transcript can be made repository-relative
 * (`mask-paths.ts`), so a caller that knows it wins and one that does not,
 * such as `isy analyze`, still gets it here.
 */
async function kimiRecords(path: string, given?: string): Promise<string[]> {
  const lines = (await readFile(path, "utf8")).split("\n");
  const dir = sessionDirFor(path);
  const state = await readState(dir);
  const sessionId = sessionIdOf(state, dir);
  const cwd = given ?? (await cwdOfSession(dir, state));

  // Kimi CLI's event log and Kimi Code's open with the same metadata header, so
  // the events after it decide which reader this is.
  if (isKimiCliWire(lines.slice(0, 3))) {
    const runtime = await kimiRuntime(dirname(dirname(dirname(dir))), sessionId);
    const subagents = await kimiCliSubagentLogs(dir);
    return kimiCliWireToClaudeRecords(lines, { sessionId, cwd, ...runtime, subagents });
  }
  if (isKimiWireTranscript(lines[0] ?? "")) {
    // A subagent's own log, asked about alone, is all there is to read.
    const subagents = basename(dirname(path)) === "main" ? await subagentLogs(dir, state ?? {}) : undefined;
    const copied = copiedUntil(state);
    return wireToClaudeRecords(lines, {
      sessionId,
      cwd,
      version: await kimiCodeVersion(),
      subagents,
      ...(copied !== undefined ? { copiedUntil: copied } : {}),
    });
  }

  let wire: string[] | undefined;
  try {
    wire = (await readFile(join(dirname(path), "wire.jsonl"), "utf8")).split("\n");
  } catch {
    wire = undefined;
  }

  return toClaudeRecords(lines, { sessionId, cwd, wire });
}

export const kimiAgent: Agent = {
  id: "kimi",
  label: "Kimi CLI",

  async present(): Promise<boolean> {
    try {
      await access(kimiHome());
      return true;
    } catch {
      return false;
    }
  },

  // Every home gets hooks, so every home's config is where they went.
  configLocation(): string {
    return kimiHomes()
      .map((home) => kimiConfigPath(home))
      .join(" and ");
  },

  hooks: allKimiHooks,

  // Sessions are found by reading each one's cwd, not by deriving a path, so
  // there is no per-directory folder to name. The root is what must be readable.
  transcriptDir(): string {
    return kimiSessionsRoot();
  },

  transcriptRoot: kimiSessionsRoot,

  async parsedSession(path: string, cwd?: string): Promise<ParsedSession> {
    const session = parseLines(await kimiRecords(path, cwd));
    session.filePath = path;
    return session;
  },

  async sessionsIn(cwd: string): Promise<SessionFile[]> {
    return discovered((await allSessions()).filter((session) => session.cwd === cwd));
  },

  // Kimi reads `state.json` to list anything at all, so unlike the other two
  // adapters the working directory comes for free with the listing — which is
  // why `DiscoveredSession` carries it and a sweep never asks `cwdOf` again.
  async allSessions(): Promise<DiscoveredSession[]> {
    return discovered(await allSessions());
  },

  async cwdOf(path: string): Promise<string | undefined> {
    const dir = sessionDirFor(path);
    return cwdOfSession(dir, await readState(dir));
  },

  // Kimi's hook payload carries no transcript path, so compose it from the
  // session id and cwd it does send, and fall back to the newest session.
  async transcriptFor(hook: HookInput | undefined, cwd: string): Promise<string | undefined> {
    const sessionId = hook?.session_id;
    if (sessionId) {
      // Matched by id across every workspace: a session resumed from another
      // directory keeps its id but moves, and the id is the thing we were told.
      const exact = (await allSessions()).find((session) => session.sessionId === sessionId);
      if (exact) return exact.transcript;
    }
    return (await kimiAgent.sessionsIn(hook?.cwd ?? cwd))[0]?.path;
  },

  async redactedLines(
    path: string,
    options: { extraPatterns?: readonly string[]; cwd?: string },
  ): Promise<string[]> {
    const records = await kimiRecords(path, options.cwd);
    return redactLines(records, { extraPatterns: options.extraPatterns, cwd: options.cwd }).lines;
  },

  // Every Kimi home gets its own hooks, as its CLI runs them: a hook counts as
  // installed only when every home that should have it does.
  async hooksInstalled(): Promise<string[]> {
    const missing = new Set<string>();
    for (const home of kimiHomes()) {
      const tables = hookTables(await readConfigToml(home));
      for (const hook of kimiHooks(home)) {
        if (!tables.some((table) => table.event === hook.event && table.command === hook.command)) missing.add(hook.event);
      }
    }
    return allKimiHooks()
      .map((hook) => hook.event)
      .filter((event) => !missing.has(event));
  },

  async installHooks(): Promise<"installed" | "already-present"> {
    let changed = false;
    for (const home of kimiHomes()) {
      const contents = await readConfigToml(home);
      if (upToDate(isyTables(contents), kimiHooks(home))) continue;
      // An older isy wrote different commands for the same job, a Kimi rewrite
      // dropped the markers, or the migration copied the other CLI's hooks in:
      // one block, where the first of isy's tables stood.
      await writeConfigToml(home, withBlock(contents, managedBlock(home)));
      changed = true;
    }
    return changed ? "installed" : "already-present";
  },

  // Only homes where an isy already wrote hooks: a home the reader left
  // without them stays that way.
  async repairHooks(): Promise<boolean> {
    let changed = false;
    for (const home of kimiHomes()) {
      const contents = await readConfigToml(home);
      const ours = isyTables(contents);
      if (ours.length === 0 || upToDate(ours, kimiHooks(home))) continue;
      await writeConfigToml(home, withBlock(contents, managedBlock(home)));
      changed = true;
    }
    return changed;
  },

  async removeHooks(): Promise<"removed" | "absent"> {
    let removed = false;
    for (const home of kimiHomes()) {
      const contents = await readConfigToml(home);
      if (isyTables(contents).length === 0 && markerLines(contents).length === 0) continue;
      await writeConfigToml(home, withBlock(contents, undefined));
      removed = true;
    }
    return removed ? "removed" : "absent";
  },

  // Kimi discards hook stdout on the events we care about, so write straight to
  // the terminal. SessionEnd fires after the session closes, so the TUI is down
  // and the line lands in the shell. With no terminal to write to — CI, a piped
  // run — park it for the UserPromptSubmit drain instead of losing it.
  async deliver(message: string): Promise<void> {
    try {
      await writeFile("/dev/tty", `${message}\n`);
      return;
    } catch {
      // No controlling terminal.
    }

    await parkAlert(message);
  },
};

async function writeConfigToml(home: string, contents: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(kimiConfigPath(home), contents, "utf8");
}

/** Every hook some Kimi home on this machine takes, once per event. */
function allKimiHooks(): AgentHook[] {
  const byEvent = new Map<string, AgentHook>();
  for (const home of kimiHomes()) for (const hook of kimiHooks(home)) if (!byEvent.has(hook.event)) byEvent.set(hook.event, hook);
  return [...byEvent.values()];
}

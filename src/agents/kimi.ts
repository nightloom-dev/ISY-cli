import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parkAlert } from "../alert.js";
import { parseLines } from "../parser.js";
import { pendingAlertPath } from "../paths.js";
import { redactLines } from "../redact.js";
import type { DiscoveredSession, ParsedSession, SessionFile } from "../types.js";
import { toClaudeRecords } from "./kimi-records.js";
import { isKimiWireTranscript, wireToClaudeRecords } from "./kimi-wire.js";
import type { Agent, AgentHook, HookInput } from "./types.js";

/** Builds have shipped under both names; take whichever this machine has. */
const HOME_CANDIDATES = [".kimi", ".kimi-code"];

export function kimiHome(): string {
  const override = process.env.KIMI_HOME;
  if (override) return override;

  for (const name of HOME_CANDIDATES) {
    const candidate = join(homedir(), name);
    if (existsSync(candidate)) return candidate;
  }
  return join(homedir(), HOME_CANDIDATES[0]!);
}

export function kimiConfigPath(): string {
  return join(kimiHome(), "config.toml");
}

/** Every workspace's sessions, whatever Kimi decides to name the folders. */
export function kimiSessionsRoot(): string {
  return join(kimiHome(), "sessions");
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

/** The transcript inside a session folder, whichever layout this build uses. */
async function transcriptIn(dir: string, state: Record<string, unknown>): Promise<string | undefined> {
  const agents = isObject(state.agents) ? state.agents : {};

  // `main` is the session's own agent; the rest are sub-agents, whose logs are
  // sidechains and not this session's transcript.
  const home = isObject(agents.main) && typeof agents.main.homedir === "string"
    ? agents.main.homedir
    : join(dir, "agents", "main");

  for (const candidate of [join(home, "wire.jsonl"), join(dir, "context.jsonl")]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      continue;
    }
  }
  return undefined;
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

/** Where the session ran, which is the root every path in it is relative to. */
function recordedCwd(state: Record<string, unknown> | undefined): string | undefined {
  return typeof state?.cwd === "string" ? state.cwd : undefined;
}

async function readSession(dir: string): Promise<KimiSession | undefined> {
  const state = await readState(dir);
  if (!state) return undefined;

  const transcript = await transcriptIn(dir, state);
  if (!transcript) return undefined;

  return { sessionId: sessionIdOf(state, dir), transcript, cwd: recordedCwd(state) };
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
      found.push({
        sessionId: session.sessionId,
        path: session.transcript,
        sizeBytes: info.size,
        modifiedAt: info.mtime,
        cwd: session.cwd,
      });
    } catch {
      continue;
    }
  }

  found.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return found;
}

/** Every session on this machine, in no particular order. */
async function allSessions(): Promise<KimiSession[]> {
  const root = kimiSessionsRoot();
  const found: KimiSession[] = [];

  for (const workspace of await subdirectories(root)) {
    const dir = join(root, workspace);
    for (const name of await subdirectories(dir)) {
      const session = await readSession(join(dir, name));
      if (session) found.push(session);
    }
  }

  return found;
}

const BEGIN = "# isy:begin — managed by isy, do not edit inside this block";
const END = "# isy:end";

function drainCommand(): string {
  const path = pendingAlertPath();
  return `if [ -s "${path}" ]; then cat "${path}"; : > "${path}"; fi`;
}

function kimiHooks(): AgentHook[] {
  return [
    {
      event: "SessionStart",
      command: "npx @nightloom/isy check --hook --agent kimi",
      superseded: ["npx isy check --hook --agent kimi"],
    },
    // Kimi 0.38 sends no `client_type`, so the hook says who fired it.
    {
      event: "SessionEnd",
      command: "npx @nightloom/isy upload --hook --agent kimi",
      superseded: ["npx isy upload --hook", "npx isy upload --hook --agent kimi"],
    },
    // SessionStart and SessionEnd are observation-only in Kimi and their stdout
    // is discarded, so an alert that could not reach the terminal directly is
    // parked in a file. UserPromptSubmit *is* blockable, so its stdout is shown:
    // this drains the backlog. Kept as shell — it runs on every prompt, and
    // `npx @nightloom/isy` would add ~380ms of node startup to each one.
    { event: "UserPromptSubmit", command: drainCommand() },
  ];
}

function managedBlock(): string {
  const entries = kimiHooks()
    .map((hook) => `[[hooks]]\nevent = "${hook.event}"\ncommand = '${hook.command}'\ntimeout = 30`)
    .join("\n\n");
  return `${BEGIN}\n${entries}\n${END}`;
}

async function readConfigToml(): Promise<string> {
  try {
    return await readFile(kimiConfigPath(), "utf8");
  } catch {
    return "";
  }
}

/**
 * One session as Claude-shaped record lines. context.jsonl is the surviving
 * conversation; wire.jsonl, when present, still holds turns a rewind discarded.
 */
/**
 * The session id for a transcript path. `wire.jsonl` sits two levels below the
 * session folder (`<session>/agents/main/wire.jsonl`), `context.jsonl` sits
 * directly in it, so the folder to name the session after differs by layout.
 */
function sessionDirFor(path: string): string {
  const dir = dirname(path);
  return basename(path) === "wire.jsonl" ? dirname(dirname(dir)) : dir;
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
  const cwd = given ?? recordedCwd(state);

  // Newer builds keep the whole session as one event log and write no
  // `context.jsonl` at all. The first line says which format this is.
  if (isKimiWireTranscript(lines[0] ?? "")) {
    return wireToClaudeRecords(lines, { sessionId, cwd });
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

  configLocation(): string {
    return kimiConfigPath();
  },

  hooks: kimiHooks,

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
    return recordedCwd(await readState(sessionDirFor(path)));
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

  async hooksInstalled(): Promise<string[]> {
    const contents = await readConfigToml();
    return kimiHooks()
      .filter((hook) => [hook.command, ...(hook.superseded ?? [])].some((command) => contents.includes(command)))
      .map((hook) => hook.event);
  },

  async installHooks(): Promise<"installed" | "already-present"> {
    const contents = await readConfigToml();
    const desired = managedBlock();

    const start = contents.indexOf(BEGIN);
    if (start >= 0) {
      const stop = contents.indexOf(END, start);
      const existing = stop >= 0 ? contents.slice(start, stop + END.length) : undefined;
      if (existing === desired) return "already-present";
      if (existing !== undefined) {
        // An older isy wrote different commands for the same job: replace them.
        await writeConfigToml(contents.replace(existing, desired));
        return "installed";
      }
    }

    const separator = contents.length === 0 || contents.endsWith("\n") ? "" : "\n";
    await writeConfigToml(`${contents}${separator}${contents.length > 0 ? "\n" : ""}${desired}\n`);
    return "installed";
  },

  async removeHooks(): Promise<"removed" | "absent"> {
    const contents = await readConfigToml();
    const start = contents.indexOf(BEGIN);
    if (start < 0) return "absent";

    const stop = contents.indexOf(END, start);
    if (stop < 0) return "absent";

    const before = contents.slice(0, start).replace(/\n+$/, "\n");
    const after = contents.slice(stop + END.length).replace(/^\n+/, "");
    await writeConfigToml(`${before}${after}`);
    return "removed";
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

async function writeConfigToml(contents: string): Promise<void> {
  await mkdir(kimiHome(), { recursive: true });
  await writeFile(kimiConfigPath(), contents, "utf8");
}

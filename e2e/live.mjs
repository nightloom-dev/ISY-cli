#!/usr/bin/env node
// Live end-to-end check of the Claude Code side of this client: a real Claude
// Code, its hooks pointed at this checkout's build, the uploads landing on the
// mock API. Not part of `npm test` — it spends a Claude subscription and takes
// minutes. What it covers, scenario by scenario, is in SCENARIOS below.
//
//   npm run build
//   ISY_REPO=../ISY CLAUDE_BIN=/path/to/claude npm run e2e:live [-- A1 A2 …]
//
// Needs, in the ISY repository: `npm ci`, `npm run db:generate -w isy-server`,
// `npm run build -w isy-server`, and node_modules/isy replaced by this checkout
// (`npm pack` here, then untar into ../ISY/node_modules/isy) — the mock parses
// every upload with the installed isy/parser. Python 3 drives the terminal
// scenarios (e2e/pty-drive.py).
//
// Environment: ISY_E2E_DIR (work dir, default $TMPDIR/isy-e2e), ISY_E2E_PORT
// (default 3998; the next port hosts the slow mock), CLAUDE_BIN, ISY_REPO,
// ISY_E2E_MODEL (default haiku; A12 always uses opus), ISY_E2E_MAX_AGENTS
// (default 3) and ISY_E2E_SLOTS (where the agent slots are claimed, shared with
// any other script recording sessions at the same time), ISY_E2E_USER_SETTINGS
// (a settings.json whose isy hooks A9 replays; default: the hooks isy wrote
// before 1.0).
//
// Every verdict is pass, fail or inconclusive. Inconclusive means the agent did
// not do what the scenario asked of it — no subagent, no background — and says
// nothing about the client. The table goes to stdout, the details with the
// paths to every transcript and log to $ISY_E2E_DIR/e2e-report.json.

import { existsSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CLAUDE_BIN,
  CLI_ROOT,
  CredentialsReplaced,
  ISY_CLI,
  WORK,
  blocksOf,
  claudeP,
  claudePty,
  envFor,
  exec,
  isy,
  keepTranscripts,
  prepareRun,
  readJsonl,
  readSettings,
  shimLog,
  startMock,
  toolUses,
  transcriptPath,
  uploads,
  waitUpload,
  writeSettings,
  writeShims,
} from "./lib.mjs";

const PORT = Number(process.env.ISY_E2E_PORT) || 3998;
const API = `http://127.0.0.1:${PORT}`;
/** Answers each upload five seconds late: a hook that waits on the upload shows it. */
const SLOW_API = `http://127.0.0.1:${PORT + 1}`;
const UPLOADS = join(WORK, "uploads");
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const { HOOK_COMMAND } = await import(join(CLI_ROOT, "dist", "hook.js"));
const { claudeAgent } = await import(join(CLI_ROOT, "dist", "agents", "claude.js"));
const { runStage0 } = await import(join(CLI_ROOT, "dist", "stage0.js"));

const pass = (reason, evidence, details) => ({ verdict: "pass", reason, evidence, details });
const fail = (reason, evidence, details) => ({ verdict: "fail", reason, evidence, details });
const inconclusive = (reason, evidence, details) => ({ verdict: "inconclusive", reason, evidence, details });
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const short = (id) => id?.slice(0, 8);

// ---------------------------------------------------------------- helpers

async function analyze(run, target, cwd) {
  const result = await exec(process.execPath, [ISY_CLI, "analyze", ...[target].flat(), "--json"], {
    cwd: cwd ?? run.repo,
    env: envFor(run),
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`isy analyze ${[target].flat().join(" ")}: ${result.stderr || result.stdout}`);
  }
}

async function dropHook(run, event) {
  const settings = await readSettings(run);
  delete settings.hooks[event];
  await writeSettings(run, settings);
}

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return undefined;
    await sleep(500);
  }
}

const readText = (path) => readFile(path, "utf8").catch(() => undefined);

/** Which subagent file answers `callId`, by the `toolUseId` its meta names. */
async function subagentFile(run, sessionId, callId) {
  const dir = join(dirname(transcriptPath(run, sessionId)), sessionId, "subagents");
  for (const name of (await readdir(dir).catch(() => [])).filter((entry) => entry.endsWith(".meta.json"))) {
    const meta = JSON.parse(await readFile(join(dir, name), "utf8"));
    if (meta.toolUseId === callId) return { path: join(dir, name.replace(/\.meta\.json$/, ".jsonl")), meta };
  }
  return undefined;
}

/**
 * Where a subagent's records landed in the upload. After its call; in the order
 * its own file has them; and by time against the session around it — a record
 * of the session that is more than a second later never stands before one of
 * the subagent's, nor an earlier one after it.
 */
function spliceProblems(records, callId, own) {
  const problems = [];
  const time = (record) => Date.parse(record.timestamp);
  const callAt = records.findIndex((record) => blocksOf(record).some((block) => block.type === "tool_use" && block.id === callId));
  const spliced = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.isSidechain === true && record.parentToolUseID === callId);
  if (callAt < 0) problems.push("the Agent call is not in the upload");
  if (spliced.length === 0) return [...problems, "no record of the subagent in the upload"];
  if (spliced[0].index < callAt) problems.push("a subagent record stands before its Agent call");

  const order = spliced.map(({ record }) => record.uuid).filter(Boolean).join();
  const fileOrder = own.map((record) => record.uuid).filter(Boolean).join();
  if (order !== fileOrder) problems.push("the subagent's records are not in its own file's order");

  const session = records
    .map((record, index) => ({ record, index }))
    .filter(({ record, index }) => record.isSidechain !== true && index > callAt && Number.isFinite(time(record)));
  let misplaced = 0;
  for (const { record, index } of spliced) {
    const at = time(record);
    if (!Number.isFinite(at)) continue;
    const late = session.some((entry) => entry.index < index && time(entry.record) > at + 1000);
    const early = session.some((entry) => entry.index > index && time(entry.record) < at - 1000);
    if (late || early) misplaced += 1;
  }
  if (misplaced > 0) problems.push(`${misplaced} subagent record(s) out of time order with the session`);
  return problems;
}

// ---------------------------------------------------------------- scenarios

const WRITE_HELLO = "Create a file hello.txt containing the single word hi, using the Write tool. Then stop.";

async function a0() {
  const run = await prepareRun("a0", { api: API });
  const agent = await claudeP(run, WRITE_HELLO, { tools: "Write" });
  const upload = await waitUpload(API, agent.sessionId);
  const log = await shimLog(run);
  const evidence = [agent.out, join(run.dir, "shim.log")];
  const started = log.some((entry) => entry.args === "check --hook");
  const ended = log.find((entry) => entry.args === "upload --hook" && entry.stdin?.includes(agent.sessionId));
  if (!started) return fail("the SessionStart hook did not run under -p", evidence);
  if (!ended) return fail("the SessionEnd hook did not run under -p, or ran without this session's payload", evidence);
  if (!upload) return fail("the session never reached the mock", evidence);
  return pass(
    `SessionStart and SessionEnd both ran under -p; SessionEnd named ${short(agent.sessionId)} on fd 3; ` +
      `upload arrived (claudeVersion ${upload.claudeVersion}, repo ${upload.repo}, hasFileEdits ${upload.hasFileEdits})`,
    evidence,
    { upload },
  );
}

const subagentRuns = new Map();

/** A1 and A2: files are edited by a subagent only, in the foreground or in the background. */
function subagentScenario(id, background) {
  if (subagentRuns.has(id)) return subagentRuns.get(id);
  const work = (async () => {
    const run = await prepareRun(id, { api: API });
    const file = background ? "b.txt" : "a.txt";
    // Three tool calls at least: stage 0 gates a shorter session as too short (MIN_TOOL_USES), which says nothing about edits.
    const task = `create the file ${file} containing the single word ${background ? "b" : "a"} with its Write tool, then read it back with its Read tool`;
    const prompt = background
      ? `Call the Agent tool with run_in_background: true and have that background subagent ${task}. Do not create or ` +
        "edit any file yourself. Wait until the background subagent reports that it has finished, then stop."
      : `Call the Agent tool (a normal foreground subagent, not in the background) and have that subagent ${task}. ` +
        "Do not create or edit any file yourself. Wait for the subagent to finish, then stop.";
    const agent = await claudeP(run, prompt, { tools: "Agent,Write,Read" });
    const path = transcriptPath(run, agent.sessionId);
    const own = toolUses(await readJsonl(path));
    const call = own.find((use) => use.name === "Agent" || use.name === "Task");
    const evidence = [agent.out, path, join(UPLOADS, `${agent.sessionId}.jsonl`)];
    const result = await (async () => {
      if (!call) return inconclusive("the agent did not call Agent", evidence);
      if (Boolean(call.input.run_in_background) !== background) {
        return inconclusive(background ? "the subagent was not sent to the background" : "the subagent ran in the background", evidence);
      }
      if (own.some((use) => EDIT_TOOLS.has(use.name))) return inconclusive("the main agent edited files itself", evidence);
      if (!existsSync(join(run.repo, file))) return inconclusive(`the subagent did not create ${file}`, evidence);

      const upload = await waitUpload(API, agent.sessionId);
      const analyzed = (await analyze(run, path)).sessions[0];
      const problems = [];
      if (!upload) problems.push("no upload");
      else {
        if (!(upload.sidechainRecords > 0)) problems.push(`mock: sidechainRecords ${upload.sidechainRecords}`);
        if (upload.hasFileEdits !== true) problems.push(`mock: hasFileEdits ${upload.hasFileEdits}`);
      }
      if (!analyzed?.eligible) problems.push(`analyze: eligible false (${analyzed?.reason})`);
      if (!(analyzed?.editToolUses > 0)) problems.push(`analyze: editToolUses ${analyzed?.editToolUses}`);
      let spliced;
      if (background && upload) {
        const sub = await subagentFile(run, agent.sessionId, call.id);
        if (!sub) problems.push("no subagent file names the call");
        else {
          evidence.push(sub.path);
          const records = await readJsonl(join(UPLOADS, `${agent.sessionId}.jsonl`));
          problems.push(...spliceProblems(records, call.id, await readJsonl(sub.path)));
          spliced = records.filter((record) => record.parentToolUseID === call.id).length;
        }
      }
      const details = { upload, analyzed: analyzed && { ...analyzed, candidates: analyzed.candidates.length }, spliced };
      if (problems.length > 0) return fail(problems.join("; "), evidence, details);
      return pass(
        `mock: sidechainRecords ${upload.sidechainRecords}, hasFileEdits true; analyze: eligible, editToolUses ${analyzed.editToolUses}` +
          (background ? `; ${spliced} spliced records after the call, in time order` : ""),
        evidence,
        details,
      );
    })();
    return { run, agent, result };
  })();
  subagentRuns.set(id, work);
  return work;
}

const a1 = async () => (await subagentScenario("a1", false)).result;
const a2 = async () => (await subagentScenario("a2", true)).result;

async function a3() {
  const done = await Promise.all([subagentScenario("a1", false), subagentScenario("a2", true)]);
  if (done.some(({ result }) => result.verdict === "inconclusive")) {
    return inconclusive("A1 or A2 left no session with a subagent to count", []);
  }
  const run = await prepareRun("a3", { api: API, init: false });
  const root = join(run.dir, "projects");
  const dir = join(root, "p");
  await mkdir(dir, { recursive: true });
  for (const { run: source } of done) await cp(dirname(transcriptPath(source, "x")), dir, { recursive: true });
  const main = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  const agentFiles = (await readdir(dir, { recursive: true })).filter((name) => /agent-[^/]*\.jsonl$/.test(name));

  const forms = [["p"], ["./p"], ["p/"], [dir], ["p", "./p"], ["p", `./p/${main[0]}`]];
  const outcomes = [];
  for (const form of forms) {
    const report = await analyze(run, form, root);
    const doubled = report.sessions.filter((session) => /[\\/]subagents[\\/]/.test(session.file)).length;
    outcomes.push({ form: form.join(" "), files: report.totals.files, subagentSessions: doubled });
  }
  const wrong = outcomes.filter((outcome) => outcome.files !== main.length || outcome.subagentSessions > 0);
  const details = { mainFiles: main.length, agentFiles: agentFiles.length, outcomes };
  const evidence = [dir];
  if (wrong.length > 0) {
    return fail(wrong.map((outcome) => `\`analyze ${outcome.form}\`: ${outcome.files} session(s), ${outcome.subagentSessions} of them subagents`).join("; "), evidence, details);
  }
  return pass(`${main.length} sessions for ${main.length} main files and ${agentFiles.length} agent-*.jsonl, in all ${forms.length} spellings`, evidence, details);
}

async function a4() {
  const run = await prepareRun("a4", { api: API });
  const agent = await claudeP(
    run,
    "Read the file README.md with the Read tool. Then use the TaskCreate tool to record two follow-up tasks for this " +
      "repository. Do not create, edit or delete any file and do not run shell commands. Then stop.",
    { tools: "Read,TaskCreate,TaskUpdate,TaskList,TaskGet" },
  );
  const path = transcriptPath(run, agent.sessionId);
  const uses = toolUses(await readJsonl(path));
  const names = [...new Set(uses.map((use) => use.name))];
  const evidence = [agent.out, path];
  if (!names.includes("Read") || !names.some((name) => name === "TaskCreate" || name === "TodoWrite")) {
    return inconclusive(`the agent called ${names.join(", ") || "nothing"}, not Read and TaskCreate`, evidence);
  }
  if (uses.some((use) => EDIT_TOOLS.has(use.name) || use.name === "Bash")) return inconclusive("the agent edited or ran a command", evidence);
  const upload = await waitUpload(API, agent.sessionId);
  const analyzed = (await analyze(run, path)).sessions[0];
  const problems = [];
  if (!upload) problems.push("no upload");
  else if (upload.hasFileEdits !== false) problems.push(`mock: hasFileEdits ${upload.hasFileEdits}`);
  if (analyzed.eligible !== false || analyzed.reason !== "no-file-edits") problems.push(`analyze: eligible ${analyzed.eligible}, reason ${analyzed.reason}`);
  const details = { tools: names, upload };
  if (problems.length > 0) return fail(problems.join("; "), evidence, details);
  return pass(`tools ${names.join(", ")}: analyze gates it out as no-file-edits, mock hasFileEdits false`, evidence, details);
}

async function a5() {
  const run = await prepareRun("a5", { api: API });
  const config = join(run.dir, "mcp.json");
  await writeFile(config, JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [join(CLI_ROOT, "e2e", "mcp-files.mjs")] } } }));
  const extra = ["--mcp-config", config, "--strict-mcp-config"];
  const reader = await claudeP(run, "Use the mcp__files__read_file tool to read README.md and tell me its first line. Use no other tool. Then stop.", {
    tools: "mcp__files__read_file",
    extra,
    label: "reader",
  });
  const writer = await claudeP(
    run,
    "Use the mcp__files__write_file tool to create notes.txt containing the word notes, then read it back with " +
      "mcp__files__read_file, then write it again with mcp__files__write_file so that it holds two lines, notes and done. " +
      "Use no other tool. Then stop.",
    {
      tools: "mcp__files__write_file,mcp__files__read_file",
      extra,
      label: "writer",
    },
  );
  const evidence = [reader.out, writer.out];
  const outcome = {};
  for (const [name, agent, tool] of [["read", reader, "mcp__files__read_file"], ["write", writer, "mcp__files__write_file"]]) {
    const path = transcriptPath(run, agent.sessionId);
    evidence.push(path);
    const used = toolUses(await readJsonl(path)).map((use) => use.name);
    if (!used.includes(tool)) return inconclusive(`the ${name} session did not call ${tool} (called ${used.join(", ") || "nothing"})`, evidence);
    const upload = await waitUpload(API, agent.sessionId);
    const analyzed = (await analyze(run, path)).sessions[0];
    outcome[name] = { used, hasFileEdits: upload?.hasFileEdits, eligible: analyzed.eligible, reason: analyzed.reason };
  }
  if (!existsSync(join(run.repo, "notes.txt"))) return inconclusive("write_file did not create notes.txt", evidence, outcome);
  const problems = [];
  if (outcome.read.hasFileEdits !== false || outcome.read.reason !== "no-file-edits") problems.push(`read_file counted as an edit (${JSON.stringify(outcome.read)})`);
  if (outcome.write.hasFileEdits !== true || outcome.write.reason === "no-file-edits") problems.push(`write_file not counted as an edit (${JSON.stringify(outcome.write)})`);
  if (problems.length > 0) return fail(problems.join("; "), evidence, outcome);
  return pass("mcp__files__write_file {path} is an edit, mcp__files__read_file {path} is not — in the mock and in analyze", evidence, outcome);
}

const EXIT = [{ send: "/exit" }, { sleep: 0.5 }, { send: "\r" }, { waitExit: 90 }];
const READY = { wait: 'Try "', timeout: 90 };

async function a6() {
  const evidence = [];
  const details = {};
  const problems = [];

  // -p: how long the process outlives its result, with the SessionEnd hook and without it.
  const [hooked, bare] = await Promise.all([prepareRun("a6-p", { api: API }), prepareRun("a6-p-nohook", { api: API })]);
  await dropHook(bare, "SessionEnd");
  const [withHook, withoutHook] = await Promise.all([
    claudeP(hooked, WRITE_HELLO, { tools: "Write" }),
    claudeP(bare, WRITE_HELLO, { tools: "Write" }),
  ]);
  evidence.push(withHook.out, withoutHook.out);
  details.print = { withHookMs: withHook.exitedAt - withHook.resultAt, withoutHookMs: withoutHook.exitedAt - withoutHook.resultAt };
  const printed = await waitUpload(API, withHook.sessionId);
  if (!printed) problems.push("-p: the session never reached the mock");
  if (Math.abs(details.print.withHookMs - details.print.withoutHookMs) >= 2000) problems.push(`-p: exit ${seconds(details.print.withHookMs)} with the hook vs ${seconds(details.print.withoutHookMs)} without`);
  const parked = await waitFor(() => readText(join(hooked.isy, "pending-alert")));
  details.print.pendingAlert = parked?.trim();
  if (!parked?.includes("session uploaded")) problems.push("-p: no line parked in pending-alert");

  // Interactive: /exit, with the hook and without it.
  const [ptyHooked, ptyBare] = await Promise.all([prepareRun("a6-pty", { api: API }), prepareRun("a6-pty-nohook", { api: API })]);
  await dropHook(ptyBare, "SessionEnd");
  const steps = [
    READY,
    { send: "Create a file hello.txt containing the single word hi using the Write tool, then reply with the word done written in uppercase letters." },
    { sleep: 0.5 },
    { send: "\r" },
    { wait: "DONE", timeout: 180 },
    { sleep: 2 },
    { mark: "exit-sent" },
    ...EXIT,
  ];
  const [one, two] = await Promise.all([claudePty(ptyHooked, steps), claudePty(ptyBare, steps)]);
  evidence.push(one.file, two.file);
  if (!one.ok || !two.ok) return inconclusive(`the interactive session did not get through its steps (${one.failedStep ?? "-"}, ${two.failedStep ?? "-"})`, evidence, { one, two });
  // Less the half second between typing /exit and pressing Enter.
  const exitMs = (run) => Math.round((run.marks.exited - run.marks["exit-sent"] - 0.5) * 1000);
  details.pty = { withHookMs: exitMs(one), withoutHookMs: exitMs(two) };
  if (Math.abs(details.pty.withHookMs - details.pty.withoutHookMs) >= 2000) problems.push(`/exit: ${seconds(details.pty.withHookMs)} with the hook vs ${seconds(details.pty.withoutHookMs)} without`);
  const sessionId = /claude --resume ([0-9a-f-]{36})/.exec(one.screen)?.[1];
  details.pty.sessionId = sessionId;
  const exited = sessionId && (await waitUpload(API, sessionId));
  if (!exited) problems.push("/exit: the session never reached the mock");
  const line = await waitFor(() => readText(join(ptyHooked.isy, "pending-alert")));
  if (!line?.includes("session uploaded")) problems.push("/exit: no line parked in pending-alert");

  // The next session start shows the parked line and takes it. Without its own
  // SessionEnd, so nothing parks a new line behind it.
  await dropHook(ptyHooked, "SessionEnd");
  const next = await claudePty(ptyHooked, [{ wait: "SessionStart:startup says:[\\s\\S]*?session uploaded", timeout: 90 }, { mark: "shown" }, ...EXIT], { label: "next" });
  evidence.push(next.file);
  details.next = { shown: next.ok, pendingAlertLeft: existsSync(join(ptyHooked.isy, "pending-alert")) };
  if (!next.ok) problems.push("the next start did not show the parked line");
  if (details.next.pendingAlertLeft) problems.push("pending-alert was not cleared by the next start");

  if (problems.length > 0) return fail(problems.join("; "), evidence, details);
  return pass(
    `-p exits ${seconds(details.print.withHookMs)} after its result with the hook, ${seconds(details.print.withoutHookMs)} without; ` +
      `/exit takes ${seconds(details.pty.withHookMs)} vs ${seconds(details.pty.withoutHookMs)}; both uploads arrived; ` +
      "the parked line was shown at the next start and the file cleared",
    evidence,
    details,
  );
}

async function a7() {
  const marker = `echo '{"systemMessage":"E2E-START"}'`;
  const variants = [
    { id: "a7-new", label: "this branch's hook", end: { command: HOOK_COMMAND } },
    { id: "a7-new-timeout", label: "this branch's hook with the timeout 30 a repair leaves", end: { command: HOOK_COMMAND, timeout: 30 } },
    { id: "a7-old-timeout", label: "the interim hook: npx @nightloom/isy upload --hook, timeout 30", end: { command: "npx @nightloom/isy upload --hook", timeout: 30 } },
  ];
  const steps = [
    READY,
    { send: "Reply with the word pong written in uppercase letters, nothing else." },
    { sleep: 0.5 },
    { send: "\r" },
    { wait: "PONG", timeout: 180 },
    { sleep: 2 },
    { mark: "clear-sent" },
    { send: "/clear" },
    { sleep: 0.5 },
    { send: "\r" },
    { wait: "SessionStart:clear says:\\s*E2E-START", timeout: 120 },
    { mark: "clear-done" },
    { snap: "clear" },
    { send: "Reply with the word ping written in uppercase letters, nothing else." },
    { sleep: 0.5 },
    { send: "\r" },
    { wait: "PING", timeout: 180 },
    { sleep: 2 },
    { send: "/resume" },
    { sleep: 0.5 },
    { send: "\r" },
    { wait: "Resume session", timeout: 60 },
    { wait: "ago", timeout: 60 },
    { sleep: 1 },
    { mark: "resume-pick" },
    { send: "\r" },
    { wait: "SessionStart:resume says:\\s*E2E-START", timeout: 120 },
    { mark: "resume-done" },
    { snap: "resume" },
    ...EXIT,
  ];
  const runs = await Promise.all(
    variants.map(async (variant) => {
      const run = await prepareRun(variant.id, { api: SLOW_API, init: false });
      await writeSettings(run, {
        hooks: {
          SessionEnd: [{ hooks: [{ type: "command", ...variant.end }] }],
          SessionStart: [{ hooks: [{ type: "command", command: marker }] }],
        },
      });
      const driven = await claudePty(run, steps);
      return { ...variant, run, driven };
    }),
  );
  const evidence = runs.map(({ driven }) => driven.file);
  const details = {};
  for (const { id, label, driven } of runs) {
    details[id] = {
      label,
      ok: driven.ok,
      failedStep: driven.failedStep,
      clearMs: driven.marks["clear-done"] && Math.round((driven.marks["clear-done"] - driven.marks["clear-sent"] - 0.5) * 1000),
      resumeMs: driven.marks["resume-done"] && Math.round((driven.marks["resume-done"] - driven.marks["resume-pick"]) * 1000),
    };
  }
  const fast = ["a7-new", "a7-new-timeout"];
  if (fast.some((id) => !details[id].ok)) return inconclusive("a session did not get through /clear and /resume", evidence, details);
  const slow = fast.filter((id) => details[id].clearMs >= 3000 || details[id].resumeMs >= 3000);
  const old = details["a7-old-timeout"];
  const comparison = old.ok ? `; the interim hook took ${seconds(old.clearMs)} and ${seconds(old.resumeMs)}` : "; the interim hook did not get through";
  if (slow.length > 0) {
    return fail(slow.map((id) => `${details[id].label}: /clear ${seconds(details[id].clearMs)}, /resume ${seconds(details[id].resumeMs)}`).join("; ") + comparison, evidence, details);
  }
  return pass(
    `with a 5 s upload: /clear ${seconds(details["a7-new"].clearMs)}, /resume ${seconds(details["a7-new"].resumeMs)}; ` +
      `with timeout 30 left on it ${seconds(details["a7-new-timeout"].clearMs)} / ${seconds(details["a7-new-timeout"].resumeMs)}${comparison}`,
    evidence,
    details,
  );
}

/**
 * Two sessions in one folder, S2 ending while S1 is still writing. Run twice:
 * with this branch's SessionEnd hook, and with the same hook minus fd 3 — the
 * form that lost the payload and so uploaded the newest session in the folder.
 * Both wait three seconds before isy reads anything, as a real `npx` does while
 * it resolves the package: long enough for S1 to write again.
 */
async function a8() {
  const arm = async (id, command) => {
    const run = await prepareRun(id, { api: API });
    run.env = { ISY_E2E_UPLOAD_DELAY: "3" };
    if (command) {
      const settings = await readSettings(run);
      settings.hooks.SessionEnd[0].hooks[0].command = command;
      await writeSettings(run, settings);
    }
    const long = claudeP(
      run,
      "Start with n = 1. Then, forty times in a row, run the Bash command `echo $((n + 1))` with n replaced by the number " +
        "the previous command printed, and set n to what it prints. One Bash call at a time, each one waiting for the " +
        "previous output — never several at once, never a loop. Then reply with the final n.",
      { tools: "Bash(echo:*)", label: "s1" },
    );
    await sleep(15_000);
    const s2 = await claudeP(run, WRITE_HELLO, { tools: "Write", label: "s2" });
    const s1 = await long;
    const log = await shimLog(run);
    // S2's SessionEnd: the upload hook that started between S2's result and S1's.
    const hook = log.find((entry) => entry.args === "upload --hook" && entry.stdinFrom >= s2.resultAt - 1000 && entry.stdinFrom < s1.resultAt);
    const done = hook && log.find((entry) => entry.pid === hook.pid && entry.exit !== undefined);
    const sent = done
      ? (await uploads(API)).filter((upload) => {
          const at = Date.parse(upload.receivedAt);
          return at >= hook.stdinFrom && at <= done.at + 500;
        })
      : [];
    const time = (record) => Date.parse(record.timestamp);
    const s2Last = Math.max(...(await readJsonl(transcriptPath(run, s2.sessionId))).map(time).filter(Number.isFinite));
    const s1Later = hook && (await readJsonl(transcriptPath(run, s1.sessionId))).some((record) => time(record) > s2Last && time(record) <= done.at);
    return {
      id,
      s1: s1.sessionId,
      s2: s2.sessionId,
      overlapped: s1.resultAt > s2.exitedAt,
      payload: hook?.stdin ? JSON.parse(hook.stdin).session_id : null,
      uploaded: sent.map((upload) => upload.sessionId),
      s1WroteAfterS2: Boolean(s1Later),
      evidence: [s1.out, s2.out, join(run.dir, "shim.log")],
    };
  };
  const fixed = await arm("a8");
  const control = await arm("a8-without-fd3", "nohup npx @nightloom/isy upload --hook >/dev/null 2>&1 &");
  const evidence = [...fixed.evidence, ...control.evidence];
  const details = { fixed, control };
  if (!fixed.overlapped) return inconclusive("S1 ended before S2 did", evidence, details);
  if (fixed.uploaded.includes(fixed.s1)) return fail("S2's end uploaded S1", evidence, details);
  if (!fixed.uploaded.includes(fixed.s2)) return fail("S2's end did not upload S2", evidence, details);
  if (!fixed.s1WroteAfterS2) return inconclusive("S2 went up, but S1 had not written since S2 ended, so S2 was the newest anyway", evidence, details);
  const shown = control.overlapped && control.uploaded.includes(control.s1) && !control.uploaded.includes(control.s2);
  return pass(
    `S2's end uploaded S2 (payload on fd 3) while S1 was writing on; ` +
      (shown ? "the same hook without fd 3 uploaded S1 instead" : `the control without fd 3 uploaded ${control.uploaded.map(short).join(", ") || "nothing"}`),
    evidence,
    details,
  );
}

async function a9() {
  const evidence = [];
  const details = {};
  const problems = [];

  // The upload hook of 1.0.1 with the interim timeout, between two of the user's own.
  const run = await prepareRun("a9", { api: API, init: false });
  const own = (name) => ({ hooks: [{ type: "command", command: `echo ${name} >> "$ISY_E2E_RUN_DIR/user-hooks.log"` }] });
  const before = {
    hooks: {
      SessionEnd: [own("user-first"), { hooks: [{ type: "command", command: "npx @nightloom/isy upload --hook", timeout: 30 }] }, own("user-last")],
      SessionStart: [{ hooks: [{ type: "command", command: "npx @nightloom/isy check --hook" }] }],
    },
  };
  await writeSettings(run, before);
  await writeFile(join(run.dir, "settings.before.json"), JSON.stringify(before, null, 2));
  const agent = await claudeP(run, "Reply with the word ok, nothing else.");
  const after = await readSettings(run);
  evidence.push(agent.out, join(run.dir, "settings.before.json"), join(run.config, "settings.json"));
  const ends = after.hooks?.SessionEnd ?? [];
  details.after = after.hooks;
  if (ends.length !== 3) problems.push(`SessionEnd has ${ends.length} groups, not 3`);
  if (JSON.stringify(ends[0]) !== JSON.stringify(before.hooks.SessionEnd[0]) || JSON.stringify(ends[2]) !== JSON.stringify(before.hooks.SessionEnd[2])) {
    problems.push("the user's own SessionEnd hooks moved or changed");
  }
  const rewritten = ends[1]?.hooks?.[0];
  if (rewritten?.command !== HOOK_COMMAND) problems.push(`the second group runs ${JSON.stringify(rewritten?.command)}`);
  details.timeoutKept = rewritten?.timeout;
  details.uploaded = Boolean(await waitUpload(API, agent.sessionId, { timeoutMs: 30_000 }));

  // The user's own hooks, as they stand: observed, not judged.
  const user = await userIsyHooks();
  const observed = await prepareRun("a9-user", { api: API, init: false });
  await writeSettings(observed, { hooks: user });
  const replay = await claudeP(observed, "Reply with the word ok, nothing else.");
  const afterSession = (await readSettings(observed)).hooks;
  const check = JSON.parse((await isy(observed, ["check", "--json"])).stdout);
  const log = await shimLog(observed);
  const initOut = await isy(observed, ["init"]);
  const afterInit = await readSettings(observed);
  evidence.push(replay.out, join(observed.dir, "shim.log"));
  details.userHooks = {
    before: user,
    afterSession,
    calls: log.map((entry) => `${entry.kind} ${entry.args}`),
    uploadedWithoutInit: Boolean((await uploads(API)).find((upload) => upload.sessionId === replay.sessionId)),
    checkMissingHooks: check.missingHooks,
    checkAction: check.action,
    afterInit: afterInit.hooks,
    initOutput: initOut.stdout.trim(),
  };

  if (problems.length > 0) return fail(problems.join("; "), evidence, details);
  return pass(
    `SessionEnd rewritten in place (group 2 of 3, the user's own untouched)${details.timeoutKept !== undefined ? `; "timeout": ${details.timeoutKept} was kept on it` : ""}; ` +
      `upload ${details.uploaded ? "arrived" : "missing"}`,
    evidence,
    details,
  );
}

/** The isy hooks of the settings file named by ISY_E2E_USER_SETTINGS; otherwise the ones isy wrote before 1.0. */
async function userIsyHooks() {
  const path = process.env.ISY_E2E_USER_SETTINGS;
  const fallback = {
    SessionEnd: [{ hooks: [{ type: "command", command: "npx isy upload --hook" }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "npx isy check --hook" }] }],
  };
  if (!path) return fallback;
  const hooks = JSON.parse(await readFile(path, "utf8")).hooks ?? {};
  const kept = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const mine = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => /\bisy\b/.test(hook.command ?? "")) }))
      .filter((group) => group.hooks.length > 0);
    if (mine.length > 0) kept[event] = mine;
  }
  return Object.keys(kept).length > 0 ? kept : fallback;
}

async function a10() {
  const run = await prepareRun("a10", { api: API });
  await dropHook(run, "SessionEnd");
  const agent = await claudeP(run, "Reply with the word ok, nothing else.");
  const settings = await readSettings(run);
  const report = JSON.parse((await isy(run, ["check", "--json"])).stdout);
  const line = (await isy(run, ["check"])).stdout.trim();
  const evidence = [agent.out, join(run.config, "settings.json")];
  const details = { hooks: Object.keys(settings.hooks ?? {}), missingHooks: report.missingHooks, line };
  if (settings.hooks?.SessionEnd) return fail("the removed SessionEnd hook came back", evidence, details);
  if (!report.missingHooks.includes("SessionEnd") || !/SessionEnd hook missing/.test(line)) return fail("isy check does not name the missing hook", evidence, details);
  return pass(`not restored; isy check: "${line}"`, evidence, details);
}

/** Refuses the key `isy_revoked` and pairs a new one, the way the server's keys screen would. */
function pairingStub() {
  return new Promise((ready) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url, "http://stub");
      const send = (status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (url.pathname === "/api/v1/me") {
        return request.headers.authorization === "Bearer isy_revoked" ? send(401, { error: "revoked" }) : send(200, { githubLogin: "e2e-user" });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/cli/pairings") {
        const base = `http://127.0.0.1:${server.address().port}`;
        return send(200, { deviceCode: "dev-e2e", userCode: "E2E-CODE", connectUrl: `${base}/settings/api_keys?connect=E2E-CODE`, expiresInMs: 60_000, pollIntervalMs: 200 });
      }
      if (url.pathname === "/api/v1/cli/pairings/dev-e2e") return send(200, { status: "ready", token: "isy_paired", githubLogin: "e2e-user" });
      send(404, { error: "not found" });
    });
    server.listen(0, "127.0.0.1", () => ready({ url: `http://127.0.0.1:${server.address().port}`, stop: () => server.close() }));
  });
}

async function a11() {
  const kept = await prepareRun("a11-kept", { api: API, init: false });
  const first = await isy(kept, ["init"]);
  const openedForKept = await readText(join(kept.dir, "browser.log"));

  const stub = await pairingStub();
  try {
    const revoked = await prepareRun("a11-revoked", { api: stub.url, init: false });
    await writeFile(join(revoked.isy, "config.json"), JSON.stringify({ token: "isy_revoked", apiBaseUrl: stub.url }));
    const second = await isy(revoked, ["init"]);
    const opened = await readText(join(revoked.dir, "browser.log"));
    const config = JSON.parse(await readFile(join(revoked.isy, "config.json"), "utf8"));
    await writeFile(join(kept.dir, "init.out"), first.stdout + first.stderr);
    await writeFile(join(revoked.dir, "init.out"), second.stdout + second.stderr);
    const evidence = [join(kept.dir, "init.out"), join(revoked.dir, "init.out"), join(revoked.dir, "browser.log")];
    const details = { kept: { code: first.code, browser: openedForKept ?? null }, revoked: { code: second.code, browser: opened?.trim(), token: config.token } };
    const problems = [];
    if (first.code !== 0 || !first.stdout.includes("Using the key already in")) problems.push("a working key was not kept");
    if (openedForKept) problems.push("the browser opened for a working key");
    if (!opened?.includes("/settings/api_keys?connect=E2E-CODE")) problems.push("the browser did not open for a revoked key");
    if (config.token !== "isy_paired") problems.push(`the paired key was not stored (token ${config.token})`);
    if (problems.length > 0) return fail(problems.join("; "), evidence, details);
    return pass("working key: kept, no browser; revoked key: browser opened on the keys screen, paired key stored", evidence, details);
  } finally {
    stub.stop();
  }
}

async function a12() {
  const run = await prepareRun("a12", { api: API });
  const first = await claudeP(
    run,
    "Think carefully, then write primes.js exporting a function nthPrime(n) that returns the n-th prime (nthPrime(1) is 2) " +
      "and throws a RangeError for anything that is not a positive integer. Work out the edge cases before writing. Use the Write tool.",
    { model: "opus", tools: "Write,Read", label: "reasoning" },
  );
  const compact = await claudeP(run, "/compact", { model: "opus", extra: ["--resume", first.sessionId], label: "compact" });
  // Something the first answer cannot have done already: a JSDoc it may well have written unasked.
  const after = await claudeP(run, "Add an exported function isPrime(n) to primes.js, next to nthPrime, using the Edit tool. Then stop.", {
    model: "opus",
    tools: "Edit,Read",
    extra: ["--resume", first.sessionId],
    label: "after-compact",
  });
  const evidence = [first.out, compact.out, after.out];
  const dir = dirname(transcriptPath(run, first.sessionId));
  let file;
  let records;
  let boundary = -1;
  for (const name of (await readdir(dir)).filter((entry) => entry.endsWith(".jsonl"))) {
    const candidate = await readJsonl(join(dir, name));
    const at = candidate.findIndex((record) => record.type === "system" && record.subtype === "compact_boundary");
    if (at >= 0) [file, records, boundary] = [join(dir, name), candidate, at];
  }
  if (!file) return inconclusive("no compact_boundary was recorded", evidence);
  evidence.push(file);
  const edit = toolUses(records).find((use) => use.index > boundary && EDIT_TOOLS.has(use.name));
  if (!edit) return inconclusive("no edit after the compaction", evidence);

  const analyzed = (await analyze(run, file)).sessions[0];
  const parsed = await claudeAgent.parsedSession(file);
  const status = JSON.parse((await isy(run, ["status", "--json"])).stdout);
  const unknown = status.agents.find((agent) => agent.id === "claude")?.latest?.unknownTypes ?? {};
  const details = {
    model: records.find((record) => record.message?.model?.startsWith("claude-opus"))?.message.model,
    hiddenThinkingBlocks: analyzed.hiddenThinkingBlocks,
    thinkingBlocks: analyzed.thinkingBlocks,
    editAfterCompactOnMainPath: parsed.mainPath.has(edit.record.uuid),
    unknownTypes: unknown,
    sessionFiles: (await readdir(dir)).filter((entry) => entry.endsWith(".jsonl")).length,
  };
  const problems = [];
  if (!(analyzed.hiddenThinkingBlocks > 0)) problems.push("hiddenThinkingBlocks 0");
  if (!details.editAfterCompactOnMainPath) problems.push("the edit after compact_boundary is off the main path");
  if (Object.keys(unknown).length > 0) problems.push(`isy status: unknown types ${Object.keys(unknown).join(", ")}`);
  if (problems.length > 0) return fail(problems.join("; "), evidence, details);
  return pass(
    `${details.model}: hiddenThinkingBlocks ${analyzed.hiddenThinkingBlocks}; the edit after compact_boundary is on the main path; isy status names no unknown type`,
    evidence,
    details,
  );
}

async function a13() {
  const scaffold = join(WORK, "scaffold-a13");
  await mkdir(scaffold, { recursive: true });
  await writeFile(join(scaffold, "package.json"), `${JSON.stringify({ name: "e2e", version: "1.0.0", private: true, dependencies: {} }, null, 2)}\n`);
  const run = await prepareRun("a13", { api: API, scaffold });
  const agent = await claudeP(
    run,
    "Do these steps in order.\n" +
      "1. Call the Agent tool with run_in_background: true. The background subagent must run the shell command `sleep 3` " +
      "five times, as five separate Bash calls, and then create notes.txt containing the word notes with its Write tool.\n" +
      '2. Without waiting for it, use the Edit tool to add "left-pad": "^1.3.0" to the dependencies in package.json, then ' +
      'run `git add package.json && git commit -m "deps: add left-pad"`.\n' +
      '3. Wait until the background subagent has finished, then run `git add notes.txt && git commit -m "docs: notes"`.\n' +
      "Then stop.",
    { tools: "Agent,Edit,Write,Read,Bash(sleep:*),Bash(git add:*),Bash(git commit:*)" },
  );
  const evidence = [agent.out, join(run.dir, "shim.log"), join(run.isy, "sessions.json")];
  const commits = (await shimLog(run)).filter((entry) => entry.args === "commit --hook" && entry.exit !== undefined);
  const rows = (out) => (out ?? "").split("|").filter((line) => line.startsWith("  ")).map((line) => line.trim());
  const details = { commits: commits.map((entry) => entry.out) };
  const call = toolUses(await readJsonl(transcriptPath(run, agent.sessionId))).find((use) => use.name === "Agent");
  if (!call?.input.run_in_background) return inconclusive("no background subagent", evidence, details);
  if (commits.length < 2) return inconclusive(`${commits.length} commit(s), not two`, evidence, details);
  if (!/external_dependency/.test(commits[0].out ?? "")) return inconclusive("the first commit printed no stage 0 note", evidence, details);
  const repeated = rows(commits[1].out).filter((row) => rows(commits[0].out).includes(row));
  // Was the fix needed? The note's record index as the session stood at the first commit, and at the end:
  // an index that moved is a key isy 1.0 would not have recognised.
  const path = transcriptPath(run, agent.sessionId);
  const index = (candidates) => candidates.find((candidate) => candidate.category === "external_dependency")?.recordIndex;
  details.recordIndex = {
    atFirstCommit: index(await candidatesAsOf(run, path, commits[0].at)),
    atEnd: index(runStage0(await claudeAgent.parsedSession(path)).candidates),
  };
  if (repeated.length > 0) return fail(`the second commit printed again: ${repeated.join(" / ")}`, evidence, details);
  const moved = details.recordIndex.atFirstCommit !== details.recordIndex.atEnd;
  return pass(
    `first commit: ${rows(commits[0].out).length} note(s); second: ${rows(commits[1].out).length}, none repeated; ` +
      (moved ? `the note's record index moved ${details.recordIndex.atFirstCommit} → ${details.recordIndex.atEnd}, so a 1.0 key would have printed it again` : "the note's record index did not move, so 1.0 would have passed too"),
    evidence,
    details,
  );
}

/**
 * Stage 0 candidates of the session as it stood at `until`: a copy of its files
 * with every record written later dropped. ponytail: records that carry no
 * timestamp are kept whenever they were written; they are a handful per session.
 */
async function candidatesAsOf(run, path, until) {
  const copy = join(run.dir, "as-of");
  await rm(copy, { recursive: true, force: true });
  const trim = async (from, to) => {
    const kept = (await readFile(from, "utf8")).split("\n").filter((line) => {
      try {
        const record = JSON.parse(line);
        return !record.timestamp || Date.parse(record.timestamp) <= until;
      } catch {
        return false;
      }
    });
    await mkdir(dirname(to), { recursive: true });
    await writeFile(to, `${kept.join("\n")}\n`);
  };
  const id = basename(path, ".jsonl");
  await trim(path, join(copy, `${id}.jsonl`));
  const subagents = join(dirname(path), id, "subagents");
  for (const name of await readdir(subagents).catch(() => [])) {
    if (name.endsWith(".jsonl")) await trim(join(subagents, name), join(copy, id, "subagents", name));
    else await cp(join(subagents, name), join(copy, id, "subagents", name));
  }
  return runStage0(await claudeAgent.parsedSession(join(copy, `${id}.jsonl`))).candidates;
}

async function a14() {
  const run = await prepareRun("a14", { api: API });
  const first = claudeP(
    run,
    "Call the Agent tool with run_in_background: true. The background subagent must start with n = 1 and then, twelve " +
      "times in a row, run the Bash command `sleep 3; echo $((n + 1))` with n replaced by the number the previous command " +
      "printed — one call at a time, each waiting for the previous output, never several at once — and finally create " +
      "s1.txt containing the final n with its Write tool. Do not do anything else yourself; wait until it has finished, then stop.",
    { tools: "Agent,Write,Bash(sleep:*),Bash(echo:*)", label: "s1" },
  );
  // S1 is in the background's hands once its subagent is writing; give its own file time to go quiet.
  const subagents = join(run.config, "projects", basename(dirname(transcriptPath(run, "x"))));
  await waitFor(async () => (await readdir(subagents, { recursive: true }).catch(() => [])).some((name) => /agent-.*\.jsonl$/.test(name)), 120_000);
  await sleep(8000);
  const second = await claudeP(
    run,
    "Create s2.txt containing the single word s2 with the Write tool. Then run exactly this command: " +
      "`sleep 8 && git add s2.txt && git commit -m s2`. Then stop.",
    { tools: "Write,Bash(sleep:*),Bash(git add:*),Bash(git commit:*)", label: "s2" },
  );
  const s1 = await first;
  const evidence = [s1.out, second.out, join(run.isy, "sessions.json"), join(run.dir, "shim.log")];
  const sha = (await exec("git", ["log", "--format=%H", "-1", "--", "s2.txt"], { cwd: run.repo, env: envFor(run) })).stdout.trim();
  if (!sha) return inconclusive("S2 made no commit", evidence);
  const hook = (await shimLog(run)).find((entry) => entry.args === "commit --hook");
  if (!hook) return inconclusive("the post-commit hook did not run", evidence);
  const state = JSON.parse(await readFile(join(run.isy, "sessions.json"), "utf8"));
  const owners = Object.entries(state)
    .filter(([, entry]) => entry.commits?.some((mark) => mark.sha === sha))
    .map(([path]) => basename(path, ".jsonl"));

  // Was it a real test? At the commit, S1's subagent had written after S2's own last record, and S1's own file had not.
  const time = (record) => Date.parse(record.timestamp);
  const at = hook.at;
  const s2Last = Math.max(...(await readJsonl(transcriptPath(run, second.sessionId))).map(time).filter((t) => t <= at));
  const s1Own = Math.max(...(await readJsonl(transcriptPath(run, s1.sessionId))).map(time).filter((t) => t <= at));
  const subFiles = (await readdir(join(subagents, s1.sessionId, "subagents")).catch(() => [])).filter((name) => name.endsWith(".jsonl"));
  let s1SubLast = -Infinity;
  for (const name of subFiles) {
    for (const record of await readJsonl(join(subagents, s1.sessionId, "subagents", name))) {
      if (time(record) <= at) s1SubLast = Math.max(s1SubLast, time(record));
    }
  }
  const details = { sha, owners, s1: s1.sessionId, s2: second.sessionId, s2LastBeforeCommit: new Date(s2Last).toISOString(), s1OwnLast: new Date(s1Own).toISOString(), s1SubagentLast: Number.isFinite(s1SubLast) ? new Date(s1SubLast).toISOString() : null };
  // Only a real test when S1's subagent wrote after S2's last record and S1's own file did not.
  if (s1Own > s2Last) return inconclusive("S1's own transcript was written after S2's last record, so S1 was the more recent session by any measure", evidence, details);
  if (!(s1SubLast > s2Last)) return inconclusive("S1's subagent had not written since S2's last record, so the commit was S2's either way", evidence, details);
  if (owners.includes(s1.sessionId)) return fail("the commit went to S1, whose background subagent wrote last", evidence, details);
  if (!owners.includes(second.sessionId)) return fail(`the commit went to ${owners.join(", ") || "no session"}`, evidence, details);
  return pass("the commit went to S2 although S1's background subagent had written more recently", evidence, details);
}

async function a15() {
  const run = await prepareRun("a15", { api: API });
  const agent = await claudeP(
    run,
    "Call the Agent tool with run_in_background: true and have that background subagent create the file b.txt containing " +
      "the single word b with its Write tool, then read it back with its Read tool. Do not create or edit any file yourself. " +
      "Wait until the background subagent reports that it has finished, then stop.",
    { tools: "Agent,Write,Read" },
  );
  const evidence = [agent.out];
  const first = await waitUpload(API, agent.sessionId);
  if (!first) return fail("the session was never uploaded", evidence);
  const sub = (await readdir(join(dirname(transcriptPath(run, agent.sessionId)), agent.sessionId, "subagents")).catch(() => [])).find((name) => name.endsWith(".jsonl"));
  if (!sub) return inconclusive("no subagent file", evidence);
  await sleep(3000);

  const sweep = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const out = (await isy(run, ["sweep", "--json"])).stdout;
      try {
        return JSON.parse(out);
      } catch {
        await sleep(2000); // "a sweep is already running"
      }
    }
    throw new Error("isy sweep never got its lock");
  };
  const unchanged = await sweep();
  // What a background subagent does after its session was uploaded: its own file grows.
  const path = join(dirname(transcriptPath(run, agent.sessionId)), agent.sessionId, "subagents", sub);
  const records = await readJsonl(path);
  const last = records.findLast((record) => record.uuid);
  const grownAt = Date.now();
  await appendFile(path, `${JSON.stringify({ ...last, uuid: crypto.randomUUID(), parentUuid: last.uuid, timestamp: new Date().toISOString() })}\n`);
  const grown = await sweep();
  const second = await waitUpload(API, agent.sessionId, { after: grownAt, timeoutMs: 30_000 });
  const again = await sweep();
  evidence.push(path, join(run.isy, "sessions.json"));
  const details = {
    unchanged: { sent: unchanged.sent, scanned: unchanged.scanned, skipped: unchanged.skipped },
    grown: { sent: grown.sent, fresh: grown.fresh },
    again: { sent: again.sent },
    sidechainRecords: [first.sidechainRecords, second?.sidechainRecords],
  };
  const problems = [];
  if (unchanged.sent !== 0) problems.push(`a sweep with nothing grown sent ${unchanged.sent}`);
  if (grown.sent !== 1 || !second) problems.push(`the grown subagent file was not sent (sent ${grown.sent})`);
  else if (second.sidechainRecords !== first.sidechainRecords + 1) problems.push(`sidechainRecords ${first.sidechainRecords} then ${second.sidechainRecords}`);
  if (again.sent !== 0) problems.push(`a sweep right after sent ${again.sent} again`);
  if (problems.length > 0) return fail(problems.join("; "), evidence, details);
  return pass(`unchanged: sent 0 of ${unchanged.scanned}; subagent file grown: sent 1 (sidechainRecords ${first.sidechainRecords} → ${second.sidechainRecords}); then 0 again`, evidence, details);
}

const SCENARIOS = [
  { id: "A0", section: "—", title: "hooks fire under -p; a short session reaches the mock", run: a0 },
  { id: "A1", section: "1.1", title: "only a foreground subagent edits", run: a1 },
  { id: "A2", section: "1.1", title: "only a background subagent edits; its records spliced by time", run: a2 },
  { id: "A3", section: "1.1, 1.7", title: "analyze <dir> in six spellings counts no subagent twice", run: a3 },
  { id: "A4", section: "1.2", title: "Read and TaskCreate only: no file edits", run: a4 },
  { id: "A5", section: "1.2", title: "MCP write_file is an edit, read_file is not", run: a5 },
  { id: "A6", section: "1.3", title: "end of session under -p and /exit: uploaded, nothing waits, line parked and shown", run: a6 },
  { id: "A7", section: "1.3", title: "/clear and /resume return at once", run: a7 },
  { id: "A8", section: "1.3", title: "two sessions in one folder: the one that ended is uploaded", run: a8 },
  { id: "A9", section: "1.4", title: "an old SessionEnd hook is rewritten in place", run: a9 },
  { id: "A10", section: "1.4", title: "a removed hook stays removed and isy check names it", run: a10 },
  { id: "A11", section: "1.4", title: "init keeps a working key, pairs again for a revoked one", run: a11 },
  { id: "A12", section: "1.5", title: "Opus: hidden thinking, calls after /compact, no unknown record types", run: a12 },
  { id: "A13", section: "1.6", title: "a second commit does not repeat the first one's notes", run: a13 },
  { id: "A14", section: "1.6", title: "a commit goes to the session that made it", run: a14 },
  { id: "A15", section: "AGENTS §4", title: "isy sweep sends only what grew, subagents included", run: a15 },
];

const PHASES = [
  ["A0", "A1", "A2", "A3", "A4", "A5", "A9", "A10", "A11", "A12", "A13", "A15"],
  ["A6", "A7"],
  ["A8"],
  ["A14"],
];

// ---------------------------------------------------------------- main

async function main() {
  const wanted = new Set(process.argv.slice(2).map((id) => id.toUpperCase()));
  const selected = SCENARIOS.filter((scenario) => wanted.size === 0 || wanted.has(scenario.id));
  await mkdir(WORK, { recursive: true });
  await writeShims();
  // Started inside the try: a slow mock that cannot bind its port must not leave the fast one running.
  const mocks = [];
  const results = [];
  let abort;
  const runOne = async (scenario) => {
    if (abort) return;
    const started = Date.now();
    let result;
    try {
      result = await scenario.run();
    } catch (error) {
      if (error instanceof CredentialsReplaced) abort = error;
      result = inconclusive(`the harness failed: ${error.message}`, [], { stack: error.stack });
    }
    const entry = { id: scenario.id, section: scenario.section, title: scenario.title, ...result, seconds: Math.round((Date.now() - started) / 1000) };
    results.push(entry);
    console.log(`${entry.id.padEnd(4)} ${entry.verdict.padEnd(12)} ${entry.reason}`);
  };
  try {
    mocks.push(await startMock({ port: PORT, keep: UPLOADS, log: join(WORK, "mock-api.log") }));
    mocks.push(await startMock({ port: PORT + 1, keep: join(WORK, "uploads-slow"), delayMs: 5000, log: join(WORK, "mock-api-slow.log") }));
    // A8 and A14 need their two sessions to overlap, so they run alone, after the rest.
    for (const phase of PHASES) await Promise.all(selected.filter((scenario) => phase.includes(scenario.id)).map(runOne));
  } finally {
    for (const mock of mocks) mock.stop();
    for (const entry of await readdir(join(WORK, "run")).catch(() => [])) {
      await keepTranscripts({ dir: join(WORK, "run", entry), config: join(WORK, "run", entry, "home", ".claude") });
    }
  }

  results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const report = { at: new Date().toISOString(), work: WORK, claude: (await exec(CLAUDE_BIN, ["--version"])).stdout.trim(), results };
  await writeFile(join(WORK, "e2e-report.json"), JSON.stringify(report, null, 2));
  console.log("\n| # | § | verdict | reason |\n|---|---|---|---|");
  for (const entry of results) console.log(`| ${entry.id} | ${entry.section} | ${entry.verdict} | ${entry.reason.replaceAll("|", "/")} |`);
  console.log(`\nDetails and evidence: ${join(WORK, "e2e-report.json")}`);
  if (abort) {
    console.error(`\nSTOPPED: ${abort.message}`);
    process.exitCode = 2;
  } else if (results.some((entry) => entry.verdict === "fail")) {
    process.exitCode = 1;
  }
}

await main();

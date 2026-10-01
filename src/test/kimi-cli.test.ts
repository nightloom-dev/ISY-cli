import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { kimiAgent } from "../agents/kimi.js";
import { kimiCliWireToClaudeRecords } from "../agents/kimi-cli-wire.js";
import { toClaudeRecords } from "../agents/kimi-records.js";
import { claudeTool, wholeFileRead } from "../agents/kimi-tools.js";
import { analyzeFiles, expandInputs } from "../commands/analyze.js";
import { parseLines } from "../parser.js";
import { runStage0 } from "../stage0.js";

/**
 * A session Kimi CLI 1.52 recorded against a scripted API
 * (`fixtures/record/README.md`): it reads `src/app.js`, runs a failing
 * `node --test`, hands the fix to a `coder` subagent (which reads and edits the
 * file), writes and appends to `NOTES.md`, runs the tests green and ticks its
 * todo list. The home keeps `kimi.json` and the log lines that open the run.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "kimi-cli-1.52", ".kimi");
const SESSION = "63ade4e9-4c75-4070-a8c6-f28b7de486b8";
const WORKSPACE = "306f8686f92cc60ecf48084865d7d36e";

const saved = process.env.KIMI_HOME;
let home: string;

/** The fixture home, with the installed package its log names put where the log says. */
async function fixtureHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "isy-kimi-cli-"));
  const kimi = join(root, ".kimi");
  await cp(FIXTURE, kimi, { recursive: true });

  const site = join(root, "site-packages");
  await mkdir(join(site, "kimi_cli", "agents", "default"), { recursive: true });
  await mkdir(join(site, "kimi_cli-1.52.0.dist-info"), { recursive: true });
  const log = join(kimi, "logs", "kimi.log");
  await writeFile(log, (await readFile(log, "utf8")).replaceAll("@SITE_PACKAGES@", site));
  return kimi;
}

before(async () => {
  home = await fixtureHome();
  process.env.KIMI_HOME = home;
});

after(() => {
  if (saved === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = saved;
});

const wire = (): string => join(home, "sessions", WORKSPACE, SESSION, "wire.jsonl");

test("Kimi's tools come out under the names the detectors read", () => {
  assert.deepEqual(claudeTool("Shell", { command: "npm test", timeout: 60 }), {
    name: "Bash",
    input: { command: "npm test", timeout: 60 },
  });
  assert.deepEqual(claudeTool("ReadFile", { path: "src/a.ts", line_offset: 10, n_lines: 20 }), {
    name: "Read",
    input: { file_path: "src/a.ts", offset: 10, limit: 20 },
  });
  assert.deepEqual(claudeTool("WriteFile", { path: "a.md", content: "x" }), {
    name: "Write",
    input: { file_path: "a.md", content: "x" },
  });
  // An append shows none of the file: an edit that replaces nothing, not a Write.
  assert.deepEqual(claudeTool("WriteFile", { path: "a.md", content: "x", mode: "append" }), {
    name: "Edit",
    input: { file_path: "a.md", new_string: "x" },
  });
  assert.deepEqual(claudeTool("StrReplaceFile", { path: "a.ts", edit: { old: "a", new: "b", replace_all: true } }), {
    name: "Edit",
    input: { file_path: "a.ts", old_string: "a", new_string: "b", replace_all: true },
  });
  assert.deepEqual(
    claudeTool("StrReplaceFile", { path: "a.ts", edit: [{ old: "a", new: "b" }, { old: "c", new: "d" }] }),
    {
      name: "MultiEdit",
      input: { file_path: "a.ts", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
    },
  );
  assert.deepEqual(claudeTool("Glob", { pattern: "*.ts", directory: "src" }), {
    name: "Glob",
    input: { pattern: "*.ts", path: "src" },
  });
  assert.equal(claudeTool("SearchWeb", { query: "x" }).name, "WebSearch");
  assert.equal(claudeTool("FetchURL", { url: "https://a" }).name, "WebFetch");
  assert.equal(claudeTool("SetTodoList", { todos: [] }).name, "TodoWrite");
  assert.equal(claudeTool("Task", { prompt: "x" }).name, "Agent");
  // Grep takes `path` in both CLIs; Claude's own names only lose Kimi's argument.
  assert.deepEqual(claudeTool("Grep", { pattern: "x", path: "src" }), { name: "Grep", input: { pattern: "x", path: "src" } });
  assert.deepEqual(claudeTool("Edit", { path: "a.ts", old_string: "a" }), {
    name: "Edit",
    input: { old_string: "a", file_path: "a.ts" },
  });
});

test("a read is the file only when it returned all of it", () => {
  const whole = "     1\texport function add(a, b) {\n     2\t  return a - b;\n     3\t}\n";
  const said = "3 lines read from file starting from line 1. Total lines in file: 3. End of file reached.";
  assert.equal(wholeFileRead(whole, said), "export function add(a, b) {\n  return a - b;\n}\n");

  // Part of the file, a cut line, or text that is not Kimi's numbering: not the file.
  assert.equal(wholeFileRead(whole, "3 lines read from file starting from line 1. Total lines in file: 9."), undefined);
  assert.equal(wholeFileRead(whole, "3 lines read from file starting from line 4. Total lines in file: 6."), undefined);
  assert.equal(wholeFileRead(whole, `${said} Lines [2] were truncated.`), undefined);
  assert.equal(wholeFileRead("export function add() {}\n", "1 lines read from file starting from line 1. Total lines in file: 1."), undefined);
});

test("a Kimi CLI 1.52 session is found by the directory kimi.json names", async () => {
  const [session, ...rest] = await kimiAgent.allSessions();
  assert.equal(rest.length, 0, "the subagent's own files are not a second session");
  assert.equal(session?.sessionId, SESSION);
  assert.equal(session?.path, wire());
  assert.equal(session?.cwd, "/home/dev/kshop");

  assert.equal((await kimiAgent.sessionsIn("/home/dev/kshop")).length, 1);
  assert.equal((await kimiAgent.sessionsIn("/home/dev/elsewhere")).length, 0);
  assert.equal(await kimiAgent.cwdOf(wire()), "/home/dev/kshop");
  assert.equal(await kimiAgent.transcriptFor({ session_id: SESSION, cwd: "/home/dev/kshop" }, "/"), wire());
});

test("a Kimi CLI 1.52 session reads whole from its event log", async () => {
  const session = await kimiAgent.parsedSession(wire());

  assert.equal(session.sessionId, SESSION);
  assert.equal(session.meta.cwd, "/home/dev/kshop");
  // Neither is in the session; the run's own log line and the installed package say them.
  assert.equal(session.meta.claudeVersion, "1.52.0");
  assert.equal(session.records.find((record) => record.type === "assistant")?.message?.model, "kimi-k2-mock");
  // Epoch seconds, not milliseconds.
  assert.equal(session.meta.startedAt, "2026-09-30T09:30:17.416Z");

  assert.deepEqual(
    session.toolUses.map((use) => `${use.isSidechain ? "sub:" : ""}${use.name}${use.result?.isError ? "!" : ""}`),
    ["Read", "Grep", "Bash!", "Agent", "sub:Read", "sub:Edit", "Write", "Edit", "Bash", "TodoWrite"],
  );
  const subagent = session.records.filter((record) => record.isSidechain === true);
  assert.ok(subagent.every((record) => record.parentToolUseID === "call_KMAIN_2_0" && record.agentId === "a8966474d"));

  assert.deepEqual([...session.fileEdits.keys()].sort(), ["NOTES.md", "src/app.js"]);
  assert.equal(session.meta.thinkingBlocks, 3);
  // Kimi numbers a read's lines; a whole read is the file again, for the revert tracker.
  assert.equal(session.toolUses[0]?.result?.fileContent, "export function add(a, b) {\n  return a - b;\n}\n");

  const result = runStage0(session);
  assert.equal(result.eligible, true);
  assert.equal(result.knownGapReachable, true);
  assert.deepEqual(result.candidates, [], "the fix was tested after the subagent made it");
});

test("the same session's context.jsonl keeps its reasoning, errors and tool names", async () => {
  const context = await readFile(join(home, "sessions", WORKSPACE, SESSION, "context.jsonl"), "utf8");
  const session = parseLines(toClaudeRecords(context.split("\n"), { sessionId: SESSION, cwd: "/home/dev/kshop" }));

  // Kimi writes reasoning as `think` parts: every one of them is here.
  assert.equal(session.meta.thinkingBlocks, 2);
  assert.deepEqual(
    session.toolUses.map((use) => `${use.name}${use.result?.isError ? "!" : ""}`),
    ["Read", "Grep", "Bash!", "Agent", "Write", "Edit", "Bash", "TodoWrite"],
  );
  assert.equal(session.toolUses[0]?.result?.fileContent, "export function add(a, b) {\n  return a - b;\n}\n");
});

test("a session whose home lost kimi.json still knows where it ran", async () => {
  const bare = await fixtureHome();
  await rm(join(bare, "kimi.json"));
  process.env.KIMI_HOME = bare;
  try {
    const [session] = await kimiAgent.allSessions();
    // Kimi CLI states the working directory to the model in its system prompt.
    assert.equal(session?.cwd, "/home/dev/kshop");
  } finally {
    process.env.KIMI_HOME = home;
  }
});

test("isy analyze reads a Kimi CLI session once, from its event log", async () => {
  const files = await expandInputs([home]);
  assert.deepEqual(files, [wire()]);

  const [analyzed] = await analyzeFiles(files, undefined);
  assert.equal(analyzed?.eligible, true);
  assert.equal(analyzed?.editToolUses, 3);
});

/** An envelope of Kimi CLI's log, `seconds` after 09:00 on the fixture's day. */
const envelope = (seconds: number, type: string, payload: object): string =>
  JSON.stringify({ timestamp: 1790758800 + seconds, message: { type, payload } });
const header = JSON.stringify({ type: "metadata", protocol_version: "1.10" });
const toolCall = (seconds: number, id: string, name: string, args: object): string =>
  envelope(seconds, "ToolCall", { type: "function", id, function: { name, arguments: JSON.stringify(args) } });
const toolResult = (seconds: number, id: string, output: string): string =>
  envelope(seconds, "ToolResult", { tool_call_id: id, return_value: { is_error: false, output, message: "" } });
const launched = (agentId: string) => `task_id: t-1\nkind: agent\nstatus: running\nagent_id: ${agentId}`;

test("a background subagent is read from its own log, when it did the work", () => {
  const records = kimiCliWireToClaudeRecords(
    [
      header,
      envelope(0, "TurnBegin", { user_input: "fix add() while I look at the rest" }),
      toolCall(1, "c1", "Agent", { description: "fix", prompt: "fix src/app.js", run_in_background: true }),
      toolResult(2, "c1", launched("bg1")),
      toolCall(10, "c2", "Shell", { command: "npm test" }),
      toolResult(11, "c2", "ok"),
      toolCall(20, "c3", "Agent", { resume: "bg1", prompt: "and the null case", run_in_background: true }),
      toolResult(21, "c3", launched("bg1")),
      envelope(40, "TurnEnd", {}),
    ],
    {
      sessionId: "s1",
      subagents: new Map([
        [
          "bg1",
          [
            header,
            envelope(3, "TurnBegin", { user_input: "fix src/app.js" }),
            toolCall(5, "s1", "StrReplaceFile", { path: "src/app.js", edit: { old: "a - b", new: "a + b" } }),
            toolResult(6, "s1", ""),
            envelope(22, "TurnBegin", { user_input: "and the null case" }),
            toolCall(25, "s2", "StrReplaceFile", { path: "src/app.js", edit: { old: "a + b", new: "(a ?? 0) + b" } }),
            toolResult(26, "s2", ""),
          ],
        ],
      ]),
    },
  );
  const session = parseLines(records);

  assert.deepEqual(
    session.toolUses.map((use) => `${use.isSidechain ? "sub:" : ""}${use.name}`),
    ["Agent", "sub:Edit", "Bash", "Agent", "sub:Edit"],
  );
  // Each run answers the call that started it: the launch, then the resume.
  const calls = session.records
    .filter((record) => record.isSidechain === true)
    .map((record) => record.parentToolUseID);
  assert.deepEqual([...new Set(calls)], ["c1", "c3"]);
  assert.equal(session.meta.hasFileEdits, true);
  // The first fix was tested; the second never was.
  const unverified = runStage0(session).candidates.filter((candidate) => candidate.category === "unverified_fix");
  assert.deepEqual(
    unverified.map((candidate) => candidate.toolUseId),
    ["s2"],
  );
});

test("a foreground subagent resumed later answers the call that resumed it", () => {
  const event = (seconds: number, call: string, inner: object) =>
    envelope(seconds, "SubagentEvent", { parent_tool_call_id: call, agent_id: "fg1", subagent_type: "coder", event: inner });
  const session = parseLines(
    kimiCliWireToClaudeRecords(
      [
        header,
        toolCall(1, "c1", "Agent", { prompt: "look" }),
        event(2, "c1", { type: "ContentPart", payload: { type: "text", text: "first run" } }),
        toolResult(3, "c1", "agent_id: fg1\nresumed: false\nstatus: completed"),
        toolCall(10, "c2", "Agent", { resume: "fg1", prompt: "look again" }),
        event(11, "c2", { type: "ContentPart", payload: { type: "text", text: "second run" } }),
        toolResult(12, "c2", "agent_id: fg1\nresumed: true\nstatus: completed"),
      ],
      // Its own log repeats what the session's log carries, and is not read.
      { sessionId: "s1", subagents: new Map([["fg1", [header, envelope(2, "TurnBegin", { user_input: "look" })]]]) },
    ),
  );

  const sidechain = session.records.filter((record) => record.isSidechain === true);
  assert.deepEqual(
    sidechain.map((record) => record.parentToolUseID),
    ["c1", "c2"],
  );
});

test("a time no date can hold leaves the record without one, and the rest readable", () => {
  const session = parseLines(
    kimiCliWireToClaudeRecords(
      [
        header,
        JSON.stringify({ timestamp: 1.79e18, message: { type: "TurnBegin", payload: { user_input: "hi" } } }),
        envelope(1, "ContentPart", { type: "text", text: "hello" }),
      ],
      { sessionId: "s1" },
    ),
  );
  assert.equal(session.records.length, 2);
  assert.equal(session.records[0]?.timestamp, undefined);
  assert.equal(session.meta.startedAt, "2026-09-30T09:00:01.000Z");
});

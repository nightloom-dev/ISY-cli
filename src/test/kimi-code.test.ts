import assert from "node:assert/strict";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { kimiAgent, kimiHomes } from "../agents/kimi.js";
import { claudeTool } from "../agents/kimi-tools.js";
import { wireToClaudeRecords } from "../agents/kimi-wire.js";
import { analyzeFiles, expandInputs } from "../commands/analyze.js";
import { mayWrite, parseLines } from "../parser.js";
import { runStage0 } from "../stage0.js";

/**
 * A session Kimi Code 2.1.1 recorded against a scripted API
 * (`fixtures/record/README.md`), the same work as the Kimi CLI 1.52 fixture:
 * it reads `src/app.js`, runs a failing `node --test`, hands the fix to a
 * `coder` subagent — which writes its own log, `agents/agent-0/wire.jsonl` —
 * writes and appends to `NOTES.md`, runs the tests green and ticks its todo
 * list. A UserPromptSubmit hook printed a line, the way isy's alert drain
 * does. `state.json` names agent homes under `/home/dev/.kimi-code`, which is
 * not where the fixture is: a session folder that moved.
 */
const FIXTURE = join(import.meta.dirname, "fixtures", "kimi-code-2.1.1", ".kimi-code");
const SESSION = "session_48c39281-a12f-4c4b-83b9-2015eb5e7c3a";
const WORKSPACE = "wd_kcshop_a7fc9137ccb7";
const CWD = "/home/dev/kcshop";

const saved = { KIMI_HOME: process.env.KIMI_HOME, PATH: process.env.PATH };
let home: string;

async function fixtureHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "isy-kimi-code-"));
  const kimi = join(root, ".kimi-code");
  await cp(FIXTURE, kimi, { recursive: true });
  return kimi;
}

before(async () => {
  home = await fixtureHome();
  process.env.KIMI_HOME = home;
});

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const sessionDir = (at = home): string => join(at, "sessions", WORKSPACE, SESSION);
const mainLog = (at = home): string => join(sessionDir(at), "agents", "main", "wire.jsonl");

test("Kimi Code's tools come out under the names the detectors read", () => {
  // Claude's names, Kimi's arguments.
  assert.deepEqual(claudeTool("Read", { path: "src/a.ts", line_offset: 10, n_lines: 20 }), {
    name: "Read",
    input: { file_path: "src/a.ts", offset: 10, limit: 20 },
  });
  assert.deepEqual(claudeTool("Write", { path: "a.md", content: "x" }), {
    name: "Write",
    input: { file_path: "a.md", content: "x" },
  });
  assert.deepEqual(claudeTool("Write", { path: "a.md", content: "x", mode: "append" }), {
    name: "Edit",
    input: { file_path: "a.md", new_string: "x" },
  });
  assert.equal(claudeTool("TodoList", { todos: [] }).name, "TodoWrite");
  // Claude Code's own call passes through untouched.
  assert.deepEqual(claudeTool("Read", { file_path: "a.ts", offset: 3 }), { name: "Read", input: { file_path: "a.ts", offset: 3 } });
  // Glob takes `path` here as in Claude Code: kept, not lost to Kimi CLI's `directory`.
  assert.deepEqual(claudeTool("Glob", { pattern: "*.ts", path: "src" }), { name: "Glob", input: { pattern: "*.ts", path: "src" } });

  // `GetGoal` takes nothing, which alone would read as a possible edit.
  assert.equal(mayWrite("GetGoal", {}), false);
  assert.equal(mayWrite("AgentSwarm", { description: "x", items: [] }), false);
});

test("a Kimi Code 2.1.1 session is found by the cwd its state.json records", async () => {
  const [session, ...rest] = await kimiAgent.allSessions();
  assert.equal(rest.length, 0, "the subagent's log is not a second session");
  assert.equal(session?.sessionId, SESSION);
  assert.equal(session?.path, mainLog());
  assert.equal(session?.cwd, CWD);

  assert.equal((await kimiAgent.sessionsIn(CWD)).length, 1);
  assert.equal(await kimiAgent.cwdOf(mainLog()), CWD);
  assert.equal(await kimiAgent.transcriptFor({ session_id: SESSION, cwd: CWD }, "/"), mainLog());
});

test("a Kimi Code session reads whole, its subagent's log spliced in where it started", async () => {
  const session = await kimiAgent.parsedSession(mainLog());

  assert.equal(session.sessionId, SESSION);
  assert.equal(session.meta.cwd, CWD);
  assert.equal(session.records.find((record) => record.type === "assistant")?.message?.model, "kimi-k2-mock");
  // Epoch milliseconds.
  assert.equal(session.meta.startedAt, "2026-09-30T10:02:16.496Z");

  assert.deepEqual(
    session.toolUses.map((use) => `${use.isSidechain ? "sub:" : ""}${use.name}${use.result?.isError ? "!" : ""}`),
    ["Read", "Grep", "Bash!", "Agent", "sub:Read", "sub:Edit", "Write", "Edit", "Bash", "TodoWrite"],
  );
  const subagent = session.records.filter((record) => record.isSidechain === true);
  assert.equal(subagent.length, 7);
  assert.ok(subagent.every((record) => record.parentToolUseID === "call_KCMAIN_2_0" && record.agentId === "agent-0"));

  // The person's prompt and the subagent's are the only turns: the hook's
  // output and the CLI's own reminders are messages too, and not anyone's words.
  const turns = session.records
    .filter((record) => record.type === "user" && Array.isArray(record.message?.content))
    .flatMap((record) => (record.message?.content as { type: string; text?: string }[]).filter((block) => block.type === "text"))
    .map((block) => block.text?.split(":")[0]);
  assert.deepEqual(turns, ["SCENARIO-KCMAIN", "SCENARIO-KCSUB"]);

  assert.deepEqual([...session.fileEdits.keys()].sort(), ["NOTES.md", "src/app.js"]);
  assert.equal(session.meta.thinkingBlocks, 3);
  // Kimi Code leaves the last newline off a read; the file is otherwise whole.
  assert.equal(session.toolUses[0]?.result?.fileContent, "export function add(a, b) {\n  return a - b;\n}");

  const result = runStage0(session);
  assert.equal(result.eligible, true);
  assert.equal(result.knownGapReachable, true);
  assert.deepEqual(result.candidates, [], "the fix was tested after the subagent made it");
});

test("a subagent is read even when nothing links it: unlisted, or never announced", async () => {
  const bare = await fixtureHome();
  const state = JSON.parse(await readFile(join(sessionDir(bare), "state.json"), "utf8")) as { agents: Record<string, unknown> };
  delete state.agents["agent-0"];
  await writeFile(join(sessionDir(bare), "state.json"), JSON.stringify(state));
  const main = (await readFile(mainLog(bare), "utf8")).split("\n").filter((line) => !line.includes('"subagent.spawned"'));
  await writeFile(mainLog(bare), main.join("\n"));

  process.env.KIMI_HOME = bare;
  try {
    const session = await kimiAgent.parsedSession(mainLog(bare));
    const subagent = session.records.filter((record) => record.isSidechain === true);
    assert.equal(subagent.length, 7, "the log is what the agent did, whoever forgot to mention it");
    assert.ok(subagent.every((record) => record.parentToolUseID === undefined));
    // With no point to splice at, it comes after the session.
    assert.equal(session.records.at(-1)?.isSidechain, true);
    assert.deepEqual([...session.fileEdits.keys()].sort(), ["NOTES.md", "src/app.js"]);
  } finally {
    process.env.KIMI_HOME = home;
  }
});

/** Kimi Code's events, `second` seconds after 10:00 on the fixture's day. */
const at = (second: number): number => Date.UTC(2026, 8, 30, 10, 0, second);
const loop = (second: number, agentId: string, event: object): string =>
  JSON.stringify({ type: "context.append_loop_event", agentId, event, time: at(second) });
const called = (second: number, agentId: string, id: string, name: string, args: object): string =>
  loop(second, agentId, { type: "tool.call", toolCallId: id, name, args });
const answered = (second: number, agentId: string, id: string): string =>
  loop(second, agentId, { type: "tool.result", toolCallId: id, result: { output: "ok" } });
const spawn = (second: number, call: string, background = false): string =>
  JSON.stringify({ type: "subagent.spawned", subagentId: "agent-0", parentToolCallId: call, runInBackground: background, time: at(second) });
const metadata = JSON.stringify({ type: "metadata", protocol_version: "1.5" });

test("a background subagent goes in when it worked, and a resumed one answers the call that resumed it", () => {
  const session = parseLines(
    wireToClaudeRecords(
      [
        metadata,
        called(1, "main", "A1", "Agent", { prompt: "fix b.ts", run_in_background: true }),
        spawn(1, "A1", true),
        answered(2, "main", "A1"),
        called(10, "main", "t1", "Bash", { command: "npm test" }),
        answered(11, "main", "t1"),
        called(30, "main", "A2", "Agent", { resume: "agent-0", prompt: "and the null case" }),
        spawn(30, "A2"),
        answered(40, "main", "A2"),
      ],
      {
        sessionId: "session_x",
        subagents: new Map([
          [
            "agent-0",
            [
              metadata,
              called(5, "agent-0", "s1", "Edit", { path: "src/b.ts", old_string: "1", new_string: "2" }),
              answered(6, "agent-0", "s1"),
              // Resumed: the same log goes on.
              called(35, "agent-0", "s2", "Edit", { path: "src/b.ts", old_string: "2", new_string: "3" }),
              answered(36, "agent-0", "s2"),
            ],
          ],
        ]),
      },
    ),
  );

  assert.deepEqual(
    session.toolUses.map((use) => `${use.isSidechain ? "sub:" : ""}${use.name}`),
    ["Agent", "sub:Edit", "Bash", "Agent", "sub:Edit"],
  );
  assert.deepEqual(
    session.records.filter((record) => record.isSidechain === true).map((record) => record.parentToolUseID),
    ["A1", "A1", "A2", "A2"],
  );
  const unverified = runStage0(session).candidates.filter((candidate) => candidate.category === "unverified_fix");
  assert.deepEqual(unverified.map((candidate) => candidate.toolUseId), ["s2"]);
});

test("a record keeps its id as a background subagent's log grows", () => {
  const main = [
    metadata,
    called(1, "main", "A1", "Agent", { prompt: "fix b.ts", run_in_background: true }),
    spawn(1, "A1", true),
    answered(2, "main", "A1"),
    called(10, "main", "t1", "Bash", { command: "npm test" }),
    answered(11, "main", "t1"),
  ];
  const first = [metadata, called(5, "agent-0", "s1", "Edit", { path: "src/b.ts", old_string: "1", new_string: "2" })];
  const idOf = (log: string[], call: string): string | undefined => {
    const session = parseLines(wireToClaudeRecords(main, { sessionId: "session_x", subagents: new Map([["agent-0", log]]) }));
    return session.toolUses.find((use) => use.id === call)?.uuid;
  };

  // The subagent wrote more, all of it before the session's test run: that
  // run's record moved down the output, and kept its id.
  const grown = [...first, answered(6, "agent-0", "s1"), called(7, "agent-0", "s2", "Read", { path: "src/b.ts" })];
  assert.equal(idOf(grown, "t1"), idOf(first, "t1"));
  assert.equal(idOf(grown, "s1"), idOf(first, "s1"));
  assert.notEqual(idOf(first, "s1"), idOf(first, "t1"));
});

test("a time no date can hold leaves the record without one, and the rest readable", () => {
  const session = parseLines(
    wireToClaudeRecords(
      [metadata, JSON.stringify({ ...JSON.parse(called(1, "main", "t1", "Bash", { command: "ls" })), time: 1.79e18 }), answered(2, "main", "t1")],
      { sessionId: "session_x" },
    ),
  );
  assert.equal(session.toolUses.length, 1);
  assert.equal(session.records[0]?.timestamp, undefined);
  assert.equal(session.meta.startedAt, "2026-09-30T10:00:02.000Z");
});

test("the version is the npm package's the kimi on PATH runs from", async () => {
  const root = await mkdtemp(join(tmpdir(), "isy-kimi-code-npm-"));
  const pkg = join(root, "lib", "node_modules", "@moonshot-ai", "kimi-code");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@moonshot-ai/kimi-code", version: "2.1.1" }));
  await writeFile(join(pkg, "dist", "main.mjs"), "");
  // npm links the bin executable; PATH only runs what is.
  await chmod(join(pkg, "dist", "main.mjs"), 0o755);
  await mkdir(join(root, "bin"));
  await symlink(join(pkg, "dist", "main.mjs"), join(root, "bin", "kimi"));

  try {
    process.env.PATH = join(root, "bin");
    assert.equal((await kimiAgent.parsedSession(mainLog())).meta.claudeVersion, "2.1.1");
    // A `kimi` that is not the npm package — the standalone build — says nothing, rather than a guess.
    await rm(join(root, "bin", "kimi"));
    await writeFile(join(root, "bin", "kimi"), "binary");
    await chmod(join(root, "bin", "kimi"), 0o755);
    assert.equal((await kimiAgent.parsedSession(mainLog())).meta.claudeVersion, undefined);
  } finally {
    process.env.PATH = saved.PATH;
  }
});

test("isy analyze reads a Kimi Code session once, its subagent inside it", async () => {
  const files = await expandInputs([home]);
  assert.deepEqual(files, [mainLog()]);

  const [analyzed] = await analyzeFiles(files, undefined);
  assert.equal(analyzed?.eligible, true);
  assert.equal(analyzed?.editToolUses, 3);

  // Asked about alone, a subagent's log is all there is to read.
  const alone = join(sessionDir(), "agents", "agent-0", "wire.jsonl");
  assert.deepEqual(await expandInputs([alone]), [alone]);
  const [subagent] = await analyzeFiles([alone], undefined);
  assert.equal(subagent?.editToolUses, 1);
});

test("hidden reasoning is skipped, empty reasoning is counted as hidden, and parts are text", () => {
  const loop = (event: unknown) => JSON.stringify({ type: "context.append_loop_event", agentId: "main", event, time: 1790762536496 });
  const lines = [
    JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1790762536400 }),
    JSON.stringify({
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text: "rename the flag" }], origin: { kind: "user" } },
    }),
    // A summary shown elsewhere, repeated for the UI.
    loop({ type: "content.part", part: { type: "think", think: "a summary", hidden: true } }),
    // Encrypted reasoning: no text, but the model did reason.
    loop({ type: "content.part", part: { type: "think", think: "", encrypted: "b64..." } }),
    loop({ type: "tool.call", toolCallId: "c1", name: "Bash", args: { command: "ls" } }),
    loop({ type: "tool.result", toolCallId: "c1", result: { output: [{ type: "text", text: "a.ts" }, { type: "text", text: "b.ts" }] } }),
  ];

  const session = parseLines(wireToClaudeRecords(lines, { sessionId: "s", cwd: "/w" }));
  assert.equal(session.meta.thinkingBlocks, 0);
  assert.equal(session.meta.hiddenThinkingBlocks, 1);
  assert.equal(session.toolUses[0]?.result?.text, "a.ts\nb.ts");
});

test("a message is a turn by Kimi Code's own rule, and a hook's output is not one", () => {
  const said = (text: string, origin?: Record<string, unknown>) =>
    JSON.stringify({
      type: "context.append_message",
      message: { role: "user", content: [{ type: "text", text }], ...(origin ? { origin } : {}) },
    });
  const lines = [
    JSON.stringify({ type: "metadata", protocol_version: "1.5" }),
    said("typed", { kind: "user" }),
    said("from a build before origins"),
    said("!ls", { kind: "shell_command", phase: "input" }),
    said("/review", { kind: "skill_activation", trigger: "user-slash", activationId: "a", skillName: "review" }),
    said("a skill the model loaded", { kind: "skill_activation", trigger: "model-tool", activationId: "b", skillName: "x" }),
    said("carry on toward the goal", { kind: "system_trigger", name: "goal_continuation" }),
    said("a stop hook's objection", { kind: "system_trigger", name: "stop_hook" }),
    said("a task finished", { kind: "task", taskId: "t", status: "completed", notificationId: "n" }),
    said("<system-reminder>", { kind: "injection", variant: "date_change" }),
    said("isy: 1 note", { kind: "hook_result", event: "UserPromptSubmit" }),
    said("the story so far", { kind: "compaction_summary" }),
    said("once more", { kind: "retry" }),
  ];

  const turns = parseLines(wireToClaudeRecords(lines, { sessionId: "s" })).records.map(
    (record) => (record.message?.content as { text?: string }[] | undefined)?.[0]?.text,
  );
  assert.deepEqual(turns, [
    "typed",
    "from a build before origins",
    "!ls",
    "/review",
    "carry on toward the goal",
    "a task finished",
  ]);
});

test("KIMI_CODE_HOME moves Kimi Code's home, and the hooks there are Kimi Code's", async () => {
  const root = await mkdtemp(join(tmpdir(), "isy-kimi-code-home-"));
  const moved = join(root, "kc");
  await mkdir(moved);
  const env = { KIMI_HOME: process.env.KIMI_HOME, KIMI_CODE_HOME: process.env.KIMI_CODE_HOME, HOME: process.env.HOME };

  try {
    delete process.env.KIMI_HOME;
    process.env.HOME = root;
    process.env.KIMI_CODE_HOME = moved;
    assert.deepEqual(kimiHomes(), [moved]);
    // Kimi Code shows UserPromptSubmit's stdout, so the parked-alert drain is installed there.
    assert.deepEqual(
      kimiAgent.hooks().map((hook) => hook.event),
      ["SessionStart", "SessionEnd", "UserPromptSubmit"],
    );
  } finally {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

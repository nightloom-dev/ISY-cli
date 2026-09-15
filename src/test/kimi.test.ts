import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { detectAgent } from "../agents/index.js";
import { collectStatus, formatStatus } from "../commands/status.js";
import { kimiAgent, kimiConfigPath, kimiSessionsRoot } from "../agents/kimi.js";
import { isKimiTranscript, toClaudeRecords } from "../agents/kimi-records.js";
import { detectAbandonedApproach } from "../detectors.js";
import { onAbandonedBranch, parseLines } from "../parser.js";
import { pendingAlertPath, projectSlug } from "../paths.js";

const saved = {
  kimi: process.env.KIMI_HOME,
  codex: process.env.CODEX_HOME,
  isy: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
};
let home: string;
let isy: string;
let claude: string;
let codex: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-kimi-"));
  isy = await mkdtemp(join(tmpdir(), "isy-kimi-home-"));
  claude = await mkdtemp(join(tmpdir(), "isy-kimi-claude-"));
  // This file is about Claude Code and Kimi, so pin Codex somewhere that does
  // not exist: whether this machine has it installed must not change it.
  codex = join(home, "no-codex-here");
  process.env.KIMI_HOME = home;
  process.env.ISY_HOME = isy;
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.CODEX_HOME = codex;
});

after(() => {
  if (saved.kimi === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = saved.kimi;
  if (saved.isy === undefined) delete process.env.ISY_HOME;
  else process.env.ISY_HOME = saved.isy;
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  if (saved.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codex;
});

const json = (value: unknown): string => JSON.stringify(value);

function assistant(text: string, calls: { id: string; name: string; args: unknown }[] = []) {
  return {
    role: "assistant",
    content: text,
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  };
}

const user = (text: string) => ({ role: "user", content: text });
const result = (id: string, text: string) => ({ role: "tool", tool_call_id: id, content: text });
const SYSTEM = { role: "_system_prompt", content: "you are kimi" };

function convert(lines: unknown[], wire?: unknown[]): ReturnType<typeof parseLines> {
  return parseLines(
    toClaudeRecords(lines.map(json), {
      sessionId: "s1",
      cwd: "/repo",
      wire: wire?.map(json),
    }),
  );
}

test("recognises a Kimi transcript by its frozen system prompt", () => {
  assert.equal(isKimiTranscript(json(SYSTEM)), true);
  assert.equal(isKimiTranscript(json({ type: "user", uuid: "a" })), false);
  assert.equal(isKimiTranscript("not json at all"), false);
  assert.equal(isKimiTranscript(""), false);
});

test("turns Kimi turns into records the shared parser understands", () => {
  const session = convert([
    SYSTEM,
    user("add a flag"),
    assistant("editing", [
      { id: "t1", name: "Edit", args: { path: "src/a.ts", old_string: "a", new_string: "b" } },
    ]),
    result("t1", "ok"),
  ]);

  assert.equal(session.sessionId, "s1");
  assert.equal(session.meta.cwd, "/repo");
  assert.equal(session.meta.assistantRecords, 1);
  assert.equal(session.meta.editToolUses, 1);

  // The frozen system prompt is bookkeeping, not a turn.
  assert.equal(session.records.length, 3);

  const edits = session.fileEdits.get("src/a.ts");
  assert.equal(edits?.length, 1);
  assert.equal(edits?.[0]?.oldString, "a");
  assert.equal(edits?.[0]?.newString, "b");
  assert.equal(session.toolUses[0]?.result?.text, "ok");
});

test("renames the file argument only for the tools Claude names differently", () => {
  const session = convert([
    SYSTEM,
    assistant("looking", [
      { id: "t1", name: "Read", args: { path: "src/a.ts" } },
      { id: "t2", name: "Grep", args: { pattern: "todo", path: "src" } },
      { id: "t3", name: "Write", args: { path: "src/b.ts", content: "x" } },
    ]),
  ]);

  const [read, grep, write] = session.toolUses;
  assert.equal(read?.input.file_path, "src/a.ts");
  assert.equal(read?.input.path, undefined);
  // Grep takes `path` in Claude Code too, so it must be left alone.
  assert.equal(grep?.input.path, "src");
  assert.equal(write?.input.file_path, "src/b.ts");
  assert.ok(session.fileEdits.has("src/b.ts"));
  assert.ok(session.filesRead.has("src/a.ts"));
});

test("accepts tool arguments as an object as well as a JSON string", () => {
  const session = convert([
    SYSTEM,
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "t1", function: { name: "Edit", arguments: { path: "src/a.ts", old_string: "a", new_string: "b" } } },
      ],
    },
  ]);

  assert.equal(session.toolUses[0]?.input.file_path, "src/a.ts");
});

test("keeps a tool call whose arguments were cut off mid-stream", () => {
  const session = convert([
    SYSTEM,
    { role: "assistant", content: "", tool_calls: [{ id: "t1", function: { name: "Bash", arguments: '{"command":"npm te' } }] },
  ]);

  assert.equal(session.toolUses.length, 1);
  assert.equal(session.toolUses[0]?.name, "Bash");
  assert.deepEqual(session.toolUses[0]?.input, {});
});

test("carries reasoning through, so known_gap stays reachable", () => {
  const withReasoning = convert([
    SYSTEM,
    { role: "assistant", content: "done", reasoning_content: "the retry path is still unhandled" },
  ]);
  assert.equal(withReasoning.meta.thinkingBlocks, 1);

  const asContentPart = convert([
    SYSTEM,
    { role: "assistant", content: [{ type: "thinking", thinking: "same idea" }, { type: "text", text: "done" }] },
  ]);
  assert.equal(asContentPart.meta.thinkingBlocks, 1);

  const without = convert([SYSTEM, assistant("done")]);
  assert.equal(without.meta.thinkingBlocks, 0);
});

test("recovers work a rewind discarded and marks it as an abandoned branch", () => {
  const kept = assistant("second attempt", [
    { id: "t2", name: "Edit", args: { path: "src/a.ts", old_string: "b", new_string: "c" } },
  ]);
  const discarded = assistant("first attempt", [
    { id: "t9", name: "Edit", args: { path: "src/gone.ts", old_string: "x", new_string: "y" } },
  ]);

  const context = [SYSTEM, user("try it"), { role: "_checkpoint", id: 1 }, user("try again"), kept, result("t2", "ok")];
  // wire.jsonl is append-only: it still holds the turn the rewind removed.
  const wire = [user("try it"), discarded, result("t9", "ok"), user("try again"), kept, result("t2", "ok")];

  const session = convert(context, wire);

  const abandoned = session.fileEdits.get("src/gone.ts")?.[0];
  assert.ok(abandoned, "the discarded edit should be recovered from wire.jsonl");
  assert.equal(onAbandonedBranch(session, abandoned.uuid), true);

  // The surviving edit must stay on the main path.
  const survived = session.fileEdits.get("src/a.ts")?.[0];
  assert.equal(onAbandonedBranch(session, survived?.uuid), false);

  const candidates = detectAbandonedApproach(session);
  const branch = candidates.find((candidate) => candidate.filePath === "src/gone.ts");
  assert.equal(branch?.detail, "edit sits on a conversation branch the session did not continue");
});

test("falls back to the surviving conversation when there is no wire log", () => {
  const session = convert([SYSTEM, user("go"), assistant("done")]);
  assert.equal(session.mainPath.size, 2);
  assert.deepEqual(detectAbandonedApproach(session), []);
});

test("ignores wire events it does not recognise instead of inventing records", () => {
  const session = convert(
    [SYSTEM, user("go"), { role: "_checkpoint", id: 1 }, assistant("done")],
    [{ event: "token_usage", tokens: 12 }, { some: "unknown shape" }],
  );

  assert.equal(session.records.length, 2);
});

test("finds a session by the cwd it recorded, whatever its folder is called", async () => {
  // Kimi has already changed this twice: the workspace folder went from a bare
  // MD5 to `wd_<name>_<sha256[:12]>`, and the transcript moved down into
  // `agents/main/wire.jsonl`. Deriving the path from cwd broke silently both
  // times, because finding nothing is indistinguishable from having no
  // sessions. Nothing below encodes a naming scheme.
  const cwd = "/work/named-anything";
  const dir = join(kimiSessionsRoot(), "a-name-no-scheme-predicts", "session_x");
  await mkdir(join(dir, "agents", "main"), { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify({ id: "session_x", cwd }));
  await writeFile(
    join(dir, "agents", "main", "wire.jsonl"),
    `${[
      { type: "metadata", protocol_version: "1.5" },
      { type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    ]
      .map(json)
      .join("\n")}\n`,
  );

  const found = await kimiAgent.sessionsIn(cwd);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.sessionId, "session_x");
  assert.equal(found[0]?.path, join(dir, "agents", "main", "wire.jsonl"));

  // A different directory must not match it.
  assert.deepEqual(await kimiAgent.sessionsIn("/work/somewhere-else"), []);
});

test("reads the event-log format newer builds write instead of context.jsonl", async () => {
  const cwd = "/work/wire-format";
  const dir = join(kimiSessionsRoot(), "wd_wire_deadbeef1234", "session_y");
  await mkdir(join(dir, "agents", "main"), { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify({ id: "session_y", cwd }));

  const loop = (event: unknown) => ({ type: "context.append_loop_event", agentId: "main", event });
  await writeFile(
    join(dir, "agents", "main", "wire.jsonl"),
    `${[
      { type: "metadata", protocol_version: "1.5" },
      { type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "add retries" }] } },
      loop({ type: "content.part", part: { type: "think", think: "the timeout path is still open" } }),
      loop({
        type: "tool.call",
        toolCallId: "Edit_0",
        name: "Edit",
        args: { path: "src/a.ts", old_string: "a", new_string: "b" },
      }),
      loop({ type: "tool.result", toolCallId: "Edit_0", result: { output: "ok" } }),
      loop({ type: "tool.call", toolCallId: "Bash_1", name: "Bash", args: { command: "npm test" } }),
      loop({ type: "tool.result", toolCallId: "Bash_1", result: { isError: true, output: "1 failing" } }),
      loop({ type: "step.end", finishReason: "stop" }),
    ]
      .map(json)
      .join("\n")}\n`,
  );

  const session = await kimiAgent.parsedSession(join(dir, "agents", "main", "wire.jsonl"), cwd);

  // step.end carries no content and must not become a record.
  assert.equal(session.records.length, 6);
  // Kimi calls the file argument `path`; every detector downstream reads
  // `file_path`, so the edit is only visible if the rename happened.
  assert.deepEqual([...session.fileEdits.keys()], ["src/a.ts"]);
  assert.equal(session.blocks.filter((block) => block.type === "thinking").length, 1);
  assert.equal(session.toolUses.length, 2);
  // A failed call is `isError` here; failedBefore only sees it through is_error.
  assert.equal(session.toolUses[1]?.result?.isError, true);
});

test("adds its hook block to config.toml once, and can take it back out", async () => {
  await writeFile(kimiConfigPath(), '[model]\nname = "k2"\n');

  assert.equal(await kimiAgent.installHooks(), "installed");
  assert.equal(await kimiAgent.installHooks(), "already-present");

  const contents = await readFile(kimiConfigPath(), "utf8");
  assert.match(contents, /\[model\]/); // the user's own settings survive
  assert.equal(contents.match(/\[\[hooks\]\]/g)?.length, 3);
  assert.match(contents, /event = "SessionEnd"/);
  assert.match(contents, /command = 'npx @nightloom\/isy upload --hook --agent kimi'/);

  assert.deepEqual(await kimiAgent.hooksInstalled(), [
    "SessionStart",
    "SessionEnd",
    "UserPromptSubmit",
  ]);

  assert.equal(await kimiAgent.removeHooks(), "removed");
  assert.equal(await kimiAgent.removeHooks(), "absent");
  assert.match(await readFile(kimiConfigPath(), "utf8"), /\[model\]/);
  assert.doesNotMatch(await readFile(kimiConfigPath(), "utf8"), /\[\[hooks\]\]/);
});

test("replaces its own block rather than stacking a second one", async () => {
  await writeFile(
    kimiConfigPath(),
    `# isy:begin — managed by isy, do not edit inside this block\n[[hooks]]\nevent = "SessionEnd"\ncommand = 'npx isy upload --silent'\ntimeout = 30\n# isy:end\n`,
  );

  assert.equal(await kimiAgent.installHooks(), "installed");
  const contents = await readFile(kimiConfigPath(), "utf8");
  assert.equal(contents.match(/# isy:begin/g)?.length, 1);
  assert.doesNotMatch(contents, /upload --silent/);
});

test("parks an alert it cannot show, so nothing is lost", async () => {
  await kimiAgent.deliver("ISY: session uploaded");
  // No controlling terminal in a test runner, so this takes the fallback path.
  assert.match(await readFile(pendingAlertPath(), "utf8"), /ISY: session uploaded/);
});

test("picks the agent from the payload the CLI sends", () => {
  assert.equal(detectAgent({ client_type: "kimi_code_cli" }).id, "kimi");
  assert.equal(detectAgent({ client_type: "claude_code" }).id, "claude");
  assert.equal(detectAgent(undefined).id, "claude");
  assert.equal(detectAgent(undefined, "kimi").id, "kimi");
  assert.equal(detectAgent({ client_type: "kimi_code_cli" }, "claude").id, "claude");

  // What Kimi 0.38 actually sends: no client_type, no transcript_path.
  const kimi038 = {
    hook_event_name: "SessionEnd",
    session_id: "session_a71d4bfa-287e-49e6-a5bc-41a36c1ef97e",
    cwd: "/work",
    reason: "exit",
  };
  assert.equal(detectAgent(kimi038).id, "kimi");
  assert.equal(detectAgent({ session_id: "a71d4bfa-287e-49e6-a5bc-41a36c1ef97e", cwd: "/work" }).id, "claude");
});

async function writeKimiSession(cwd: string, sessionId: string, lines: unknown[]): Promise<string> {
  // The folder name is deliberately unrelated to cwd: discovery reads state.json.
  const dir = join(kimiSessionsRoot(), `wd_${sessionId}_abcdef012345`, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "state.json"), JSON.stringify({ id: sessionId, cwd }));
  const path = join(dir, "context.jsonl");
  await writeFile(path, `${lines.map(json).join("\n")}\n`);
  return path;
}

test("status counts Kimi sessions and reads the newest one", async () => {
  const cwd = "/work/kimi-status";
  await writeKimiSession(cwd, "sess-a", [
    SYSTEM,
    user("add retries"),
    assistant("editing", [
      { id: "t1", name: "Edit", args: { path: "src/a.ts", old_string: "a", new_string: "b" } },
    ]),
    result("t1", "ok"),
    { role: "assistant", content: "done", reasoning_content: "the timeout path is still open" },
  ]);

  const report = await collectStatus(cwd);

  const kimi = report.agents.find((agent) => agent.id === "kimi");
  assert.equal(kimi?.sessions, 1);
  assert.equal(kimi?.transcriptDir, kimiSessionsRoot());

  assert.equal(report.project.sessions, 1);
  assert.equal(report.latestSession?.agent, "kimi");
  assert.equal(report.latestSession?.sessionId, "sess-a");
  assert.equal(report.latestSession?.records, 4);
  assert.equal(report.latestSession?.toolUses, 1);
  assert.equal(report.latestSession?.editedFiles, 1);
  assert.equal(report.latestSession?.thinkingBlocks, 1);

  const text = formatStatus(report);
  assert.match(text, /Kimi CLI\s+1 session\(s\)/);
  assert.match(text, /latest\s+sess-a \(Kimi CLI\)/);
});

test("status shows both CLIs and picks whichever ran last", async () => {
  const cwd = "/work/both-clis";
  const kimiPath = await writeKimiSession(cwd, "sess-kimi", [SYSTEM, user("go"), assistant("done")]);

  const claudeDir = join(claude, "projects", projectSlug(cwd));
  await mkdir(claudeDir, { recursive: true });
  const claudePath = join(claudeDir, "sess-claude.jsonl");
  await writeFile(
    claudePath,
    `${json({ type: "user", uuid: "u", parentUuid: null, sessionId: "sess-claude", cwd, message: { role: "user", content: "go" } })}\n`,
  );

  // Make the Claude session unambiguously the newer of the two.
  const old = new Date("2026-08-01T00:00:00Z");
  await utimes(kimiPath, old, old);

  const report = await collectStatus(cwd);

  assert.deepEqual(
    report.agents.map((agent) => [agent.label, agent.sessions]),
    [["Claude Code", 1], ["Kimi CLI", 1]],
  );
  assert.equal(report.project.sessions, 2);
  assert.equal(report.latestSession?.agent, "claude");

  const text = formatStatus(report);
  assert.match(text, /Claude Code\s+1 session\(s\)/);
  assert.match(text, /Kimi CLI\s+1 session\(s\)/);
});

test("status says which CLIs it looked in when nothing is recorded", async () => {
  const report = await collectStatus("/work/never-touched");
  assert.equal(report.project.sessions, 0);
  assert.equal(report.latestSession, undefined);
  assert.match(formatStatus(report), /no Claude Code or Kimi CLI sessions recorded/);
});

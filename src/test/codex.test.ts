import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { detectAgent } from "../agents/index.js";
import { codexAgent, codexHooksPath, codexSessionsDir } from "../agents/codex.js";
import { isCodexTranscript, parseApplyPatch, toClaudeRecords } from "../agents/codex-records.js";
import { collectStatus, formatStatus } from "../commands/status.js";
import { detectAbandonedApproach } from "../detectors.js";
import { parseLines } from "../parser.js";
import { pendingAlertPath } from "../paths.js";

const saved = {
  codex: process.env.CODEX_HOME,
  isy: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  kimi: process.env.KIMI_HOME,
};
let home: string;
let isy: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-codex-"));
  isy = await mkdtemp(join(tmpdir(), "isy-codex-home-"));
  process.env.CODEX_HOME = home;
  process.env.ISY_HOME = isy;
  // These assertions are about Codex, so pin the other CLIs somewhere that does
  // not exist: whether this machine has them installed must not change them.
  process.env.CLAUDE_CONFIG_DIR = join(home, "no-claude-here");
  process.env.KIMI_HOME = join(home, "no-kimi-here");
});

after(() => {
  if (saved.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codex;
  if (saved.isy === undefined) delete process.env.ISY_HOME;
  else process.env.ISY_HOME = saved.isy;
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  if (saved.kimi === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = saved.kimi;
});

const json = (value: unknown): string => JSON.stringify(value);

const META = {
  type: "session_meta",
  timestamp: "2026-08-20T10:00:00Z",
  payload: {
    session_id: "sess-1",
    cwd: "/repo",
    cli_version: "0.145.0",
    base_instructions: { text: "You are Codex." },
  },
};

const item = (payload: unknown) => ({ type: "response_item", timestamp: "2026-08-20T10:00:01Z", payload });

const say = (role: string, text: string) =>
  item({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });

const exec = (callId: string, cmd: string) =>
  item({ type: "function_call", name: "exec_command", call_id: callId, arguments: json({ cmd }) });

const execOut = (callId: string, output: string) =>
  item({ type: "function_call_output", call_id: callId, output });

const patch = (callId: string, input: string) =>
  item({ type: "custom_tool_call", name: "apply_patch", call_id: callId, input });

function convert(lines: unknown[]): ReturnType<typeof parseLines> {
  return parseLines(toClaudeRecords(lines.map(json)));
}

test("recognises a Codex rollout by its session_meta line", () => {
  assert.equal(isCodexTranscript(json(META)), true);
  assert.equal(isCodexTranscript(json({ role: "_system_prompt" })), false);
  assert.equal(isCodexTranscript(json({ type: "user", uuid: "a" })), false);
  assert.equal(isCodexTranscript("not json at all"), false);
  assert.equal(isCodexTranscript(""), false);
});

test("takes the session identity off session_meta and drops its system prompt", () => {
  const session = convert([META, say("user", "add a flag")]);

  assert.equal(session.sessionId, "sess-1");
  assert.equal(session.meta.cwd, "/repo");
  assert.equal(session.meta.claudeVersion, "0.145.0");
  // session_meta is bookkeeping, not a turn.
  assert.equal(session.records.length, 1);
  assert.doesNotMatch(session.records.map((r) => json(r)).join(""), /You are Codex/);
});

test("turns a shell call and its output into a Bash tool use", () => {
  const session = convert([
    META,
    say("user", "run the tests"),
    exec("call-1", "npm test"),
    execOut("call-1", "2 passing"),
  ]);

  assert.equal(session.toolUses.length, 1);
  assert.equal(session.toolUses[0]?.name, "Bash");
  assert.equal(session.toolUses[0]?.input.command, "npm test");
  assert.equal(session.toolUses[0]?.result?.text, "2 passing");
});

test("reads the shell command out of an exec harness script", () => {
  const script = 'const r = await tools.exec_command({cmd:"rg -n \\"todo\\" src", workdir:"/repo"}); text(r.output);\n';
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: script }),
  ]);

  assert.equal(session.toolUses[0]?.name, "Bash");
  assert.equal(session.toolUses[0]?.input.command, 'rg -n "todo" src');
});

test("keeps a harness script that runs no shell command under its own name", () => {
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: "text(ALL_TOOLS.length);" }),
  ]);

  // Still a tool use, just not one the shell detectors should ever see.
  assert.equal(session.toolUses[0]?.name, "exec");
  assert.equal(session.meta.editToolUses, 0);
});

test("reads every call an exec harness script makes, edits included", () => {
  const patch = "*** Begin Patch\n*** Update File: src/cache.ts\n@@\n-const ttl = 1;\n+const ttl = 60;\n*** End Patch\n";
  const script = [
    'const a = await tools.exec_command({cmd:"rg -n ttl src"});',
    `await tools.apply_patch(${JSON.stringify(patch)});`,
    'const b = await tools.exec_command({cmd:"npm test", workdir:"/repo"});',
    "text(b.output);",
  ].join("\n");
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: script }),
  ]);

  assert.deepEqual(session.toolUses.map((use) => use.name), ["Bash", "MultiEdit", "Bash"]);
  assert.equal(session.toolUses[2]?.input.command, "npm test");
  assert.equal(session.meta.editToolUses, 1);
  const edits = [...session.fileEdits.entries()].find(([path]) => path.endsWith("src/cache.ts"))?.[1];
  assert.equal(edits?.[0]?.newString, "const ttl = 60;");
  assert.equal(session.meta.hasFileEdits, true);
});

test("reads a patch the script binds to a const before applying it", () => {
  // The shape Codex 0.154 writes: the patch on one line, the call on the next.
  const patch = "*** Begin Patch\n*** Update File: src/cache.ts\n@@\n-const ttl = 1;\n+const ttl = 60;\n*** End Patch\n";
  const script = `const patch = ${JSON.stringify(patch)};\ntext(await tools.apply_patch(patch));\n`;
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: script }),
  ]);

  assert.deepEqual(session.toolUses.map((use) => use.name), ["MultiEdit"]);
  assert.equal(session.meta.editToolUses, 1);
});

test("a patch section holding only context is no edit, so repeating it is no revert", () => {
  const patch =
    "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-const a = 1;\n+const a = 2;\n@@\n export function set() {\n*** End Patch\n";
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "apply_patch", call_id: "call-1", input: patch }),
    item({ type: "custom_tool_call", name: "apply_patch", call_id: "call-2", input: patch }),
  ]);

  const edits = [...session.fileEdits.values()].flat();
  assert.equal(edits.length, 2);
  assert.ok(edits.every((edit) => edit.oldString !== edit.newString));
  assert.deepEqual(detectAbandonedApproach(session), []);
});

test("leaves a patch name unread when the script binds it with let or twice", () => {
  const patch = JSON.stringify("*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch\n");
  for (const script of [
    `let patch = ${patch};\nawait tools.apply_patch(patch);`,
    `const patch = ${patch};\n{ const patch = ${patch}; }\nawait tools.apply_patch(patch);`,
  ]) {
    const session = convert([
      META,
      item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: script }),
    ]);
    assert.deepEqual(session.toolUses.map((use) => use.name), ["exec"], script);
  }
});

test("keeps the harness in view when a call's argument cannot be read", () => {
  const script = `const r = await tools.exec_command({cmd:"sed -n '" + range + "p' src/a.ts"}); text(r.output);`;
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: script }),
  ]);

  // Half a command would lie to the shell detectors; the script stays an unknown
  // tool instead, which still lets the session through the no-edits gate.
  assert.deepEqual(session.toolUses.map((use) => use.name), ["exec"]);
  assert.equal(session.meta.hasFileEdits, true);
});

test("accepts the argv form older builds send", () => {
  const session = convert([
    META,
    item({
      type: "function_call",
      name: "shell",
      call_id: "call-1",
      arguments: json({ command: ["bash", "-lc", "git status"] }),
    }),
  ]);

  assert.equal(session.toolUses[0]?.name, "Bash");
  assert.equal(session.toolUses[0]?.input.command, "git status");
});

test("an argv that is not a shell wrapper is the whole command", () => {
  const session = convert([
    META,
    item({
      type: "function_call",
      name: "shell",
      call_id: "call-1",
      arguments: json({ command: ["sed", "-n", "1,200p", "src/cache.ts"] }),
    }),
  ]);

  assert.equal(session.toolUses[0]?.input.command, "sed -n 1,200p src/cache.ts");
});

test("reads the quoted-key cmd out of an exec harness script", () => {
  const script = 'const r = await tools.exec_command({"cmd":"ls -la","workdir":"/repo"}); text(r.output);';
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: script }),
  ]);

  assert.equal(session.toolUses[0]?.name, "Bash");
  assert.equal(session.toolUses[0]?.input.command, "ls -la");
});

test("an exec script is read call by call, patches included", () => {
  // Codex 0.154: one harness script, several tools, the patch among them.
  const script = [
    'const patched = await tools.apply_patch("*** Begin Patch\\n*** Update File: src/cache.ts\\n@@\\n-  return store.get(key);\\n+  return remote.fetch(key);\\n*** End Patch");',
    "text(patched);",
    'text(await tools.exec_command({cmd:"npm test", yield_time_ms:10000}));',
    'text(await tools.exec_command({"cmd":"rm -rf dist"}));',
  ].join("\n");
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: script }),
    item({
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [
        { type: "input_text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" },
        { type: "input_text", text: "Done!" },
        { type: "input_text", text: json({ exit_code: 1, output: 'npm ERR! "exit_code":0' }) },
        { type: "input_text", text: json({ exit_code: 0, output: "" }) },
      ],
    }),
  ]);

  assert.deepEqual(
    session.toolUses.map((use) => use.name),
    ["MultiEdit", "Bash", "Bash"],
  );
  assert.equal(session.toolUses[1]?.input.command, "npm test");
  assert.equal(session.toolUses[2]?.input.command, "rm -rf dist");
  assert.equal(session.meta.editToolUses, 1);
  assert.ok(session.fileEdits.has("src/cache.ts"));
  // One result for the whole script, on its first command; one failing command fails it.
  assert.equal(session.toolUses[1]?.id, "call-1");
  assert.equal(session.toolUses[1]?.result?.isError, true);
  assert.equal(session.toolUses[0]?.result, undefined);
});

test("an exec script whose commands all pass is not an error", () => {
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: 'text(await tools.exec_command({cmd:"ls"}));' }),
    item({
      type: "custom_tool_call_output",
      call_id: "call-1",
      output: [{ type: "input_text", text: json({ exit_code: 0, output: '{"exit_code":1}' }) }],
    }),
  ]);

  assert.equal(session.toolUses[0]?.result?.isError, false);
});

test("a script that outran its yield takes its exit code from the wait that finished it", () => {
  const running = (text: string) => [{ type: "input_text", text }];
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: 'text(await tools.exec_command({cmd:"npm test"}));' }),
    item({ type: "custom_tool_call_output", call_id: "call-1", output: "Script running with cell ID 5\nWall time 31.0 seconds\nOutput:\n" }),
    item({ type: "function_call", name: "wait", call_id: "call-2", arguments: json({ cell_id: "5", yield_time_ms: 1000 }) }),
    item({ type: "function_call_output", call_id: "call-2", output: running("Script running with cell ID 5\nWall time 30.0 seconds\nOutput:\n") }),
    item({ type: "function_call", name: "wait", call_id: "call-3", arguments: json({ cell_id: "5", yield_time_ms: 1000 }) }),
    item({
      type: "function_call_output",
      call_id: "call-3",
      output: [
        { type: "input_text", text: "Script completed\nWall time 0.0 seconds\nOutput:\n" },
        { type: "input_text", text: json({ exit_code: 1, output: "1 failed" }) },
      ],
    }),
  ]);

  // The waits are how the result arrived, not tools of their own.
  assert.deepEqual(session.toolUses.map((use) => use.name), ["Bash"]);
  assert.equal(session.toolUses[0]?.result?.isError, true);
  assert.match(session.toolUses[0]?.result?.text ?? "", /1 failed/);
});

test("a command that outran its yield takes its exit code from the write_stdin poll that finished it", () => {
  const output = (body: object) => `Script completed\nWall time 5.0 seconds\nOutput:\n\n${json(body)}`;
  const session = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: 'text(await tools.exec_command({cmd:"npm test", yield_time_ms:1000}));' }),
    item({ type: "custom_tool_call_output", call_id: "call-1", output: output({ session_id: 20794, output: "running" }) }),
    item({ type: "custom_tool_call", name: "exec", call_id: "call-2", input: 'text(await tools.write_stdin({session_id:20794,chars:"","yield_time_ms":1000}));' }),
    item({ type: "custom_tool_call_output", call_id: "call-2", output: output({ session_id: 20794, output: "" }) }),
    item({ type: "custom_tool_call", name: "exec", call_id: "call-3", input: 'text(await tools.write_stdin({session_id:20794,chars:""}));' }),
    item({ type: "custom_tool_call_output", call_id: "call-3", output: output({ exit_code: 1, output: "1 failed" }) }),
  ]);

  // The polls are how the result arrived, not tools of their own.
  assert.deepEqual(session.toolUses.map((use) => use.name), ["Bash"]);
  assert.equal(session.toolUses[0]?.result?.isError, true);
  assert.match(session.toolUses[0]?.result?.text ?? "", /1 failed/);

  // A shell this rollout never started has nothing to fold into.
  const unknown = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: 'text(await tools.write_stdin({session_id:7,chars:""}));' }),
  ]);
  assert.deepEqual(unknown.toolUses.map((use) => use.name), ["exec"]);
});

test("a wait on a cell the rollout never started stays a tool that edits nothing", () => {
  const session = convert([
    META,
    item({ type: "function_call", name: "wait", call_id: "call-1", arguments: json({ cell_id: "9" }) }),
    item({ type: "function_call_output", call_id: "call-1", output: "Script completed\nOutput:\n" }),
  ]);

  assert.deepEqual(session.toolUses.map((use) => use.name), ["wait"]);
  assert.equal(session.meta.hasFileEdits, false);
});

test("a script that only searches the web or looks at an image edits nothing", () => {
  const looking = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: 'text(await tools.web__run({search_query:[{q:"heleket api"}]}));' }),
    item({
      type: "custom_tool_call",
      name: "exec",
      call_id: "call-2",
      input: 'await tools.view_image({path:"shot.png"}); await tools.image_gen__imagegen({prompt:"logo"});',
    }),
  ]);
  assert.deepEqual(looking.toolUses.map((use) => use.name), ["web__run", "view_image", "image_gen__imagegen"]);
  assert.equal(looking.meta.hasFileEdits, false);

  // Typing into a running shell can write anything, so that one still may have edited.
  const typing = convert([
    META,
    item({ type: "custom_tool_call", name: "exec", call_id: "call-1", input: 'await tools.write_stdin({session_id:1, chars:"y\\n"});' }),
  ]);
  assert.deepEqual(typing.toolUses.map((use) => use.name), ["exec"]);
  assert.equal(typing.meta.hasFileEdits, true);
});

test("a local_shell_call carries its command under action.command", () => {
  const session = convert([
    META,
    item({
      type: "local_shell_call",
      id: "call-1",
      action: { type: "exec", command: ["bash", "-lc", "npm test"] },
      status: "completed",
    }),
    item({ type: "function_call_output", call_id: "call-1", output: "2 passing" }),
  ]);

  assert.equal(session.toolUses.length, 1);
  assert.equal(session.toolUses[0]?.name, "Bash");
  assert.equal(session.toolUses[0]?.input.command, "npm test");
  assert.equal(session.toolUses[0]?.result?.text, "2 passing");
});

test("a non-zero exit code marks the tool result is_error", () => {
  const session = convert([
    META,
    exec("call-1", "npm test"),
    execOut("call-1", "1 failed\nProcess exited with code 1"),
    exec("call-2", "npm test"),
    execOut("call-2", json({ output: "2 passing", metadata: { exit_code: 0 } })),
    exec("call-3", "npm test"),
    execOut("call-3", json({ output: "1 failed", metadata: { exit_code: 1 } })),
  ]);

  assert.equal(session.toolUses[0]?.result?.isError, true);
  assert.equal(session.toolUses[1]?.result?.isError, false);
  assert.equal(session.toolUses[2]?.result?.isError, true);
});

test("keeps reasoning Codex recorded in the clear and drops what it encrypted", () => {
  const session = convert([
    META,
    item({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "the retry path is still open" }],
      content: null,
      encrypted_content: "gAAAAABsecret",
    }),
  ]);

  assert.equal(session.meta.thinkingBlocks, 1);
  assert.match(session.blocks[0]?.text ?? "", /retry path/);
  assert.doesNotMatch(session.records.map((r) => json(r)).join(""), /gAAAAAB/);
});

test("a session whose reasoning was never recorded in the clear has no thinking", () => {
  const session = convert([
    META,
    item({ type: "reasoning", summary: [], content: null, encrypted_content: "gAAAAABsecret" }),
  ]);

  assert.equal(session.meta.thinkingBlocks, 0);
  assert.equal(session.records.length, 0);
});

test("drops developer messages, which are harness context and not the user's work", () => {
  const session = convert([META, say("developer", "## Memory\nprior runs said"), say("user", "go")]);

  assert.equal(session.records.length, 1);
  assert.doesNotMatch(session.records.map((r) => json(r)).join(""), /prior runs said/);
});

test("an apply_patch update becomes an edit the shared parser unpacks per hunk", () => {
  const session = convert([
    META,
    patch(
      "call-1",
      [
        "*** Begin Patch",
        "*** Update File: src/cache.ts",
        "@@",
        " export function get(key) {",
        "-  return store.get(key);",
        "+  return remote.fetch(key);",
        " }",
        "*** End Patch",
      ].join("\n"),
    ),
    item({ type: "custom_tool_call_output", call_id: "call-1", output: [{ type: "input_text", text: "done" }] }),
  ]);

  assert.equal(session.meta.editToolUses, 1);
  assert.equal(session.toolUses[0]?.result?.text, "done");

  const edits = session.fileEdits.get("src/cache.ts");
  assert.equal(edits?.length, 1);
  // Context lines belong to both sides, exactly as an Edit's strings do.
  assert.equal(edits?.[0]?.oldString, "export function get(key) {\n  return store.get(key);\n}");
  assert.equal(edits?.[0]?.newString, "export function get(key) {\n  return remote.fetch(key);\n}");
});

test("parseApplyPatch handles added, deleted and multi-file patches", () => {
  const edits = parseApplyPatch(
    [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+export const a = 1;",
      "+export const b = 2;",
      "*** Update File: src/old.ts",
      "@@",
      "-const x = 1;",
      "+const x = 2;",
      "@@",
      "-const y = 1;",
      "+const y = 2;",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n"),
  );

  assert.deepEqual(edits[0], {
    tool: "Write",
    input: { file_path: "src/new.ts", content: "export const a = 1;\nexport const b = 2;" },
  });
  assert.equal(edits[1]?.tool, "MultiEdit");
  assert.equal(edits[1]?.input.file_path, "src/old.ts");
  assert.equal((edits[1]?.input.edits as unknown[]).length, 2);
  // Nothing records what a deleted file held, so it is an edit with no diff.
  assert.deepEqual(edits[2], { tool: "Edit", input: { file_path: "src/gone.ts" } });
});

test("one patch touching several files keeps its result on the first call", () => {
  const session = convert([
    META,
    patch(
      "call-1",
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "-a",
        "+b",
        "*** Update File: src/b.ts",
        "@@",
        "-c",
        "+d",
        "*** End Patch",
      ].join("\n"),
    ),
    item({ type: "custom_tool_call_output", call_id: "call-1", output: "ok" }),
  ]);

  assert.equal(session.toolUses.length, 2);
  assert.equal(session.toolUses[0]?.id, "call-1");
  assert.equal(session.toolUses[1]?.id, "call-1#1");
  assert.equal(session.toolUses[0]?.result?.text, "ok");
  assert.ok(session.fileEdits.has("src/a.ts"));
  assert.ok(session.fileEdits.has("src/b.ts"));
});

test("survives a malformed rollout line instead of failing the session", () => {
  const records = toClaudeRecords([json(META), "{not json", "", json(say("user", "go"))]);
  assert.equal(records.length, 1);
});

async function writeRollout(date: string, id: string, lines: unknown[]): Promise<string> {
  const [year, month, day] = date.split("-");
  const dir = join(codexSessionsDir(), year!, month!, day!);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-${date}T10-00-00-${id}.jsonl`);
  await writeFile(path, `${lines.map(json).join("\n")}\n`);
  return path;
}

const metaFor = (cwd: string, sessionId: string) => ({
  ...META,
  payload: { ...META.payload, session_id: sessionId, cwd },
});

test("finds only the sessions recorded for this working directory", async () => {
  const cwd = "/work/codex-project";
  const mine = await writeRollout("2026-08-20", "019dc36a-3ce7-7163-8d38-416ea68327d4", [
    metaFor(cwd, "sess-mine"),
    say("user", "go"),
  ]);
  await writeRollout("2026-08-19", "019dc36a-3ce7-7163-8d38-416ea68327d5", [
    metaFor("/work/somewhere-else", "sess-theirs"),
    say("user", "go"),
  ]);

  const sessions = await codexAgent.sessionsIn(cwd);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0]?.path, mine);
  // The id comes off the rollout name, which ends in the session's uuid.
  assert.equal(sessions[0]?.sessionId, "019dc36a-3ce7-7163-8d38-416ea68327d4");
});

test("uses the transcript path Codex sends, and the newest session without one", async () => {
  const cwd = "/work/codex-transcript";
  const path = await writeRollout("2026-08-20", "019dc36a-3ce7-7163-8d38-416ea68327d6", [
    metaFor(cwd, "sess-newest"),
    say("user", "go"),
  ]);

  assert.equal(await codexAgent.transcriptFor({ transcript_path: "/given/by/codex.jsonl" }, cwd), "/given/by/codex.jsonl");
  assert.equal(await codexAgent.transcriptFor(undefined, cwd), path);
  assert.equal(await codexAgent.transcriptFor(undefined, "/work/nothing-here"), undefined);
});

test("status counts Codex sessions and reads the newest one", async () => {
  const cwd = "/work/codex-status";
  await writeRollout("2026-08-20", "019dc36a-3ce7-7163-8d38-416ea68327d7", [
    metaFor(cwd, "sess-status"),
    say("user", "add retries"),
    patch("call-1", "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch"),
    item({ type: "custom_tool_call_output", call_id: "call-1", output: "ok" }),
    item({ type: "reasoning", summary: [{ type: "summary_text", text: "the timeout path is still open" }] }),
  ]);

  const report = await collectStatus(cwd);
  const codex = report.agents.find((agent) => agent.id === "codex");

  assert.equal(codex?.sessions, 1);
  assert.equal(codex?.transcriptDir, codexSessionsDir());
  assert.equal(report.latestSession?.agent, "codex");
  assert.equal(report.latestSession?.editedFiles, 1);
  assert.equal(report.latestSession?.thinkingBlocks, 1);

  assert.match(formatStatus(report), /Codex CLI\s+1 session\(s\)/);
});

beforeEach(async () => {
  await writeFile(codexHooksPath(), json({ hooks: {} }));
});

test("writes its hooks into hooks.json and takes them out again", async () => {
  assert.equal(await codexAgent.installHooks(), "installed");
  assert.equal(await codexAgent.installHooks(), "already-present");

  const contents = JSON.parse(await readFile(codexHooksPath(), "utf8")) as {
    hooks: Record<string, { hooks: { type: string; command: string }[] }[]>;
  };
  assert.equal(
    contents.hooks.SessionStart?.[0]?.hooks[0]?.command,
    "npx @nightloom/isy check --hook --agent codex",
  );
  // Detached, because Codex is closing the session and the hook shell must not
  // wait; the payload goes over fd 3, because a background job's stdin is /dev/null.
  assert.match(
    contents.hooks.SessionEnd?.[0]?.hooks[0]?.command ?? "",
    /^exec 3<&0; nohup npx @nightloom\/isy upload --hook --agent codex <&3 .*&$/,
  );

  assert.deepEqual(await codexAgent.hooksInstalled(), ["SessionStart", "SessionEnd"]);

  assert.equal(await codexAgent.removeHooks(), "removed");
  assert.equal(await codexAgent.removeHooks(), "absent");
  assert.deepEqual(await codexAgent.hooksInstalled(), []);
});

test("replaces an older isy command rather than stacking a second one", async () => {
  for (const older of [
    "npx isy upload --hook --agent codex",
    // Detached, but blind to the payload: it guessed the newest rollout in the cwd.
    "nohup npx isy upload --hook --agent codex >/dev/null 2>&1 </dev/null &",
    // Same command, back when it was reached through npx.
    "exec 3<&0; nohup npx isy upload --hook --agent codex <&3 >/dev/null 2>&1 &",
  ]) {
    await writeFile(
      codexHooksPath(),
      json({ hooks: { SessionEnd: [{ hooks: [{ type: "command", command: older }] }] } }),
    );

    assert.equal(await codexAgent.installHooks(), "installed", older);

    const contents = JSON.parse(await readFile(codexHooksPath(), "utf8")) as {
      hooks: { SessionEnd: { hooks: { command: string }[] }[] };
    };
    assert.equal(contents.hooks.SessionEnd.length, 1, older);
    assert.match(contents.hooks.SessionEnd[0]?.hooks[0]?.command ?? "", /<&3 /, older);
  }
});

test("superseding keeps the user's later groups at their approved positions", async () => {
  // Codex keys approvals by group index, so replacing ISY's old command must
  // not shift the group that follows it.
  await writeFile(
    codexHooksPath(),
    json({
      hooks: {
        SessionEnd: [
          { hooks: [{ type: "command", command: "npx isy upload --hook --agent codex" }] },
          { matcher: "always", hooks: [{ type: "command", command: "their-hook" }] },
        ],
      },
    }),
  );

  assert.equal(await codexAgent.installHooks(), "installed");

  const contents = JSON.parse(await readFile(codexHooksPath(), "utf8")) as {
    hooks: { SessionEnd: { hooks: { command: string }[] }[] };
  };
  assert.equal(contents.hooks.SessionEnd.length, 2);
  assert.match(contents.hooks.SessionEnd[0]?.hooks[0]?.command ?? "", /<&3 /);
  assert.equal(contents.hooks.SessionEnd[1]?.hooks[0]?.command, "their-hook");
});

test("appends after the user's own hooks, never ahead of them", async () => {
  // Codex keys its hook trust ledger by position, so an insert ahead of an
  // existing group would silently untrust hooks the user already approved.
  await writeFile(
    codexHooksPath(),
    json({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "their-hook" }] }],
      },
    }),
  );

  await codexAgent.installHooks();

  const contents = JSON.parse(await readFile(codexHooksPath(), "utf8")) as {
    hooks: { SessionStart: { hooks: { command: string }[] }[] };
  };
  assert.equal(contents.hooks.SessionStart.length, 2);
  assert.equal(contents.hooks.SessionStart[0]?.hooks[0]?.command, "their-hook");
});

test("removing our hooks leaves the user's alone", async () => {
  await writeFile(
    codexHooksPath(),
    json({
      hooks: { SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "their-hook" }] }] },
    }),
  );

  await codexAgent.installHooks();
  assert.equal(await codexAgent.removeHooks(), "removed");

  const contents = JSON.parse(await readFile(codexHooksPath(), "utf8")) as {
    hooks: { SessionStart: { hooks: { command: string }[] }[] };
  };
  assert.equal(contents.hooks.SessionStart.length, 1);
  assert.equal(contents.hooks.SessionStart[0]?.hooks[0]?.command, "their-hook");
});

test("parks a SessionEnd line, then shows it at the next SessionStart", async () => {
  await writeFile(pendingAlertPath(), "");

  // Codex has no output schema for SessionEnd at all, so nothing said there can
  // reach the user until the next session opens.
  await codexAgent.deliver("ISY: session uploaded", "SessionEnd");
  assert.match(await readFile(pendingAlertPath(), "utf8"), /ISY: session uploaded/);

  const said: string[] = [];
  const log = console.log;
  console.log = (line: string) => said.push(line);
  try {
    await codexAgent.deliver("ISY 0.1.0 active", "SessionStart");
  } finally {
    console.log = log;
  }

  const shown = JSON.parse(said[0] ?? "{}") as { systemMessage?: string };
  assert.match(shown.systemMessage ?? "", /session uploaded/);
  assert.match(shown.systemMessage ?? "", /ISY 0\.1\.0 active/);
  // Drained, so the next session does not repeat it. The takeover renames the
  // file away, so it may simply be gone.
  const left = await readFile(pendingAlertPath(), "utf8").catch(() => "");
  assert.equal(left.trim(), "");
});

test("picks Codex only when told to: its payload looks exactly like Claude's", () => {
  assert.equal(detectAgent(undefined, "codex").id, "codex");
  assert.equal(detectAgent({ transcript_path: "/x.jsonl", session_id: "s", cwd: "/repo" }).id, "claude");
  assert.equal(detectAgent({ transcript_path: "/x.jsonl" }, "codex").id, "codex");
});

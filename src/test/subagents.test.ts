import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { claudeAgent } from "../agents/claude.js";
import { analyzeFiles, expandInputs } from "../commands/analyze.js";
import { onMainPath, parseLines } from "../parser.js";
import { runStage0 } from "../stage0.js";
import { sessionFingerprint, sessionLines, subagentsOf } from "../subagents.js";

/**
 * Two sessions Claude Code 2.1.285 recorded against a scripted API
 * (`fixtures/record/README.md`), with the client-context attachments
 * shortened and every record shape left as it was written.
 *
 * `compacted`: a background subagent fixes a bug; the session is compacted with
 * `/compact`, then carries on — redacted reasoning, a `CronList`, a new file, a test run.
 * `delegated`: a foreground subagent makes the only edit; the session runs the tests.
 */
const fixtures = join(import.meta.dirname, "fixtures", "claude-2.1.285");
const compacted = join(fixtures, "compacted", "70a18f29-539f-40b6-b3e5-269625d413e9.jsonl");
const delegated = join(fixtures, "delegated", "5d529f07-bb5a-43d6-b702-63bbe03cc5c3.jsonl");

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

test("reads a subagent in right after the call that started it", async () => {
  const lines = await collect(sessionLines(compacted));
  const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  const call = records.findIndex((record) => JSON.stringify(record).includes('"id":"toolu_0006mockmunvr0jg"'));
  const subagent = records.filter((record) => record.agentId === "a08798d64bcf4727b");

  assert.ok(call > 0);
  assert.equal(subagent.length, 22);
  // The subagent's first record follows the call, before the call's result.
  assert.equal(records[call + 1]?.agentId, "a08798d64bcf4727b");
  assert.equal(records[call + 1]?.parentUuid, null);
  for (const record of subagent) {
    assert.equal(record.isSidechain, true);
    assert.equal(record.parentToolUseID, "toolu_0006mockmunvr0jg");
  }
});

test("a compacted 2.1.285 session parses whole, subagent and all", async () => {
  const session = await claudeAgent.parsedSession(compacted);

  assert.deepEqual(session.skipped.unknownTypes, {});
  assert.equal(session.filePath, compacted);
  assert.equal(session.meta.claudeVersion, "2.1.285");
  assert.equal(session.meta.sidechainRecords, 22);
  // The subagent's Read/Edit/Bash, and the session's own calls before and after the compaction.
  assert.deepEqual(
    session.toolUses.map((use) => `${use.isSidechain ? "sub:" : ""}${use.name}`),
    ["Read", "Agent", "sub:Read", "sub:Edit", "sub:Bash", "Write", "CronList", "Bash"],
  );
  // One subagent thought out loud; everything else left its reasoning out.
  assert.equal(session.meta.thinkingBlocks, 1);
  assert.equal(session.meta.hiddenThinkingBlocks, 7);
  // The first prompt is still on the main path, across the compaction boundary.
  assert.equal(onMainPath(session, "b219284b-2f5c-48db-90ff-706971485833"), true);
  assert.equal(onMainPath(session, "bddf298e-1f95-423e-934e-0e5356105578"), true);
  assert.equal(onMainPath(session, "433c64bb-911f-499f-a0b4-934221394b14"), true);

  const result = runStage0(session);
  assert.equal(result.eligible, true);
  assert.equal(result.knownGapReachable, true);
  // The subagent tested its fix, and the session ran the suite after writing the README.
  assert.deepEqual(result.candidates, []);
});

test("a session whose only edit was a subagent's is a session that edited", async () => {
  const alone = parseLines((await collect(sessionLines(delegated))).filter((line) => !line.includes('"isSidechain":true')));
  // Even without the subagent's records, its result says it edited a file.
  assert.equal(alone.meta.editToolUses, 0);
  assert.equal(alone.meta.hasFileEdits, true);

  const session = await claudeAgent.parsedSession(delegated);
  assert.equal(session.meta.editToolUses, 1);
  assert.equal(session.meta.hiddenThinkingBlocks, 5);

  const edit = session.fileEdits.get("/home/dev/cart/src/cart.js")?.[0];
  const test = session.toolUses.find((use) => use.name === "Bash");
  assert.ok(edit && test && edit.recordIndex < test.recordIndex, "the edit sits before the test run that checked it");

  const result = runStage0(session);
  assert.equal(result.eligible, true);
  assert.equal(result.candidates.some((candidate) => candidate.category === "unverified_fix"), false);
  assert.equal(result.knownGapReachable, false);
});

test("the upload of a session carries its subagents, masked like the rest", async () => {
  const lines = await claudeAgent.redactedLines(delegated, {});
  const text = lines.join("\n");

  assert.ok(text.includes('"isSidechain":true'));
  assert.ok(text.includes('"parentToolUseID":"toolu_0037mockmunvwkwi"'));
  // The session ran in /home/dev/cart: the subagent's paths turn relative with the session's.
  assert.ok(!text.includes("/home/dev/cart/src/cart.js"));
  assert.ok(text.includes('"file_path":"src/cart.js"'));
});

async function session(records: Record<string, unknown>[]): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "isy-subagents-"));
  const path = join(dir, "s1.jsonl");
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n"));
  return { dir, path };
}

async function subagent(
  dir: string,
  agentId: string,
  records: Record<string, unknown>[],
  meta?: Record<string, unknown>,
  under = "",
): Promise<void> {
  const home = join(dir, "s1", "subagents", under);
  await mkdir(home, { recursive: true });
  await writeFile(join(home, `agent-${agentId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n"));
  if (meta) await writeFile(join(home, `agent-${agentId}.meta.json`), JSON.stringify(meta));
}

const call = (uuid: string, parentUuid: string | null, id: string, extra: object = {}) => ({
  type: "assistant",
  uuid,
  parentUuid,
  sessionId: "s1",
  message: { role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input: { prompt: "go" } }] },
  ...extra,
});
const said = (uuid: string, parentUuid: string | null, text: string, extra: object = {}) => ({
  type: "assistant",
  uuid,
  parentUuid,
  sessionId: "s1",
  message: { role: "assistant", content: [{ type: "text", text }] },
  ...extra,
});
const answered = (uuid: string, parentUuid: string, id: string, agentId: string) => ({
  type: "user",
  uuid,
  parentUuid,
  sessionId: "s1",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "done" }] },
  toolUseResult: { status: "completed", agentId },
});

test("nests a subagent's own subagent after the call that started it", async () => {
  const { dir, path } = await session([call("a", null, "toolu_outer"), answered("b", "a", "toolu_outer", "outer")]);
  await subagent(dir, "outer", [said("o1", null, "outer starts"), call("o2", "o1", "toolu_inner"), said("o3", "o2", "outer ends")], {
    toolUseId: "toolu_outer",
  });
  await subagent(dir, "inner", [said("i1", null, "inner works")], { toolUseId: "toolu_inner" });

  const order = (await collect(sessionLines(path))).map((line) => (JSON.parse(line) as { uuid: string }).uuid);
  assert.deepEqual(order, ["a", "o1", "o2", "i1", "o3", "b"]);
});

test("places a subagent without a meta file by the result that names it", async () => {
  const { dir, path } = await session([
    call("a", null, "toolu_1"),
    answered("b", "a", "toolu_1", "lost"),
    said("c", "b", "after"),
  ]);
  await subagent(dir, "lost", [said("l1", null, "work")]);

  const records = (await collect(sessionLines(path))).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(records.map((record) => record.uuid), ["a", "b", "l1", "c"]);
  assert.equal(records[2]?.parentToolUseID, "toolu_1");
});

test("a subagent whose call is nowhere still counts, after the session", async () => {
  const { dir, path } = await session([said("a", null, "hello")]);
  await subagent(dir, "stray", [said("s1", null, "work")], { toolUseId: "toolu_elsewhere" });
  await subagent(dir, "workflow", [said("w1", null, "step")], undefined, join("workflows", "run-1"));

  const records = (await collect(sessionLines(path))).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(records.map((record) => record.uuid), ["a", "s1", "w1"]);
  assert.equal(records[1]?.isSidechain, true);
  assert.equal(records[1]?.parentToolUseID, "toolu_elsewhere");
  assert.equal(records[2]?.isSidechain, true);
  assert.equal(records[2]?.parentToolUseID, undefined);
  assert.equal((await subagentsOf(path)).length, 2);
});

const at = (second: number) => new Date(Date.UTC(2026, 8, 30, 9, 0, second)).toISOString();
const use = (uuid: string, parentUuid: string | null, second: number, id: string, name: string, input: object) => ({
  type: "assistant",
  uuid,
  parentUuid,
  sessionId: "s1",
  timestamp: at(second),
  message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});
const result = (uuid: string, parentUuid: string, second: number, id: string, extra: object = {}) => ({
  type: "user",
  uuid,
  parentUuid,
  sessionId: "s1",
  timestamp: at(second),
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  ...extra,
});

test("a background subagent's work goes in when it happened, not in one piece after its call", async () => {
  // The session reads a.ts, sends a subagent to run the tests in the background,
  // then edits a.ts a minute later; the subagent runs the suite a minute after that.
  const { dir, path } = await session([
    use("a", null, 1, "t_read", "Read", { file_path: "/repo/src/a.ts" }),
    result("b", "a", 2, "t_read"),
    use("c", "b", 3, "t_agent", "Agent", { prompt: "run the tests", run_in_background: true }),
    result("d", "c", 4, "t_agent", { toolUseResult: { status: "async_launched", agentId: "bg" } }),
    use("e", "d", 60, "t_edit", "Edit", { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" }),
    result("f", "e", 61, "t_edit"),
    said("g", "f", "the tests pass", { timestamp: at(131) }),
  ]);
  await subagent(
    dir,
    "bg",
    [
      said("s1", null, "running them", { timestamp: at(5) }),
      use("s2", "s1", 120, "t_test", "Bash", { command: "npm test" }),
      result("s3", "s2", 125, "t_test"),
    ],
    { toolUseId: "t_agent", requestShape: "background" },
  );

  const parsed = await claudeAgent.parsedSession(path);
  assert.deepEqual(
    parsed.toolUses.map((use) => `${use.isSidechain ? "sub:" : ""}${use.name}`),
    ["Read", "Agent", "Edit", "sub:Bash"],
  );
  assert.deepEqual(
    parsed.records.map((record) => record.uuid),
    ["a", "b", "c", "d", "s1", "e", "f", "s2", "s3", "g"],
  );
  // The suite ran after the edit, so the edit was checked.
  assert.equal(runStage0(parsed).candidates.some((candidate) => candidate.category === "unverified_fix"), false);
});

test("a subagent resumed later goes in at the time of its second run", async () => {
  const { dir, path } = await session([
    use("a", null, 1, "t_agent", "Agent", { prompt: "fix it" }),
    result("b", "a", 10, "t_agent", { toolUseResult: { status: "completed", agentId: "x" } }),
    use("c", "b", 20, "t_bash", "Bash", { command: "ls" }),
    result("d", "c", 21, "t_bash"),
    use("e", "d", 40, "t_send", "SendMessage", { to: "x", message: "and the other one" }),
    result("f", "e", 50, "t_send"),
  ]);
  await subagent(
    dir,
    "x",
    [
      said("x1", null, "first run", { timestamp: at(2) }),
      said("x2", "x1", "first run done", { timestamp: at(9) }),
      said("x3", "x2", "second run", { timestamp: at(41) }),
    ],
    { toolUseId: "t_agent" },
  );

  const order = (await collect(sessionLines(path))).map((line) => (JSON.parse(line) as { uuid: string }).uuid);
  assert.deepEqual(order, ["a", "x1", "x2", "b", "c", "d", "e", "x3", "f"]);
});

test("a subagent never goes ahead of its call, whatever its clock says", async () => {
  const { dir, path } = await session([
    said("a", null, "start", { timestamp: at(1) }),
    use("b", "a", 10, "t_agent", "Agent", { prompt: "go" }),
    result("c", "b", 20, "t_agent"),
  ]);
  await subagent(dir, "early", [said("e1", null, "stamped before the call", { timestamp: at(5) })], {
    toolUseId: "t_agent",
  });

  const order = (await collect(sessionLines(path))).map((line) => (JSON.parse(line) as { uuid: string }).uuid);
  assert.deepEqual(order, ["a", "b", "e1", "c"]);
});

test("a subagent whose file cannot be read leaves the session readable", async () => {
  const { dir, path } = await session([call("a", null, "toolu_1"), said("b", "a", "after")]);
  await subagent(dir, "gone", [said("g1", null, "work")], { toolUseId: "toolu_1" });

  const lines: string[] = [];
  for await (const line of sessionLines(path)) {
    lines.push(line);
    // Listed before the read began, gone by the time its call is reached.
    if (lines.length === 1) await rm(join(dir, "s1", "subagents", "agent-gone.jsonl"));
  }
  assert.deepEqual(lines.map((line) => (JSON.parse(line) as { uuid: string }).uuid), ["a", "b"]);
});

test("a session with no subagents reads exactly as its file", async () => {
  const records = [said("a", null, "one"), said("b", "a", "two")];
  const { path } = await session(records);
  assert.deepEqual(await collect(sessionLines(path)), records.map((record) => JSON.stringify(record)));
});

test("a session's size and age include its subagents", async () => {
  const { dir, path } = await session([call("a", null, "toolu_1")]);
  const alone = await sessionFingerprint(path);
  assert.equal(alone.sizeBytes, (await stat(path)).size);

  await subagent(dir, "x", [said("x1", null, "work")], { toolUseId: "toolu_1" });
  const whole = await sessionFingerprint(path);
  const agent = await stat(join(dir, "s1", "subagents", "agent-x.jsonl"));
  assert.equal(whole.sizeBytes, alone.sizeBytes + agent.size);
  assert.ok(whole.modifiedAt.getTime() >= agent.mtime.getTime());
});

test("isy analyze counts a session once, however many subagents it had", async () => {
  const dir = await mkdtemp(join(tmpdir(), "isy-analyze-subagents-"));
  await cp(join(fixtures, "compacted"), dir, { recursive: true });

  const files = await expandInputs([dir]);
  assert.deepEqual(files, [join(dir, "70a18f29-539f-40b6-b3e5-269625d413e9.jsonl")]);

  const [analyzed] = await analyzeFiles(files, undefined);
  assert.equal(analyzed?.eligible, true);
  assert.equal(analyzed?.editToolUses, 2);
  assert.equal(analyzed?.hiddenThinkingBlocks, 7);

  // Asked about on its own, a subagent is all there is to read.
  const lone = join(dir, "70a18f29-539f-40b6-b3e5-269625d413e9", "subagents", "agent-a08798d64bcf4727b.jsonl");
  assert.deepEqual(await expandInputs([lone]), [lone]);

  // Named beside its session, it is its session's, however either was spelled.
  const named = relative(process.cwd(), files[0]!);
  assert.deepEqual(await expandInputs([named, lone, `./${named}`]), [named]);
});

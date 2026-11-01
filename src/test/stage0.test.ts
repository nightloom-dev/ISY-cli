import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLines } from "../parser.js";
import {
  LOG_ONLY_CATCHES,
  SUPPRESSORS,
  addedDependencies,
  detectAbandonedApproach,
  detectDestructiveCommand,
  detectErrorSuppressed,
  detectStaleContext,
  detectTestModifiedToPass,
  detectUnverifiedAssumption,
  detectUnverifiedFix,
  installedPackages,
  isTestFile,
  weakensTest,
} from "../detectors.js";
import { MIN_TOOL_USES, eligibility, runStage0 } from "../stage0.js";
import type { ParsedSession } from "../types.js";

let clock = 0;

function nextTimestamp(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 7, 16, 9, clock)).toISOString();
}

function assistant(uuid: string, parentUuid: string | null, content: unknown[]): unknown {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: "s1",
    timestamp: nextTimestamp(),
    message: { role: "assistant", content },
  };
}

function result(uuid: string, parentUuid: string, toolUseId: string, extra: object): unknown {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: "s1",
    timestamp: nextTimestamp(),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }] },
    ...extra,
  };
}

function build(records: unknown[]): ParsedSession {
  clock = 0;
  return parseLines(records.map((record) => JSON.stringify(record)));
}

/** A path-less Glob: a tool call that reads no file and trips no detector. */
function lookup(i: number): unknown {
  return { type: "tool_use", id: `pad-t${i}`, name: "Glob", input: { pattern: "*" } };
}

/** Twenty records ending in `pad19`, the first of them tool calls enough to pass the length gate. */
function padded(records: unknown[]): ParsedSession {
  const filler: unknown[] = [];
  for (let i = 0; i < 20; i += 1) {
    const content = i < MIN_TOOL_USES ? [lookup(i)] : [{ type: "text", text: "x" }];
    filler.push(assistant(`pad${i}`, i === 0 ? null : `pad${i - 1}`, content));
  }
  return build([...filler, ...records]);
}

test("rejects a session with too few tool calls", () => {
  const session = build([
    assistant("a", null, [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" } },
    ]),
  ]);
  assert.equal(eligibility(session), "too-short");
  assert.deepEqual(runStage0(session).candidates, []);
});

test("counts length in tool calls, so a few records holding several calls pass", () => {
  // Codex packs several calls into one harness script: few records, real work.
  const session = build([
    assistant("a", null, [
      lookup(0),
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } },
    ]),
  ]);
  assert.equal(eligibility(session), undefined);
});

test("a short session that never edited is told apart from a short one that did", () => {
  const session = build([assistant("a", null, [lookup(0)])]);
  assert.equal(eligibility(session), "no-file-edits");
});

test("rejects a long session that never edited a file", () => {
  const session = padded([]);
  assert.equal(eligibility(session), "no-file-edits");
  assert.equal(runStage0(session).eligible, false);
});

test("accepts a long session that edited a file", () => {
  const session = padded([
    assistant("e", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" } },
    ]),
  ]);
  assert.equal(eligibility(session), undefined);
  assert.equal(runStage0(session).eligible, true);
});

test("a session with too many edits to hold up to its calls finds nothing, and is not rejected for it", () => {
  const session = (edits: number) => parseLines([JSON.stringify(assistant("u0", null, [
    ...Array.from({ length: edits }, (_, index) => ({ type: "tool_use", id: `e${index}`, name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: `${index}` } })),
    { type: "tool_use", id: "t0", name: "Bash", input: { command: "git reset --hard" } },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "sed -i x a.ts" } },
  ]))]);
  assert.ok(runStage0(session(1000)).candidates.length > 0);
  const result = runStage0(session(20_000));
  assert.equal(result.eligible, true);
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.candidates, []);
});

test("a long session with few edits keeps its findings, as nothing it holds multiplies", () => {
  const session = parseLines([JSON.stringify(assistant("u0", null, [
    ...Array.from({ length: 30_000 }, (_, index) => ({ type: "tool_use", id: `r${index}`, name: "Read", input: { file_path: `src/${index}.ts` } })),
    { type: "tool_use", id: "t0", name: "Bash", input: { command: "git reset --hard" } },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "sed -i x a.ts" } },
  ]))]);
  assert.ok(runStage0(session).candidates.length > 0);
});

test("recognises test files by path and by name", () => {
  for (const path of [
    "/r/tests/thing.py",
    "/r/__tests__/thing.js",
    "/r/src/payments.test.ts",
    "/r/src/payments_spec.rs",
    "/r/Thing.spec.java",
  ]) {
    assert.equal(isTestFile(path), true, path);
  }
  assert.equal(isTestFile("/r/TestRounding.java"), true);
  assert.equal(isTestFile("/r/test_rounding.py"), true);

  for (const path of ["/r/src/payments.ts", "/r/latest/notes.md", "/r/contest.go", "/r/latest.ts", "/r/spectrum.ts"]) {
    assert.equal(isTestFile(path), false, path);
  }
});

test("spots each way a test can be weakened", () => {
  assert.match(
    weakensTest("expect(a).toBe(1);\nexpect(b).toBe(2);", "expect(a).toBe(1);") ?? "",
    /assertions removed/,
  );
  assert.match(weakensTest("it('works', () => {})", "it.only('works', () => {})") ?? "", /skipped/);
  assert.match(
    weakensTest("def test_a():\n  pass\ndef test_b():\n  pass", "def test_a():\n  pass") ?? "",
    /deleted/,
  );
  assert.equal(weakensTest("expect(a).toBe(1);", "expect(a).toBe(2);"), undefined);
});

test("flags a weakened test and scores it higher after a failing command", () => {
  const session = padded([
    assistant("b", "pad19", [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "npm test" } }]),
    result("br", "b", "t0", { toolUseResult: { stdout: "1 test FAILED", stderr: "" } }),
    assistant("c", "br", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/r/tests/rounding.test.ts",
          old_string: "expect(cents).toBe(3);\nexpect(rest).toBe(0);",
          new_string: "expect(cents).toBe(3);",
        },
      },
    ]),
  ]);

  const candidates = detectTestModifiedToPass(session);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.filePath, "/r/tests/rounding.test.ts");
  assert.equal(candidates[0]?.weight, 0.9);
  assert.match(candidates[0]?.detail ?? "", /failing command/);
});

test("scores a weakened test lower when nothing failed beforehand", () => {
  const session = padded([
    assistant("c", "pad19", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/r/tests/rounding.test.ts",
          old_string: "expect(a).toBe(1);\nexpect(b).toBe(2);",
          new_string: "expect(a).toBe(1);",
        },
      },
    ]),
  ]);

  const candidates = detectTestModifiedToPass(session);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.weight, 0.6);
});

test("flags an assertion deleted outright, with an empty replacement", () => {
  // Claude Code deletes lines with `new_string: ""`; read as no replacement at
  // all, the most direct weakening of a test was the one never flagged.
  const session = padded([
    assistant("b", "pad19", [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "npm test" } }]),
    result("br", "b", "t0", { toolUseResult: { stdout: "1 test FAILED", stderr: "" } }),
    assistant("c", "br", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: { file_path: "/r/test/money.test.js", old_string: "assert.equal(split(5, 2), [3, 2]);\n", new_string: "" },
      },
    ]),
  ]);

  const candidates = detectTestModifiedToPass(session);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.weight, 0.9);
});

test("ignores a strengthened test and a non-test file", () => {
  const session = padded([
    assistant("c", "pad19", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/r/tests/rounding.test.ts",
          old_string: "expect(a).toBe(1);",
          new_string: "expect(a).toBe(1);\nexpect(b).toBe(2);",
        },
      },
      {
        type: "tool_use",
        id: "t2",
        name: "Edit",
        input: { file_path: "/r/src/app.ts", old_string: "expect(a);\nexpect(b);", new_string: "expect(a);" },
      },
    ]),
  ]);

  assert.deepEqual(detectTestModifiedToPass(session), []);
});

test("notices a file rebuilt back to content it already had", () => {
  const session = padded([
    assistant("r", "pad19", [{ type: "tool_use", id: "t0", name: "Read", input: { file_path: "/r/a.ts" } }]),
    result("rr", "r", "t0", {
      toolUseResult: { type: "text", file: { filePath: "/r/a.ts", content: "const a = 1;\n", numLines: 1, startLine: 1, totalLines: 1 } },
    }),
    assistant("e1", "rr", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } },
    ]),
    assistant("e2", "e1", [
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/r/a.ts", old_string: "const a = 2;", new_string: "const a = 1;" } },
    ]),
  ]);

  const candidates = detectAbandonedApproach(session);
  assert.ok(candidates.length >= 1);
  assert.equal(candidates[0]?.category, "abandoned_approach");
  assert.equal(candidates[0]?.filePath, "/r/a.ts");
  assert.ok(candidates.some((candidate) => candidate.weight >= 0.7));
});

test("does not flag a file that only moves forward", () => {
  const session = padded([
    assistant("r", "pad19", [{ type: "tool_use", id: "t0", name: "Read", input: { file_path: "/r/a.ts" } }]),
    result("rr", "r", "t0", {
      toolUseResult: { file: { filePath: "/r/a.ts", content: "const a = 1;\n", numLines: 1, startLine: 1, totalLines: 1 } },
    }),
    assistant("e1", "rr", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } },
    ]),
    assistant("e2", "e1", [
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/r/a.ts", old_string: "const a = 2;", new_string: "const a = 3;" } },
    ]),
  ]);

  assert.deepEqual(detectAbandonedApproach(session), []);
});

test("does not treat re-reading a file after editing it as a revert", () => {
  const session = padded([
    assistant("r1", "pad19", [{ type: "tool_use", id: "t0", name: "Read", input: { file_path: "/r/a.ts" } }]),
    result("rr1", "r1", "t0", {
      toolUseResult: { file: { filePath: "/r/a.ts", content: "const a = 1;\n", numLines: 1, startLine: 1, totalLines: 1 } },
    }),
    assistant("e1", "rr1", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "const a = 1;", new_string: "const a = 2;" } },
    ]),
    assistant("r2", "e1", [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/r/a.ts" } }]),
    result("rr2", "r2", "t2", {
      toolUseResult: { file: { filePath: "/r/a.ts", content: "const a = 2;\n", numLines: 1, startLine: 1, totalLines: 1 } },
    }),
  ]);

  assert.deepEqual(
    detectAbandonedApproach(session).filter((c) => c.detail.includes("returned to a state")),
    [],
  );
});

test("treats a repeated read with no edits between as unremarkable", () => {
  const session = padded([
    assistant("r1", "pad19", [{ type: "tool_use", id: "t0", name: "Read", input: { file_path: "/r/a.ts" } }]),
    result("rr1", "r1", "t0", {
      toolUseResult: { file: { filePath: "/r/a.ts", content: "same\n", numLines: 1, startLine: 1, totalLines: 1 } },
    }),
    assistant("r2", "rr1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/a.ts" } }]),
    result("rr2", "r2", "t1", {
      toolUseResult: { file: { filePath: "/r/a.ts", content: "same\n", numLines: 1, startLine: 1, totalLines: 1 } },
    }),
    assistant("e", "rr2", [
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/r/b.ts", old_string: "x", new_string: "y" } },
    ]),
  ]);

  assert.deepEqual(detectAbandonedApproach(session), []);
});

test("a file of padding or blank lines is compared in linear time", () => {
  for (const content of [`${" ".repeat(200_000)}x`, `${"\n".repeat(200_000)}x`]) {
    const session = padded([
      assistant("w", "pad19", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/r/a.txt", content } }]),
    ]);
    const started = performance.now();
    detectAbandonedApproach(session);
    const took = performance.now() - started;
    assert.ok(took < 1000, `took ${Math.round(took)}ms on ${JSON.stringify(content.slice(0, 2))}…`);
  }
});

test("flags edits thrown away by a git command", () => {
  for (const command of ["git checkout -- src/app.ts", "git restore src/app.ts", "git reset --hard", "git stash"]) {
    const session = padded([
      assistant("e", "pad19", [
        { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/app.ts", old_string: "x", new_string: "y" } },
      ]),
      assistant("g", "e", [{ type: "tool_use", id: "t2", name: "Bash", input: { command } }]),
    ]);

    const candidates = detectAbandonedApproach(session).filter((c) => c.detail.includes("git command"));
    assert.equal(candidates.length, 1, command);
    assert.equal(candidates[0]?.filePath, "/r/src/app.ts");
  }
});

test("does not treat restoring a stash as discarding work", () => {
  const session = padded([
    assistant("e", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/app.ts", old_string: "x", new_string: "y" } },
    ]),
    assistant("g", "e", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "git stash pop" } }]),
  ]);

  assert.deepEqual(
    detectAbandonedApproach(session).filter((c) => c.detail.includes("git command")),
    [],
  );
});

test("ignores a git revert that happened before the file was touched", () => {
  const session = padded([
    assistant("g", "pad19", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git reset --hard" } }]),
    assistant("e", "g", [
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/r/src/app.ts", old_string: "x", new_string: "y" } },
    ]),
  ]);

  assert.deepEqual(
    detectAbandonedApproach(session).filter((c) => c.detail.includes("git command")),
    [],
  );
});

test("flags edits on a branch the session walked away from", () => {
  const session = padded([
    assistant("dead", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/tried.ts", old_string: "x", new_string: "y" } },
    ]),
    assistant("live", "pad19", [{ type: "text", text: "different approach" }]),
    assistant("tip", "live", [{ type: "text", text: "done" }]),
  ]);

  const candidates = detectAbandonedApproach(session).filter((c) => c.detail.includes("branch"));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.filePath, "/r/src/tried.ts");
  assert.equal(candidates[0]?.weight, 0.4);
});

test("does not call a truncated history an abandoned branch", () => {
  const session = padded([
    assistant("orphan", "missing-from-this-file", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/kept.ts", old_string: "x", new_string: "y" } },
    ]),
    assistant("tip", "pad19", [{ type: "text", text: "done" }]),
  ]);

  assert.deepEqual(
    detectAbandonedApproach(session).filter((c) => c.detail.includes("branch")),
    [],
  );
});

test("stage 0 returns both categories sorted by position in the session", () => {
  const session = padded([
    assistant("e1", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/app.ts", old_string: "x", new_string: "y" } },
    ]),
    assistant("g", "e1", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "git checkout -- src/app.ts" } }]),
    assistant("e2", "g", [
      {
        type: "tool_use",
        id: "t3",
        name: "Edit",
        input: {
          file_path: "/r/tests/app.test.ts",
          old_string: "expect(a).toBe(1);\nexpect(b).toBe(2);",
          new_string: "expect(a).toBe(1);",
        },
      },
    ]),
  ]);

  const result = runStage0(session);
  assert.equal(result.eligible, true);

  const categories = new Set(result.candidates.map((candidate) => candidate.category));
  assert.ok(categories.has("abandoned_approach"));
  assert.ok(categories.has("test_modified_to_pass"));

  const indices = result.candidates.map((candidate) => candidate.recordIndex);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
});

test("does not read an unchanged rewrite as a return to an earlier state", () => {
  const session = padded([
    assistant("w1", "pad19", [
      { type: "tool_use", id: "t0", name: "Write", input: { file_path: "/r/hook.ts", content: "export const a = 1;\n" } },
    ]),
    assistant("r", "w1", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/r/hook.ts" } }]),
    result("rr", "r", "t1", {
      toolUseResult: {
        file: { filePath: "/r/hook.ts", content: "export const a = 1;\n", numLines: 1, startLine: 1, totalLines: 1 },
      },
    }),
    assistant("w2", "rr", [
      { type: "tool_use", id: "t2", name: "Write", input: { file_path: "/r/hook.ts", content: "export const a = 1;\n" } },
    ]),
  ]);

  assert.deepEqual(detectAbandonedApproach(session), []);
});

test("collapses a git revert that discards many files into one candidate", () => {
  const session = padded([
    assistant("e", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/r/b.ts", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/r/c.ts", old_string: "a", new_string: "b" } },
    ]),
    assistant("g", "e", [
      { type: "tool_use", id: "t4", name: "Bash", input: { command: "git reset --hard origin/main" } },
    ]),
  ]);

  const candidates = detectAbandonedApproach(session);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.filePath, undefined);
  assert.match(candidates[0]?.detail ?? "", /edits to 3 files were discarded .*a\.ts, b\.ts, c\.ts/);
});

test("keeps the file on a git revert that discards a single file", () => {
  const session = padded([
    assistant("e", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "a", new_string: "b" } },
    ]),
    assistant("g", "e", [
      { type: "tool_use", id: "t2", name: "Bash", input: { command: "git checkout -- a.ts" } },
    ]),
  ]);

  const candidates = detectAbandonedApproach(session);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.filePath, "/r/a.ts");
});

test("counts a shell read as having looked at the file", () => {
  const blind = padded([
    assistant("e", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/pricing.ts", old_string: "a", new_string: "b" } },
    ]),
  ]);
  assert.equal(detectUnverifiedAssumption(blind).length, 1);

  const inspected = padded([
    assistant("s", "pad19", [
      { type: "tool_use", id: "t0", name: "Bash", input: { command: "sed -n '1,40p' src/pricing.ts" } },
    ]),
    assistant("e", "s", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/pricing.ts", old_string: "a", new_string: "b" } },
    ]),
  ]);
  assert.deepEqual(detectUnverifiedAssumption(inspected), []);
});

/** One Bash call, with the cwd a real transcript carries on every record. */
function ran(uuid: string, parentUuid: string, command: string, cwd = "/repo"): unknown {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: "s1",
    cwd,
    timestamp: nextTimestamp(),
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `bash-${uuid}`, name: "Bash", input: { command } }],
    },
  };
}

function edited(uuid: string, parentUuid: string, filePath: string, newString = "b"): unknown {
  return assistant(uuid, parentUuid, [
    {
      type: "tool_use",
      id: `edit-${uuid}`,
      name: "Edit",
      input: { file_path: filePath, old_string: "a", new_string: newString },
    },
  ]);
}

test("a file read through a glob counts as read", () => {
  // `cat src/*.js` read src/server.js; a candidate here was a false "never read".
  const session = padded([
    ran("s", "pad19", "cat src/*.js test/*.js README.md"),
    edited("e", "s", "/repo/src/server.js"),
  ]);
  assert.deepEqual(detectUnverifiedAssumption(session), []);

  const elsewhere = padded([ran("s", "pad19", "cat lib/*.js"), edited("e", "s", "/repo/src/server.js")]);
  assert.equal(detectUnverifiedAssumption(elsewhere).length, 1);
});

test("an edit through sed -i is an edit to the detectors", () => {
  // Never read, edited in place: the same assumption an Edit would make.
  const blind = padded([ran("s", "pad19", "sed -i 's/2.34/2.35/' README.md")]);
  const found = detectUnverifiedAssumption(blind);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.filePath, "/repo/README.md");

  // A test rewritten in place right after a failure: what changed is the model's to read.
  const afterFailure = padded([
    ran("t", "pad19", "npm test"),
    result("tr", "t", "bash-t", { toolUseResult: { stdout: "1 test FAILED", stderr: "" } }),
    ran("s", "tr", "sed -i 's/\\[0.02, 0.03\\]/[0.03, 0.02]/' test/money.test.js"),
  ]);
  const weakened = detectTestModifiedToPass(afterFailure);
  assert.equal(weakened.length, 1);
  assert.equal(weakened[0]?.filePath, "/repo/test/money.test.js");
  assert.equal(weakened[0]?.weight, 0.5);

  // The same edit with nothing failing before it is no signal.
  const calm = padded([ran("s", "pad19", "sed -i 's/a/b/' test/money.test.js")]);
  assert.deepEqual(detectTestModifiedToPass(calm), []);
});

test("code edited after the last test run is one note, not one per file", () => {
  const session = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("v", "e1", "npm test"),
    edited("e2", "v", "/repo/src/b.ts"),
    edited("e3", "e2", "/repo/src/c.ts"),
  ]);

  const found = detectUnverifiedFix(session);
  assert.equal(found.length, 1, "one session, one note");
  assert.match(found[0]!.detail, /after the last test or build run/);
  assert.match(found[0]!.detail, /b\.ts, c\.ts/);
  // Anchored at the last unchecked edit, which is where the session stopped looking.
  assert.equal(found[0]!.toolUseId, "edit-e3");
  assert.equal(found[0]!.weight, 0.6);
});

test("a session that verified after its last edit is not flagged", () => {
  const session = padded([edited("e1", "pad19", "/repo/src/a.ts"), ran("v", "e1", "cargo test")]);
  assert.deepEqual(detectUnverifiedFix(session), []);
});

test("a finding about a file outside both the repository and the home is dropped", () => {
  // One edit after the last test run: an unverified_fix that names its file.
  const files = (cwd: string | undefined, filePath: string): (string | undefined)[] => {
    const run =
      cwd === undefined
        ? assistant("v", "pad19", [{ type: "tool_use", id: "bash-v", name: "Bash", input: { command: "npm test" } }])
        : ran("v", "pad19", "npm test", cwd);
    return runStage0(padded([run, edited("e1", "v", filePath)])).candidates.map((found) => found.filePath);
  };

  // On the machine, before masking.
  assert.ok(!files("/home/alice/repo", "/tmp/reset.py").includes("/tmp/reset.py"));
  assert.ok(files("/home/alice/repo", "/home/alice/repo/src/a.py").includes("/home/alice/repo/src/a.py"));
  // A monorepo session started in a subdirectory still edits its siblings.
  assert.ok(files("/home/alice/repo/client", "/home/alice/repo/server/a.py").includes("/home/alice/repo/server/a.py"));

  // On the server the transcript arrives masked, its cwd along with it.
  assert.ok(!files(".", "/tmp/reset.py").includes("/tmp/reset.py"));
  assert.ok(files(".", "src/a.py").includes("src/a.py"));
  assert.ok(files(".", "~/repo/server/a.py").includes("~/repo/server/a.py"));

  // Nothing to judge against: kept.
  assert.ok(files(undefined, "/tmp/reset.py").includes("/tmp/reset.py"));
});

test("a session that never ran anything says so, and ignores tests and prose", () => {
  const session = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    edited("e2", "e1", "/repo/tests/test_a.py"),
    edited("e3", "e2", "/repo/README.md"),
    ran("g", "e3", "git status"),
  ]);

  const found = detectUnverifiedFix(session);
  assert.equal(found.length, 1);
  assert.match(found[0]!.detail, /no test, build or lint command ran/);
  assert.match(found[0]!.detail, /a\.ts/);
  assert.ok(!found[0]!.detail.includes("README"), "prose is not code");
  assert.ok(!found[0]!.detail.includes("test_a"), "a test file has its own category");
});

test("a suppression added to production code is a signal, and one already there is not", () => {
  const added = padded([
    assistant("e", "pad19", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/repo/src/pay.ts",
          old_string: "const id = charge.ref;",
          new_string: "// @ts-ignore\nconst id = charge.ref;",
        },
      },
    ]),
  ]);
  const found = detectErrorSuppressed(added);
  assert.equal(found.length, 1);
  assert.match(found[0]!.detail, /TypeScript error was suppressed/);
  assert.equal(found[0]!.weight, 0.45, "no failing command before it");

  const untouched = padded([
    assistant("e", "pad19", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/repo/src/pay.ts",
          old_string: "// @ts-ignore\nconst id = charge.ref;",
          new_string: "// @ts-ignore\nconst id = charge.reference;",
        },
      },
    ]),
  ]);
  assert.deepEqual(detectErrorSuppressed(untouched), []);
});

test("a check whose failure is thrown away is a signal, a cleanup line is not", () => {
  const discarded = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", "npm test || true"),
  ]);
  assert.equal(detectErrorSuppressed(discarded).length, 1);

  const cleanup = padded([edited("e1", "pad19", "/repo/src/a.ts"), ran("b", "e1", "pkill node || true")]);
  assert.deepEqual(detectErrorSuppressed(cleanup), []);
});

/** `content` written over a file, right after a command that failed or, with `failing` off, passed. */
/** A command's result, with the exit status the transcript records as `is_error`. */
function ranAndGot(command: string, stdout: string, isError: boolean): unknown[] {
  return [
    ran("b", "pad19", command),
    result("br", "b", "bash-b", {
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-b", content: stdout, is_error: isError }] },
      toolUseResult: { stdout, stderr: "" },
    }),
  ];
}

function writtenAfterCheck(content: string, failing = true, filePath = "/repo/src/config.js"): ParsedSession {
  return padded([
    ...ranAndGot("npm run check", failing ? "check FAILED" : "all good", failing),
    assistant("w", "br", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: filePath, content } }]),
  ]);
}

test("a catch left only logging right after a failing command is a signal", () => {
  const swallowed = [
    // What gets a release gate green over a broken config.
    `export function loadConfig(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    // TEMP: the file is truncated upstream.
    console.warn(\`WARNING: cannot load \${path}: \${err.message}\`);
    return null;
  }
}`,
    "try { x(); } catch { logger.error('no'); }",
    "try { x(); } catch (e) {\n  console.error(\n    `long message ${e.message}`,\n    e,\n  );\n  return [];\n}",
    "try { x(); } catch (IOException e) {\r\n  log.warn(\"x\", e);\r\n  return;\r\n}",
  ];
  for (const content of swallowed) {
    const found = detectErrorSuppressed(writtenAfterCheck(content));
    assert.equal(found.length, 1, content);
    assert.equal(found[0]!.detail, "an exception is caught and only logged, shortly after a failing command");
    assert.equal(found[0]!.weight, 0.7);
  }

  const python = "try:\n    x()\nexcept ValueError as e:\n    # note\n    logger.warning('x %s', e)\n    return None\n";
  assert.equal(detectErrorSuppressed(writtenAfterCheck(python, true, "/repo/src/config.py")).length, 1);
});

test("a catch that only logs is everyday code with no failure before it", () => {
  const content = "try { x(); } catch (e) { console.warn(e); return null; }";
  assert.deepEqual(detectErrorSuppressed(writtenAfterCheck(content, false)), []);
});

test("a catch that does something with the failure is no signal, even right after one", () => {
  const handled = [
    "try { x(); } catch (e) { console.warn(e); throw e; }",
    "try { x(); } catch (e) { console.error(e); process.exit(1); }",
    "try { x(); } catch (e) { console.warn(e); doMore(); return null; }",
    "try { x(); } catch (e) { console.warn(e)\n  doMore()\n}",
    "try { x(); } catch (e) { logger.error(e); return { ok: false, error: e }; }",
    "try { x(); } catch { return undefined; }",
    "promise.catch(report);",
  ];
  for (const content of handled) assert.deepEqual(detectErrorSuppressed(writtenAfterCheck(content)), [], content);

  for (const content of [
    "except ValueError as e:\n    logger.warning(e)\n    raise\n",
    "except ValueError as e:\n    logger.warning(e)\n    return compute()\n",
    "except ValueError as e:\n    logger.warning(e)\n    retry()\n    return None\n",
    "except ValueError:\n    return None\n",
  ]) {
    assert.deepEqual(detectErrorSuppressed(writtenAfterCheck(content, true, "/repo/src/config.py")), [], content);
  }

  // Already there before the edit: not what this edit did about the failure.
  const kept = "try { x(); } catch (e) { console.warn(e); return null; }";
  const session = padded([
    ...ranAndGot("npm run check", "check FAILED", true),
    assistant("e", "br", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/src/a.js", old_string: `${kept}\nold();`, new_string: `${kept}\nnew();` } },
    ]),
  ]);
  assert.deepEqual(detectErrorSuppressed(session), []);

  // A test file has its own category.
  assert.deepEqual(detectErrorSuppressed(writtenAfterCheck(kept, true, "/repo/src/config.test.js")), []);
});

test("a catch that only logs counts after a check failed, not after a word or a search that found nothing", () => {
  const content = "try { x(); } catch (e) { console.warn(e); return null; }";
  const written = (command: string, stdout: string, isError: boolean): ParsedSession =>
    padded([
      ...ranAndGot(command, stdout, isError),
      assistant("w", "br", [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "/repo/src/a.js", content } }]),
    ]);

  for (const [command, stdout, isError] of [
    ["cargo test", "test result: ok. 12 passed; 0 failed; 0 ignored", false],
    ["pytest -q", "12 passed, 0 failed in 0.3s", false],
    ["sed -n 1,40p src/upload.ts", 'if (!ok) console.error("upload failed");', false],
    ["git log --oneline -5", "abc123 fix failed retry in the queue", false],
    ["grep -rq TODO src", "", true],
    ["grep -rq 'npm test' .github", "", true],
    ["ls missing", "ls: cannot access 'missing'", true],
    ["cat <<'EOF' > notes.txt\nnpm test\nEOF\nfalse", "", true],
  ] as const) {
    assert.deepEqual(detectErrorSuppressed(written(command, stdout, isError)), [], command);
  }

  for (const command of [
    "cargo test",
    "cat package.json && npm test",
    "cat <<'EOF' > fixture.json\n{}\nEOF\nnpm run check 2>&1 | tail -5",
  ]) {
    assert.equal(detectErrorSuppressed(written(command, "", true)).length, 1, command);
  }
});

test("a silent catch given a log line is no signal, even right after a failed check", () => {
  for (const [file_path, old_string, new_string] of [
    ["/repo/src/a.js", "catch (err) {}", "catch (err) { console.error(err); }"],
    ["/repo/src/a.py", "except OSError:\n    pass\n", "except OSError as e:\n    logger.error(e)\n    return None\n"],
  ]) {
    const session = padded([
      ...ranAndGot("npm run check", "check FAILED", true),
      assistant("e", "br", [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path, old_string, new_string } }]),
    ]);
    assert.deepEqual(detectErrorSuppressed(session), [], file_path);
  }
});

test("a catch that only logs in a document or in a string is no signal, even right after a failed check", () => {
  const fenced = "```js\ntry { x(); } catch (e) { console.warn(e); return null; }\n```\n";
  assert.deepEqual(detectErrorSuppressed(writtenAfterCheck(fenced, true, "/repo/docs/guide.md")), []);

  for (const content of [
    `const help = "use try { x() } catch (e) { console.log(e) } here";`,
    `const help = 'use try { x() } catch (e) { console.log(e) } here';`,
    "const help = `use try { x() } catch (e) { console.log(e) } here`;",
  ]) {
    assert.deepEqual(detectErrorSuppressed(writtenAfterCheck(content)), [], content);
  }
});

test("the rules for a catch that only logs get through 200 KB of text built to stall them", () => {
  const size = 200_000;
  const fill = (unit: string): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const shapes = [
    `catch${" ".repeat(size)}`,
    `catch${"\n".repeat(size)}`,
    fill("catch("),
    `catch(x)${" ".repeat(size)}`,
    `catch{${" ".repeat(size)}`,
    `catch{${"//".repeat(size / 2)}`,
    `catch{// ${fill("// ")}\n`,
    `catch{${fill("// x\n")}`,
    fill("catch{//"),
    fill("catch { // "),
    fill("catch {\n// "),
    fill("// } catch {\n//   other();\n// }\n"),
    fill("catch{console.log("),
    `catch{console.log(${"\n".repeat(size)}`,
    `catch{console.log(${")".repeat(size)}`,
    `catch{console.log(x)${" ".repeat(size)}`,
    `catch{console.log(x);return${" ".repeat(size)}`,
    `catch{console.log(x);return null${" ".repeat(size)}`,
    fill("except:\n"),
    `except${" ".repeat(size)}`,
    `except:\n${fill("    # x\n")}`,
    fill("except:\nprint("),
    `except:\nprint(${")".repeat(size)}`,
    `except:\nprint(x)\nreturn${" ".repeat(size)}`,
    `${" ".repeat(size)}except`,
  ];
  for (const text of shapes) {
    for (const { pattern } of LOG_ONLY_CATCHES) {
      const started = performance.now();
      text.match(pattern);
      const took = performance.now() - started;
      assert.ok(took < 1000, `took ${Math.round(took)}ms on ${JSON.stringify(text.slice(0, 24))}…`);
    }
  }
});

test("the rules for a dropped exception get through 200 KB of text built to stall them", () => {
  const size = 200_000;
  const fill = (unit: string): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const shapes = [
    `catch${" ".repeat(size)}`,
    `catch${"\n".repeat(size)}`,
    fill("catch("),
    `catch(x)${" ".repeat(size)}`,
    `catch{${" ".repeat(size)}`,
    fill(`catch${" ".repeat(400)}`),
    fill("catch(x"),
    fill(`catch(${"x".repeat(1200)}`),
    fill("except:# "),
    `except:${"\n".repeat(size)}`,
    `except:${" ".repeat(size)}`,
    `except:\n${"\n".repeat(size)}`,
    fill("except x"),
    fill("except:#"),
    fill(`except:${"\n".repeat(400)}`),
    `rescue${"\n".repeat(size)}`,
    `rescue${" ".repeat(size)}`,
    `rescue =>${" ".repeat(size)}`,
    `rescue => a${"\n".repeat(size)}`,
    fill("rescue => a"),
    fill(`rescue${"\n".repeat(400)}`),
  ];
  for (const text of shapes) {
    for (const { pattern } of SUPPRESSORS) {
      const started = performance.now();
      text.match(pattern);
      const took = performance.now() - started;
      assert.ok(took < 1000, `took ${Math.round(took)}ms on ${JSON.stringify(text.slice(0, 24))}…`);
    }
  }
});

test("the rules for a dropped exception read a long line as well as a short one", () => {
  const tuple = Array.from({ length: 25 }, (_, index) => `SomeLongError${index}`).join(", ");
  for (const [filePath, content] of [
    ["/repo/src/a.py", `try:\n    a()\nexcept (${tuple}):\n    pass\n`],
    ["/repo/src/a.py", `try:\n    a()\nexcept OSError:  # ${"x".repeat(500)}\n    pass\n`],
    ["/repo/src/a.ts", `try { a(); } catch (e: ${"T".repeat(300)}) {}`],
    ["/repo/src/a.ts", `try { a(); } catch (e: ${"T".repeat(5000)}) {}`],
  ] as const) {
    const found = detectErrorSuppressed(writtenAfterCheck(content, false, filePath));
    assert.equal(found[0]?.detail, "an exception is caught and dropped", content.slice(0, 40));
  }
});

test("a recursive delete is reported, unless the path grows back on its own", () => {
  const real = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", "rm -rf src/generated"),
  ]);
  const found = detectDestructiveCommand(real);
  assert.equal(found.length, 1);
  assert.match(found[0]!.detail, /deleted recursively: src\/generated/);

  const rebuilt = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", "rm -rf node_modules dist && npm ci"),
  ]);
  assert.deepEqual(detectDestructiveCommand(rebuilt), []);
});

test("the pattern has to be a command, not text a command carries", () => {
  // The corpus is full of both: a grep for the phrase, and a path outside the
  // repository that the pull request has no stake in.
  const quoted = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", "grep -rn 'rm -rf' scripts/ && echo 'DROP TABLE users'"),
  ]);
  assert.deepEqual(detectDestructiveCommand(quoted), []);

  const elsewhere = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", "rm -rf ~/android"),
  ]);
  assert.deepEqual(detectDestructiveCommand(elsewhere), []);
});

test("a destructive database command is reported wherever it ran", () => {
  const dropped = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", 'psql -c "DROP DATABASE IF EXISTS shop_dev"'),
    ran("c", "b", 'sqlite3 app.db "DELETE FROM sessions"'),
  ]);

  const found = detectDestructiveCommand(dropped);
  assert.equal(found.length, 2);
  assert.match(found[0]!.detail, /database object was dropped/);
  assert.match(found[1]!.detail, /no WHERE clause/);
});

test("one git reset is one note, under the category that explains it", () => {
  const session = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", "git reset --hard HEAD"),
  ]);

  const categories = runStage0(session).candidates.map((candidate) => candidate.category);
  assert.deepEqual(categories.filter((c) => c === "destructive_command"), []);
  assert.ok(categories.includes("abandoned_approach"));
});

/** One Read call, the way the agent looks a file up before touching it. */
function read(uuid: string, parentUuid: string, filePath: string): unknown {
  return assistant(uuid, parentUuid, [
    { type: "tool_use", id: `read-${uuid}`, name: "Read", input: { file_path: filePath } },
  ]);
}

test("an edit written after a long break, on a file read before it, is stale context", () => {
  const records: unknown[] = [read("r", "pad19", "/repo/src/api.ts")];
  // 45 minutes of nothing. One tick is spent by the record that follows.
  clock += 44;
  records.push(edited("e", "r", "/repo/src/api.ts"));

  const candidates = detectStaleContext(padded(records));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.category, "stale_context");
  assert.equal(candidates[0]?.filePath, "/repo/src/api.ts");
  assert.match(candidates[0]!.detail, /a 45m break and edited api\.ts/);
});

test("one note per break, however many files the agent went on to edit", () => {
  const records: unknown[] = [read("r1", "pad19", "/repo/src/a.ts"), read("r2", "r1", "/repo/src/b.ts")];
  clock += 44;
  records.push(edited("e1", "r2", "/repo/src/a.ts"));
  records.push(edited("e2", "e1", "/repo/src/b.ts"));

  assert.equal(detectStaleContext(padded(records)).length, 1);
});

test("many breaks in one session are one note that says how many", () => {
  const records: unknown[] = [read("r1", "pad19", "/repo/src/a.ts"), read("r2", "r1", "/repo/src/b.ts")];
  clock += 44;
  records.push(edited("e1", "r2", "/repo/src/a.ts"));
  // A second break, and the agent picks up b.ts on what it read before both.
  clock += 90;
  records.push(edited("e2", "e1", "/repo/src/b.ts"));

  const candidates = detectStaleContext(padded(records));

  assert.equal(candidates.length, 1);
  // The longest break is the one printed, and both files are named.
  assert.match(candidates[0]!.detail, /a 1h31 break and edited a\.ts, b\.ts without reading them again/);
  assert.match(candidates[0]!.detail, /2 breaks in this session/);
  assert.equal(candidates[0]?.filePath, "/repo/src/b.ts");
});

test("a break is only stale context when the agent came back without looking again", () => {
  const rechecked: unknown[] = [read("r", "pad19", "/repo/src/api.ts")];
  clock += 44;
  rechecked.push(read("r2", "r", "/repo/src/api.ts"));
  rechecked.push(edited("e", "r2", "/repo/src/api.ts"));
  assert.deepEqual(detectStaleContext(padded(rechecked)), []);

  // Never read at all is `unverified_assumption`, and one edit must not be two notes.
  const blind: unknown[] = [ran("b", "pad19", "npm test")];
  clock += 44;
  blind.push(edited("e", "b", "/repo/src/api.ts"));
  assert.deepEqual(detectStaleContext(padded(blind)), []);

  // A few minutes is the developer reading the diff before approving the call.
  const brief: unknown[] = [read("r", "pad19", "/repo/src/api.ts")];
  clock += 5;
  brief.push(edited("e", "r", "/repo/src/api.ts"));
  assert.deepEqual(detectStaleContext(padded(brief)), []);
});

test("SQL inside a search pattern or a substitution is text, not a migration", () => {
  // Both shapes come straight off the corpus: an alternation in a grep pattern,
  // and a grep whose output is an argument to something else.
  const alternation = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", 'grep -rn "DELETE FROM|DROP TABLE" src'),
  ]);
  assert.deepEqual(detectDestructiveCommand(alternation), []);

  const substitution = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", 'node check.js $(grep -rl "DROP INDEX" .)'),
  ]);
  assert.deepEqual(detectDestructiveCommand(substitution), []);

  // The real thing still reports.
  const real = padded([
    edited("e1", "pad19", "/repo/src/a.ts"),
    ran("b", "e1", 'sqlite3 data/app.db "DELETE FROM sessions;"'),
  ]);
  assert.equal(detectDestructiveCommand(real).length, 1);
});

function writtenThenEdited(content: string, edits: object[]): ParsedSession {
  return padded([
    assistant("w", "pad19", [{ type: "tool_use", id: "w0", name: "Write", input: { file_path: "/r/a.txt", content } }]),
    ...edits.map((edit, i) =>
      assistant(`e${i}`, i === 0 ? "w" : `e${i - 1}`, [
        { type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: "/r/a.txt", ...edit } },
      ]),
    ),
  ]);
}

test("a file doubled over and over stops being followed before it takes the heap", () => {
  const doubling = { old_string: "\n", new_string: "\n\n", replace_all: true };
  const session = writtenThenEdited("\n", Array.from({ length: 40 }, () => doubling));
  assert.deepEqual(detectAbandonedApproach(session), []);
});

test("a large file edited over and over stops being followed before it takes minutes", () => {
  const edits = Array.from({ length: 1000 }, (_, i) => ({ old_string: i % 2 ? "b" : "a", new_string: i % 2 ? "a" : "b" }));
  const session = writtenThenEdited(`a${"\n".repeat(4_000_000)}`, edits);
  const started = performance.now();
  detectAbandonedApproach(session);
  const took = performance.now() - started;
  assert.ok(took < 5000, `took ${took} ms`);
});

test("a long edit that almost repeats is looked for in time proportional to the file", () => {
  const half = "a".repeat(50_000);
  const session = writtenThenEdited("a".repeat(400_000), [{ old_string: `${half}b${half}`, new_string: "c" }]);
  const started = performance.now();
  assert.deepEqual(detectAbandonedApproach(session), []);
  const took = performance.now() - started;
  assert.ok(took < 1000, `took ${took} ms`);
});

test("an edit's new text is literal, as the tool that made it", () => {
  const candidates = detectAbandonedApproach(
    writtenThenEdited("a b", [
      { old_string: "a", new_string: "$&x" },
      { old_string: "$&", new_string: "a" },
      { old_string: "x", new_string: "" },
    ]),
  );
  assert.deepEqual(candidates.map((candidate) => candidate.category), ["abandoned_approach"]);
});

test("replace_all takes occurrences from the left without overlap, and a plain edit only the first", () => {
  const back = (edit: object, after: string): number =>
    detectAbandonedApproach(writtenThenEdited("aaaaa", [edit, { old_string: after, new_string: "aaaaa" }])).length;
  assert.equal(back({ old_string: "aa", new_string: "b", replace_all: true }, "bba"), 1);
  assert.equal(back({ old_string: "aa", new_string: "b" }, "baaa"), 1);
  assert.equal(back({ old_string: "aa", new_string: "b" }, "bba"), 0);
});

function readThenEdited(glob: string, filePath: string): ParsedSession {
  return padded([read("r", "pad19", glob), edited("e", "r", filePath)]);
}

test("what a glob read covers of an edited file", () => {
  const covers: [string, string, boolean][] = [
    ["src/*.js", "/repo/src/a.js", true],
    ["src/*.js", "/repo/src/lib/a.js", false],
    ["*.js", "/repo/lib/a.js", true],
    ["src/**/*.js", "/repo/src/a.js", true],
    ["src/**/*.js", "/repo/src/lib/deep/a.js", true],
    ["src/**/*.js", "/repo/other/a.js", false],
    ["**/a.js", "/repo/a.js", true],
    ["/repo/*.js", "/repo/a.js", true],
    ["/repo/*.js", "/other/repo/a.js", false],
    ["/repo/**", "/repo/x/y.js", true],
    ["a?.js", "/repo/ab.js", true],
    ["a?.js", "/repo/a/.js", false],
    ["src/a*b*c.js", "/repo/src/axbyc.js", true],
    ["src/a*b*c.js", "/repo/src/axbyd.js", false],
    ["s*c/*.js", "/repo/src/a.js", true],
    ["s*/**/z.js", "/repo/src/a/b/z.js", true],
    ["re.o/*.js", "/repo/re.o/a.js", true],
    ["re.o/*.js", "/repo/rexo/a.js", false],
    ["a**/b.js", "/repo/ax/y/b.js", true],
    ["a*a*b.js", "/repo/aaab.js", true],
    ["src/*/a.js", "/repo/src/x/y/a.js", false],
  ];
  for (const [glob, filePath, covered] of covers) {
    const found = detectUnverifiedAssumption(readThenEdited(glob, filePath));
    assert.equal(found.length === 0, covered, `${glob} over ${filePath}`);
  }
});

test("a read of many stars is held up to an edit in time proportional to it", () => {
  const started = performance.now();
  const found = detectUnverifiedAssumption(readThenEdited(`${"*a".repeat(6)}*b`, `/${"a".repeat(60)}`));
  const took = performance.now() - started;
  assert.equal(found.length, 1);
  assert.ok(took < 1000, `took ${took} ms`);
});

test("a read of more stars than a pattern can hold is a read like any other", () => {
  assert.equal(detectUnverifiedAssumption(readThenEdited(`${"*".repeat(128000)}a.js`, "/repo/a.js")).length, 0);
  assert.equal(detectUnverifiedAssumption(readThenEdited(`${"*?".repeat(64000)}b`, "/repo/a.js")).length, 1);
});

test("many long globs against many long paths give up rather than take hours", () => {
  const records: unknown[] = [];
  const stretch = "a".repeat(2000);
  for (let i = 0; i < 40; i += 1) records.push(read(`r${i}`, i === 0 ? "pad19" : `r${i - 1}`, `/**${stretch}${i}b`));
  for (let i = 0; i < 40; i += 1) records.push(edited(`e${i}`, i === 0 ? "r39" : `e${i - 1}`, `/${stretch}${stretch}${i}`));
  const session = padded(records);
  const started = performance.now();
  detectUnverifiedAssumption(session);
  detectStaleContext(session);
  const took = performance.now() - started;
  assert.ok(took < 5000, `took ${took} ms`);
});

test("a failed check is read once, not again for each edit after it", () => {
  const command = `npm test ${"a ".repeat(150_000)}`;
  const edits = Array.from({ length: 300 }, (_, i) => ({ type: "tool_use", id: `e${i}`, name: "Edit", input: { file_path: "/repo/src/a.ts", old_string: "a", new_string: "b" } }));
  const session = padded([
    assistant("c", "pad19", [{ type: "tool_use", id: "bash", name: "Bash", input: { command } }]),
    result("cr", "c", "bash", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash", content: "failed", is_error: true }] } }),
    assistant("e", "cr", edits),
  ]);
  const started = performance.now();
  detectErrorSuppressed(session);
  const took = performance.now() - started;
  assert.ok(took < 3000, `took ${took} ms`);
});

function assertQuick(label: string, run: () => unknown): void {
  const started = performance.now();
  run();
  const took = performance.now() - started;
  assert.ok(took < 2000, `${label} took ${Math.round(took)} ms`);
}

test("a manifest of blank lines or of an open table is read in time proportional to it", () => {
  for (const [file, text] of [
    ["requirements.txt", "\n".repeat(40_000)],
    ["requirements.txt", " \n".repeat(40_000)],
    ["pyproject.toml", "\n".repeat(40_000)],
    ["pyproject.toml", ` ${"\n ".repeat(40_000)}`],
    ["pyproject.toml", `[${" ".repeat(3_000)}`],
  ] as const) {
    assertQuick(`${file} of ${JSON.stringify(text.slice(0, 2))}`, () => addedDependencies(`/r/${file}`, "", text));
  }
});

test("a dependency is found behind blank lines and indentation, and a table however it is spaced", () => {
  assert.deepEqual(
    addedDependencies("/r/requirements.txt", "", "\n\n  \n\trequests==2.31.0\r\n\r\n\u00a0flask>=2\n\ufeffclick~=8\n"),
    ["click", "flask", "requests"],
  );
  assert.deepEqual(addedDependencies("/r/Gemfile", "", "\n \n  gem 'rails'\n"), ["rails"]);
  assert.deepEqual(addedDependencies("/r/go.mod", "", "\n \n  require github.com/a/b v1.0.0\n"), ["github.com/a/b"]);
  assert.deepEqual(
    addedDependencies("/r/Cargo.toml", "", '\n\n[ dependencies ]  # pinned\n\n  serde = "1.0"\n\n[[ bin ]]\nclap = "4"\n'),
    ["serde"],
  );
  assert.deepEqual(addedDependencies("/r/Cargo.toml", "", '\n \n  "serde" = "1.0"\n'), ["serde"]);
  assert.deepEqual(addedDependencies("/r/pyproject.toml", "", '\n\n[ project ]\n\n  dependencies = ["click"]\n'), ["click"]);
});

test("a command that says one thing over and over is read in time proportional to it", () => {
  const destructive = (command: string) => detectDestructiveCommand(padded([ran("b", "pad19", command)]));
  assertQuick("a run of dots", () => installedPackages(`npm install ${".".repeat(100_000)}a`));
  assertQuick("a run of spaces after a delete", () => destructive(`DELETE FROM a${" ".repeat(100_000)}x`));
  assertQuick("many pushes", () => destructive("git push ".repeat(20_000)));
  assertQuick("a run of spaces after a push", () => destructive(`git push${" ".repeat(40_000)}${"x".repeat(40_000)}`));
});

test("a package, a delete and a force push are found however they are spaced", () => {
  assert.deepEqual(installedPackages("npm install left-pad, and more")?.packages, ["left-pad"]);
  assert.deepEqual(installedPackages("npm install left-pad...")?.packages, ["left-pad"]);
  assert.equal(installedPackages("npm install ...a"), undefined);

  for (const [command, fires, detail] of [
    ["DELETE FROM a", true, "no WHERE clause"],
    ["delete from a ;", true, "no WHERE clause"],
    ['psql -c "DELETE FROM a  "  ', true, "no WHERE clause"],
    ["psql -c 'DELETE FROM a'", true, "no WHERE clause"],
    ["DELETE FROM a WHERE b", false, "no WHERE clause"],
    ["git push origin main --force", true, "force-pushed"],
    ["git  push \t origin --force", true, "force-pushed"],
    ["git push origin -f", true, "force-pushed"],
    ["git push  -f", true, "force-pushed"],
    ["git push a git push b --force", true, "force-pushed"],
    ["git push --force-with-lease git push --force", true, "force-pushed"],
    ["git push a git push -f", true, "force-pushed"],
    ["git push git push git push -f", true, "force-pushed"],
    ["git push origin --force-with-lease", false, "force-pushed"],
    ["git push origin main", false, "force-pushed"],
  ] as const) {
    const found = detectDestructiveCommand(padded([ran("b", "pad19", command)]));
    assert.equal(found.some((candidate) => candidate.detail.includes(detail)), fires, command);
  }
});

test("a discard is held up to a session's files once, however many paths it names", () => {
  const files = Array.from({ length: 200 }, (_, index) => edited(`e${index}`, "pad19", `/r/f${index}.ts`));
  const discards = Array.from({ length: 8 }, (_, index) => ran(`g${index}`, "e199", `git checkout ${"z ".repeat(20_000)}`));
  const session = padded([...files, ...discards]);
  assertQuick("many paths", () => detectAbandonedApproach(session));
});

test("a discard goes by the last part of a path, in or out of quotes", () => {
  for (const [command, fires] of [
    ["git checkout -- src/app.ts", true],
    ["git checkout -- ./src/app.ts", true],
    ["git checkout -- app.ts", true],
    ["git checkout -- other/app.ts", true],
    ['git restore "src/app.ts"', true],
    ["git restore 'app.ts' b.ts", true],
    ["git restore b.ts app.ts", true],
    ["git checkout -- .", true],
    ["git restore '*'", true],
    ["git checkout -- src/app.tsx", false],
    ["git restore pp.ts", false],
    ["git restore src/", false],
  ] as const) {
    const session = padded([edited("e", "pad19", "/r/src/app.ts"), ran("g", "e", command)]);
    const found = detectAbandonedApproach(session).filter((candidate) => candidate.detail.includes("git command"));
    assert.equal(found.length, fires ? 1 : 0, command);
  }
});

test("the rule for a dropped exception looks from one except as far as the next", () => {
  const rule = SUPPRESSORS.find(({ pattern }) => pattern.source.startsWith("except"))!;
  assertQuick("many excepts", () => "except ".repeat(1_000_000).match(rule.pattern));
  for (const [text, count] of [
    ["except except:\n    pass\n", 1],
    ["except (exceptions.A, exceptions.B):\n    pass\n", 1],
    ["except A:  # except this\n    pass\n", 1],
    ["except A: x\nexcept B:\n    pass\nexcept C:\n    pass\n", 2],
  ] as const) {
    assert.equal(text.match(rule.pattern)?.length, count, text);
  }
});

test("what a command printed is looked through once, not again for each edit after it", () => {
  const printed = "x".repeat(16_000_000);
  const session = padded([
    ran("c", "pad19", "true"),
    result("cr", "c", "bash-c", { toolUseResult: { stdout: printed, stderr: printed } }),
    ran("s", "cr", `sed -i x ${"tests/a.ts ".repeat(1000)}`),
  ]);
  assertQuick("many edits", () => assert.deepEqual(detectTestModifiedToPass(session), []));
});

test("a long edit is held up to the ones before it in time proportional to them", () => {
  const stretch = "q".repeat(1400);
  const steps = Array.from({ length: 8000 }, () => ({ old_string: `${stretch}1`, new_string: `${stretch}2` }));
  const session = padded([assistant("m", "pad19", [{ type: "tool_use", id: "t1", name: "MultiEdit", input: { file_path: "/r/a.ts", edits: steps } }])]);
  assertQuick("many steps", () => assert.deepEqual(detectAbandonedApproach(session), []));
});

test("an edit undoes one before it only if each one's two sides are the other's", () => {
  const editing = (uuid: string, parent: string, old_string: string, new_string: string): unknown =>
    assistant(uuid, parent, [{ type: "tool_use", id: `t-${uuid}`, name: "Edit", input: { file_path: "/r/a.ts", old_string, new_string } }]);
  const undone = (first: [string, string], second: [string, string]): number =>
    detectAbandonedApproach(padded([editing("e1", "pad19", ...first), editing("e2", "e1", ...second)])).length;
  assert.equal(undone(["ab", "c"], ["c", "ab"]), 1);
  assert.equal(undone(["ab", "c"], ["bc", "a"]), 0);
  assert.equal(undone(["ab", "c"], ["ab", "c"]), 0);
});

test("a discard takes the last part of each file's path once, however many discards there are", () => {
  const stretch = "p".repeat(5000);
  const files = Array.from({ length: 500 }, (_, index) => edited(`e${index}`, "pad19", `/${stretch}${index}`));
  const discards = Array.from({ length: 2000 }, (_, index) => ran(`g${index}`, "e499", "git checkout z"));
  const session = padded([...files, ...discards]);
  assertQuick("many long paths", () => detectAbandonedApproach(session));
});

test("a discard names the first edit of each file it took back, not one made after it", () => {
  const session = padded([ran("g", "pad19", "git checkout a.ts"), edited("e1", "g", "/r/a.ts")]);
  assert.deepEqual(detectAbandonedApproach(session).filter((c) => c.detail.includes("discarded")), []);
  const taken = padded([edited("e1", "pad19", "/r/a.ts"), ran("g", "e1", "git checkout a.ts"), edited("e2", "g", "/r/a.ts")]);
  assert.deepEqual(
    detectAbandonedApproach(taken).filter((c) => c.detail.includes("discarded")).map((c) => c.filePath),
    ["/r/a.ts"],
  );
});

test("a side chain is walked once, however many edits stand on it", () => {
  const records: unknown[] = [];
  const parentOf = (index: number): string => (index === 0 ? "pad19" : `c${index - 1}`);
  for (let index = 0; index < 60_000; index += 1) records.push(assistant(`c${index}`, parentOf(index), [{ type: "text", text: "x" }]));
  for (let index = 0; index < 2000; index += 1) records.push(edited(`e${index}`, index === 0 ? "c59999" : `e${index - 1}`, "/r/a.ts"));
  records.push(assistant("live", "pad19", [{ type: "text", text: "different approach" }]));
  records.push(assistant("tip", "live", [{ type: "text", text: "done" }]));
  const session = padded(records);
  let found = 0;
  assertQuick("a long chain", () => {
    found = detectAbandonedApproach(session).filter((c) => c.detail.includes("branch")).length;
  });
  assert.equal(found, 1);
});

test("many long reads against many edited files give up rather than take minutes, but for the path itself", () => {
  const stretch = "r".repeat(1000);
  const reads = Array.from({ length: 5000 }, (_, index) => read(`r${index}`, index === 0 ? "pad19" : `r${index - 1}`, `${stretch}${index}`));
  const files = Array.from({ length: 1000 }, (_, index) => edited(`e${index}`, index === 0 ? "last" : `e${index - 1}`, `/r/f${index}.ts`));
  const session = padded([...reads, read("last", "r4999", "/r/f999.ts"), ...files]);
  let found: unknown[] = [];
  assertQuick("long reads", () => {
    found = detectUnverifiedAssumption(session);
  });
  assert.equal(found.length, 999);
});

test("many reads that share a long start with many edited files give up rather than take minutes", () => {
  const stretch = "/".concat("r".repeat(2000));
  const reads = Array.from({ length: 5000 }, (_, index) => read(`r${index}`, index === 0 ? "pad19" : `r${index - 1}`, `${stretch}${index}`));
  const files = Array.from({ length: 1000 }, (_, index) => edited(`e${index}`, index === 0 ? "r4999" : `e${index - 1}`, `${stretch}/f${index}.ts`));
  const session = padded([...reads, ...files]);
  assertQuick("shared starts", () => detectUnverifiedAssumption(session));
});

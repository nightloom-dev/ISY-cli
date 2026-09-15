import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLines } from "../parser.js";
import {
  detectAbandonedApproach,
  detectDestructiveCommand,
  detectErrorSuppressed,
  detectStaleContext,
  detectTestModifiedToPass,
  detectUnverifiedAssumption,
  detectUnverifiedFix,
  isTestFile,
  weakensTest,
} from "../detectors.js";
import { MIN_ASSISTANT_RECORDS, eligibility, runStage0 } from "../stage0.js";
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

function padded(records: unknown[]): ParsedSession {
  const filler: unknown[] = [];
  for (let i = 0; i < MIN_ASSISTANT_RECORDS; i += 1) {
    filler.push(assistant(`pad${i}`, i === 0 ? null : `pad${i - 1}`, [{ type: "text", text: "x" }]));
  }
  return build([...filler, ...records]);
}

test("rejects a session with too few assistant records", () => {
  const session = build([
    assistant("a", null, [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" } },
    ]),
  ]);
  assert.equal(eligibility(session), "too-short");
  assert.deepEqual(runStage0(session).candidates, []);
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

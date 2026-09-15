import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  commandSegments,
  onMainPath,
  parseLines,
  parseTranscriptFile,
  shellReadPaths,
  shellWrites,
  withoutHeredocs,
} from "../parser.js";

function jsonl(records: unknown[]): string[] {
  return records.map((record) => JSON.stringify(record));
}

function assistant(uuid: string, parentUuid: string | null, content: unknown[]) {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: "s1",
    timestamp: "2026-08-14T09:00:00Z",
    cwd: "/repo",
    gitBranch: "feat/x",
    version: "2.0.0",
    message: { role: "assistant", content },
  };
}

function toolResult(uuid: string, parentUuid: string, toolUseId: string, extra: object = {}) {
  return {
    type: "user",
    uuid,
    parentUuid,
    sessionId: "s1",
    timestamp: "2026-08-14T09:00:01Z",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "ok" }],
    },
    ...extra,
  };
}

test("survives malformed lines without losing valid records", () => {
  const lines = [
    ...jsonl([assistant("a", null, [{ type: "text", text: "hi" }])]),
    "\0\0\0\0",
    "",
    "   ",
    "[1,2,3]",
    ...jsonl([assistant("b", "a", [{ type: "text", text: "bye" }])]),
  ];

  const session = parseLines(lines);

  assert.equal(session.records.length, 2);
  assert.equal(session.skipped.malformedJson, 1);
  assert.equal(session.skipped.notAnObject, 1);
  assert.equal(session.skipped.blank, 2);
  assert.equal(session.skipped.lines, 6);
});

test("keeps records whose type is absent from the known set", () => {
  const session = parseLines(jsonl([
    { type: "bridge-session", sessionId: "s1" },
    { type: "brand-new-type", sessionId: "s1" },
    { sessionId: "s1" },
  ]));

  assert.equal(session.records.length, 3);
  assert.deepEqual(session.skipped.unknownTypes, { "brand-new-type": 1, unknown: 1 });
});

test("reads message.content when it is a plain string", () => {
  const session = parseLines(jsonl([
    { type: "user", uuid: "a", parentUuid: null, message: { role: "user", content: "plain text" } },
  ]));

  assert.equal(session.blocks.length, 1);
  assert.equal(session.blocks[0]?.type, "text");
  assert.equal(session.blocks[0]?.text, "plain text");
});

test("links a tool_use to its tool_result and normalizes stdout and stderr", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } },
    ]),
    {
      ...toolResult("b", "a", "toolu_1"),
      toolUseResult: { stdout: "1 failed", stderr: "AssertionError", interrupted: false },
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "FAILED" },
        ],
      },
    },
  ]));

  const use = session.toolUses[0];
  assert.equal(use?.name, "Bash");
  assert.equal(use?.input.command, "npm test");
  assert.equal(use?.result?.isError, true);
  assert.equal(use?.result?.text, "FAILED");
  assert.equal(use?.result?.stdout, "1 failed");
  assert.equal(use?.result?.stderr, "AssertionError");
  assert.equal(use?.result?.recordIndex, 1);
});

test("accepts a tool_result whose content is an array of text parts", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/a.ts" } }]),
    {
      ...toolResult("b", "a", "toolu_1"),
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }],
          },
        ],
      },
    },
  ]));

  assert.equal(session.toolUses[0]?.result?.text, "line one\nline two");
});

test("builds a per-file edit timeline and expands MultiEdit", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Edit",
        input: { file_path: "/repo/a.ts", old_string: "one", new_string: "two" },
      },
    ]),
    assistant("b", "a", [
      {
        type: "tool_use",
        id: "toolu_2",
        name: "MultiEdit",
        input: {
          file_path: "/repo/a.ts",
          edits: [
            { old_string: "two", new_string: "three" },
            { old_string: "three", new_string: "four" },
          ],
        },
      },
    ]),
    assistant("c", "b", [
      { type: "tool_use", id: "toolu_3", name: "Write", input: { file_path: "/repo/b.ts", content: "body" } },
    ]),
  ]));

  const edits = session.fileEdits.get("/repo/a.ts");
  assert.equal(edits?.length, 3);
  assert.equal(edits?.[0]?.oldString, "one");
  assert.equal(edits?.[1]?.newString, "three");
  assert.equal(edits?.[2]?.newString, "four");
  assert.equal(session.fileEdits.get("/repo/b.ts")?.[0]?.content, "body");
  assert.equal(session.meta.editToolUses, 3);
});

test("collects files touched by lookup tools", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/repo/a.ts" } },
      { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "foo", path: "/repo/src" } },
      { type: "tool_use", id: "t3", name: "Bash", input: { command: "ls /repo/secret" } },
    ]),
  ]));

  assert.deepEqual([...session.filesRead].sort(), ["/repo/a.ts", "/repo/src"]);
});

test("marks a branch that never reaches the session tip as off the main path", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [{ type: "text", text: "start" }]),
    assistant("abandoned", "a", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/a.ts" } },
    ]),
    assistant("c", "a", [{ type: "text", text: "retry" }]),
    assistant("d", "c", [{ type: "text", text: "done" }]),
  ]));

  assert.equal(onMainPath(session, "d"), true);
  assert.equal(onMainPath(session, "c"), true);
  assert.equal(onMainPath(session, "a"), true);
  assert.equal(onMainPath(session, "abandoned"), false);
});

test("does not loop forever when parentUuid links form a cycle", () => {
  const session = parseLines(jsonl([
    assistant("a", "b", [{ type: "text", text: "one" }]),
    assistant("b", "a", [{ type: "text", text: "two" }]),
  ]));

  assert.deepEqual([...session.mainPath].sort(), ["a", "b"]);
});

test("summarizes session metadata", () => {
  const session = parseLines(jsonl([
    { type: "user", uuid: "u", parentUuid: null, sessionId: "s1", timestamp: "2026-08-14T09:00:00Z", cwd: "/repo", gitBranch: "main", version: "2.0.0", message: { role: "user", content: "go" } },
    { ...assistant("a", "u", [{ type: "thinking", thinking: "considering" }]), timestamp: "2026-08-14T10:00:00Z" },
    { ...assistant("b", "a", [{ type: "text", text: "done" }]), isSidechain: true, timestamp: "2026-08-14T11:00:00Z" },
  ]));

  assert.equal(session.sessionId, "s1");
  assert.equal(session.meta.cwd, "/repo");
  assert.equal(session.meta.claudeVersion, "2.0.0");
  assert.equal(session.meta.startedAt, "2026-08-14T09:00:00Z");
  assert.equal(session.meta.endedAt, "2026-08-14T11:00:00Z");
  assert.equal(session.meta.assistantRecords, 2);
  assert.equal(session.meta.sidechainRecords, 1);
  assert.equal(session.meta.thinkingBlocks, 1);
});

const corpus = join(homedir(), ".claude", "projects");

test("parses real Claude Code transcripts", { skip: !existsSync(corpus) }, async () => {
  const projects = await readdir(corpus);
  const files: string[] = [];

  for (const project of projects) {
    let entries: string[];
    try {
      entries = await readdir(join(corpus, project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) files.push(join(corpus, project, entry));
    }
  }

  assert.ok(files.length > 0, "expected at least one transcript in the local corpus");

  let records = 0;
  let toolUses = 0;
  let linkedResults = 0;

  for (const file of files) {
    const session = await parseTranscriptFile(file);
    records += session.records.length;
    toolUses += session.toolUses.length;
    linkedResults += session.toolUses.filter((use) => use.result).length;

    for (const use of session.toolUses) {
      assert.equal(typeof use.id, "string");
      assert.equal(typeof use.name, "string");
    }
    for (const [filePath, edits] of session.fileEdits) {
      assert.ok(filePath.length > 0);
      assert.ok(edits.length > 0);
    }
  }

  assert.ok(records > 0);
  assert.ok(toolUses > 0);
  assert.ok(linkedResults / toolUses > 0.9, "most tool calls should resolve to a result");
});

test("picks file paths out of shell commands that read a file", () => {
  assert.deepEqual(shellReadPaths("cat src/app.ts"), ["src/app.ts"]);
  assert.deepEqual(shellReadPaths("sed -n '190,240p' src/routes/products.ts"), ["src/routes/products.ts"]);
  assert.deepEqual(shellReadPaths("git show main:server/src/index.ts"), ["server/src/index.ts"]);
  assert.deepEqual(shellReadPaths("rg -n 'drain' src/queue.ts"), ["src/queue.ts"]);
});

test("does not treat a write or a glob as a shell read", () => {
  assert.deepEqual(shellReadPaths("rm -rf src/app.ts"), []);
  assert.deepEqual(shellReadPaths("echo hi > src/app.ts"), []);
  assert.deepEqual(shellReadPaths("cat src/*.ts"), []);
  assert.deepEqual(shellReadPaths("npm test"), []);
});

test("stops at a redirection so a heredoc write is not read as a lookup", () => {
  assert.deepEqual(shellReadPaths("cat > src/new.ts <<EOF"), []);
  assert.deepEqual(shellReadPaths("cat src/a.ts > /tmp/out.txt"), ["src/a.ts"]);
  assert.deepEqual(shellReadPaths("cat src/a.ts 2>/dev/null"), ["src/a.ts"]);
});

test("a heredoc body is not part of the command that carries it", () => {
  const command = [
    "python3 - <<'PY'",
    "old = 'npm install decimal.js'",
    "run('cat src/app.ts')",
    "PY",
    "npm run build",
  ].join("\n");

  assert.equal(withoutHeredocs(command), "python3 - <<'PY'\nnpm run build");
  // The file named inside the body was never read: the agent wrote it as text.
  assert.deepEqual(shellReadPaths(command), []);
});

test("a command splits the way a shell would, not the way a regex does", () => {
  // The `|` lives inside a search pattern, so this is one command, not two.
  assert.deepEqual(commandSegments('grep -E "DELETE FROM|DROP TABLE" src'), [
    'grep -E "DELETE FROM|DROP TABLE" src',
  ]);
  assert.deepEqual(commandSegments("npm ci && npm test"), ["npm ci ", " npm test"]);
  // A substitution runs a command of its own and is judged as one.
  assert.deepEqual(commandSegments('node run.js $(grep -rl "DROP TABLE" .)'), [
    "node run.js  ",
    'grep -rl "DROP TABLE" .',
  ]);
});

test("tells a shell command that writes a file from one that only looks", () => {
  for (const command of [
    "sed -i 's/old/new/' src/a.ts",
    "perl -pi -e 's/a/b/' src/a.ts",
    "python3 - <<'PY'\nopen('src/a.ts', 'w').write('x')\nPY",
    "cat <<'EOF' > src/a.ts\nbody\nEOF",
    "echo x >> src/a.ts",
    "npm run gen && printf ok | tee src/out.txt",
    "git apply fix.patch",
    "mv src/a.ts src/b.ts",
  ]) {
    assert.equal(shellWrites(command), true, command);
  }
  for (const command of [
    "rg -n 'drain' src 2>/dev/null",
    "npm test 2>&1 | tail -20",
    "grep -n \"=> \" src/a.ts",
    "sed -n '1,40p' src/a.ts",
    "cat src/a.ts > /dev/null",
    "git diff > /tmp/p.diff",
    "ls src",
  ]) {
    assert.equal(shellWrites(command), false, command);
  }
});

test("a session counts as editing files however the files were edited", () => {
  const call = (id: string, name: string, input: object) =>
    assistant(id, null, [{ type: "tool_use", id: `toolu_${id}`, name, input }]);
  const hasEdits = (...records: unknown[]) => parseLines(jsonl(records)).meta.hasFileEdits;

  assert.equal(hasEdits(call("a", "Edit", { file_path: "/repo/a.ts", old_string: "a", new_string: "b" })), true);
  assert.equal(hasEdits(call("a", "Bash", { command: "sed -i 's/a/b/' src/a.ts" })), true);
  // Kimi and whatever comes next: an editor under a name nobody told the parser about.
  assert.equal(hasEdits(call("a", "Grep", { pattern: "x" }), call("b", "StrReplaceFile", { path: "a.ts" })), true);

  assert.equal(hasEdits(call("a", "Read", { file_path: "/repo/a.ts" }), call("b", "Bash", { command: "rg -n x src" })), false);
  assert.equal(hasEdits(assistant("a", null, [{ type: "text", text: "nothing to do" }])), false);
});

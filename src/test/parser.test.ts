import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import { claudeAgent } from "../agents/claude.js";
import { detectUnverifiedAssumption } from "../detectors.js";
import {
  commandSegments,
  mayWrite,
  onAbandonedBranch,
  onMainPath,
  parseLines,
  shellEditPaths,
  shellReadPaths,
  shellWrites,
  gitCommands,
  shellOnlyLooks,
  withoutHeredocs,
} from "../parser.js";
import { subagentsOf } from "../subagents.js";

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

test("a recorded API request repeats the conversation without adding to it", () => {
  const edit = { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" } };
  const session = parseLines(jsonl([
    assistant("a", null, [edit]),
    toolResult("b", "a", "toolu_1"),
    // Claude Code 2.1.309 writes the messages of its next request as blobs.
    { type: "api-request-blob", sessionId: "s1", hash: "h1", message: { role: "assistant", content: [edit] } },
    { type: "api-request-blob", sessionId: "s1", hash: "h2", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } },
    { type: "api-request", sessionId: "s1", id: "r1", params: { model: "claude-opus-5-5" }, tail: ["h1", "h2"] },
  ]));

  assert.equal(session.records.length, 5);
  assert.equal(session.toolUses.length, 1);
  assert.equal([...session.fileEdits.values()].reduce((sum, list) => sum + list.length, 0), 1);
  assert.deepEqual(session.skipped.unknownTypes, {});
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

test("a subagent decides neither where the session ran nor when it ended", () => {
  const session = parseLines(jsonl([
    { ...assistant("a", null, [{ type: "text", text: "start" }]), timestamp: "2026-08-14T09:00:00Z" },
    { ...assistant("b", "a", [{ type: "text", text: "done" }]), timestamp: "2026-08-14T12:00:00Z" },
    // A subagent whose call is nowhere follows the whole session (`subagents.ts`).
    { ...assistant("s", null, [{ type: "text", text: "work" }]), isSidechain: true, timestamp: "2026-08-14T10:00:00Z", cwd: "/jobs/wf", gitBranch: "HEAD", version: "2.0.1" },
  ]));

  assert.equal(session.meta.cwd, "/repo");
  assert.equal(session.meta.gitBranch, "feat/x");
  assert.equal(session.meta.claudeVersion, "2.0.0");
  assert.equal(session.meta.endedAt, "2026-08-14T12:00:00Z");

  // Read alone, a subagent's file is all there is to go by.
  const alone = parseLines(jsonl([{ ...assistant("s", null, []), isSidechain: true, cwd: "/jobs/wf" }]));
  assert.equal(alone.meta.cwd, "/jobs/wf");
});

const corpus = join(homedir(), ".claude", "projects");

/** Object lines in a file: what one subagent adds to its session once spliced in. */
async function recordCount(path: string): Promise<number> {
  return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim().startsWith("{")).length;
}

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
    // Counted before the parse: a session still running only grows, so what
    // the parse reads can be more than this, never less.
    let spliced = 0;
    for (const agent of await subagentsOf(file)) spliced += await recordCount(agent.path);

    // Read the way the upload reads it: the session with its subagents.
    const session = await claudeAgent.parsedSession(file);
    records += session.records.length;
    toolUses += session.toolUses.length;
    linkedResults += session.toolUses.filter((use) => use.result).length;
    assert.ok(session.meta.sidechainRecords >= spliced, `${file}: every subagent record is read in`);

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

test("does not treat a write as a shell read", () => {
  assert.deepEqual(shellReadPaths("rm -rf src/app.ts"), []);
  assert.deepEqual(shellReadPaths("echo hi > src/app.ts"), []);
  assert.deepEqual(shellReadPaths("npm test"), []);
});

test("a case-insensitive grep is a read, and sed -i in any spelling is not", () => {
  assert.deepEqual(shellReadPaths("grep -i total src/cart.ts"), ["src/cart.ts"]);
  assert.deepEqual(shellReadPaths("sed -Ei 's/a/b/' src/cart.ts"), []);
  assert.deepEqual(shellReadPaths("sed -i.bak 's/a/b/' src/cart.ts"), []);
});

test("keeps a glob read as the glob, for the detectors to match", () => {
  assert.deepEqual(shellReadPaths("cat src/*.ts test/*.js README.md"), ["src/*.ts", "test/*.js", "README.md"]);
});

test("names the files sed -i and perl -i rewrite, and not their scripts", () => {
  assert.deepEqual(shellEditPaths("sed -i 's/a b/c d/; s/x/y/' test/money.test.js README.md"), ["test/money.test.js", "README.md"]);
  assert.deepEqual(shellEditPaths("sed -i -e 's/a/b/' -e 's/c/d/' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("sed -i '' 's/a/b/' src/a.ts"), ["src/a.ts"], "BSD sed's empty backup suffix");
  assert.deepEqual(shellEditPaths("sed -ie 's/a/b/' src/a.ts"), ["src/a.ts"], "-ie is -i with a suffix");
  assert.deepEqual(shellEditPaths("perl -pi -e 's/a/b/' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("sudo sed -i 's/a/b/' /etc/hosts"), ["/etc/hosts"]);
  assert.deepEqual(shellEditPaths(`sed -i "s/banker's/away/" README.md && npm test`), ["README.md"]);
  // Not an edit: no -i, or a glob this cannot list.
  assert.deepEqual(shellEditPaths("sed -n '1,5p' src/a.ts"), []);
  assert.deepEqual(shellEditPaths("sed 's/ -i //' src/a.ts"), [], "-i inside the script");
  assert.deepEqual(shellEditPaths("sed -i 's/a/b/' src/*.ts"), []);
  assert.deepEqual(shellEditPaths("sed -i '$a K=v' src/a.ts"), ["src/a.ts"], "sed's own `$`, the last line");
  assert.deepEqual(shellEditPaths("sed -i '$d' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths('sed -i "$SCRIPT" src/a.ts'), ["src/a.ts"], "a quoted variable is the one script");
  assert.deepEqual(shellEditPaths("sed -i $FLAGS 's/a/b/' src/a.ts"), ["src/a.ts"], "a bare one can be flags");
  assert.deepEqual(shellEditPaths(`sed -i 's/a/b/' "$FILE" $OTHER "$DIR/a.ts"`), [], "a variable names no file");
  assert.deepEqual(shellEditPaths("perl -p -i -e 's/a/b/' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("perl -0pi -e 's/a/b/' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("perl -pe 's/a/b/' src/a.ts"), []);
  assert.deepEqual(shellEditPaths(`ruby -pi -e 'sub("a","b")' src/a.ts`), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths(`ruby -i.bak -pe 'sub("a","b")' src/a.ts`), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("ruby -ne 'puts 1' src/a.ts"), []);
  assert.deepEqual(shellEditPaths("awk -i inplace '{print}' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("gawk -i inplace -v x=1 -F : '{print}' src/a.ts src/b.ts"), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(shellEditPaths("gawk --include=inplace '{print}' src/a.ts"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("awk -i lib.awk '{print}' src/a.ts"), [], "-i only loads a library");
  assert.deepEqual(shellEditPaths("awk '{print}' src/a.ts"), []);
  assert.deepEqual(shellEditPaths("for f in a b; do sed -i 's/a/b/' src/a.ts; done"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("if true; then sudo sed -i 's/a/b/' src/a.ts; fi"), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("perl script.pl -input src/a.ts"), [], "a flag of the script's own");
});

test("whether a command wrote agrees with what it names as edited, for every in-place editor", () => {
  for (const command of [
    "sed -i 's/a/b/' a.ts",
    "perl -pi -e 's/a/b/' a.ts",
    "perl -0pi -e 's/a/b/' a.ts",
    "perl -p -i -e 's/a/b/' a.ts",
    "ruby -pi -e 'x' a.ts",
    "awk -i inplace '{print}' a.ts",
    "gawk --include=inplace '{print}' a.ts",
    "for f in x; do sed -i 's/a/b/' a.ts; done",
  ]) {
    assert.equal(shellWrites(command), true, command);
    assert.deepEqual(shellEditPaths(command), ["a.ts"], command);
  }
  for (const command of ["sed 's/a/b/' a.ts", "perl -pe 's/a/b/' a.ts", "ruby -ne 'x' a.ts", "awk '{print}' a.ts", "awk -i lib.awk '{print}' a.ts"]) {
    assert.equal(shellWrites(command), false, command);
    assert.deepEqual(shellEditPaths(command), [], command);
  }
});

test("telling an in-place edit or a heredoc from anything else gets through 200 KB of text built to stall it", () => {
  const fill = (unit: string): string => unit.repeat(Math.ceil(200_000 / unit.length));
  for (const command of [
    `perl ${fill("-a ")}`,
    `perl ${fill("-a ")}x`,
    `ruby ${fill("-a")}`,
    `ruby -${"a".repeat(200_000)}`,
    `perl${" ".repeat(200_000)}-a`,
    `perl ${fill("-a  ")}'x' y`,
    `awk ${fill("-i ")}`,
    `awk -i${" ".repeat(200_000)}x`,
    `awk --include=${" ".repeat(200_000)}x`,
    `gawk ${fill("--include ")}`,
    fill("do "),
    fill("do  "),
    `${fill("do ")}sed -i x y`,
    `${fill("sudo\t")}awk`,
    fill("<<\\"),
    `<<${" ".repeat(200_000)}`,
    `cat ${fill("<<-\\")}`,
    `echo ${fill('\\"')} > a.txt`,
    `echo "${fill('\\"')} > a.txt`,
    `echo ${fill('"\\')} > a.txt`,
    `sed -i ${fill('\\"')} a.txt`,
    `sed -i "${fill('\\"')} a.txt`,
  ]) {
    const started = Date.now();
    shellWrites(command);
    shellEditPaths(command);
    withoutHeredocs(command);
    const took = Date.now() - started;
    assert.ok(took < 1000, `took ${took}ms on ${JSON.stringify(command.slice(0, 24))}`);
  }
});

test("an escaped quote opens nothing, so what follows it is no argument", () => {
  assert.equal(shellWrites('echo \\"a\\" > b.txt'), true);
  assert.equal(shellWrites("echo it\\'s > b.txt"), true);
  assert.equal(shellWrites('echo "a \\" > b.txt"'), false);
  assert.equal(shellWrites("sed 's/ -i //' a.ts"), false);
  assert.deepEqual(shellEditPaths("sed -i 's/a/b/' my\\ dir/a.ts"), ["my\\ dir/a.ts"]);
});

test("a heredoc's body is cut whichever way its delimiter is quoted", () => {
  for (const opener of ["<<EOF", "<<-EOF", "<<'EOF'", '<<"EOF"', "<<\\EOF"]) {
    assert.equal(withoutHeredocs(`cat > a.txt ${opener}\nDROP DATABASE\nEOF\nnpm test`).includes("DROP DATABASE"), false, opener);
  }
});

test("resolves a sed -i path against the directory the command ran in", () => {
  assert.deepEqual(shellEditPaths("sed -i 's/a/b/' ./src/a.ts", "/repo"), ["/repo/src/a.ts"]);
  // Masked, the working directory is "." and paths come out repo-relative, as Edit's do.
  assert.deepEqual(shellEditPaths("sed -i 's/a/b/' ./src/a.ts", "."), ["src/a.ts"]);
  assert.deepEqual(shellEditPaths("cd pkg && sed -i 's/a/b/' a.ts", "/repo"), ["/repo/pkg/a.ts"]);
  assert.deepEqual(shellEditPaths("cd /elsewhere && sed -i 's/a/b/' a.ts", "/repo"), ["/elsewhere/a.ts"]);
  assert.deepEqual(shellEditPaths("cd $DIR && sed -i 's/a/b/' a.ts", "/repo"), ["a.ts"], "a cd it cannot follow");
});

test("stops at a redirection so a heredoc write is not read as a lookup", () => {
  assert.deepEqual(shellReadPaths("cat > src/new.ts <<EOF"), []);
  assert.deepEqual(shellReadPaths("cat src/a.ts > /tmp/out.txt"), ["src/a.ts"]);
  assert.deepEqual(shellReadPaths("cat src/a.ts 2>/dev/null"), ["src/a.ts"]);
});

test("a here-string has no body, so the lines after it still ran", () => {
  const command = "grep -c x <<< word\nnpm run build\nword";
  assert.equal(withoutHeredocs(command), command);
  assert.equal(withoutHeredocs(`tr a b <<<"$x"\nnpm run build`), `tr a b <<<"$x"\nnpm run build`);
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
  // What a backslash escapes neither opens nor closes a quote nor ends a command.
  assert.deepEqual(commandSegments("echo don\\'t; rm a"), ["echo don\\'t", " rm a"]);
  assert.deepEqual(commandSegments('echo \\"a; rm b'), ['echo \\"a', " rm b"]);
  assert.deepEqual(commandSegments('echo "c:\\\\"; rm c'), ['echo "c:\\\\"', " rm c"]);
  assert.deepEqual(commandSegments('echo "a\\"; b"; rm d'), ['echo "a\\"; b"', " rm d"]);
  assert.deepEqual(commandSegments("find . -exec rm {} \\; && ls"), ["find . -exec rm {} \\; ", " ls"]);
  // At the end of a line it joins that line to the next, and here it is still where a segment ends.
  assert.deepEqual(commandSegments("a \\\nb"), ["a \\", "b"]);
});

test("a marker's colon is no revision's, so a masked path the shell read stays whole", () => {
  const masked = "~/.claude/projects/[ISY_REDACTED:project]/memory/notes.md";
  assert.deepEqual(shellReadPaths(`cat ${masked}`), [masked]);
  assert.deepEqual(shellReadPaths(`git show main:${masked}`), [masked]);
  assert.deepEqual(shellReadPaths("cat [ISY_REDACTED:a]/[ISY_REDACTED:b]/c.md"), ["[ISY_REDACTED:a]/[ISY_REDACTED:b]/c.md"]);
  assert.deepEqual(shellReadPaths("git show main:src/a.ts"), ["src/a.ts"]);

  const session = parseLines([
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `cat ${masked}` } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: masked, old_string: "x", new_string: "y" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } }),
  ]);
  assert.ok(session.filesRead.has(masked));
  assert.deepEqual(detectUnverifiedAssumption(session), []);
});

test("a load path, a required library or a program named like an editor edits nothing", () => {
  for (const command of [
    "ruby -Ilib -Itest test/foo_test.rb",
    "ruby -Ilib -e 'puts 1'",
    "bundle exec ruby -Ilib -Itest test/foo_test.rb",
    "ruby -rdigest -e 'puts 1'",
    "ruby -ruri -e 'puts 1'",
    "ruby -rfileutils -e 'puts 1'",
    "ruby -rbigdecimal x.rb",
    "ruby -W:no-experimental x.rb",
    "ruby -Eiso-8859-1 x.rb",
    "ruby-build -i",
    "ruby-install -i /opt",
    "perl -Ilib t/x.t",
    "perl -Mstrict -e 1",
    "perl -MList::Util=sum -e 1",
    "perl -Mlib=lib t/x.t",
    "perl -ei a.ts",
    "awk -f -i inplace f",
    "gawk -v -i inplace f",
  ]) {
    assert.equal(shellWrites(command), false, command);
    assert.deepEqual(shellEditPaths(command), [], command);
  }
  for (const command of [
    "perl -pi -e 's/a/b/' a.ts",
    "perl -0pi -e 's/a/b/' a.ts",
    "perl -0777pi -e 's/a/b/' a.ts",
    "perl -wpi -e 's/a/b/' a.ts",
    "perl -i -pe 's/a/b/' a.ts",
    "perl -i.bak -pe 's/a/b/' a.ts",
    "perl -pie 's/a/b/' a.ts",
    "perl -Ilib -pi -e 's/a/b/' a.ts",
    "perl -CSDA -Mutf8 -pi -e 's/a/b/' a.ts",
    "ruby -i.bak -pe 'x' a.ts",
    "ruby -rjson -pi -e 'x' a.ts",
    "gawk -i inplace '{print}' a.ts",
    "awk -f x.awk -i inplace a.ts",
  ]) {
    assert.equal(shellWrites(command), true, command);
  }
  const session = parseLines([
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ruby -Ilib -Itest test/foo_test.rb" } }] } }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "1 runs, 0 failures" }] } }),
  ]);
  assert.equal(session.meta.hasFileEdits, false);
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

test("a session that committed counts as editing files, however the files changed", () => {
  const call = (id: string, command: string) =>
    assistant(id, null, [{ type: "tool_use", id: `toolu_${id}`, name: "Bash", input: { command } }]);
  const hasEdits = (...records: unknown[]) => parseLines(jsonl(records)).meta.hasFileEdits;

  for (const command of ["gofmt -w . && git add . && git commit -m x", "git -C app commit -am x", "npm run format; git commit"]) {
    assert.equal(hasEdits(call("a", command)), true, command);
  }

  for (const command of [
    "git status",
    "git log --grep commit",
    "grep -rn 'git commit' .",
    "echo \"git commit\"",
    "cat <<'EOF'\ngit commit -m x\nEOF",
    "npm --prefix tools/commit test",
  ]) {
    assert.equal(hasEdits(call("a", command)), false, command);
  }

  // Nothing to commit, or a hook that said no: it put nothing anywhere.
  const failed = { ...toolResult("b", "a", "toolu_a"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", is_error: true, content: "nothing to commit" }] } };
  assert.equal(hasEdits(call("a", "git commit -m x"), failed), false);
});

test("counts reasoning only when there is text in it", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [{ type: "thinking", thinking: "", signature: "EqMock==" }]),
    assistant("b", "a", [{ type: "thinking", thinking: "  \n", signature: "EqMock==" }]),
    assistant("c", "b", [{ type: "redacted_thinking", data: "EmwKAhgB" }]),
    assistant("d", "c", [{ type: "thinking", thinking: "the retry path is not covered", signature: "EqMock==" }]),
  ]));

  assert.equal(session.meta.thinkingBlocks, 1);
  assert.equal(session.meta.hiddenThinkingBlocks, 3);
  assert.deepEqual(
    session.blocks.map((block) => block.text),
    [undefined, "  \n", undefined, "the retry path is not covered"],
  );
});

test("knows every record type Claude Code 2.1 writes", () => {
  const session = parseLines(jsonl([
    { type: "atis-latch", atis: "", sessionId: "s1" },
    { type: "cost-state", sessionId: "s1", totalCostUSD: 0.1 },
    { type: "ai-title", aiTitle: "Fix add", sessionId: "s1" },
    { type: "last-prompt", lastPrompt: "fix it", leafUuid: "a", sessionId: "s1" },
    { type: "queue-operation", operation: "enqueue", sessionId: "s1" },
    { type: "content-replacement", sessionId: "s1", replacements: [] },
    { type: "worktree-state", sessionId: "s1" },
    { type: "custom-title", customTitle: "x", sessionId: "s1" },
    { type: "attribution-snapshot", sessionId: "s1" },
    { type: "progress", sessionId: "s1" },
    { type: "tools-used", tools: ["Read", "Bash"], sessionId: "s1" },
  ]));

  assert.deepEqual(session.skipped.unknownTypes, {});
});

test("follows a compaction back to the work before it", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [{ type: "text", text: "start" }]),
    assistant("rewound", "a", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/repo/a.ts" } },
    ]),
    assistant("b", "a", [{ type: "text", text: "kept" }]),
    // Claude Code starts the chain over at a compaction: no parent, only a logical one.
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "boundary",
      parentUuid: null,
      logicalParentUuid: "b",
      sessionId: "s1",
      compactMetadata: { trigger: "manual", preTokens: 1280 },
    },
    { type: "user", uuid: "summary", parentUuid: "boundary", isCompactSummary: true, message: { role: "user", content: "summary" } },
    assistant("c", "summary", [{ type: "text", text: "after" }]),
  ]));

  for (const uuid of ["c", "summary", "boundary", "b", "a"]) assert.equal(onMainPath(session, uuid), true, uuid);
  assert.equal(onMainPath(session, "rewound"), false);
  assert.equal(onAbandonedBranch(session, "rewound"), true);
});

test("an unknown tool counts as an edit only when it could have named a file", () => {
  // Claude Code 2.1 bookkeeping: known, and a file is not among their arguments anyway.
  assert.equal(mayWrite("TaskCreate", { subject: "a", description: "b" }), false);
  assert.equal(mayWrite("SubagentHandback", { message: "done" }), false);
  assert.equal(mayWrite("EnterWorktree", { name: "fix" }), false);
  // A tool this parser has never heard of, told nothing about a file.
  assert.equal(mayWrite("ScheduleSomething", { when: "tomorrow", note: "x" }), false);
  // Told about a file, handed code, or with arguments nobody could read.
  assert.equal(mayWrite("StrReplaceFile", { path: "a.ts", edit: {} }), true);
  assert.equal(mayWrite("exec", { script: "tools.apply_patch(p)" }), true);
  assert.equal(mayWrite("apply_patch", {}), true);
  // Code runners write wherever their code says.
  assert.equal(mayWrite("PowerShell", { command: "Set-Content a.ts x" }), true);
  assert.equal(mayWrite("REPL", { code: "fs.writeFileSync('a')" }), true);
  // Writers that never name a file: a patch Codex's adapter could not parse, a git merge.
  assert.equal(mayWrite("apply_patch", { input: "*** Begin Patch\r\n" }), true);
  assert.equal(mayWrite("TowerMerge", { branch: "tower/m1" }), true);
  // Kimi Code's Tower bookkeeping, some of it with no arguments at all.
  assert.equal(mayWrite("TowerInit", {}), false);
  assert.equal(mayWrite("TowerStatus", {}), false);
  assert.equal(mayWrite("TowerFinding", { file: "a.ts", note: "x" }), false);
  // The edit tools are counted on their own.
  assert.equal(mayWrite("Edit", { file_path: "a.ts" }), false);
  // An MCP tool counts when its name says it writes and it is told where.
  assert.equal(mayWrite("mcp__fs__write_file", { path: "a.ts", content: "x" }), true);
  assert.equal(mayWrite("mcp__serena__replace_symbol_body", { name_path: "f", relative_path: "a.ts", body: "x" }), true);
  assert.equal(mayWrite("mcp__fs__editFile", { path: "a.ts", edits: [] }), true);
  assert.equal(mayWrite("mcp__fs__read_file", { path: "a.ts" }), false);
  assert.equal(mayWrite("mcp__github__get_file_contents", { owner: "o", repo: "r", path: "a.ts" }), false);
  assert.equal(mayWrite("mcp__github__create_issue", { owner: "o", repo: "r", title: "t" }), false);
});

test("a subagent that never came back may have edited", () => {
  const launch = (name = "Agent") => [
    assistant("a", null, [
      { type: "tool_use", id: "toolu_agent", name, input: { prompt: "fix it", run_in_background: true } },
    ]),
    // A background subagent answers at once, and with no count of its edits.
    toolResult("b", "a", "toolu_agent", {
      toolUseResult: { isAsync: true, status: "async_launched", agentId: "ad7e" },
    }),
  ];
  const hasEdits = (records: unknown[]) => parseLines(jsonl(records)).meta.hasFileEdits;

  // Uploaded without its file: nothing says it did not edit.
  assert.equal(hasEdits(launch()), true);
  assert.equal(hasEdits(launch("TowerSpawn")), true);

  // Its records came along, and they say what it did — here, nothing.
  const read = {
    ...assistant("s1", null, [{ type: "tool_use", id: "toolu_s1", name: "Read", input: { file_path: "/repo/a.ts" } }]),
    isSidechain: true,
    agentId: "ad7e",
    parentToolUseID: "toolu_agent",
  };
  assert.equal(hasEdits([...launch(), read]), false);

  // A call that failed started nothing.
  const refused = {
    ...toolResult("b", "a", "toolu_agent"),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_agent", content: "unknown agent type", is_error: true }],
    },
  };
  assert.equal(hasEdits([launch()[0], refused]), false);
});

test("a session whose subagent edited files counts as editing, even without its records", () => {
  const session = parseLines(jsonl([
    assistant("a", null, [
      { type: "tool_use", id: "toolu_agent", name: "Agent", input: { description: "fix", prompt: "fix it" } },
    ]),
    toolResult("b", "a", "toolu_agent", {
      toolUseResult: { status: "completed", agentId: "ad7e", toolStats: { readCount: 1, editFileCount: 1 } },
    }),
  ]));

  assert.equal(session.meta.editToolUses, 0);
  assert.equal(session.meta.hasFileEdits, true);

  const untouched = parseLines(jsonl([
    assistant("a", null, [{ type: "tool_use", id: "toolu_agent", name: "Agent", input: { prompt: "look" } }]),
    toolResult("b", "a", "toolu_agent", { toolUseResult: { agentId: "ad7e", toolStats: { editFileCount: 0 } } }),
  ]));
  assert.equal(untouched.meta.hasFileEdits, false);
});

test("a git command is told by what the shell runs, not by the words in it", () => {
  const cases: [string, string[]][] = [
    ["git commit -m x", ["commit"]],
    ["git add . && git commit -am x", ["add", "commit"]],
    ["cd app && git -C sub -c user.name='A B' --no-pager commit", ["commit"]],
    ["GIT_AUTHOR_NAME=x sudo git rebase main", ["rebase"]],
    ["if git pull --rebase; then echo ok; fi", ["pull"]],
    ["(git cherry-pick abc)", ["cherry-pick"]],
    ["git commit-tree abc", ["commit-tree"]],
    ["pytest tests/git/ -x", []],
    ["tail -f ~/git/app/server.log", []],
    ["cd ~/git/other && npm test", []],
    ["npm --prefix tools/commit run dev", []],
    ['echo "git commit -m x"', []],
    ["cat > note.md <<'EOF'\ngit commit -m x\nEOF", []],
    ["git --version", []],
  ];
  for (const [command, expected] of cases) assert.deepEqual(gitCommands(command), expected, command);
});

test("telling a git command from anything else gets through 200 KB of text built to stall it", () => {
  for (const text of [
    "git ".repeat(50_000),
    `git ${"-x ".repeat(66_000)}`,
    `git ${"-C a ".repeat(40_000)}`,
    `${"a=b ".repeat(50_000)}git commit`,
    `${"( ".repeat(100_000)}git`,
    `git commit "${'\\"'.repeat(100_000)}`,
  ]) {
    const started = performance.now();
    gitCommands(text);
    const took = performance.now() - started;
    assert.ok(took < 1000, `took ${Math.round(took)} ms`);
  }
});

test("a command only looks when every part of it is known to, and anything else nobody can say", () => {
  for (const command of [
    "git status",
    "git log --oneline -5 | head -3",
    "git add -A && git commit -m 'run npm install' && git push",
    "git switch -c topic",
    "gh pr create --fill",
    "cd src && ls -la; pwd",
    "# what is there\ncat README.md",
    "grep -rn 'npm run build' . | sort | uniq",
    "for f in a b; do cat $f; done",
    "if [ -f a ]; then echo yes; fi",
    "cat > docs/notes.md <<'EOF'\nnpm run build\nEOF",
    "sed -i 's/a/b/' a.txt",
    "",
  ]) {
    assert.equal(shellOnlyLooks(command), true, command);
  }

  for (const command of [
    "npm run format",
    "npm install",
    "cargo fmt",
    "python3 -c \"open('a','w')\"",
    "python3 - <<'PY'\nprint(1)\nPY",
    "npx prettier --write src/a.ts",
    "./scripts/gen.sh",
    "git apply fix.patch",
    "git pull",
    "git stash pop",
    "git status && make",
    "cat a.txt | xargs rm",
    "echo $(npm run build)",
    "touch a.txt",
    "curl -o a.txt http://x/y",
  ]) {
    assert.equal(shellOnlyLooks(command), false, command);
  }
});

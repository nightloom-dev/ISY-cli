import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { writeConfig } from "../config.js";
import { formatCommit, runCommit } from "../commands/commit.js";
import { runUpload } from "../commands/upload.js";
import {
  COMMIT_COMMAND,
  PUSH_COMMAND,
  autoInstallGitHook,
  gitHookInstalled,
  installGitHook,
  postCommitPath,
  prePushPath,
  removeGitHook,
} from "../githook.js";
import { projectSlug, sessionStatePath } from "../paths.js";
import { candidateKey, looksUnchanged, readState, unseen, withCommit } from "../state.js";
import type { Candidate } from "../types.js";

const run = promisify(execFile);

let home: string;
let claudeConfig: string;
let server: Server;
let baseUrl: string;

const uploads: { sessionId: string; contentHash: string; commits?: unknown }[] = [];

const saved = {
  home: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  kimi: process.env.KIMI_HOME,
  codex: process.env.CODEX_HOME,
};

async function newRepo(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "t@e.com"], { cwd: dir });
  await run("git", ["config", "user.name", "T"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "one");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: dir });
  await run("git", ["remote", "add", "origin", "git@github.com:unwinned/ISY.git"], { cwd: dir });
  return dir;
}

function record(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

/**
 * Long enough to clear the stage 0 eligibility floor, with one manifest edit at
 * the end so `external_dependency` has something real to find.
 */
function transcript(sessionId: string, cwd: string, dependency: string): string {
  const lines = [
    record({
      type: "user",
      uuid: `${sessionId}-u`,
      parentUuid: null,
      sessionId,
      cwd,
      version: "2.0.0",
      timestamp: "2026-08-16T09:00:00Z",
      message: { role: "user", content: "go" },
    }),
  ];

  for (let index = 0; index < 21; index += 1) {
    lines.push(
      record({
        type: "assistant",
        uuid: `${sessionId}-a${index}`,
        parentUuid: index === 0 ? `${sessionId}-u` : `${sessionId}-a${index - 1}`,
        sessionId,
        timestamp: "2026-08-16T09:30:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `${sessionId}-t${index}`,
              name: "Edit",
              input: {
                file_path: join(cwd, `src/f${index}.ts`),
                old_string: "one",
                new_string: "two",
              },
            },
          ],
        },
      }),
    );
  }

  lines.push(
    record({
      type: "assistant",
      uuid: `${sessionId}-manifest`,
      parentUuid: `${sessionId}-a20`,
      sessionId,
      timestamp: "2026-08-16T10:00:00Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: `${sessionId}-tm`,
            name: "Edit",
            input: {
              file_path: join(cwd, "package.json"),
              old_string: '{\n  "dependencies": {}\n}',
              new_string: `{\n  "dependencies": {\n    "${dependency}": "^1.0.0"\n  }\n}`,
            },
          },
        ],
      },
    }),
  );

  return lines.join("\n");
}

async function writeSession(cwd: string, sessionId: string, dependency: string): Promise<string> {
  const dir = join(claudeConfig, "projects", projectSlug(cwd));
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, transcript(sessionId, cwd, dependency));
  return path;
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-commit-home-"));
  claudeConfig = await mkdtemp(join(tmpdir(), "isy-commit-claude-"));
  process.env.ISY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  // Pinned at directories that do not exist: these assertions are about Claude
  // Code, and a machine with Kimi or Codex installed must not change them.
  process.env.KIMI_HOME = join(home, "absent-kimi");
  process.env.CODEX_HOME = join(home, "absent-codex");

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      if (req.url?.endsWith("/sessions")) {
        const body = JSON.parse(gunzipSync(raw).toString("utf8")) as {
          sessionId: string;
          contentHash: string;
          commits?: unknown;
        };
        uploads.push(body);
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "ses_1", deduplicated: false }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries({
    ISY_HOME: saved.home,
    CLAUDE_CONFIG_DIR: saved.claude,
    KIMI_HOME: saved.kimi,
    CODEX_HOME: saved.codex,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  uploads.length = 0;
  await writeFile(sessionStatePath(), "{}\n").catch(() => undefined);
  await writeConfig({ token: "t", apiBaseUrl: baseUrl });
});

test("installs a post-commit hook a fresh repository did not have", async () => {
  const fresh = await newRepo("isy-hook-fresh-");

  assert.equal(await installGitHook(fresh), "installed");
  assert.equal(await gitHookInstalled(fresh), true);

  const path = (await postCommitPath(fresh))!;
  const body = await readFile(path, "utf8");
  assert.match(body, /^#!\/bin\/sh/);
  assert.ok(body.includes(COMMIT_COMMAND));

  // Git only runs a hook it can execute, so a file it cannot is not installed.
  assert.equal(((await stat(path)).mode & 0o111) !== 0, true);
  assert.equal(await installGitHook(fresh), "already-present");
});

test("joins a hook the user already wrote instead of replacing it", async () => {
  const fresh = await newRepo("isy-hook-existing-");
  const path = (await postCommitPath(fresh))!;
  await writeFile(path, "#!/bin/sh\nset -e\necho mine\n");

  assert.equal(await installGitHook(fresh), "installed");

  const body = await readFile(path, "utf8");
  assert.ok(body.includes("echo mine"), "the user's own script survives");
  assert.ok(body.includes(COMMIT_COMMAND));
  // `set -e` above would abort the hook on a non-zero isy; `|| true` stops that.
  assert.ok(body.includes("|| true"));

  // Under the shebang and above their script, so a hook ending in `exec` or
  // `exit` still runs ours, and ours is never the command git takes the exit
  // code from.
  assert.match(body, /^#!\/bin\/sh\n# isy:begin/);
  assert.ok(body.indexOf(COMMIT_COMMAND) < body.indexOf("echo mine"));

  assert.equal(await removeGitHook(fresh), "removed");
  const afterRemoval = await readFile(path, "utf8");
  assert.ok(afterRemoval.includes("echo mine"));
  assert.ok(!afterRemoval.includes("isy"));
});

test("a pre-push that rejects still rejects with our block in the file", async () => {
  const fresh = await newRepo("isy-hook-verdict-");
  const path = (await prePushPath(fresh))!;
  // Someone else's gate, ending the way most of them do: no explicit `exit`, so
  // the hook's verdict is the exit code of its last command — which is exactly
  // what a block appended below would take over, `&` always succeeding.
  await writeFile(path, "#!/bin/sh\ngrep -q nothing-here /dev/null\n");

  assert.equal(await installGitHook(fresh), "installed");
  assert.ok((await readFile(path, "utf8")).includes(PUSH_COMMAND));

  await assert.rejects(
    () => run("sh", [path], { cwd: fresh }),
    "the push the repository's own hook refused is still refused",
  );
});

test("a hook that ends in exec still runs our block", async () => {
  const fresh = await newRepo("isy-hook-exec-");
  const path = (await postCommitPath(fresh))!;
  const marker = join(fresh, "ours-ran");
  await writeFile(path, `#!/bin/sh\nexec echo theirs\n`);

  assert.equal(await installGitHook(fresh), "installed");

  // Nothing below an `exec` is ever reached, so the proof is that our line runs
  // at all: stand a touchable marker in for the upload.
  const body = (await readFile(path, "utf8")).replace(COMMIT_COMMAND, `: > "${marker}"`);
  await writeFile(path, body);
  await run("sh", [path], { cwd: fresh });

  await stat(marker);
});

test("replaces a block an older isy wrote rather than stacking a second one", async () => {
  const fresh = await newRepo("isy-hook-upgrade-");
  const path = (await postCommitPath(fresh))!;
  await writeFile(
    path,
    "#!/bin/sh\n# isy:begin — managed by isy, do not edit inside this block\nnpx isy upload --silent\n# isy:end\n",
  );

  assert.equal(await installGitHook(fresh), "installed");

  const body = await readFile(path, "utf8");
  assert.equal(body.match(/isy:begin/g)?.length, 1);
  assert.ok(!body.includes("npx isy upload --silent"));
  assert.ok(body.includes(COMMIT_COMMAND));
});

test("writes where core.hooksPath points, not where it does not", async () => {
  const fresh = await newRepo("isy-hook-path-");
  const custom = join(fresh, ".husky");
  await mkdir(custom, { recursive: true });
  await run("git", ["config", "core.hooksPath", ".husky"], { cwd: fresh });

  assert.equal(await installGitHook(fresh), "installed");
  assert.equal(await postCommitPath(fresh), join(custom, "post-commit"));
  assert.ok((await readFile(join(custom, "post-commit"), "utf8")).includes(COMMIT_COMMAND));
});

test("deletes a hook file that held nothing but our own block", async () => {
  const fresh = await newRepo("isy-hook-solo-");
  await installGitHook(fresh);
  const path = (await postCommitPath(fresh))!;

  assert.equal(await removeGitHook(fresh), "removed");
  assert.equal(await gitHookInstalled(fresh), false);
  // Uninstalling leaves the repository as it was, not holding an empty script.
  await assert.rejects(() => stat(path));
  assert.equal(await removeGitHook(fresh), "absent");
});

test("installs the pre-push hook alongside the commit one", async () => {
  const fresh = await newRepo("isy-hook-push-");

  assert.equal(await installGitHook(fresh), "installed");

  const path = (await prePushPath(fresh))!;
  const body = await readFile(path, "utf8");
  assert.match(body, /^#!\/bin\/sh/);
  assert.ok(body.includes(PUSH_COMMAND));
  assert.equal(((await stat(path)).mode & 0o111) !== 0, true);

  // git waits for pre-push and writes the refs being pushed to its stdin: the
  // upload has to outlive the hook and must not sit reading those refs.
  assert.ok(PUSH_COMMAND.endsWith("&"), "the upload is backgrounded");
  assert.ok(PUSH_COMMAND.includes("</dev/null"), "the upload does not read the refs");
});

test("a repository wired before pre-push existed is completed, not left half-wired", async () => {
  const fresh = await newRepo("isy-hook-partial-");
  await installGitHook(fresh);
  // What an older isy left behind: the commit hook and nothing else.
  await rm((await prePushPath(fresh))!);

  assert.equal(await gitHookInstalled(fresh), false);
  assert.equal(await installGitHook(fresh), "installed");
  assert.equal(await gitHookInstalled(fresh), true);

  // The hook that was already correct is not rewritten into a second block.
  const body = await readFile((await postCommitPath(fresh))!, "utf8");
  assert.equal(body.match(/isy:begin/g)?.length, 1);
});

test("uninstalling takes both hooks, and an older half-install with them", async () => {
  const fresh = await newRepo("isy-hook-both-");
  await installGitHook(fresh);
  const commit = (await postCommitPath(fresh))!;
  const push = (await prePushPath(fresh))!;

  assert.equal(await removeGitHook(fresh), "removed");
  await assert.rejects(() => stat(commit));
  await assert.rejects(() => stat(push));
  assert.equal(await removeGitHook(fresh), "absent");
});

test("reports a directory that is not a repository rather than creating one", async () => {
  const plain = await mkdtemp(join(tmpdir(), "isy-hook-plain-"));
  assert.equal(await installGitHook(plain), "not-a-repository");
  assert.equal(await removeGitHook(plain), "not-a-repository");
  assert.equal(await gitHookInstalled(plain), false);
});

test("prints possible signals once and stays quiet on the next commit", async () => {
  const cwd = await newRepo("isy-commit-signals-");
  await writeSession(cwd, "sess-a", "left-pad");

  const first = await runCommit({ noUpload: true }, cwd);
  assert.equal(first.candidates.length > 0, true);
  const rendered = formatCommit(first);
  assert.match(rendered!, /possible signal/);
  assert.match(rendered!, /external_dependency/);

  // Same transcript, second commit: the finding was already shown, so silence.
  const second = await runCommit({ noUpload: true }, cwd);
  assert.deepEqual(second.candidates, []);
  assert.equal(formatCommit(second), undefined);
});

test("records how many records the transcript held at each commit", async () => {
  const cwd = await newRepo("isy-commit-marks-");
  const path = await writeSession(cwd, "sess-b", "left-pad");

  await runCommit({ noUpload: true }, cwd);
  const afterFirst = (await readState())[path]!;
  assert.equal(afterFirst.commits?.length, 1);
  const records = afterFirst.commits![0]!.records;

  // A second commit with more of the session behind it gets its own mark.
  await writeFile(path, `${await readFile(path, "utf8")}\n${transcript("sess-b", cwd, "ms")}`);
  await writeFile(join(cwd, "b.txt"), "two");
  await run("git", ["add", "."], { cwd });
  await run("git", ["commit", "-q", "-m", "second"], { cwd });

  await runCommit({ noUpload: true }, cwd);
  const afterSecond = (await readState())[path]!;
  assert.equal(afterSecond.commits?.length, 2);
  assert.equal(afterSecond.commits![1]!.records > records, true);
  assert.notEqual(afterSecond.commits![0]!.sha, afterSecond.commits![1]!.sha);
});

test("an amend replaces its own mark instead of recording the commit twice", () => {
  const once = withCommit({}, { sha: "abc", records: 10 });
  const again = withCommit({ commits: once }, { sha: "abc", records: 14 });

  assert.deepEqual(again, [{ sha: "abc", records: 14 }]);
});

test("uploads a session that ended without a commit of its own", async () => {
  const cwd = await newRepo("isy-commit-all-");
  await writeSession(cwd, "sess-quiet", "left-pad");
  await writeSession(cwd, "sess-loud", "ms");

  const report = await runUpload({ silent: true, all: true }, cwd);

  // The scan is not "the newest session": a session that ended days ago with no
  // commit of its own is exactly the one the newest-only rule used to lose.
  assert.equal(report.sent, 2);
  assert.equal(uploads.length, 2);
});

test("does not send a transcript the server already has", async () => {
  const cwd = await newRepo("isy-commit-unchanged-");
  await writeSession(cwd, "sess-once", "left-pad");

  assert.equal((await runUpload({ silent: true, all: true }, cwd)).sent, 1);
  uploads.length = 0;

  const second = await runUpload({ silent: true, all: true }, cwd);
  assert.equal(second.sent, 0);
  assert.equal(uploads.length, 0);
  assert.match(second.skipped ?? "", /nothing new to upload/);
});

test("sends the commit marks along with the transcript", async () => {
  const cwd = await newRepo("isy-commit-payload-");
  await writeSession(cwd, "sess-marks", "left-pad");

  await runCommit({ noUpload: true }, cwd);
  await runUpload({ silent: true, all: true }, cwd);

  assert.equal(uploads.length, 1);
  const commits = uploads[0]!.commits as { sha: string; records: number }[];
  assert.equal(Array.isArray(commits), true);
  assert.equal(commits.length, 1);
  assert.equal(typeof commits[0]!.sha, "string");
  assert.equal(commits[0]!.records > 0, true);
});

test("a commit after the session ended sends it again, with the new mark", async () => {
  const cwd = await newRepo("isy-commit-after-");
  await writeSession(cwd, "sess-ended", "left-pad");

  assert.equal((await runUpload({ silent: true, all: true }, cwd)).sent, 1);
  uploads.length = 0;

  // The agent is done and the transcript will not grow again, but the commit is
  // what the pull request matches on — and it used to stay on this machine.
  await runCommit({ noUpload: true }, cwd);
  assert.equal((await runUpload({ silent: true, all: true }, cwd)).sent, 1);
  assert.equal((uploads[0]!.commits as unknown[]).length, 1);

  uploads.length = 0;
  assert.equal((await runUpload({ silent: true, all: true }, cwd)).sent, 0);
});

test("a transcript is only skipped once the server has accepted it", () => {
  const file = { sizeBytes: 100, modifiedAt: new Date(1_000) };

  assert.equal(looksUnchanged({}, file), false, "never uploaded is never unchanged");
  assert.equal(
    looksUnchanged({ sizeBytes: 100, modifiedMs: 1_000 }, file),
    false,
    "size and mtime alone do not prove the server has it",
  );
  assert.equal(
    looksUnchanged({ uploadedHash: "sha256:x", sizeBytes: 100, modifiedMs: 1_000 }, file),
    true,
  );
  assert.equal(
    looksUnchanged({ uploadedHash: "sha256:x", sizeBytes: 120, modifiedMs: 1_000 }, file),
    false,
    "a grown transcript is changed even at the same mtime",
  );
  const marked = {
    uploadedHash: "sha256:x",
    sizeBytes: 100,
    modifiedMs: 1_000,
    commits: [{ sha: "b", records: 3 }],
  };
  assert.equal(looksUnchanged(marked, file), false, "a commit since the upload is news");
  assert.equal(looksUnchanged({ ...marked, uploadedCommit: "b" }, file), true);
});

test("a candidate keeps its identity as the session grows", () => {
  const candidate: Candidate = {
    category: "known_gap",
    uuid: "u1",
    toolUseId: "t1",
    filePath: "/repo/src/a.ts",
    recordIndex: 7,
    weight: 0.5,
    detail: "left for later",
  };

  // Same finding, reported again after more of the session was appended.
  assert.equal(candidateKey(candidate), candidateKey({ ...candidate, detail: "reworded" }));
  assert.notEqual(candidateKey(candidate), candidateKey({ ...candidate, recordIndex: 8 }));
  assert.deepEqual(unseen({ shown: [candidateKey(candidate)] }, [candidate]), []);
  assert.deepEqual(unseen({ shown: [] }, [candidate]), [candidate]);
});

test("the session hook wires a repository's commit hook without isy init", async () => {
  const fresh = await newRepo("isy-hook-auto-");
  assert.equal(await autoInstallGitHook(fresh), "installed");
  assert.equal(await gitHookInstalled(fresh), true);
  assert.equal(await autoInstallGitHook(fresh), "already-present");

  // Created without templates: no .git/hooks, still a repository to wire.
  const bare = await newRepo("isy-hook-auto-nodir-");
  await rm(join(bare, ".git", "hooks"), { recursive: true, force: true });
  assert.equal(await autoInstallGitHook(bare), "installed");

  const plain = await mkdtemp(join(tmpdir(), "isy-hook-auto-plain-"));
  assert.equal(await autoInstallGitHook(plain), "not-a-repository");
});

test("leaves a committed hooks directory to isy init", async () => {
  const fresh = await newRepo("isy-hook-auto-shared-");
  await mkdir(join(fresh, ".husky"), { recursive: true });
  await run("git", ["config", "core.hooksPath", ".husky"], { cwd: fresh });

  assert.equal(await autoInstallGitHook(fresh), "shared-hooks");
  await assert.rejects(() => stat(join(fresh, ".husky", "post-commit")));

  // Once the developer put it there on purpose, it counts as present.
  await installGitHook(fresh);
  assert.equal(await autoInstallGitHook(fresh), "already-present");
});

test("a session hook wires the commit hook with nothing on stdin, the way Codex runs it", async () => {
  const cwd = await newRepo("isy-commit-hookflag-");
  await writeSession(cwd, "sess-hookflag", "left-pad");

  // A hand-run upload is not a session ending: it leaves the repository alone.
  await runUpload({ silent: true, all: true }, cwd);
  assert.equal(await gitHookInstalled(cwd), false);

  await writeSession(cwd, "sess-hookflag-next", "ms");
  const report = await runUpload({ silent: true, all: true, hook: true }, cwd);
  assert.equal(report.gitHook, "installed");
  assert.equal(await gitHookInstalled(cwd), true);
});

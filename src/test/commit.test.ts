import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { writeConfig } from "../config.js";
import { formatCommit, runCommit, wordsOf } from "../commands/commit.js";
import { currentBranch } from "../git.js";
import { formatUploadAlert, runUpload } from "../commands/upload.js";
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

const uploads: { sessionId: string; contentHash: string; commits?: unknown; transcript?: string }[] = [];

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
        const body = JSON.parse(gunzipSync(raw).toString("utf8")) as (typeof uploads)[number];
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
  // A background subagent merged in by time moved its record further down.
  assert.equal(candidateKey(candidate), candidateKey({ ...candidate, recordIndex: 12 }));
  assert.notEqual(candidateKey(candidate), candidateKey({ ...candidate, toolUseId: "t2" }));
  // Pointing at nothing else, the index is all a candidate has.
  const loose: Candidate = { category: "known_gap", recordIndex: 7, weight: 0.5, detail: "x" };
  assert.notEqual(candidateKey(loose), candidateKey({ ...loose, recordIndex: 8 }));

  assert.deepEqual(unseen({ shown: [candidateKey(candidate)] }, [candidate]), []);
  assert.deepEqual(unseen({ shown: [] }, [candidate]), [candidate]);
  // What isy 1.0 printed, under the key it wrote then, is not printed again.
  const written = ["known_gap", "/repo/src/a.ts", "u1", "t1", 7].join("\x00");
  assert.deepEqual(unseen({ shown: [written] }, [candidate]), []);
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
  // The line is parked and read wherever the next session starts: "this repository" would be wrong there.
  assert.match(formatUploadAlert(report) ?? "", /hooks added to unwinned\/ISY/);
});

test("a parked line about a shared hooks directory names the repository, and outlives an init run elsewhere", async () => {
  const cwd = await newRepo("isy-commit-hookflag-shared-");
  await mkdir(join(cwd, ".husky"), { recursive: true });
  await run("git", ["config", "core.hooksPath", ".husky"], { cwd });
  await writeSession(cwd, "sess-hookflag-shared", "left-pad");

  const report = await runUpload({ silent: true, all: true, hook: true }, cwd);
  assert.equal(report.gitHook, "shared-hooks");
  const line = formatUploadAlert(report) ?? "";
  assert.match(line, /no git hooks in unwinned\/ISY/);
  // `isy init` drops a parked part with this wording, and an init in another repository answers nothing here.
  assert.doesNotMatch(line, /run: isy init/);
});

/** A session that last wrote `days` ago, the way a transcript left alone looks. */
async function age(path: string, days: number): Promise<void> {
  const then = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await utimes(path, then, then);
}

test("a commit goes to a session started in a subdirectory, though git runs the hook at the top", async () => {
  const top = await realpath(await newRepo("isy-commit-subdir-"));
  await mkdir(join(top, "src"));
  const atTop = await writeSession(top, "sess-at-top", "left-pad");
  await age(atTop, 1);
  const inSrc = await writeSession(join(top, "src"), "sess-in-src", "ms");

  const report = await runCommit({ noUpload: true }, top);

  assert.equal(report.sessionId, "sess-in-src");
  const state = await readState();
  assert.equal(state[inSrc]?.commits?.length, 1);
  assert.equal(state[atTop]?.commits, undefined);

  // Nothing at the top at all is no reason to skip the commit either.
  const alone = await realpath(await newRepo("isy-commit-subdir-alone-"));
  await mkdir(join(alone, "lib"));
  await writeSession(join(alone, "lib"), "sess-alone", "ms");
  assert.equal((await runCommit({ noUpload: true }, alone)).sessionId, "sess-alone");
});

test("the commit and the push send a session started in a subdirectory", async () => {
  const top = await realpath(await newRepo("isy-commit-subdir-send-"));
  await mkdir(join(top, "src"));
  await writeSession(join(top, "src"), "sess-sent", "ms");

  await runCommit({ noUpload: true }, top);
  const report = await runUpload({ silent: true, all: true }, top);

  assert.equal(report.sent, 1);
  assert.equal(uploads[0]!.sessionId, "sess-sent");
  assert.equal((uploads[0]!.commits as unknown[]).length, 1);
});

test("a hook in a linked worktree still finds the session in its subdirectory", async () => {
  const main = await realpath(await newRepo("isy-commit-linked-"));
  const tree = `${main}-linked`;
  await run("git", ["worktree", "add", "-q", "-b", "linked", tree], { cwd: main });
  await mkdir(join(tree, "src"));
  const inSrc = await writeSession(join(tree, "src"), "sess-linked", "ms");

  // What git hands a post-commit hook there, and not in a main worktree: asked
  // about any directory, git then answers that it is the top of the tree.
  process.env.GIT_DIR = (await run("git", ["rev-parse", "--absolute-git-dir"], { cwd: tree })).stdout.trim();
  try {
    assert.equal((await runCommit({ noUpload: true }, tree)).sessionId, "sess-linked");
  } finally {
    delete process.env.GIT_DIR;
  }
  assert.equal((await readState())[inSrc]?.commits?.length, 1);
});

test("a commit stays out of the trees beside and inside this one", async () => {
  const top = await realpath(await newRepo("isy-commit-trees-"));
  const session = await writeSession(top, "sess-here", "left-pad");
  await age(session, 1);

  // Each of these is newer, and each is its own checkout on its own history.
  const worktree = join(top, ".claude", "worktrees", "other");
  await mkdir(join(top, ".claude", "worktrees"), { recursive: true });
  await run("git", ["worktree", "add", "-q", "-b", "nested", worktree], { cwd: top });
  await writeSession(worktree, "sess-nested-worktree", "ms");

  const vendored = join(top, "vendor", "lib");
  await mkdir(vendored, { recursive: true });
  await run("git", ["init", "-q", "-b", "main"], { cwd: vendored });
  await writeSession(vendored, "sess-nested-repo", "ms");

  // Same prefix on disk, so the same prefix among Claude's project folders.
  const beside = await newRepo("isy-commit-trees-beside-");
  await rename(beside, `${top}-beside`);
  await writeSession(`${top}-beside`, "sess-beside", "ms");

  assert.equal((await runCommit({ noUpload: true }, top)).sessionId, "sess-here");
  assert.equal((await readState())[session]?.commits?.length, 1);

  assert.equal((await runUpload({ silent: true, all: true }, top)).sent, 1);
  assert.deepEqual(uploads.map((upload) => upload.sessionId), ["sess-here"]);
});

test("a session elsewhere in the tree counts only as far back as a sweep looks", async () => {
  const top = await realpath(await newRepo("isy-commit-subdir-old-"));
  await mkdir(join(top, "src"));
  const here = await writeSession(top, "sess-old-here", "left-pad");
  await age(here, 60);
  const inSrc = await writeSession(join(top, "src"), "sess-old-src", "ms");
  await age(inSrc, 30);

  // The directory's own sessions go however old they are, as they always did.
  assert.equal((await runCommit({ noUpload: true }, top)).sessionId, "sess-old-here");
  assert.equal((await runUpload({ silent: true, all: true }, top)).sent, 1);
  assert.deepEqual(uploads.map((upload) => upload.sessionId), ["sess-old-here"]);
});

/** The paths a transcript went up with, as `sent` lines of JSON. */
function sentRecords(upload: { transcript?: string }): Record<string, unknown>[] {
  const jsonl = gunzipSync(Buffer.from(upload.transcript ?? "", "base64")).toString("utf8");
  return jsonl.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

function editedPaths(records: Record<string, unknown>[]): string[] {
  const paths: string[] = [];
  for (const entry of records) {
    const content = (entry.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as { input?: { file_path?: string } }[]) {
      if (block.input?.file_path) paths.push(block.input.file_path);
    }
  }
  return paths;
}

test("a session started in a subdirectory uploads its paths from the top of the repository", async () => {
  const top = await realpath(await newRepo("isy-commit-root-"));
  const pkg = join(top, "pkg");
  await mkdir(pkg);
  const path = await writeSession(pkg, "sess-root", "left-pad");
  // A sibling of the directory it started in, the way a monorepo session reaches one.
  await writeFile(
    path,
    `${await readFile(path, "utf8")}\n${record({
      type: "assistant",
      uuid: "sess-root-sibling",
      parentUuid: "sess-root-manifest",
      sessionId: "sess-root",
      timestamp: "2026-08-16T10:30:00Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t-sibling", name: "Edit", input: { file_path: join(top, "test/x.test.ts"), old_string: "a", new_string: "b" } },
        ],
      },
    })}`,
  );

  // The commit reads it the same way, and what it prints is from the top too.
  const committed = await runCommit({ noUpload: true }, top);
  assert.ok(committed.candidates.some((candidate) => candidate.filePath === "pkg/package.json"));

  // From the hook's directory, the session's own hook and the sweep: three routes, one set of bytes.
  const hashes = new Set<string>();
  for (const send of [
    () => runUpload({ silent: true, all: true }, top),
    () => runUpload({ silent: true }, pkg),
    () => runUpload({ silent: true, sweep: true }, tmpdir()),
  ]) {
    await writeFile(sessionStatePath(), "{}\n");
    uploads.length = 0;
    await send();
    const sent = uploads.find((upload) => upload.sessionId === "sess-root");
    assert.ok(sent);
    hashes.add(sent.contentHash);

    const records = sentRecords(sent);
    assert.equal(records[0]!.cwd, "pkg");
    const edited = editedPaths(records);
    assert.ok(edited.includes("pkg/src/f0.ts"), "under the directory it started in");
    assert.ok(edited.includes("pkg/package.json"));
    assert.ok(edited.includes("test/x.test.ts"), "beside it");
  }
  assert.equal(hashes.size, 1);
});

test("a session at the top of the repository is masked as it always was", async () => {
  const top = await realpath(await newRepo("isy-commit-root-top-"));
  await writeSession(top, "sess-top", "left-pad");

  await runUpload({ silent: true, all: true }, top);

  const records = sentRecords(uploads[0]!);
  assert.equal(records[0]!.cwd, ".");
  assert.ok(editedPaths(records).includes("src/f0.ts"));
});

/** The session as Claude Code writes it: every record says which branch it ran on. */
async function onBranch(path: string, branch: string): Promise<void> {
  const lines = (await readFile(path, "utf8")).split("\n");
  const stamped = lines.map((line) => record({ ...(JSON.parse(line) as object), gitBranch: branch }));
  await writeFile(path, stamped.join("\n"));
}

/** A commit of one new or changed file, the way someone at a terminal makes one. */
async function commitFile(cwd: string, file: string, content = "text"): Promise<void> {
  await mkdir(join(cwd, dirname(file)), { recursive: true });
  await writeFile(join(cwd, file), content);
  await run("git", ["add", "."], { cwd });
  await run("git", ["commit", "-q", "-m", file], { cwd });
}

async function appendTurn(path: string, sessionId: string, block: object, timestamp: string): Promise<void> {
  const added = record({
    type: "assistant",
    uuid: `${sessionId}-${timestamp}`,
    parentUuid: `${sessionId}-manifest`,
    sessionId,
    timestamp,
    message: { role: "assistant", content: [block] },
  });
  await writeFile(path, `${await readFile(path, "utf8")}\n${added}`);
}

const OLD = "2026-08-16T11:00:00Z";
const shell = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });

test("a commit on a branch the session never worked on leaves it alone", async () => {
  const cwd = await newRepo("isy-commit-other-");
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  const path = await writeSession(cwd, "sess-feat", "left-pad");
  await onBranch(path, "feat");

  await commitFile(cwd, "own.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  await runUpload({ silent: true, all: true }, cwd);
  uploads.length = 0;

  // Long after it ended, on a branch made for something else.
  await run("git", ["switch", "-q", "-c", "elsewhere", "main"], { cwd });
  await commitFile(cwd, "README.md");
  const report = await runCommit({ noUpload: true }, cwd);

  assert.match(report.skipped ?? "", /another branch/);
  assert.deepEqual(report.candidates, []);
  const state = (await readState())[path]!;
  assert.equal(state.commits?.length, 1);
  assert.equal(state.branch, "feat");
  // Nothing goes up that would move it there either.
  assert.equal((await runUpload({ silent: true, all: true }, cwd)).sent, 0);

  // Back on its own branch, a commit after it ended is its own, as it always was.
  await run("git", ["switch", "-q", "feat"], { cwd });
  await commitFile(cwd, "later.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.commits?.length, 2);
});

test("an upload from another checkout leaves a session on the branch its transcript names", async () => {
  const cwd = await newRepo("isy-commit-stamp-");
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  const path = await writeSession(cwd, "sess-stamp", "left-pad");
  await onBranch(path, "feat");

  // What a pre-push from a branch made for something else runs.
  await run("git", ["switch", "-q", "-c", "elsewhere", "main"], { cwd });
  await runUpload({ silent: true, all: true }, cwd);
  assert.equal((await readState())[path]!.branch, "feat");

  await commitFile(cwd, "README.md");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);
  assert.equal((await readState())[path]!.commits, undefined);
});

test("a detached HEAD is no branch for a session to stand on", async () => {
  const cwd = await newRepo("isy-commit-detached-");
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  const path = await writeSession(cwd, "sess-detached", "left-pad");
  await onBranch(path, "feat");
  await commitFile(cwd, "own.txt");
  await runCommit({ noUpload: true }, cwd);

  // The agent commits on a detached HEAD: a mark, and the session stays where it was.
  await run("git", ["checkout", "-q", "--detach"], { cwd });
  const now = new Date().toISOString();
  await appendTurn(path, "sess-detached", shell("t-try", "git commit -m try"), now);
  await commitFile(cwd, "try.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  let state = (await readState())[path]!;
  assert.equal(state.commits?.length, 2);
  assert.equal(state.branch, "feat");

  // So a commit long after, on a branch it never saw, is still someone else's.
  await writeFile(path, (await readFile(path, "utf8")).replaceAll(now, OLD));
  await run("git", ["switch", "-q", "-c", "unrelated", "main"], { cwd });
  await commitFile(cwd, "README.md");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);

  // An upload from one stores nothing either, for a session that names no branch.
  const bare = await newRepo("isy-commit-detached-bare-");
  const barePath = await writeSession(bare, "sess-detached-bare", "left-pad");
  await run("git", ["checkout", "-q", "--detach"], { cwd: bare });
  await runUpload({ silent: true, all: true }, bare);
  state = (await readState())[barePath]!;
  assert.ok(state.uploadedHash);
  assert.equal(state.branch, undefined);
});

test("a commit on a new branch holding what the session left uncommitted is its own", async () => {
  const cwd = await newRepo("isy-commit-carried-");
  const path = await writeSession(cwd, "sess-carried", "left-pad");
  await onBranch(path, "main");

  // The agent stopped with edits in the tree; the human branched and committed them.
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  await commitFile(cwd, "src/f0.ts");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  let state = (await readState())[path]!;
  assert.equal(state.commits?.length, 1);
  assert.equal(state.branch, "feat");

  // That branch is its own now, whatever goes on it.
  await commitFile(cwd, "unrelated.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  state = (await readState())[path]!;
  assert.equal(state.commits?.length, 2);

  // The same file on yet another branch is not: that edit is behind its last mark.
  await run("git", ["switch", "-q", "-c", "other", "main"], { cwd });
  await commitFile(cwd, "src/f0.ts", "someone else's");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);
  assert.equal((await readState())[path]!.commits?.length, 2);
});

test("a session in a subdirectory is matched against the commit from the top of the repository", async () => {
  const top = await realpath(await newRepo("isy-commit-carried-sub-"));
  await mkdir(join(top, "pkg"));
  const path = await writeSession(join(top, "pkg"), "sess-carried-sub", "left-pad");
  await onBranch(path, "main");

  await run("git", ["switch", "-q", "-c", "feat"], { cwd: top });
  await commitFile(top, "pkg/src/f0.ts");

  assert.equal((await runCommit({ noUpload: true }, top)).skipped, undefined);
  assert.equal((await readState())[path]!.commits?.length, 1);
});

test("what a session wrote through the shell counts when the commit holds a file it mentions", async () => {
  const cwd = await newRepo("isy-commit-shell-");
  const path = await writeSession(cwd, "sess-shell", "left-pad");
  await appendTurn(path, "sess-shell", shell("t-heredoc", "cat > docs/notes.md <<'EOF'\nhello\nEOF"), OLD);
  await onBranch(path, "main");

  await run("git", ["switch", "-q", "-c", "unrelated"], { cwd });
  await commitFile(cwd, "other.md");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);

  await run("git", ["switch", "-q", "-c", "carried", "main"], { cwd });
  await commitFile(cwd, "docs/notes.md");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
});

test("a shell call that has not answered yet is the agent making this commit", async () => {
  const cwd = await newRepo("isy-commit-running-");
  const path = await writeSession(cwd, "sess-running", "left-pad");
  await appendTurn(path, "sess-running", shell("t-commit", "git switch -c topic && git commit -am topic"), new Date().toISOString());
  await onBranch(path, "main");

  await run("git", ["switch", "-q", "-c", "topic"], { cwd });
  await commitFile(cwd, "nothing-it-edited.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "topic");

  // The same call left unanswered days ago is a session that died, not one committing.
  const dead = await newRepo("isy-commit-running-dead-");
  const deadPath = await writeSession(dead, "sess-dead", "left-pad");
  await appendTurn(deadPath, "sess-dead", shell("t-commit", "git switch -c topic && git commit -am topic"), OLD);
  await onBranch(deadPath, "main");
  await run("git", ["switch", "-q", "-c", "topic"], { cwd: dead });
  await commitFile(dead, "nothing-it-edited.txt");
  assert.match((await runCommit({ noUpload: true }, dead)).skipped ?? "", /another branch/);
});

test("a commit goes to the session making it, though others wrote after it", async () => {
  const cwd = await realpath(await newRepo("isy-commit-maker-"));
  await mkdir(join(cwd, "docs"));
  const making = await writeSession(cwd, "sess-making", "left-pad");
  const below = await writeSession(join(cwd, "docs"), "sess-below", "ms");
  const beside = await writeSession(cwd, "sess-beside", "ms");
  const now = new Date().toISOString();
  await appendTurn(making, "sess-making", shell("t-commit", "git commit -am x"), now);
  await age(making, 1 / 1440);
  // A long shell call that makes no commit says nothing of whose this one is.
  await appendTurn(below, "sess-below", shell("t-test", "npm test"), now);
  await appendTurn(beside, "sess-beside", { type: "text", text: "still reading" }, now);

  await commitFile(cwd, "whatever.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-making");

  const state = await readState();
  assert.equal(state[making]?.commits?.length, 1);
  assert.equal(state[below]?.commits, undefined);
  assert.equal(state[beside]?.commits, undefined);
});

test("a commit holding what a session edited goes to it, though another wrote after it", async () => {
  const cwd = await realpath(await newRepo("isy-commit-holder-"));
  await mkdir(join(cwd, "docs"));
  const holder = await writeSession(cwd, "sess-holder", "left-pad");
  await age(holder, 1 / 1440);
  const reader = await writeSession(join(cwd, "docs"), "sess-reader", "ms");

  await commitFile(cwd, "src/f0.ts");
  assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-holder");
  assert.equal((await readState())[holder]?.commits?.length, 1);
  assert.equal((await readState())[reader]?.commits, undefined);

  // One holding nobody's work goes to the newest, as any other commit does.
  await age(holder, 1 / 1440);
  await commitFile(cwd, "README.md");
  assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-reader");

  // And a session that has been quiet for longer than a shell call can run is not asked.
  const old = await realpath(await newRepo("isy-commit-holder-old-"));
  await mkdir(join(old, "docs"));
  await age(await writeSession(old, "sess-holder-old", "left-pad"), 1 / 24);
  await writeSession(join(old, "docs"), "sess-reader-old", "ms");
  await commitFile(old, "src/f0.ts");
  assert.equal((await runCommit({ noUpload: true }, old)).sessionId, "sess-reader-old");
});

test("a CLI that records no branch is judged by the one its upload found", async () => {
  const cwd = await newRepo("isy-commit-nobranch-");
  const path = await writeSession(cwd, "sess-nobranch", "left-pad");

  await runUpload({ silent: true, all: true }, cwd);
  assert.equal((await readState())[path]!.branch, "main");

  await run("git", ["switch", "-q", "-c", "elsewhere"], { cwd });
  await commitFile(cwd, "README.md");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);
  assert.equal((await readState())[path]!.commits, undefined);
});

test("a resume that only read from a branch does not make that branch its own", async () => {
  const cwd = await newRepo("isy-commit-resume-");
  const path = await writeSession(cwd, "sess-resume", "left-pad");
  await onBranch(path, "main");
  await commitFile(cwd, "own.txt");
  await runCommit({ noUpload: true }, cwd);

  await run("git", ["switch", "-q", "-c", "looking"], { cwd });
  await appendTurn(path, "sess-resume", { type: "text", text: "that function is in a.txt" }, OLD);
  await onBranch(path, "looking");
  await commitFile(cwd, "README.md");

  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);
  const state = (await readState())[path]!;
  assert.equal(state.commits?.length, 1);
  assert.equal(state.branch, "main");
});

test("a rebase counts as the branch it rebases, not as no branch at all", async () => {
  const cwd = await newRepo("isy-commit-rebase-");
  await run("git", ["switch", "-q", "-c", "topic"], { cwd });
  await commitFile(cwd, "a.txt", "topic's");
  await run("git", ["switch", "-q", "main"], { cwd });
  await commitFile(cwd, "a.txt", "main's");
  await run("git", ["switch", "-q", "topic"], { cwd });
  // Stops on the conflict: detached, the way every pick of a rebase fires the hook.
  await assert.rejects(() => run("git", ["rebase", "main"], { cwd }));
  assert.equal(await currentBranch(cwd), "topic");

  const path = await writeSession(cwd, "sess-rebase", "left-pad");
  await onBranch(path, "other");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);

  await onBranch(path, "topic");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "topic");
});

test("a name is read out of a command as a whole word, however it is quoted or spelled", () => {
  const words = wordsOf({ command: `cat > "docs/notes.md" <<'EOF'\nhello\nEOF\nprintf x>>src\\a.ts` });
  for (const name of ["notes.md", "a.ts", "hello", "EOF"]) assert.ok(words.includes(name), name);
  assert.ok(!words.includes("a"));
  assert.ok(!words.includes("otes.md"));
});

test("reading the names out of a command stays linear", () => {
  for (const text of [
    "\\".repeat(200_000),
    "/".repeat(200_000),
    "\"".repeat(200_000),
    "a/".repeat(100_000),
    "a".repeat(200_000),
    "\\ ".repeat(100_000),
  ]) {
    const started = performance.now();
    wordsOf({ command: text });
    const took = performance.now() - started;
    assert.ok(took < 1000, `took ${Math.round(took)} ms`);
  }
});

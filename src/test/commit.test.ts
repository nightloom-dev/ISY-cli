import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { appendFile, chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { claudeAgent } from "../agents/index.js";
import { writeConfig } from "../config.js";
import { formatCommit, runCommit, wordsOf } from "../commands/commit.js";
import { collectGitMetadata, currentBranch } from "../git.js";
import { readJournal } from "../log.js";
import { formatUploadAlert, runUpload } from "../commands/upload.js";
import {
  COMMIT_COMMAND,
  PUSH_COMMAND,
  autoInstallGitHook,
  gitHookInstalled,
  installGitHook,
  hooksLeftToTheUser,
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

const OLD_COMMIT_BLOCK =
  "# isy:begin — managed by isy, do not edit inside this block\nnpx @nightloom/isy commit --hook || true\n# isy:end\n";
const OLD_PUSH_BLOCK =
  "# isy:begin — managed by isy, do not edit inside this block\nnpx @nightloom/isy upload --silent --all >/dev/null 2>&1 </dev/null &\n# isy:end\n";

/** This checkout's isy, run the way a hook runs it: nothing on stdin. */
function cli(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), join(import.meta.dirname, "..", "index.ts"), ...args],
      { cwd, stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

test("whatever a hook runs next in a repository brings an older block up to date", async () => {
  for (const args of [
    ["commit", "--hook"],
    ["check", "--hook"],
    ["upload", "--hook"],
    ["upload", "--silent", "--all"],
  ]) {
    const label = args.join(" ");
    const fresh = await newRepo("isy-hook-stale-");
    const commit = (await postCommitPath(fresh))!;
    const push = (await prePushPath(fresh))!;
    await writeFile(commit, `#!/bin/sh\n${OLD_COMMIT_BLOCK}echo mine\n`);
    await writeFile(push, `#!/bin/sh\n${OLD_PUSH_BLOCK}echo mine\n`);

    await cli(fresh, args);

    const begin = OLD_COMMIT_BLOCK.split("\n")[0];
    assert.equal(await readFile(commit, "utf8"), `#!/bin/sh\n${begin}\n${COMMIT_COMMAND}\n# isy:end\necho mine\n`, label);
    assert.equal(await readFile(push, "utf8"), `#!/bin/sh\n${begin}\n${PUSH_COMMAND}\n# isy:end\necho mine\n`, label);
    assert.equal(await gitHookInstalled(fresh), true, label);
  }
});

test("bringing a block up to date adds none that is not there, and leaves a shared directory alone", async () => {
  const fresh = await newRepo("isy-hook-stale-none-");
  await cli(fresh, ["commit", "--hook"]);
  await assert.rejects(() => stat(join(fresh, ".git", "hooks", "post-commit")));

  const shared = await newRepo("isy-hook-stale-shared-");
  await mkdir(join(shared, ".husky"));
  await run("git", ["config", "core.hooksPath", ".husky"], { cwd: shared });
  // Tracked, so a rewrite nobody asked for leaves the tree dirty and `git rebase` refuses.
  const written = `#!/bin/sh\n${OLD_COMMIT_BLOCK}`;
  await writeFile(join(shared, ".husky", "post-commit"), written);
  await cli(shared, ["commit", "--hook"]);
  assert.equal(await readFile(join(shared, ".husky", "post-commit"), "utf8"), written);

  // `isy init`, run on purpose, does write there.
  await installGitHook(shared);
  assert.ok((await readFile(join(shared, ".husky", "post-commit"), "utf8")).includes(COMMIT_COMMAND));
});

test("a hook rewritten while it runs carries on with the rest of the user's script", async () => {
  const fresh = await newRepo("isy-hook-running-");
  const path = (await postCommitPath(fresh))!;
  const marker = join(fresh, "mine-ran");
  // bash goes back to the file for every line, at the offset it had reached.
  await writeFile(path, `#!/bin/bash\n${OLD_COMMIT_BLOCK}echo ran >> "${marker}"\n`);
  await chmod(path, 0o755);

  // The old line as it runs for real: npx starts isy, and isy rewrites the hook running it.
  const bin = await mkdtemp(join(tmpdir(), "isy-hook-bin-"));
  await writeFile(
    join(bin, "npx"),
    `#!/bin/sh\nwhile [ "$1" != "@nightloom/isy" ]; do shift; done\nshift\n` +
      `exec "${process.execPath}" --import "${import.meta.resolve("tsx")}" "${join(import.meta.dirname, "..", "index.ts")}" "$@"\n`,
  );
  await chmod(join(bin, "npx"), 0o755);

  const { stderr } = await run("git", ["commit", "-q", "--allow-empty", "-m", "next"], {
    cwd: fresh,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
  });

  assert.equal(stderr, "");
  assert.equal(await readFile(marker, "utf8"), "ran\n");
  assert.ok((await readFile(path, "utf8")).includes(COMMIT_COMMAND));
});

test("a hook linked in from elsewhere stays linked when its block is rewritten", async () => {
  const fresh = await newRepo("isy-hook-linked-");
  const path = (await postCommitPath(fresh))!;
  const script = join(fresh, "post-commit.sh");
  await writeFile(script, `#!/bin/sh\n${OLD_COMMIT_BLOCK}`);
  await symlink(script, path);

  assert.equal(await installGitHook(fresh), "installed");

  assert.equal((await lstat(path)).isSymbolicLink(), true);
  assert.ok((await readFile(script, "utf8")).includes(COMMIT_COMMAND));
});

test("a hook linked to a file in the work tree keeps its older block until asked, so the tree stays clean", async () => {
  const fresh = await newRepo("isy-hook-tracked-");
  await mkdir(join(fresh, "tools"));
  const script = join(fresh, "tools/post-commit");
  const wired = `#!/bin/sh\n${OLD_COMMIT_BLOCK}`;
  await writeFile(script, wired, { mode: 0o755 });
  await run("git", ["add", "."], { cwd: fresh });
  await run("git", ["commit", "-q", "-m", "tools"], { cwd: fresh });
  await symlink("../../tools/post-commit", (await postCommitPath(fresh))!);
  const clean = async () => assert.equal((await run("git", ["status", "--porcelain"], { cwd: fresh })).stdout, "");

  await cli(fresh, ["commit", "--hook"]);
  await clean();
  assert.equal(await readFile(script, "utf8"), wired);

  assert.equal(await autoInstallGitHook(fresh), "shared-hooks");
  await clean();

  assert.equal(await installGitHook(fresh), "installed");
  assert.ok((await readFile(script, "utf8")).includes(COMMIT_COMMAND));
});

test("a hook linked to a file of a work tree waits, from whichever tree of the repository it is reached", async () => {
  const fresh = await newRepo("isy-hook-tracked-linked-");
  await mkdir(join(fresh, "tools"));
  const script = join(fresh, "tools/post-commit");
  const wired = `#!/bin/sh\n${OLD_COMMIT_BLOCK}`;
  await writeFile(script, wired, { mode: 0o755 });
  await run("git", ["add", "."], { cwd: fresh });
  await run("git", ["commit", "-q", "-m", "tools"], { cwd: fresh });
  await symlink("../../tools/post-commit", (await postCommitPath(fresh))!);
  const linked = join(await mkdtemp(join(tmpdir(), "isy-hook-tree-")), "linked");
  await run("git", ["worktree", "add", "-q", "-b", "linked", linked], { cwd: fresh });

  await cli(linked, ["commit", "--hook"]);
  assert.equal((await run("git", ["status", "--porcelain"], { cwd: fresh })).stdout, "");
  assert.equal(await readFile(script, "utf8"), wired);
  assert.equal(await autoInstallGitHook(linked), "shared-hooks");
});

test("a hook linked to a file in no work tree is nobody else's, and its older block is brought up to date", async () => {
  const fresh = await newRepo("isy-hook-dotfile-");
  const script = join(await mkdtemp(join(tmpdir(), "isy-hook-dot-")), "post-commit");
  await writeFile(script, `#!/bin/sh\n${OLD_COMMIT_BLOCK}`, { mode: 0o755 });
  await symlink(script, (await postCommitPath(fresh))!);

  await cli(fresh, ["commit", "--hook"]);
  assert.ok((await readFile(script, "utf8")).includes(COMMIT_COMMAND));
});

test("a link into the git directory is no shared file, and its older block is brought up to date", async () => {
  const fresh = await newRepo("isy-hook-private-link-");
  const path = (await postCommitPath(fresh))!;
  const script = join(dirname(dirname(path)), "my-post-commit");
  await writeFile(script, `#!/bin/sh\n${OLD_COMMIT_BLOCK}`, { mode: 0o755 });
  await symlink("../my-post-commit", path);

  await cli(fresh, ["commit", "--hook"]);
  assert.ok((await readFile(script, "utf8")).includes(COMMIT_COMMAND));
});

test("takes the block out of a hook in another language, byte for byte, and never adds it again", async () => {
  const hooks: Record<string, Buffer> = {
    python: Buffer.from("#!/usr/bin/env python3\nimport sys\n\n\n\nsys.exit(0)\n"),
    "python given flags": Buffer.from("#!/usr/bin/env -S python3 -u\nimport sys\n"),
    node: Buffer.from("#!/usr/bin/env node\nprocess.exit(0);"),
    perl: Buffer.from("#!/usr/bin/perl\r\nexit 0;\r\n"),
    "not UTF-8": Buffer.concat([Buffer.from("#!/usr/bin/python\n# caf"), Buffer.from([0xe9]), Buffer.from("\n")]),
  };

  for (const [label, original] of Object.entries(hooks)) {
    const fresh = await newRepo("isy-hook-foreign-");
    const commit = (await postCommitPath(fresh))!;
    const cut = original.indexOf("\n") + 1;
    // Where every older isy put it: under the shebang, above the user's script.
    await writeFile(
      commit,
      Buffer.concat([original.subarray(0, cut), Buffer.from(OLD_COMMIT_BLOCK), original.subarray(cut)]),
    );
    await chmod(commit, 0o700);
    assert.equal(await gitHookInstalled(fresh), false, label);

    await cli(fresh, ["commit", "--hook"]);

    assert.deepEqual(await readFile(commit), original, label);
    assert.equal((await stat(commit)).mode & 0o777, 0o700, label);

    // Nothing that runs later puts it back.
    await installGitHook(fresh);
    await autoInstallGitHook(fresh);
    await cli(fresh, ["commit", "--hook"]);
    assert.deepEqual(await readFile(commit), original, label);
    assert.ok((await readFile((await prePushPath(fresh))!, "utf8")).includes(PUSH_COMMAND), label);
    assert.equal(await gitHookInstalled(fresh), true, label);
    assert.deepEqual((await hooksLeftToTheUser(fresh)).map((hook) => hook.name), ["post-commit"], label);
  }
});

test("takes a block out of a hook in another language in a shared directory too, and on logout", async () => {
  const original = "#!/usr/bin/env python3\nimport sys\n\n\n\nsys.exit(0)";
  const damaged = `#!/usr/bin/env python3\n${OLD_COMMIT_BLOCK}import sys\n\n\n\nsys.exit(0)`;

  const shared = await newRepo("isy-hook-foreign-shared-");
  await mkdir(join(shared, "githooks"));
  await run("git", ["config", "core.hooksPath", "githooks"], { cwd: shared });
  await writeFile(join(shared, "githooks", "post-commit"), damaged);
  await cli(shared, ["check", "--hook"]);
  assert.equal(await readFile(join(shared, "githooks", "post-commit"), "utf8"), original);

  const fresh = await newRepo("isy-hook-foreign-logout-");
  const commit = (await postCommitPath(fresh))!;
  await writeFile(commit, damaged);
  assert.equal(await removeGitHook(fresh), "removed");
  assert.equal(await readFile(commit, "utf8"), original);
});

test("a push and a commit go through a hook in another language, with the session's hook run before them", async () => {
  const fresh = await newRepo("isy-hook-foreign-push-");
  const bare = await mkdtemp(join(tmpdir(), "isy-hook-foreign-bare-"));
  await run("git", ["init", "-q", "--bare", "-b", "main"], { cwd: bare });
  const body = "#!/usr/bin/env node\nprocess.exit(0);\n";
  for (const path of [(await postCommitPath(fresh))!, (await prePushPath(fresh))!]) {
    await writeFile(path, body);
    await chmod(path, 0o755);
  }

  assert.equal(await autoInstallGitHook(fresh), "already-present");

  const committed = await run("git", ["commit", "-q", "--allow-empty", "-m", "next"], { cwd: fresh });
  assert.equal(committed.stderr, "");
  await run("git", ["push", "-q", bare, "main"], { cwd: fresh });
  assert.equal(await readFile((await prePushPath(fresh))!, "utf8"), body);
});

test("a compiled hook is left alone, and a hook git hands to sh is not", async () => {
  const fresh = await newRepo("isy-hook-compiled-");
  const compiled = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0xff, 0xfe, 0x00, 0x0a]);
  const commit = (await postCommitPath(fresh))!;
  await writeFile(commit, compiled);
  await installGitHook(fresh);
  assert.deepEqual(await readFile(commit), compiled);

  for (const shell of [
    "#!/bin/sh",
    "#! /bin/sh -e",
    "#!/bin/bash",
    "#!/usr/bin/env bash",
    "#!/usr/bin/env -S bash -e",
    "#!/usr/bin/zsh",
    "#!/bin/ksh",
    "#!/bin/dash",
    "#!/bin/ash",
    "#!/nix/store/abc-bash-5.2/bin/bash",
    "# no shebang at all",
  ]) {
    await writeFile(commit, `${shell}\necho mine\n`);
    await installGitHook(fresh);
    assert.ok((await readFile(commit, "utf8")).includes(COMMIT_COMMAND), shell);
    assert.equal(await gitHookInstalled(fresh), true, shell);
  }
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

/**
 * A commit of one new or changed file, the way someone at a terminal makes one. Its
 * own text by default, as the same line under two names reads as one work moved.
 */
async function commitFile(cwd: string, file: string, content = `text of ${file}`): Promise<void> {
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

test("work a session's mark holds stays its own when it moves to another branch", async () => {
  const moves: [string, (cwd: string) => Promise<void>][] = [
    ["redone on a new branch", async (cwd) => {
      await run("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd });
      await run("git", ["switch", "-q", "-c", "feat"], { cwd });
      await run("git", ["commit", "-q", "-m", "redo"], { cwd });
    }],
    ["amended on a new branch", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "feat"], { cwd });
      await run("git", ["commit", "-q", "--amend", "-m", "better"], { cwd });
    }],
    ["picked onto a new branch", async (cwd) => {
      const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
      await run("git", ["switch", "-q", "-c", "feat", "HEAD~1"], { cwd });
      await run("git", ["cherry-pick", stdout.trim()], { cwd });
    }],
    ["amended on the branch renamed under it", async (cwd) => {
      await run("git", ["branch", "-m", "feat"], { cwd });
      await run("git", ["commit", "-q", "--amend", "-m", "better"], { cwd });
    }],
    ["an older mark's file, picked once a later mark changed it", async (cwd) => {
      const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
      await commitFile(cwd, "src/f0.ts", "changed again");
      await runCommit({ noUpload: true }, cwd);
      await run("git", ["switch", "-q", "-c", "feat", "HEAD~2"], { cwd });
      await run("git", ["cherry-pick", stdout.trim()], { cwd });
    }],
  ];
  for (const [name, move] of moves) {
    const cwd = await newRepo("isy-commit-work-moved-");
    const path = await writeSession(cwd, "sess-work-moved", "left-pad");
    await onBranch(path, "main");
    await commitFile(cwd, "src/f0.ts");
    assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined, name);

    await move(cwd);
    assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined, name);
    const state = (await readState())[path]!;
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
    assert.equal(state.commits?.at(-1)?.sha, stdout.trim(), name);
    assert.equal(state.branch, "feat", name);
    await writeFile(sessionStatePath(), "{}\n");
  }
});

const LONG = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") + "\n";
const longWith = (top = "line 0", bottom = "line 39") => LONG.replace("line 0\n", `${top}\n`).replace("line 39\n", `${bottom}\n`);

/** A session on main whose mark changed the top of `f.txt`; another branch changed the bottom. */
async function markedLongFile(prefix: string): Promise<{ cwd: string; path: string; mark: string }> {
  const cwd = await newRepo(prefix);
  await commitFile(cwd, "f.txt", LONG);
  await run("git", ["branch", "up"], { cwd });
  const path = await writeSession(cwd, "sess-changed", "left-pad");
  await onBranch(path, "main");
  await commitFile(cwd, "f.txt", longWith("agent"));
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
  await run("git", ["switch", "-q", "up"], { cwd });
  await commitFile(cwd, "f.txt", longWith("line 0", "upstream"));
  await run("git", ["switch", "-q", "main"], { cwd });
  return { cwd, path, mark: stdout.trim() };
}

test("work a session's mark holds stays its own when it moves to another branch and changes on the way", async () => {
  const amendTweak = async (cwd: string) => {
    await writeFile(join(cwd, "f.txt"), longWith("agent", "human"));
    await run("git", ["add", "."], { cwd });
    await run("git", ["commit", "-q", "--amend", "--no-edit"], { cwd });
  };
  const moves: [string, (cwd: string, mark: string) => Promise<void>][] = [
    ["amended with a tweak on a new branch", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "feat"], { cwd });
      await amendTweak(cwd);
    }],
    ["redone with a tweak on a new branch", async (cwd) => {
      await run("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd });
      await run("git", ["switch", "-q", "-c", "feat"], { cwd });
      await commitFile(cwd, "f.txt", longWith("agent", "human"));
    }],
    ["amended with a tweak on the branch renamed under it", async (cwd) => {
      await run("git", ["branch", "-m", "main", "feat"], { cwd });
      await amendTweak(cwd);
    }],
    ["amended with a tweak on a detached HEAD", async (cwd) => {
      await run("git", ["switch", "-q", "--detach"], { cwd });
      await amendTweak(cwd);
    }],
    ["a copy rebased over a branch that changed the file", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "feat"], { cwd });
      await run("git", ["rebase", "-q", "up"], { cwd });
    }],
    ["picked onto a branch that changed the file", async (cwd, mark) => {
      await run("git", ["switch", "-q", "-c", "feat", "up"], { cwd });
      await run("git", ["cherry-pick", mark], { cwd });
    }],
    ["picked without committing, and tweaked", async (cwd, mark) => {
      await run("git", ["switch", "-q", "-c", "feat", "HEAD~1"], { cwd });
      await run("git", ["cherry-pick", "-n", mark], { cwd });
      await commitFile(cwd, "f.txt", longWith("agent", "human"));
    }],
    ["squashed over a branch that changed the file", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "feat", "up"], { cwd });
      await run("git", ["merge", "-q", "--squash", "main"], { cwd });
      await run("git", ["commit", "-q", "-m", "squashed"], { cwd });
    }],
    ["renamed and amended", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "feat"], { cwd });
      await run("git", ["mv", "f.txt", "g.txt"], { cwd });
      await run("git", ["commit", "-q", "--amend", "--no-edit"], { cwd });
    }],
    ["reindented with CRLF endings on a new branch", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "feat"], { cwd });
      await writeFile(join(cwd, "f.txt"), longWith("agent").replaceAll("\n", "\r\n").replaceAll("line", "  line").replace("agent", "    agent"));
      await run("git", ["add", "."], { cwd });
      await run("git", ["commit", "-q", "--amend", "--no-edit"], { cwd });
    }],
  ];
  for (const [name, move] of moves) {
    const { cwd, path, mark } = await markedLongFile("isy-commit-changed-");
    await move(cwd, mark);
    assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined, name);
    const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd });
    assert.equal((await readState())[path]!.commits?.at(-1)?.sha, stdout.trim(), name);
    await writeFile(sessionStatePath(), "{}\n");
  }
});

test("a merge that settled a file of a session's mark stays its own, unless it kept what stood here", async () => {
  const settles: [string, string | undefined][] = [
    ["by hand, with both sides on one line", longWith("agent+up")],
    ["taking the mark's side whole", longWith("agent")],
    ["keeping the branch's own side", undefined],
  ];
  for (const [name, settled] of settles) {
    const cwd = await newRepo("isy-commit-settled-");
    await commitFile(cwd, "f.txt", LONG);
    await run("git", ["branch", "up"], { cwd });
    const path = await writeSession(cwd, "sess-settled", "left-pad");
    await onBranch(path, "main");
    await commitFile(cwd, "f.txt", longWith("agent"));
    await runCommit({ noUpload: true }, cwd);
    await run("git", ["switch", "-q", "up"], { cwd });
    await commitFile(cwd, "f.txt", longWith("up"));
    await run("git", ["switch", "-q", "-c", "mix"], { cwd });
    await assert.rejects(run("git", ["merge", "main"], { cwd }));
    await writeFile(join(cwd, "f.txt"), settled ?? longWith("up"));
    await run("git", ["add", "."], { cwd });
    await run("git", ["commit", "-q", "--no-edit"], { cwd });

    const { skipped } = await runCommit({ noUpload: true }, cwd);
    if (settled) assert.equal(skipped, undefined, name);
    else assert.match(skipped ?? "", /another branch/, name);
    await writeFile(sessionStatePath(), "{}\n");
  }
});

test("a file a session wrote and nobody marked stays its own when it is renamed on another branch", async () => {
  const cwd = await newRepo("isy-commit-renamed-");
  const path = await writeSession(cwd, "sess-renamed", "left-pad");
  await onBranch(path, "main");
  const written = "what only this session wrote\n";
  await appendTurn(path, "sess-renamed", { type: "tool_use", id: "t-write", name: "Write", input: { file_path: join(cwd, "new.txt"), content: written } }, OLD);
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  await commitFile(cwd, "moved.txt", written);
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "feat");
});

test("a binary a session's mark added stays its own when it is renamed on another branch", async () => {
  const cwd = await newRepo("isy-commit-binary-");
  const path = await writeSession(cwd, "sess-binary", "left-pad");
  await onBranch(path, "main");
  await commitFile(cwd, "logo.png", "\0\x01\x02 made of no lines");
  await runCommit({ noUpload: true }, cwd);
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  await run("git", ["mv", "logo.png", "icon.png"], { cwd });
  await run("git", ["commit", "-q", "--amend", "--no-edit"], { cwd });
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "feat");
});

test("a commit on another branch sharing nothing of a session's marks, or only boilerplate, is not its own", async () => {
  const refused: [string, (cwd: string, mark: string) => Promise<void>][] = [
    ["the marked file, to other text", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "other"], { cwd });
      await commitFile(cwd, "f.txt", longWith("human"));
    }],
    ["another file", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "other"], { cwd });
      await commitFile(cwd, "h.txt", "human\n");
    }],
    ["a line of punctuation in common", async (cwd) => {
      await run("git", ["switch", "-q", "-c", "other"], { cwd });
      await commitFile(cwd, "h.txt", "human\n}\n");
    }],
    ["a revert of the mark", async (cwd, mark) => {
      await run("git", ["switch", "-q", "-c", "other"], { cwd });
      await run("git", ["revert", "--no-edit", mark], { cwd });
    }],
    ["the marks gone from the repository", async (cwd) => {
      await run("git", ["reset", "-q", "--hard", "HEAD~1"], { cwd });
      await run("git", ["reflog", "expire", "--expire=now", "--all"], { cwd });
      await run("git", ["gc", "-q", "--prune=now"], { cwd });
      await run("git", ["switch", "-q", "-c", "other"], { cwd });
      await commitFile(cwd, "h.txt", "human\n");
    }],
  ];
  for (const [name, commit] of refused) {
    const { cwd, path, mark } = await markedLongFile("isy-commit-unrelated-");
    await commit(cwd, mark);
    assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/, name);
    assert.equal((await readState())[path]!.commits?.length, 1, name);
    await writeFile(sessionStatePath(), "{}\n");
  }

  // Two lines any two commits in a language have in common, among thirty of each.
  const cwd = await newRepo("isy-commit-boilerplate-");
  const path = await writeSession(cwd, "sess-boilerplate", "left-pad");
  await onBranch(path, "main");
  const body = (who: string) => Array.from({ length: 28 }, (_, index) => `${who}(${index});`).concat("return null;", "} else {").join("\n");
  await commitFile(cwd, "own.ts", body("agent"));
  await runCommit({ noUpload: true }, cwd);
  await run("git", ["switch", "-q", "-c", "other"], { cwd });
  await commitFile(cwd, "theirs.ts", body("human"));
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);
  assert.equal((await readState())[path]!.commits?.length, 1);
});

test("a mark too large for git to read back leaves the commit with the session", async () => {
  const cwd = await newRepo("isy-commit-huge-mark-");
  const path = await writeSession(cwd, "sess-huge-mark", "left-pad");
  await onBranch(path, "main");
  await commitFile(cwd, "big.txt", "a line of a generated file\n".repeat(200_000));
  await runCommit({ noUpload: true }, cwd);
  await run("git", ["switch", "-q", "-c", "other"], { cwd });
  await commitFile(cwd, "h.txt", "human\n");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "other");
});

test("a copy of a session's branch rebased elsewhere stays its own", async () => {
  const cwd = await newRepo("isy-commit-copied-");
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  const path = await writeSession(cwd, "sess-copied", "left-pad");
  await onBranch(path, "feat");
  await commitFile(cwd, "src/f0.ts");
  await runCommit({ noUpload: true }, cwd);
  await commitFile(cwd, "src/f1.ts");
  await runCommit({ noUpload: true }, cwd);

  await run("git", ["switch", "-q", "main"], { cwd });
  await commitFile(cwd, "m.txt");
  await run("git", ["switch", "-q", "-c", "feat2", "feat"], { cwd });
  await run("git", ["rebase", "-q", "main"], { cwd });
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "feat2");
});

test("what a session edited and no mark took goes with it, though its last mark is behind the edit", async () => {
  const cwd = await newRepo("isy-commit-split-");
  const path = await writeSession(cwd, "sess-split", "left-pad");
  await onBranch(path, "main");
  await commitFile(cwd, "src/f0.ts");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);

  await run("git", ["switch", "-q", "-c", "rest"], { cwd });
  await commitFile(cwd, "src/f1.ts");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "rest");
});

test("a mark says nothing of another commit to its files, or of a merge that brings them in", async () => {
  const cwd = await newRepo("isy-commit-not-moved-");
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  const path = await writeSession(cwd, "sess-not-moved", "left-pad");
  await onBranch(path, "feat");
  await commitFile(cwd, "src/f0.ts");
  await runCommit({ noUpload: true }, cwd);
  await commitFile(cwd, "own.txt");
  await runCommit({ noUpload: true }, cwd);

  // An earlier mark took this file, and what is committed here is not what it took.
  await run("git", ["switch", "-q", "-c", "other", "main"], { cwd });
  await commitFile(cwd, "src/f0.ts", "someone else's");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);

  await run("git", ["merge", "-q", "--no-ff", "-m", "bring it in", "feat", "-X", "ours"], { cwd });
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);
  assert.equal((await readState())[path]!.commits?.length, 2);
  assert.equal((await readState())[path]!.branch, "feat");
});

test("a file named HEAD does not cost a commit the list of what it holds", async () => {
  const cwd = await newRepo("isy-commit-named-head-");
  await commitFile(cwd, "HEAD");
  const path = await writeSession(cwd, "sess-named-head", "left-pad");
  await onBranch(path, "main");

  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  await commitFile(cwd, "src/f0.ts");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "feat");
});

test("a merge is known by the conflict it settled, whichever side that took", async () => {
  for (const settled of ["feat's", "both"]) {
    const cwd = await newRepo("isy-commit-settled-");
    await run("git", ["switch", "-q", "-c", "feat"], { cwd });
    const path = await writeSession(cwd, "sess-settled", "left-pad");
    await onBranch(path, "feat");
    await commitFile(cwd, "a.txt", "feat's");
    await runCommit({ noUpload: true }, cwd);

    await run("git", ["switch", "-q", "main"], { cwd });
    await commitFile(cwd, "a.txt", "main's");
    await run("git", ["merge", "-q", "feat"], { cwd }).catch(() => undefined);
    await appendTurn(path, "sess-settled", {
      type: "tool_use",
      id: "t-settle",
      name: "Edit",
      input: { file_path: join(cwd, "a.txt"), old_string: "<<<<<<<", new_string: settled },
    }, OLD);
    await commitFile(cwd, "a.txt", settled);

    assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined, settled);
    assert.equal((await readState())[path]!.branch, "main", settled);
    await writeFile(sessionStatePath(), "{}\n");
  }
});

test("an edit through a symlinked directory is matched against where the file really is", async () => {
  const cwd = await realpath(await newRepo("isy-commit-through-link-"));
  await commitFile(cwd, "real/a.txt", "one");
  await symlink("real", join(cwd, "link"));
  const path = await writeSession(cwd, "sess-through-link", "left-pad");
  await appendTurn(path, "sess-through-link", {
    type: "tool_use",
    id: "t-link",
    name: "Edit",
    input: { file_path: join(cwd, "link/a.txt"), old_string: "one", new_string: "two" },
  }, OLD);
  await onBranch(path, "main");

  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  await commitFile(cwd, "real/a.txt", "two");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
});

test("an MCP tool whose name does not say it only reads keeps the commit with its session", async () => {
  for (const [tool, input, kept] of [
    ["mcp__ide__executeCode", { code: "open('a','w')" }, true],
    ["mcp__x__format_all", {}, true],
    ["mcp__github__get_file_contents", { path: "a.txt" }, false],
    ["mcp__fs__readFile", { path: "a.txt" }, false],
    ["mcp__docs__search", { query: "x" }, false],
  ] as const) {
    const cwd = await newRepo("isy-commit-mcp-");
    const path = await writeSession(cwd, "sess-mcp", "left-pad");
    await appendTurn(path, "sess-mcp", { type: "tool_use", id: "t-mcp", name: tool, input }, OLD);
    await onBranch(path, "main");
    await run("git", ["switch", "-q", "-c", "feat"], { cwd });
    await commitFile(cwd, "README.md");

    const { skipped } = await runCommit({ noUpload: true }, cwd);
    if (kept) assert.equal(skipped, undefined, tool);
    else assert.match(skipped ?? "", /another branch/, tool);
    await writeFile(sessionStatePath(), "{}\n");
  }
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

test("an edit named from where the session stood is matched from the top of the repository", async () => {
  const top = await realpath(await newRepo("isy-commit-relative-"));
  await mkdir(join(top, "pkg"));
  const path = await writeSession(join(top, "pkg"), "sess-relative", "left-pad");
  await appendTurn(path, "sess-relative", {
    type: "tool_use", id: "t-edit", name: "Edit",
    input: { file_path: "lib/x.ts", old_string: "a", new_string: "b" },
  }, OLD);
  await onBranch(path, "main");

  await run("git", ["switch", "-q", "-c", "feat"], { cwd: top });
  await commitFile(top, "pkg/lib/x.ts");
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

test("a running command that only says git or commit takes nothing from the session whose work it is", async () => {
  for (const busy of [
    "pytest tests/git/ -x",
    "git fetch origin",
    "git log -p | less",
    "tail -f ~/git/app/server.log",
    "cd ~/git/other && npm test",
    "npm --prefix tools/commit run dev",
  ]) {
    const cwd = await realpath(await newRepo("isy-commit-word-"));
    const older = await writeSession(cwd, "sess-busy", "left-pad");
    await appendTurn(older, "sess-busy", shell("t-busy", busy), new Date().toISOString());
    await age(older, 1 / 1440);
    const newest = await writeSession(cwd, "sess-worker", "ms");

    await commitFile(cwd, "src/f0.ts");
    assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-worker", busy);
    assert.equal((await readState())[newest]?.commits?.length, 1, busy);
    assert.equal((await readState())[older]?.commits, undefined, busy);
    await writeFile(sessionStatePath(), "{}\n");
  }
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

test("a transcript that cannot be read costs the commit no one else's mark", { skip: process.getuid?.() === 0 }, async () => {
  const cwd = await realpath(await newRepo("isy-commit-unreadable-"));
  await mkdir(join(cwd, "pkg"));
  const below = await writeSession(join(cwd, "pkg"), "sess-below", "ms");
  const older = await writeSession(cwd, "sess-older", "left-pad");
  await age(below, 2 / 1440);
  await age(older, 1 / 1440);
  const newest = await writeSession(cwd, "sess-newest", "ms");
  await commitFile(cwd, "whatever.txt");

  // Where a session ran is read off its transcript too, for one further down the tree.
  await chmod(below, 0o000);
  await chmod(older, 0o000);
  assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-newest");
  assert.equal((await readState())[newest]?.commits?.length, 1);

  await chmod(older, 0o600);
  await chmod(newest, 0o000);
  assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-older");

  // None left to ask is a commit with no mark, never a hook that dies.
  await chmod(older, 0o000);
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /could be read/);

  for (const path of [below, older, newest]) await chmod(path, 0o600);
});

test("a session redaction throws on leaves a commit with no mark, and the journal says which", async () => {
  const cwd = await realpath(await newRepo("isy-commit-deep-"));
  const session = await writeSession(cwd, "sess-deep", "ms");
  const nested = `${"[".repeat(200_000)}${"]".repeat(200_000)}`;
  await appendFile(session, `\n{"type":"assistant","sessionId":"sess-deep","message":{"role":"assistant","content":[{"type":"tool_use","id":"t","name":"mcp__x__y","input":{"a":${nested}}}]}}\n`);
  await commitFile(cwd, "whatever.txt");

  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /could not be read/);
  const said = readJournal().filter((entry) => entry.level === "error").at(-1)?.message ?? "";
  assert.match(said, /^commit: sess-deep could not be read: Maximum call stack/);
});

test("telling sessions apart reads no further than its budget, at every pick of a rebase", async () => {
  const cwd = await realpath(await newRepo("isy-commit-budget-"));
  const megabytes = (size: number) =>
    `${record({ type: "user", message: { role: "user", content: "x".repeat(size * 1024 * 1024) } })}\n`;

  const huge = await writeSession(cwd, "sess-huge", "ms");
  await appendFile(huge, `\n${megabytes(17)}`);
  const second = await writeSession(cwd, "sess-second", "ms");
  await appendFile(second, `\n${megabytes(9)}`);
  const third = await writeSession(cwd, "sess-third", "ms");
  await appendFile(third, `\n${megabytes(9)}`);
  await writeSession(cwd, "sess-newest", "ms");
  await age(huge, 1 / 1440);
  await age(second, 2 / 1440);
  await age(third, 3 / 1440);
  await commitFile(cwd, "README.md");

  const reads: string[] = [];
  const { parsedSession, redactedLines } = claudeAgent;
  claudeAgent.parsedSession = async (path, sessionCwd) => {
    reads.push(basename(path, ".jsonl"));
    return parsedSession(path, sessionCwd);
  };
  claudeAgent.redactedLines = async (path, options) => {
    reads.push(basename(path, ".jsonl"));
    return redactedLines(path, options);
  };
  try {
    assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-newest");
  } finally {
    Object.assign(claudeAgent, { parsedSession, redactedLines });
  }

  // One over the budget is passed over for the next one under it, and what is
  // left of the budget, not each session's own size, decides the one after that.
  assert.ok(!reads.includes("sess-huge"), reads.join());
  assert.ok(reads.includes("sess-second"), reads.join());
  assert.ok(!reads.includes("sess-third"), reads.join());
});

test("how much of git a commit asks does not grow with the sessions active beside it", async () => {
  const cwd = await realpath(await newRepo("isy-commit-many-"));
  const newest = await writeSession(cwd, "sess-newest", "ms");
  for (let index = 0; index < 20; index += 1) {
    await age(await writeSession(cwd, `sess-${index}`, "ms"), 1 / 1440);
  }
  await commitFile(cwd, "README.md");

  // Every git this process starts leaves a line, before running the real one.
  const bin = await mkdtemp(join(tmpdir(), "isy-commit-bin-"));
  const log = join(bin, "calls");
  const real = (await run("sh", ["-c", "command -v git"], { cwd })).stdout.trim();
  await writeFile(join(bin, "git"), `#!/bin/sh\necho "$1" >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-newest");
  } finally {
    process.env.PATH = path;
  }
  assert.equal((await readState())[newest]?.commits?.length, 1);

  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.filter((call) => call === "show").length, 1, calls.join());
  assert.ok(calls.length <= 12, calls.join());
});

test("a tree full of other repositories' sessions bounds the walk a commit makes for its own", async () => {
  const cwd = await realpath(await newRepo("isy-commit-walk-"));
  const nested = await newRepo("isy-commit-walk-nested-");
  const inside = join(cwd, "work", "proj");
  await mkdir(dirname(inside), { recursive: true });
  await rename(nested, inside);
  for (let index = 0; index < 40; index += 1) {
    await age(await writeSession(inside, `sess-nested-${index}`, "ms"), 2 / 24);
  }
  const own = await writeSession(cwd, "sess-own", "ms");
  await age(own, 3 / 24);
  await commitFile(cwd, "README.md");

  const { cwdOf } = claudeAgent;
  let looked = 0;
  claudeAgent.cwdOf = async (file) => {
    looked += 1;
    return cwdOf(file);
  };
  try {
    assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-own");
  } finally {
    claudeAgent.cwdOf = cwdOf;
  }
  assert.ok(looked <= 32, String(looked));
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

  // Once that branch is gone under another name, its row goes too.
  await run("git", ["branch", "-m", "main", "trunk"], { cwd });
  await commitFile(cwd, "other.md");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
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

test("a branch the agent left for itself, or a rename, leaves its row behind and the session on it", async () => {
  const cwd = await newRepo("isy-commit-moved-");
  await run("git", ["switch", "-q", "-c", "feat1"], { cwd });
  const path = await writeSession(cwd, "sess-moved", "left-pad");
  await onBranch(path, "feat1");
  await commitFile(cwd, "own.txt");
  await runCommit({ noUpload: true }, cwd);
  assert.equal((await readState())[path]!.branch, "feat1");

  // The agent made a branch and went on there; a human commits on it.
  await appendTurn(path, "sess-moved", shell("t-move", "git switch -c feat2"), OLD);
  await onBranch(path, "feat2");
  await run("git", ["switch", "-q", "-c", "feat2"], { cwd });
  await commitFile(cwd, "human.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "feat2");

  // Renamed under it: the name in its row is on nothing any more.
  await run("git", ["branch", "-m", "feat3"], { cwd });
  await appendTurn(path, "sess-moved", { type: "text", text: "still here" }, OLD);
  await onBranch(path, "feat3");
  await commitFile(cwd, "renamed.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "feat3");

  // A move the transcript does not end on says nothing of the branch it did end on.
  await appendTurn(path, "sess-moved", shell("t-away", "git switch -c feat4 && git switch feat3"), OLD);
  await run("git", ["switch", "-q", "-c", "feat4"], { cwd });
  await commitFile(cwd, "someone-else.txt");
  assert.match((await runCommit({ noUpload: true }, cwd)).skipped ?? "", /another branch/);
});

test("a command nobody can read keeps the commit with its session, and one that only looks gives it up", async () => {
  for (const [command, file, kept] of [
    [`python3 -c "open('docs/n.md','w').write('x')"`, "docs/n.md", true],
    ["npx prettier --write src/a.ts", "src/a.ts", true],
    ["git apply fix.patch", "src/a.ts", true],
    ["curl -o docs/n.md http://x/y", "docs/n.md", true],
    ["cargo fmt", "src/a.rs", true],
    ["npm run format", "src/a.ts", true],
    ["npm install", "package-lock.json", true],
    ["sed -i 's/one/two/' $(git ls-files)", "src/a.ts", true],
    ["for f in src/*.ts; do sed -i 's/a/b/' $f; done", "src/a.ts", true],
    ["git checkout other -- src/a.ts", "src/a.ts", true],
    ["sort -o src/a.txt src/a.txt", "src/a.txt", true],
    ["gh pr checkout 12", "README.md", true],
    ["git status && git log -3 && cat README.md", "README.md", false],
    ["git add -A && git commit -m notes.md && git push", "docs/notes.md", false],
    ["gh pr create --fill", "other.md", false],
  ] as const) {
    const cwd = await newRepo("isy-commit-unread-");
    const path = await writeSession(cwd, "sess-unread", "left-pad");
    await appendTurn(path, "sess-unread", shell("t-call", command), OLD);
    await onBranch(path, "main");
    await run("git", ["switch", "-q", "-c", "feat"], { cwd });
    await commitFile(cwd, file);

    const { skipped } = await runCommit({ noUpload: true }, cwd);
    if (kept) assert.equal(skipped, undefined, command);
    else assert.match(skipped ?? "", /another branch/, command);
    await writeFile(sessionStatePath(), "{}\n");
  }

  // Waiting on one that only looks says nothing either, and on one nobody can read it may.
  for (const [busy, kept] of [["tail -f server.log", false], ["./release.sh", true]] as const) {
    const cwd = await newRepo("isy-commit-busy-");
    const path = await writeSession(cwd, "sess-busy", "left-pad");
    await appendTurn(path, "sess-busy", shell("t-busy", busy), new Date().toISOString());
    await onBranch(path, "main");
    await run("git", ["switch", "-q", "-c", "feat"], { cwd });
    await commitFile(cwd, "README.md");
    assert.equal((await runCommit({ noUpload: true }, cwd)).skipped === undefined, kept, busy);
  }
});

test("a commit passes over a newer session on another branch for the one standing on this one", async () => {
  const cwd = await realpath(await newRepo("isy-commit-standing-"));
  await mkdir(join(cwd, "docs"));
  await run("git", ["switch", "-q", "-c", "feat"], { cwd });
  const standing = await writeSession(cwd, "sess-standing", "left-pad");
  await onBranch(standing, "feat");
  await age(standing, 1 / 1440);
  const elsewhere = await writeSession(join(cwd, "docs"), "sess-elsewhere", "ms");
  await onBranch(elsewhere, "main");

  await commitFile(cwd, "README.md");
  assert.equal((await runCommit({ noUpload: true }, cwd)).sessionId, "sess-standing");
  assert.equal((await readState())[elsewhere]?.commits, undefined);
});

test("a tag named like the branch does not change the branch's name", async () => {
  const cwd = await newRepo("isy-commit-tagged-");
  await run("git", ["switch", "-q", "-c", "release"], { cwd });
  await run("git", ["tag", "release"], { cwd });
  const path = await writeSession(cwd, "sess-tagged", "left-pad");
  await onBranch(path, "release");
  assert.equal(await currentBranch(cwd), "release");

  await commitFile(cwd, "human.txt");
  assert.equal((await runCommit({ noUpload: true }, cwd)).skipped, undefined);
  assert.equal((await readState())[path]!.branch, "release");

  const metadata = await collectGitMetadata(cwd);
  assert.ok(metadata.ok);
  assert.equal(metadata.metadata.branch, "release");
});

test("a redaction pattern that matches a name does not hide the session from the commit", async () => {
  await writeConfig({ token: "t", apiBaseUrl: baseUrl, extraRedactPatterns: ["acme"] });

  // Standing on a branch the pattern matches, with nothing else to go on.
  const idle = await newRepo("isy-commit-pattern-idle-");
  await run("git", ["switch", "-q", "-c", "fix/acme-login"], { cwd: idle });
  const idlePath = await writeSession(idle, "sess-idle", "left-pad");
  await onBranch(idlePath, "fix/acme-login");
  await commitFile(idle, "human.txt");
  assert.equal((await runCommit({ noUpload: true }, idle)).skipped, undefined);
  assert.equal((await readState())[idlePath]!.branch, "fix/acme-login");

  // A row an upload stamped holds the name as it went up.
  await writeFile(sessionStatePath(), `${JSON.stringify({ [idlePath]: { branch: "fix/[ISY_REDACTED:custom]-login" } })}\n`);
  await commitFile(idle, "human-again.txt");
  assert.equal((await runCommit({ noUpload: true }, idle)).skipped, undefined);

  // An edit to a file the pattern matches, committed on a new branch by a human.
  const edited = await newRepo("isy-commit-pattern-edit-");
  const editedPath = await writeSession(edited, "sess-edited", "left-pad");
  await appendTurn(editedPath, "sess-edited", {
    type: "tool_use", id: "t-edit", name: "Edit",
    input: { file_path: join(edited, "src/acme/x.ts"), old_string: "a", new_string: "b" },
  }, OLD);
  await onBranch(editedPath, "main");
  await run("git", ["switch", "-q", "-c", "feat"], { cwd: edited });
  await commitFile(edited, "src/acme/x.ts");
  assert.equal((await runCommit({ noUpload: true }, edited)).skipped, undefined);

  // And one made through the shell.
  const shelled = await newRepo("isy-commit-pattern-shell-");
  const shelledPath = await writeSession(shelled, "sess-shelled", "acme-lib");
  await appendTurn(shelledPath, "sess-shelled", shell("t-sed", "sed -i 's/a/b/' acme.txt"), OLD);
  await onBranch(shelledPath, "main");
  await run("git", ["switch", "-q", "-c", "feat"], { cwd: shelled });
  await commitFile(shelled, "acme.txt");
  const report = await runCommit({ noUpload: true }, shelled);
  assert.equal(report.skipped, undefined);

  // Telling sessions apart saw the names, and what it reports went through the pattern.
  assert.ok(report.candidates.length > 0);
  assert.ok(!JSON.stringify(report.candidates).includes("acme"));
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

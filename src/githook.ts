import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const SHEBANG = "#!/bin/sh";
const BEGIN = "# isy:begin — managed by isy, do not edit inside this block";
const END = "# isy:end";

/**
 * `|| true` is not about git — git ignores what post-commit returns, the commit
 * already happened. It is about the user's own script: a hook running under
 * `set -e` must not abort at our line.
 */
export const COMMIT_COMMAND = "npx @nightloom/isy commit --hook || true";

/**
 * The push is the moment the analysis is actually waiting for: a pull request
 * is opened or updated seconds later, and matching is by commit SHA. The
 * commit hook alone leaves a gap — a session that kept working after the last
 * commit, or a commit made before isy was installed in this repository.
 *
 * Backgrounded rather than run: git waits for pre-push, and a push must not
 * stop for the network. Its exit code is therefore never ours, which is also
 * why nothing here can reject a push. stdin is closed explicitly — git writes
 * the refs being pushed to it, and the upload has no use for them.
 *
 * Backgrounding is also why the block has to go at the top of the file rather
 * than the bottom (`insert`): `&` always succeeds, so as the last line of
 * someone else's pre-push it would hand git a 0 for a push their own hook had
 * just rejected.
 */
export const PUSH_COMMAND = "npx @nightloom/isy upload --silent --all >/dev/null 2>&1 </dev/null &";

/**
 * The repository-side hooks, both written into the same managed block format.
 * One list, because every operation here — install, inspect, remove — has to
 * cover all of them or leave the repository half-wired.
 */
export const GIT_HOOKS: { name: string; command: string }[] = [
  { name: "post-commit", command: COMMIT_COMMAND },
  { name: "pre-push", command: PUSH_COMMAND },
];

export type GitHookOutcome =
  | "installed"
  | "already-present"
  | "removed"
  | "absent"
  | "not-a-repository";

function block(command: string): string {
  return `${BEGIN}\n${command}\n${END}`;
}

/**
 * Where a new block goes: straight after the shebang, ahead of whatever the
 * user's own script does.
 *
 * Two reasons, one position. A hook whose last statement is `exec` or `exit`
 * never reaches a block appended below it — and isy would still report it as
 * installed, because the text is in the file. And the hook's exit status is the
 * status of its last command, so a block at the bottom answers git on the
 * user's behalf: for pre-push that turns a rejection into a push.
 */
function insert(contents: string, desired: string): string {
  if (!contents.startsWith("#!")) return `${desired}\n${contents}`;

  // A file that is nothing but a shebang has no line to insert before.
  const cut = contents.indexOf("\n");
  if (cut < 0) return `${contents}\n${desired}\n`;

  return `${contents.slice(0, cut + 1)}${desired}\n${contents.slice(cut + 1)}`;
}

/**
 * Where git will actually look for hooks in this repository. `--git-path`
 * honours `core.hooksPath`, so a repo driven by husky or lefthook gets the
 * block in the directory those tools own rather than in a `.git/hooks` git
 * never reads.
 */
export async function gitHooksDir(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", ["rev-parse", "--git-path", "hooks"], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    const path = stdout.trim();
    if (path.length === 0) return undefined;
    return isAbsolute(path) ? path : resolve(cwd, path);
  } catch {
    return undefined;
  }
}

/** Where git would look for one of our hooks in this repository. */
export async function hookPath(cwd: string, name: string): Promise<string | undefined> {
  const dir = await gitHooksDir(cwd);
  return dir === undefined ? undefined : resolve(dir, name);
}

export function postCommitPath(cwd: string): Promise<string | undefined> {
  return hookPath(cwd, "post-commit");
}

export function prePushPath(cwd: string): Promise<string | undefined> {
  return hookPath(cwd, "pre-push");
}

async function readHook(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The managed block as it currently stands in this file, if it is there at all. */
function existingBlock(contents: string): string | undefined {
  const start = contents.indexOf(BEGIN);
  if (start < 0) return undefined;
  const stop = contents.indexOf(END, start);
  return stop < 0 ? undefined : contents.slice(start, stop + END.length);
}

async function oneInstalled(cwd: string, hook: { name: string; command: string }): Promise<boolean> {
  const path = await hookPath(cwd, hook.name);
  if (!path) return false;
  const contents = await readHook(path);
  return contents !== undefined && existingBlock(contents) === block(hook.command);
}

/** True only with every hook in place: half-wired is not installed. */
export async function gitHookInstalled(cwd: string): Promise<boolean> {
  for (const hook of GIT_HOOKS) if (!(await oneInstalled(cwd, hook))) return false;
  return true;
}

async function installOne(
  cwd: string,
  hook: { name: string; command: string },
): Promise<GitHookOutcome> {
  const path = await hookPath(cwd, hook.name);
  if (!path) return "not-a-repository";

  const contents = await readHook(path);
  const desired = block(hook.command);

  if (contents === undefined) {
    await writeFile(path, `${SHEBANG}\n${desired}\n`, "utf8");
    await chmod(path, 0o755);
    return "installed";
  }

  const existing = existingBlock(contents);
  if (existing === desired) {
    // A hook git will not execute is not installed, whatever the file says.
    await chmod(path, 0o755);
    return "already-present";
  }

  const next = existing === undefined ? insert(contents, desired) : contents.replace(existing, desired);

  await writeFile(path, next, "utf8");
  await chmod(path, 0o755);
  return "installed";
}

/**
 * Adds the block to each of this repository's hooks, creating the file where
 * there is none and inserting above the user's own script where there is
 * (`insert`). An older block is replaced in place rather than stacked — which is also how a
 * repository wired by an isy that only knew about post-commit picks up
 * pre-push: it reports "installed" until every hook is there.
 */
export async function installGitHook(cwd: string): Promise<GitHookOutcome> {
  let outcome: GitHookOutcome = "already-present";

  for (const hook of GIT_HOOKS) {
    const result = await installOne(cwd, hook);
    if (result === "not-a-repository") return result;
    if (result === "installed") outcome = "installed";
  }

  return outcome;
}

/**
 * The hooks directory and the git directory, both absolute and both resolved by
 * git, so a worktree or a symlinked checkout compares like for like.
 */
async function hookLocation(cwd: string): Promise<{ hooks: string; gitDir: string } | undefined> {
  try {
    const { stdout } = await run(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-path", "hooks", "--git-common-dir"],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    const [hooks, gitDir] = stdout.split("\n").map((line) => line.trim());
    return hooks && gitDir ? { hooks, gitDir } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the SessionEnd hook runs in every repository a session happened in, so
 * `isy init` is once per machine rather than once per repository. It writes
 * only where nobody else will see it: a hooks directory inside the git
 * directory. One that core.hooksPath points elsewhere — `.husky`, a team's
 * `githooks/` — is usually committed, and writing there would hand the hook to
 * every teammate. That one is left to `isy init`, run on purpose.
 */
export async function autoInstallGitHook(cwd: string): Promise<GitHookOutcome | "shared-hooks"> {
  const location = await hookLocation(cwd);
  if (!location) return "not-a-repository";
  if (await gitHookInstalled(cwd)) return "already-present";

  const inside = relative(location.gitDir, location.hooks);
  if (inside.startsWith("..") || isAbsolute(inside)) return "shared-hooks";

  // A repository created without templates has no hooks directory at all.
  await mkdir(location.hooks, { recursive: true });
  return installGitHook(cwd);
}

async function removeOne(cwd: string, name: string): Promise<GitHookOutcome> {
  const path = await hookPath(cwd, name);
  if (!path) return "not-a-repository";

  const contents = await readHook(path);
  if (contents === undefined) return "absent";

  const existing = existingBlock(contents);
  if (existing === undefined) return "absent";

  const stripped = contents.replace(existing, "").replace(/\n{3,}/g, "\n\n");

  if (stripped.replace(SHEBANG, "").trim().length === 0) {
    await rm(path, { force: true });
    return "removed";
  }

  await writeFile(path, stripped.endsWith("\n") ? stripped : `${stripped}\n`, "utf8");
  return "removed";
}

/**
 * Strips the block from every hook it is in. A file that held nothing but our
 * block is deleted rather than left as an empty script, so uninstalling puts
 * the repo back as it was. "removed" when anything was there to remove: a
 * repository wired by an older isy has only the post-commit block, and that is
 * still an uninstall.
 */
export async function removeGitHook(cwd: string): Promise<GitHookOutcome> {
  let outcome: GitHookOutcome = "absent";

  for (const hook of GIT_HOOKS) {
    const result = await removeOne(cwd, hook.name);
    if (result === "not-a-repository") return result;
    if (result === "removed") outcome = "removed";
  }

  return outcome;
}

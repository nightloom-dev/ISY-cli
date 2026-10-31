import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { workTreeTop } from "./git.js";
import { NPX_ISY, NPX_ISY_CACHED } from "./hook.js";
import { logLine } from "./log.js";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const SHEBANG = "#!/bin/sh";
/**
 * A hook is read and written as latin1, one character to a byte, so that what a
 * user's script holds comes back out as it went in, valid UTF-8 or not. So the
 * one character here that is not ASCII is spelled as its bytes.
 */
const BEGIN = Buffer.from("# isy:begin — managed by isy, do not edit inside this block").toString("latin1");
const END = "# isy:end";

/**
 * `|| true` is not about git — git ignores what post-commit returns, the commit
 * already happened. It is about the user's own script: a hook running under
 * `set -e` must not abort at our line.
 */
export const COMMIT_COMMAND = `${NPX_ISY_CACHED} commit --hook || true`;

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
export const PUSH_COMMAND = `${NPX_ISY} upload --silent --all >/dev/null 2>&1 </dev/null &`;

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
  | "not-a-repository"
  | "not-shell";

function block(command: string): string {
  return `${BEGIN}\n${command}\n${END}`;
}

/** The program a shebang line runs, looking through `env`. */
function interpreter(contents: string): string | undefined {
  if (!contents.startsWith("#!")) return undefined;
  const [program = "", ...rest] = contents.slice(2).split("\n", 1)[0]!.trim().split(/\s+/);
  const name = basename(program);
  if (name !== "env") return name;
  return basename(rest.find((word) => !word.startsWith("-") && !word.includes("=")) ?? "");
}

/**
 * Whether the block can stand in this hook. It is shell, and in a python, node or
 * perl script it is a syntax error that takes the user's hook down with it: for
 * pre-push, that rejects the push. Prepended to a compiled program it destroys it.
 * A file with no shebang is shell: git hands it to sh. An interpreter not known
 * here is left alone, which costs a hook and breaks nothing.
 */
function takesBlock(contents: string): boolean {
  if (contents.includes("\0")) return false;
  const program = interpreter(contents);
  return program === undefined || /^(?:a|ba|da|k|mk|pdk|y|z)?sh\d*$/.test(program);
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
    return await readFile(path, "latin1");
  } catch {
    return undefined;
  }
}

/**
 * Swapped in whole rather than written over, with the mode it has now. A hook is
 * rewritten by the very commands it runs, and a shell reads its script as it
 * goes: written in place, bash would carry on from its old offset, in the middle
 * of a line of the new text. A hook linked in from elsewhere stays linked.
 */
async function replaceHook(path: string, contents: string): Promise<void> {
  const target = await realpath(path);
  const temporary = join(dirname(target), `.${basename(target)}.isy-${process.pid}`);
  await writeFile(temporary, contents, "latin1");
  await chmod(temporary, (await stat(target)).mode & 0o7777);
  await rename(temporary, target);
}

/** The managed block as it currently stands in this file, if it is there at all. */
function existingBlock(contents: string): string | undefined {
  const start = contents.indexOf(BEGIN);
  if (start < 0) return undefined;
  const stop = contents.indexOf(END, start);
  return stop < 0 ? undefined : contents.slice(start, stop + END.length);
}

/** The file without its block and the newline `insert` gave it: what the user had before. */
function withoutBlock(contents: string, existing: string): string {
  const start = contents.indexOf(existing);
  const stop = start + existing.length;
  return contents.slice(0, start) + contents.slice(contents[stop] === "\n" ? stop + 1 : stop);
}

async function oneInstalled(cwd: string, hook: { name: string; command: string }): Promise<boolean> {
  const path = await hookPath(cwd, hook.name);
  if (!path) return false;
  const contents = await readHook(path);
  if (contents === undefined) return false;
  // Nothing is missing from a hook that takes no block, and `isy init` cannot add it.
  return existingBlock(contents) === (takesBlock(contents) ? block(hook.command) : undefined);
}

/** True only with every hook in place: half-wired is not installed. */
export async function gitHookInstalled(cwd: string): Promise<boolean> {
  for (const hook of GIT_HOOKS) if (!(await oneInstalled(cwd, hook))) return false;
  return true;
}

/** The hooks that take no block, and what each would have to run: wiring them is the user's to do. */
export async function hooksLeftToTheUser(
  cwd: string,
): Promise<{ name: string; command: string; language: string }[]> {
  const left: { name: string; command: string; language: string }[] = [];
  for (const hook of GIT_HOOKS) {
    const path = await hookPath(cwd, hook.name);
    const contents = path === undefined ? undefined : await readHook(path);
    if (contents !== undefined && !takesBlock(contents)) {
      left.push({ ...hook, language: interpreter(contents) ?? "compiled" });
    }
  }
  return left;
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
    await writeFile(path, `${SHEBANG}\n${desired}\n`, "latin1");
    await chmod(path, 0o755);
    return "installed";
  }

  const existing = existingBlock(contents);
  if (!takesBlock(contents)) {
    // An older isy put it there, and every run of this hook has failed since.
    if (existing !== undefined) {
      await replaceHook(path, withoutBlock(contents, existing));
      logLine(`git hooks: took the block back out of ${path}: not a shell script`);
    }
    return "not-shell";
  }

  if (existing === desired) {
    // A hook git will not execute is not installed, whatever the file says.
    await chmod(path, 0o755);
    return "already-present";
  }

  const next = existing === undefined ? insert(contents, desired) : contents.replace(existing, desired);

  await replaceHook(path, next);
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
 * Whether core.hooksPath points out of the git directory — `.husky`, a team's
 * `githooks/`. Such a directory is usually committed: a write there nobody asked
 * for reaches every teammate, and until then leaves the tree dirty, which is
 * enough for `git rebase` to refuse. Those are left to `isy init`, run on purpose.
 */
function isShared(location: { hooks: string; gitDir: string }): boolean {
  return !holds(location.gitDir, location.hooks);
}

function holds(directory: string, path: string): boolean {
  const inside = relative(directory, path);
  return !inside.startsWith("..") && !isAbsolute(inside);
}

/**
 * Whether a hook is a link to a file in the work tree, which for the same reason as
 * `isShared` waits for `isy init` to have what it holds rewritten.
 */
async function linkedIntoTree(cwd: string, path: string, gitDir: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return false;
    const [target, top, git] = await Promise.all([realpath(path), workTreeTop(cwd), realpath(gitDir)]);
    return top !== undefined && holds(top, target) && !holds(git, target);
  } catch {
    return false;
  }
}

/**
 * Bring the blocks an older isy wrote up to date where they stand, adding none:
 * what every run from a hook does first, so that an upgrade reaches a repository
 * the next time anything happens in it, with no `isy init` to go through. A block
 * that is only old waits in a shared file. One that breaks its hook comes out
 * wherever it is: the file goes back to what the user had, and a push stops failing.
 */
export async function repairGitHook(cwd: string): Promise<void> {
  const location = await hookLocation(cwd);
  if (!location) return;

  for (const hook of GIT_HOOKS) {
    const path = resolve(location.hooks, hook.name);
    const contents = await readHook(path);
    if (contents === undefined) continue;
    const existing = existingBlock(contents);
    if (existing === undefined) continue;
    const old =
      existing !== block(hook.command) && !isShared(location) && !(await linkedIntoTree(cwd, path, location.gitDir));
    if (old || !takesBlock(contents)) await installOne(cwd, hook);
  }
}

/**
 * What the SessionEnd hook runs in every repository a session happened in, so
 * `isy init` is once per machine rather than once per repository. It writes
 * only where nobody else will see it (`isShared`).
 */
export async function autoInstallGitHook(cwd: string): Promise<GitHookOutcome | "shared-hooks"> {
  const location = await hookLocation(cwd);
  if (!location) return "not-a-repository";
  if (await gitHookInstalled(cwd)) return "already-present";
  if (isShared(location)) return "shared-hooks";
  for (const hook of GIT_HOOKS) {
    const path = resolve(location.hooks, hook.name);
    if (existingBlock((await readHook(path)) ?? "") === undefined) continue;
    if (await linkedIntoTree(cwd, path, location.gitDir)) return "shared-hooks";
  }

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

  const stripped = withoutBlock(contents, existing);

  if (stripped.replace(SHEBANG, "").trim().length === 0) {
    await rm(path, { force: true });
    return "removed";
  }

  await replaceHook(path, stripped);
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

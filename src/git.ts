import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const GIT_TIMEOUT_MS = 5000;
const RECENT_SHA_COUNT = 50;

export interface GitMetadata {
  remote: string;
  branch: string;
  headSha: string;
  recentShas: string[];
}

export type GitFailure = "not-a-repository" | "no-commits" | "no-remote";

export type GitResult =
  | { ok: true; metadata: GitMetadata }
  | { ok: false; reason: GitFailure };

async function gitOutput(cwd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await run("git", args, {
    cwd,
    env,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const value = (await gitOutput(cwd, args, env)).trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function remotePath(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return undefined;

  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)(.+)$/.exec(trimmed);
  if (scp) return scp[2];

  try {
    return new URL(trimmed).pathname;
  } catch {
    return undefined;
  }
}

export function normalizeRemote(url: string): string | undefined {
  const path = remotePath(url);
  if (!path) return undefined;

  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length < 2) return undefined;

  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

/**
 * The branch HEAD stands on, or `HEAD` when detached. By its full name, because
 * `--abbrev-ref` says `heads/release` once a tag is called `release` too.
 */
async function headName(cwd: string): Promise<string | undefined> {
  return (await git(cwd, ["rev-parse", "--symbolic-full-name", "HEAD"]))?.replace(/^refs\/heads\//, "");
}

export async function collectGitMetadata(cwd: string): Promise<GitResult> {
  const insideWorkTree = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") return { ok: false, reason: "not-a-repository" };

  const headSha = await git(cwd, ["rev-parse", "HEAD"]);
  if (!headSha) return { ok: false, reason: "no-commits" };

  const remoteUrl = await git(cwd, ["config", "--get", "remote.origin.url"]);
  const remote = remoteUrl ? normalizeRemote(remoteUrl) : undefined;
  if (!remote) return { ok: false, reason: "no-remote" };

  const branch = (await headName(cwd)) ?? "HEAD";
  const log = await git(cwd, ["log", "--format=%H", "-n", String(RECENT_SHA_COUNT)]);
  const recentShas = log ? log.split("\n").map((line) => line.trim()).filter(Boolean) : [headSha];

  return { ok: true, metadata: { remote, branch, headSha, recentShas } };
}

/**
 * HEAD alone, without the remote a full upload needs. A repository with no
 * remote still deserves local signals, so this must not fail where
 * `collectGitMetadata` does.
 */
export async function headSha(cwd: string): Promise<string | undefined> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * The branch a commit made now lands on. A rebase runs detached and fires the
 * post-commit hook for every pick, so there it is the branch being rebased,
 * which git keeps beside the rebase's own state.
 */
export async function currentBranch(cwd: string): Promise<string | undefined> {
  const branch = await headName(cwd);
  if (branch !== "HEAD") return branch;
  const state = await git(cwd, ["rev-parse", "--git-path", "rebase-merge/head-name"]);
  try {
    const name = (await readFile(resolve(cwd, state ?? ""), "utf8")).trim();
    return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : branch;
  } catch {
    return branch;
  }
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  return (await git(cwd, ["rev-parse", "--verify", "-q", `refs/heads/${name}`])) !== undefined;
}

/** `git -c` by the environment, as `-c` ends a key at its first `=` and a merge driver's name may hold one. */
function withConfig(keys: string[], value: string): NodeJS.ProcessEnv {
  const before = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_COUNT: String(before + keys.length) };
  keys.forEach((key, index) => {
    env[`GIT_CONFIG_KEY_${before + index}`] = key;
    env[`GIT_CONFIG_VALUE_${before + index}`] = value;
  });
  return env;
}

/**
 * The files HEAD changed, from the top of the repository wherever `cwd` is. For a
 * merge those are the ones its author settled, whichever side they took, and none
 * of what it brings in clean. A git older than 2.35 refuses the flag, and there a
 * merge lists only what differs from both sides. The flag merges again, and a merge
 * driver of the repository's may take any time and do anything besides, in a hook
 * someone is waiting on, so each one stands in as `false`: a conflict that left its
 * side as it was, which tells whether what was settled differs from it just as well.
 */
export async function filesInHead(cwd: string): Promise<string[]> {
  const show = ["show", "--root", "-z", "--format=", "--name-only", "--no-renames"];
  const drivers = (await git(cwd, ["config", "--name-only", "--get-regexp", "^merge\\..*\\.driver$"]))?.split("\n") ?? [];
  const files = (await git(cwd, [...show, "--remerge-diff", "HEAD", "--"], withConfig(drivers, "false"))) ?? (await git(cwd, [...show, "HEAD", "--"]));
  return files ? files.split("\0").filter(Boolean) : [];
}

/**
 * What the given commits left in each file they changed, by blob. A merge has none,
 * as what it brings in is the other side's, and a commit gone from the repository
 * is passed over.
 */
export async function blobsOf(cwd: string, shas: string[]): Promise<Map<string, Set<string>>> {
  const raw = await git(cwd, [
    "log", "--root", "--no-walk", "--ignore-missing", "-z", "--format=", "--raw", "--no-abbrev", "--no-renames", ...shas, "--",
  ]);
  const fields = raw?.split("\0").filter(Boolean) ?? [];
  const blobs = new Map<string, Set<string>>();
  // `:100644 100644 <old> <new> M`, then the path.
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1]!;
    blobs.set(path, (blobs.get(path) ?? new Set()).add(fields[index]!.split(" ")[3]!));
  }
  return blobs;
}

/**
 * The lines the given commits add, in any file, or undefined when git could not say
 * by `timeoutMs`. As in `blobsOf`, a merge adds none and a commit gone from the repository
 * is passed over. What a hook someone waits on reads is the repository's text, so no
 * textconv or external diff gets to run, and a partial clone goes to the network for
 * none of it. A git older than 2.45 knows no such setting and may start that fetch,
 * which outlives the timeout.
 */
export async function addedLines(cwd: string, shas: string[], timeoutMs: number): Promise<string[] | undefined> {
  let diff: string;
  try {
    diff = await gitOutput(cwd, [
      "log", "--root", "--no-walk", "--ignore-missing", "--format=", "-p", "-U0", "--no-renames", "--no-color", "--no-ext-diff", "--no-textconv", ...shas, "--",
    ], { ...process.env, GIT_NO_LAZY_FETCH: "1" }, timeoutMs);
  } catch {
    return undefined;
  }
  const lines: string[] = [];
  // Past a file's `@@` every line is the diff's own, so `+++ b/path` above it is no line added.
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && line.startsWith("+")) lines.push(line.slice(1));
  }
  return lines;
}

/**
 * The commit HEAD replaced, in git's own record of it: the reflog's entry before an
 * amend, or the pick a rebase stands on. Nothing an amend or a pick changed need look
 * like what it replaced.
 */
export async function commitHeadReplaced(cwd: string): Promise<string | undefined> {
  const [last, before] = (await git(cwd, ["reflog", "-2", "--no-show-signature", "--format=%H %gs", "HEAD"]))?.split("\n") ?? [];
  if (last && /^\S+ commit \(amend\): /.test(last)) return before?.split(" ")[0];
  const done = await git(cwd, ["rev-parse", "--git-path", "rebase-merge/done"]);
  try {
    const pick = (await readFile(resolve(cwd, done ?? ""), "utf8")).trim().split("\n").at(-1)?.split(/\s+/)[1];
    return pick && (await git(cwd, ["rev-parse", "--verify", "-q", `${pick}^{commit}`]));
  } catch {
    return undefined;
  }
}

/** The files a merge at HEAD changed on the branch it stands on. No merge, no files. */
export async function filesMergedIntoHead(cwd: string): Promise<string[]> {
  if (!(await git(cwd, ["rev-parse", "-q", "--verify", "HEAD^2"]))) return [];
  const files = await git(cwd, ["diff", "-z", "--name-only", "--no-renames", "HEAD^1", "HEAD", "--"]);
  return files ? files.split("\0").filter(Boolean) : [];
}

/**
 * For a question about a directory, which may not be the one a hook runs in: a
 * post-commit hook in a linked worktree inherits `GIT_DIR`, and git then takes
 * any directory it stands in for the top of the tree.
 */
function withoutHookEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined };
}

/** The top of the work tree a directory belongs to, however that directory was reached. */
export async function workTreeTop(cwd: string): Promise<string | undefined> {
  return git(cwd, ["rev-parse", "--show-toplevel"], withoutHookEnv());
}

/**
 * The roots a session's transcript is masked by: the top of its repository, the
 * form GitHub and every other session use, whichever subdirectory it started in.
 * Counted up from `cwd` rather than asked for outright, because the toplevel git
 * reports has its symlinks resolved and the transcript's paths may not.
 */
export async function maskRootsFor(
  cwd: string | undefined,
): Promise<{ cwd?: string; base?: string }> {
  if (!cwd) return {};
  const up = await git(cwd, ["rev-parse", "--show-cdup"], withoutHookEnv());
  return up ? { cwd: resolve(cwd, up), base: cwd } : { cwd };
}

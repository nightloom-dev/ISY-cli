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

async function git(
  cwd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const value = stdout.trim();
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

/** The files HEAD changed, from the top of the repository wherever `cwd` is. */
export async function filesInHead(cwd: string): Promise<string[]> {
  const files = await git(cwd, ["show", "-z", "--format=", "--name-only", "--no-renames", "HEAD"]);
  return files ? files.split("\0").filter(Boolean) : [];
}

/**
 * What the given commits left in each file they changed, by blob. A merge has none,
 * as what it brings in is the other side's, and a commit gone from the repository
 * is passed over.
 */
export async function blobsOf(cwd: string, shas: string[]): Promise<Map<string, Set<string>>> {
  const raw = await git(cwd, [
    "log", "--no-walk", "--ignore-missing", "-z", "--format=", "--raw", "--no-abbrev", "--no-renames", ...shas, "--",
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

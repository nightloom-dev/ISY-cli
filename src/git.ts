import { execFile } from "node:child_process";
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

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
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

export async function collectGitMetadata(cwd: string): Promise<GitResult> {
  const insideWorkTree = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (insideWorkTree !== "true") return { ok: false, reason: "not-a-repository" };

  const headSha = await git(cwd, ["rev-parse", "HEAD"]);
  if (!headSha) return { ok: false, reason: "no-commits" };

  const remoteUrl = await git(cwd, ["config", "--get", "remote.origin.url"]);
  const remote = remoteUrl ? normalizeRemote(remoteUrl) : undefined;
  if (!remote) return { ok: false, reason: "no-remote" };

  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) ?? "HEAD";
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

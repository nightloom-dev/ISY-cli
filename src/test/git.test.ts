import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { collectGitMetadata, normalizeRemote } from "../git.js";

const run = promisify(execFile);

async function makeRepo(remote?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "isy-git-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "one");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: dir });
  if (remote) await run("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

test("normalizes every remote URL form to owner/repo", () => {
  const cases: [string, string][] = [
    ["https://github.com/unwinned/ISY.git", "unwinned/ISY"],
    ["https://github.com/unwinned/ISY", "unwinned/ISY"],
    ["git@github.com:unwinned/ISY.git", "unwinned/ISY"],
    ["ssh://git@github.com/unwinned/ISY.git", "unwinned/ISY"],
    ["https://github.com/unwinned/ISY/", "unwinned/ISY"],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeRemote(input), expected, input);
});

test("drops credentials embedded in a remote URL", () => {
  const remote = normalizeRemote("https://x-access-token:ghp_secretvalue@github.com/unwinned/ISY.git");
  assert.equal(remote, "unwinned/ISY");
  assert.ok(!remote?.includes("ghp_"));
});

test("rejects a remote URL with no owner and repo", () => {
  assert.equal(normalizeRemote("https://github.com/"), undefined);
  assert.equal(normalizeRemote(""), undefined);
  assert.equal(normalizeRemote("not a url"), undefined);
});

test("collects head, branch, remote and recent shas from a real repository", async () => {
  const dir = await makeRepo("git@github.com:unwinned/ISY.git");
  await writeFile(join(dir, "b.txt"), "two");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-q", "-m", "second"], { cwd: dir });

  const result = await collectGitMetadata(dir);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.metadata.remote, "unwinned/ISY");
  assert.equal(result.metadata.branch, "main");
  assert.match(result.metadata.headSha, /^[0-9a-f]{40}$/);
  assert.equal(result.metadata.recentShas.length, 2);
  assert.equal(result.metadata.recentShas[0], result.metadata.headSha);
});

test("refuses a directory that is not a git repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "isy-plain-"));
  const result = await collectGitMetadata(dir);
  assert.deepEqual(result, { ok: false, reason: "not-a-repository" });
});

test("refuses a repository that has no origin remote", async () => {
  const dir = await makeRepo();
  const result = await collectGitMetadata(dir);
  assert.deepEqual(result, { ok: false, reason: "no-remote" });
});

test("refuses a repository with no commits yet", async () => {
  const dir = await mkdtemp(join(tmpdir(), "isy-empty-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await run("git", ["remote", "add", "origin", "git@github.com:o/r.git"], { cwd: dir });

  const result = await collectGitMetadata(dir);
  assert.deepEqual(result, { ok: false, reason: "no-commits" });
});

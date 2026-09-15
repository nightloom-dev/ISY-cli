import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { readConfig, updateConfig, writeConfig } from "../config.js";
import { collectStatus, formatStatus } from "../commands/status.js";
import { findSessions, projectSlug, queueDir } from "../paths.js";

let home: string;
let claudeConfig: string;
const savedEnv = {
  isyHome: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  kimi: process.env.KIMI_HOME,
  codex: process.env.CODEX_HOME,
};

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-home-"));
  claudeConfig = await mkdtemp(join(tmpdir(), "isy-claude-"));
  process.env.ISY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  // These assertions are about Claude Code, so pin Kimi and Codex somewhere that does not
  // exist: whether this machine has them installed must not change them.
  process.env.KIMI_HOME = join(home, "no-kimi-here");
  process.env.CODEX_HOME = join(home, "no-codex-here");
});

after(() => {
  if (savedEnv.isyHome === undefined) delete process.env.ISY_HOME;
  else process.env.ISY_HOME = savedEnv.isyHome;
  if (savedEnv.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv.claude;
  if (savedEnv.kimi === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = savedEnv.kimi;
  if (savedEnv.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedEnv.codex;
});

test("encodes a working directory the way Claude Code names its project folder", () => {
  assert.equal(projectSlug("/home/unwinned/docs/softs/ISY"), "-home-unwinned-docs-softs-ISY");
  assert.equal(projectSlug("/home/u/my.repo_v2"), "-home-u-my-repo-v2");
});

test("returns an empty config when the file does not exist", async () => {
  assert.deepEqual(await readConfig(), {});
});

test("writes the config with owner-only permissions and reads it back", async () => {
  await writeConfig({ token: "secret", githubLogin: "octocat" });

  const config = await readConfig();
  assert.equal(config.token, "secret");
  assert.equal(config.githubLogin, "octocat");

  const info = await stat(join(home, "config.json"));
  assert.equal(info.mode & 0o777, 0o600);
});

test("merges patches into the existing config", async () => {
  await updateConfig({ lastUploadAt: "2026-08-14T12:00:00Z" });

  const config = await readConfig();
  assert.equal(config.token, "secret");
  assert.equal(config.lastUploadAt, "2026-08-14T12:00:00Z");
});

test("rejects a config file that is not valid JSON", async () => {
  await writeFile(join(home, "config.json"), "{ broken");
  await assert.rejects(readConfig, /not valid JSON/);
  await writeConfig({ token: "secret", githubLogin: "octocat" });
});

test("lists sessions for a directory newest first", async () => {
  const cwd = "/tmp/example-repo";
  const dir = join(claudeConfig, "projects", projectSlug(cwd));
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "older.jsonl"), "{}\n");
  await writeFile(join(dir, "newer.jsonl"), "{}\n");
  await writeFile(join(dir, "notes.txt"), "ignored");

  const now = Date.now();
  await utimes(join(dir, "older.jsonl"), new Date(now - 60_000), new Date(now - 60_000));
  await utimes(join(dir, "newer.jsonl"), new Date(now), new Date(now));

  const sessions = await findSessions(cwd);
  assert.deepEqual(sessions.map((session) => session.sessionId), ["newer", "older"]);
});

test("returns no sessions for a directory Claude Code never touched", async () => {
  assert.deepEqual(await findSessions("/tmp/never-used-repo"), []);
});

test("reports configuration, queue and the latest parsed session", async () => {
  const cwd = "/tmp/status-repo";
  const dir = join(claudeConfig, "projects", projectSlug(cwd));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "abc.jsonl"),
    [
      JSON.stringify({ type: "user", uuid: "u", parentUuid: null, sessionId: "abc", cwd, message: { role: "user", content: "go" } }),
      JSON.stringify({
        type: "assistant",
        uuid: "a",
        parentUuid: "u",
        sessionId: "abc",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/tmp/status-repo/a.ts", old_string: "x", new_string: "y" } }],
        },
      }),
      "{ not json",
    ].join("\n"),
  );

  await mkdir(queueDir(), { recursive: true });
  await writeFile(join(queueDir(), "one.json"), "{}");
  await writeFile(join(queueDir(), "two.json.failed"), "{}");

  const report = await collectStatus(cwd);

  assert.equal(report.tokenConfigured, true);
  assert.equal(report.githubLogin, "octocat");
  assert.deepEqual(report.queue, { pending: 1, failed: 1 });
  assert.equal(report.project.sessions, 1);
  assert.equal(report.latestSession?.sessionId, "abc");
  assert.equal(report.latestSession?.records, 2);
  assert.equal(report.latestSession?.toolUses, 1);
  assert.equal(report.latestSession?.editedFiles, 1);
  assert.equal(report.latestSession?.malformedLines, 1);

  const text = formatStatus(report);
  assert.match(text, /Claude Code\s+1 session\(s\)/);
  assert.match(text, /latest\s+abc \(Claude Code\)/);
  assert.match(text, /token\s+configured \(octocat\)/);
  assert.match(text, /queue\s+1 pending, 1 failed/);
  assert.match(text, /latest\s+abc/);
  assert.match(text, /unparsed\s+1 lines/);
});

test("reports a directory with no recorded sessions", async () => {
  const report = await collectStatus("/tmp/empty-repo");

  assert.equal(report.project.sessions, 0);
  assert.equal(report.latestSession, undefined);
  assert.match(formatStatus(report), /no Claude Code sessions recorded/);
});

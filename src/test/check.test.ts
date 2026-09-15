import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { collectCheck, formatCheck, relativeTime, runCheck } from "../commands/check.js";
import type { CheckReport } from "../commands/check.js";
import { HOOK_COMMAND, START_HOOK_COMMAND } from "../hook.js";

const saved = {
  home: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  kimi: process.env.KIMI_HOME,
  codex: process.env.CODEX_HOME,
};
const NOW = Date.parse("2026-08-18T12:00:00.000Z");

let home: string;
let claude: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-check-home-"));
  claude = await mkdtemp(join(tmpdir(), "isy-check-claude-"));
  process.env.ISY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claude;
  // Pin Kimi and Codex somewhere that does not exist: whether this machine happens to
  // have them installed must not change what these assertions see.
  process.env.KIMI_HOME = join(home, "no-kimi-here");
  process.env.CODEX_HOME = join(home, "no-codex-here");
});

after(() => {
  if (saved.home === undefined) delete process.env.ISY_HOME;
  else process.env.ISY_HOME = saved.home;
  if (saved.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved.claude;
  if (saved.kimi === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = saved.kimi;
  if (saved.codex === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = saved.codex;
});

async function configure(config: object): Promise<void> {
  await writeFile(join(home, "config.json"), JSON.stringify(config));
}

async function hooks(commands: { SessionEnd?: string; SessionStart?: string }): Promise<void> {
  const settings: Record<string, unknown> = {};
  const entries: Record<string, unknown> = {};
  for (const [event, command] of Object.entries(commands)) {
    entries[event] = [{ hooks: [{ type: "command", command }] }];
  }
  settings.hooks = entries;
  await writeFile(join(claude, "settings.json"), JSON.stringify(settings));
}

beforeEach(async () => {
  await configure({});
  await hooks({});
  await mkdir(join(home, "queue"), { recursive: true });
});

test("turns a timestamp into a readable age", () => {
  assert.equal(relativeTime(undefined, NOW), "never");
  assert.equal(relativeTime("nonsense", NOW), "never");
  assert.equal(relativeTime("2026-08-18T11:59:30.000Z", NOW), "just now");
  assert.equal(relativeTime("2026-08-18T11:30:00.000Z", NOW), "30m ago");
  assert.equal(relativeTime("2026-08-18T09:00:00.000Z", NOW), "3h ago");
  assert.equal(relativeTime("2026-08-16T12:00:00.000Z", NOW), "2d ago");
});

test("says nothing works before the token is stored", async () => {
  const report = await collectCheck();
  assert.equal(report.configured, false);
  assert.equal(report.ok, false);
  assert.match(formatCheck(report, NOW), /is not configured — run: isy init/);
});

test("announces itself as active once the token and both hooks are in place", async () => {
  await configure({ token: "t", githubLogin: "unwinned", lastUploadAt: "2026-08-18T09:00:00.000Z" });
  await hooks({ SessionEnd: HOOK_COMMAND, SessionStart: START_HOOK_COMMAND });

  const report = await collectCheck();
  assert.equal(report.ok, true);
  assert.deepEqual(report.missingHooks, []);
  // The version is the package's own, read at runtime: pinning it here broke on every release.
  assert.equal(formatCheck(report, NOW), `ISY ${report.version} active · unwinned · hooks ok · last upload 3h ago`);
});

test("names the hook that is missing instead of claiming to work", async () => {
  await configure({ token: "t", githubLogin: "unwinned" });
  await hooks({ SessionEnd: HOOK_COMMAND });

  const report = await collectCheck();
  assert.equal(report.ok, false);
  assert.deepEqual(report.missingHooks, ["SessionStart"]);

  const line = formatCheck(report, NOW);
  assert.match(line, /SessionStart hook missing/);
  assert.match(line, /last upload never/);
  assert.match(line, /run: isy init/);
});

test("surfaces uploads that are stuck or given up on", async () => {
  await configure({ token: "t", githubLogin: "unwinned", lastUploadAt: "2026-08-18T11:00:00.000Z" });
  await hooks({ SessionEnd: HOOK_COMMAND, SessionStart: START_HOOK_COMMAND });
  await writeFile(join(home, "queue", "a.json"), "{}");
  await writeFile(join(home, "queue", "b.json.failed"), "{}");

  const line = formatCheck(await collectCheck(), NOW);
  assert.match(line, /1 queued/);
  assert.match(line, /1 gave up/);
});

test("does not touch the network unless asked", async () => {
  await configure({ token: "t", apiBaseUrl: "http://127.0.0.1:1" });
  await hooks({ SessionEnd: HOOK_COMMAND, SessionStart: START_HOOK_COMMAND });

  const report = await collectCheck();
  assert.equal(report.api, undefined);
  assert.equal(report.ok, true);
});

test("reports an unreachable api when the ping is asked for", async () => {
  await configure({ token: "t", apiBaseUrl: "http://127.0.0.1:1" });
  await hooks({ SessionEnd: HOOK_COMMAND, SessionStart: START_HOOK_COMMAND });

  const report = await collectCheck({ ping: true });
  assert.notEqual(report.api, "ok");
  assert.equal(report.ok, false);
  assert.match(formatCheck(report, NOW), /api unreachable/);
});

test("the session start hook prints one JSON line the client can display", async () => {
  await configure({ token: "t", githubLogin: "unwinned" });
  await hooks({ SessionEnd: HOOK_COMMAND, SessionStart: START_HOOK_COMMAND });

  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => void printed.push(line);
  try {
    await runCheck({ hook: true });
  } finally {
    console.log = log;
  }

  assert.equal(printed.length, 1);
  const payload: unknown = JSON.parse(printed[0]!);
  assert.match((payload as { systemMessage: string }).systemMessage, /ISY \d+\.\d+\.\d+ active/);
});

test("the session start hook stays silent rather than breaking the session", async () => {
  await writeFile(join(claude, "settings.json"), "{ this is not json");

  const printed: string[] = [];
  const log = console.log;
  console.log = (line: string) => void printed.push(line);
  try {
    await runCheck({ hook: true });
  } finally {
    console.log = log;
  }

  assert.deepEqual(printed, []);
  await assert.rejects(collectCheck(), /settings\.json/);
});

test("the session start hook sweeps once set up, whatever directory it ran in", async () => {
  await hooks({ SessionEnd: HOOK_COMMAND, SessionStart: START_HOOK_COMMAND });
  const repo = await realpath(await mkdtemp(join(tmpdir(), "isy-check-repo-")));
  await promisify(execFile)("git", ["init", "-q"], { cwd: repo });
  const plain = await mkdtemp(join(tmpdir(), "isy-check-plain-"));

  // The sweep reads each transcript's own cwd, so a session launched outside a
  // repository still has repository sessions to send. Only the token gates it.
  let started = 0;
  const catchUp = () => void (started += 1);
  const original = process.cwd();
  const log = console.log;
  console.log = () => undefined;
  try {
    await configure({ token: "t" });
    process.chdir(repo);
    await runCheck({ hook: true, catchUp });
    process.chdir(plain);
    await runCheck({ hook: true, catchUp });

    await configure({});
    process.chdir(repo);
    await runCheck({ hook: true, catchUp });
  } finally {
    console.log = log;
    process.chdir(original);
  }

  assert.equal(started, 2);
});

test("keeps the report readable when the login is unknown", () => {
  const report: CheckReport = {
    ok: true,
    configured: true,
    version: "0.1.0",
    apiBaseUrl: "https://isy.dev",
    agents: [],
    missingHooks: [],
    queue: { pending: 0, failed: 0 },
    journalErrors: 0,
  };
  assert.equal(formatCheck(report, NOW), "ISY 0.1.0 active · hooks ok · last upload never");
});

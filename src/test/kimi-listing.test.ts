import assert from "node:assert/strict";
import { appendFile, chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, test } from "node:test";
import { kimiAgent } from "../agents/kimi.js";
import { firstLines } from "../paths.js";

/**
 * How Kimi sessions are listed: which folders are sessions, when one counts as
 * changed, and what a session says about the CLI that ran it. Each test copies
 * the recorded homes (`fixtures/record/README.md`) somewhere of its own.
 */
const KIMI_CLI = join(import.meta.dirname, "fixtures", "kimi-cli-1.52", ".kimi");
const KIMI_CLI_SESSION = "63ade4e9-4c75-4070-a8c6-f28b7de486b8";
const KIMI_CLI_WORKSPACE = "306f8686f92cc60ecf48084865d7d36e";
const KIMI_CODE = join(import.meta.dirname, "fixtures", "kimi-code-2.1.1", ".kimi-code");
const KIMI_CODE_SESSION = "session_48c39281-a12f-4c4b-83b9-2015eb5e7c3a";
const KIMI_CODE_WORKSPACE = "wd_kcshop_a7fc9137ccb7";

const saved = { KIMI_HOME: process.env.KIMI_HOME, PATH: process.env.PATH };

after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A copy of a recorded home under a name of its CLI's, pinned as the only Kimi home. */
async function homeFrom(fixture: string, name: ".kimi" | ".kimi-code"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "isy-kimi-listing-"));
  const home = join(root, name);
  await cp(fixture, home, { recursive: true });
  process.env.KIMI_HOME = home;
  return home;
}

test("a Kimi CLI session that never wrote state.json is listed all the same, under its folder's name", async () => {
  const home = await homeFrom(KIMI_CLI, ".kimi");
  const dir = join(home, "sessions", KIMI_CLI_WORKSPACE, KIMI_CLI_SESSION);
  // A first turn cancelled, failed or cut off at its step limit: no state.json yet.
  await rm(join(dir, "state.json"));

  const [session, ...rest] = await kimiAgent.allSessions();
  assert.equal(rest.length, 0);
  assert.equal(session?.sessionId, KIMI_CLI_SESSION);
  assert.equal(session?.cwd, "/home/dev/kshop");
  // The SessionEnd hook finds this session, not whichever other one is newest.
  assert.equal(
    await kimiAgent.transcriptFor({ session_id: KIMI_CLI_SESSION, cwd: "/home/dev/kshop" }, "/"),
    join(dir, "wire.jsonl"),
  );

  // A Kimi Code folder without one is a copy that never finished, and not a session.
  const debris = join(home, "sessions", KIMI_CLI_WORKSPACE, "ses_00000000-0000-0000-0000-000000000000");
  await mkdir(join(debris, "agents", "main"), { recursive: true });
  await writeFile(join(debris, "agents", "main", "wire.jsonl"), '{"type":"metadata","protocol_version":"1.0"}\n');
  assert.equal((await kimiAgent.allSessions()).length, 1);
});

test("a session Kimi Code imported from Kimi CLI is not listed again until it is gone on with", async () => {
  const home = await homeFrom(KIMI_CODE, ".kimi-code");
  const dir = join(home, "sessions", KIMI_CODE_WORKSPACE, "ses_63ade4e9-4c75-4070-a8c6-f28b7de486b8");
  const log = join(dir, "agents", "main", "wire.jsonl");
  const created = Date.parse("2026-08-01T09:30:00Z");
  const imported = Date.parse("2026-09-30T08:00:00Z");

  // What the import writes: the history with the old time or none, and the old mtime.
  await mkdir(join(dir, "agents", "main"), { recursive: true });
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({
      id: "ses_63ade4e9-4c75-4070-a8c6-f28b7de486b8",
      cwd: "/home/dev/kshop",
      custom: {
        imported_from_kimi_cli: true,
        kimi_cli_session_id: "63ade4e9-4c75-4070-a8c6-f28b7de486b8",
        imported_at: new Date(imported).toISOString(),
      },
    }),
  );
  const line = (event: object): string => `${JSON.stringify(event)}\n`;
  await writeFile(
    log,
    [
      line({ type: "metadata", protocol_version: "1.0", created_at: created }),
      line({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "the old ask" }], origin: { kind: "user" }, time: created }),
      line({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "the old ask" }] } }),
      line({ type: "context.append_message", message: { role: "assistant", content: [{ type: "text", text: "the old answer" }] } }),
      line({ type: "turn.ended", agentId: "main", turnId: 0, reason: "completed", time: created }),
    ].join(""),
  );
  await utimes(log, new Date(created), new Date(created));

  const listed = async () => (await kimiAgent.allSessions()).map((session) => session.sessionId);
  assert.deepEqual(await listed(), [KIMI_CODE_SESSION]);

  // Gone on with in Kimi Code: what came after the import is new, and only that.
  const resumed = imported + 60_000;
  const loop = (event: object, time: number): string =>
    line({ type: "context.append_loop_event", agentId: "main", event, time });
  await appendFile(
    log,
    [
      line({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "and now" }], origin: { kind: "user" }, time: resumed }),
      line({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "and now" }] }, time: resumed }),
      loop({ type: "tool.call", toolCallId: "t1", name: "Edit", args: { path: "src/app.js", old_string: "-", new_string: "+" } }, resumed + 1_000),
      loop({ type: "tool.result", toolCallId: "t1", result: { output: "ok" } }, resumed + 2_000),
    ].join(""),
  );
  await utimes(log, new Date(resumed + 2_000), new Date(resumed + 2_000));

  assert.deepEqual((await listed()).sort(), [KIMI_CODE_SESSION, "ses_63ade4e9-4c75-4070-a8c6-f28b7de486b8"].sort());
  const session = await kimiAgent.parsedSession(log);
  assert.deepEqual(session.toolUses.map((use) => use.name), ["Edit"]);
  assert.doesNotMatch(JSON.stringify(session.records), /the old/);
  assert.equal(session.meta.startedAt, new Date(resumed).toISOString());
});

test("a session forked off with /fork goes up with what came after the fork, and not before anyone goes on with it", async () => {
  const home = await homeFrom(KIMI_CODE, ".kimi-code");
  const source = join(home, "sessions", KIMI_CODE_WORKSPACE, KIMI_CODE_SESSION, "agents", "main", "wire.jsonl");
  const fork = join(home, "sessions", KIMI_CODE_WORKSPACE, "session_f0f0f0f0-0000-4000-8000-000000000000");
  const log = join(fork, "agents", "main", "wire.jsonl");

  // What /fork writes: the source's log as it was, times and calls and all, a
  // marker, and a state.json created at the fork.
  const copied = (await readFile(source, "utf8")).trimEnd().split("\n");
  const last = Math.max(...copied.map((line) => (JSON.parse(line) as { time?: number }).time ?? 0));
  const forkedAt = last + 60_000;
  await mkdir(join(fork, "agents", "main"), { recursive: true });
  await writeFile(log, `${[...copied, JSON.stringify({ type: "forked", agentId: "main", time: forkedAt - 5 })].join("\n")}\n`);
  await utimes(log, new Date(forkedAt - 5), new Date(forkedAt - 5));
  await writeFile(
    join(fork, "state.json"),
    JSON.stringify({ id: "session_f0f0f0f0-0000-4000-8000-000000000000", cwd: "/home/dev/kcshop", createdAt: forkedAt, forkedFrom: KIMI_CODE_SESSION }),
  );

  const listed = async () => (await kimiAgent.allSessions()).map((session) => session.sessionId);
  assert.deepEqual(await listed(), [KIMI_CODE_SESSION]);

  // Gone on with: the fork's own work, and none of its source's again.
  const event = (value: object, time: number): string => `${JSON.stringify({ ...value, time })}\n`;
  await appendFile(
    log,
    [
      event({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text: "try it the other way" }] } }, forkedAt + 1_000),
      event({ type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", toolCallId: "f1", name: "Bash", args: { command: "npm test" } } }, forkedAt + 2_000),
      event({ type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "f1", result: { output: "ok" } } }, forkedAt + 3_000),
    ].join(""),
  );
  await utimes(log, new Date(forkedAt + 3_000), new Date(forkedAt + 3_000));

  assert.equal((await listed()).length, 2);
  const session = await kimiAgent.parsedSession(log);
  assert.deepEqual(session.toolUses.map((use) => use.name), ["Bash"]);
  assert.equal(session.meta.startedAt, new Date(forkedAt + 1_000).toISOString());
});

test("a subagent's log counts toward its session's change, and not toward which session is newest", async () => {
  const home = await homeFrom(KIMI_CODE, ".kimi-code");
  const dir = join(home, "sessions", KIMI_CODE_WORKSPACE, KIMI_CODE_SESSION);
  const main = join(dir, "agents", "main", "wire.jsonl");
  const agent = join(dir, "agents", "agent-0", "wire.jsonl");

  const before = (await kimiAgent.allSessions())[0]!;
  assert.equal(before.sizeBytes, (await stat(main)).size + (await stat(agent)).size);

  // The subagent, sent to the background, goes on after the session went quiet.
  // A whole second, which `utimes` stores exactly: a millisecond in between
  // can come back from the filesystem a nanosecond short of itself.
  const later = new Date(Math.ceil((await stat(main)).mtimeMs / 1000) * 1000 + 3_600_000);
  await appendFile(agent, '{"type":"context.append_loop_event","agentId":"agent-0","event":{"type":"step.begin"},"time":1}\n');
  await utimes(agent, later, later);

  const after = (await kimiAgent.allSessions())[0]!;
  assert.ok(after.sizeBytes > before.sizeBytes);
  assert.equal(after.modifiedAt.getTime(), later.getTime());
  assert.equal(after.activeAt?.getTime(), (await stat(main)).mtime.getTime());
});

test("runs started together in Kimi CLI's log give neither session the other's model", async () => {
  const home = await homeFrom(KIMI_CLI, ".kimi");
  const wire = join(home, "sessions", KIMI_CLI_WORKSPACE, KIMI_CLI_SESSION, "wire.jsonl");
  const entry = (time: string, message: string): string => `2026-09-30 ${time} | INFO     | kimi_cli.x:y:1 |  - ${message}`;
  const writeLog = (other: string) =>
    writeFile(
      join(home, "logs", "kimi.log"),
      [
        entry(other, "Created new session: 11111111-2222-3333-4444-555555555555"),
        entry("09:30:16.214", `Created new session: ${KIMI_CLI_SESSION}`),
        entry("09:30:16.620", "Using LLM model: provider='moonshot' model='the-other-one' max_context_size=256000"),
        entry("09:30:16.700", "Using LLM model: provider='mock' model='kimi-k2-mock' max_context_size=128000"),
      ].join("\n"),
    );
  const model = async () =>
    (await kimiAgent.parsedSession(wire)).records.find((record) => record.type === "assistant")?.message?.model;

  // Opened a tenth of a second apart: whose model line is whose cannot be told.
  await writeLog("09:30:16.100");
  assert.equal(await model(), undefined);

  // A minute apart, the other run is long done: the line after this run's opening is this run's.
  await writeLog("09:29:16.100");
  assert.equal(await model(), "the-other-one");
});

test("Kimi Code's version comes from the kimi a shell would run, past a folder or a file named kimi", async () => {
  await homeFrom(KIMI_CODE, ".kimi-code");
  const root = await mkdtemp(join(tmpdir(), "isy-kimi-listing-path-"));
  const pkg = join(root, "lib", "node_modules", "@moonshot-ai", "kimi-code");
  await mkdir(join(pkg, "dist"), { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@moonshot-ai/kimi-code", version: "2.1.1" }));
  await writeFile(join(pkg, "dist", "main.mjs"), "");
  await chmod(join(pkg, "dist", "main.mjs"), 0o755);
  await mkdir(join(root, "bin"));
  await symlink(join(pkg, "dist", "main.mjs"), join(root, "bin", "kimi"));
  // Ahead of it on PATH: a project folder with a `kimi` folder in it, and a `kimi` no one may run.
  await mkdir(join(root, "project", "kimi"), { recursive: true });
  await mkdir(join(root, "notes"));
  await writeFile(join(root, "notes", "kimi"), "not a program");

  const log = join(process.env.KIMI_HOME!, "sessions", KIMI_CODE_WORKSPACE, KIMI_CODE_SESSION, "agents", "main", "wire.jsonl");
  try {
    process.env.PATH = [join(root, "project"), join(root, "notes"), join(root, "bin")].join(delimiter);
    assert.equal((await kimiAgent.parsedSession(log)).meta.claudeVersion, "2.1.1");
  } finally {
    process.env.PATH = saved.PATH;
  }
});

test("the first lines of a file are read without the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "isy-kimi-listing-lines-"));
  const file = join(dir, "wire.jsonl");
  await writeFile(file, `a\r\nb\n${"c".repeat(1 << 20)}\n`);
  assert.deepEqual(await firstLines(file, 2), ["a", "b"]);
  assert.deepEqual(await firstLines(file, 1), ["a"]);
  assert.equal((await readFile(file, "utf8")).length > 1 << 20, true);
});

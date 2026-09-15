import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { claudeAgent } from "../agents/claude.js";
import { drainAlerts, parkAlert } from "../alert.js";
import { writeConfig } from "../config.js";
import { runUpload } from "../commands/upload.js";
import { collectScan } from "../commands/scan.js";
import { allClaudeSessions, firstCwd, sessionStatePath } from "../paths.js";
import { listPending } from "../queue.js";
import { claimSweep, releaseSweep } from "../state.js";

const run = promisify(execFile);

let home: string;
let claudeConfig: string;
let repo: string;
let elsewhere: string;
let server: Server;
let baseUrl: string;

const uploads: { remote: string; branch: string; sessionId: string }[] = [];
let nextStatus = 200;

const saved = {
  isy: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  codex: process.env.CODEX_HOME,
  kimi: process.env.KIMI_HOME,
};

/**
 * A session recorded under a project folder that has nothing to do with where it
 * ran: `projectSlug` is lossy, so a sweep that trusted the folder name would find
 * the wrong directory — or none. The `cwd` in the records is the only truth.
 */
async function writeSession(
  folder: string,
  sessionId: string,
  cwd: string | undefined,
  options: { withId?: boolean } = {},
): Promise<string> {
  const dir = join(claudeConfig, "projects", folder);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  // A transcript that never names itself: the filename is the only id left.
  const id = options.withId === false ? {} : { sessionId };

  await writeFile(
    path,
    [
      // A resumed session opens with a record that carries no directory at all,
      // which is why the scan looks past the first line.
      JSON.stringify({ type: "summary", summary: "earlier work", leafUuid: "x" }),
      JSON.stringify({
        type: "user",
        uuid: `u-${sessionId}`,
        parentUuid: null,
        ...id,
        ...(cwd ? { cwd } : {}),
        version: "2.0.0",
        timestamp: "2026-09-12T09:00:00Z",
        message: { role: "user", content: "go" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: `a-${sessionId}`,
        parentUuid: `u-${sessionId}`,
        ...id,
        timestamp: "2026-09-12T10:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: `t-${sessionId}`,
              name: "Edit",
              input: { file_path: join(cwd ?? "/tmp", "a.txt"), old_string: "one", new_string: "two" },
            },
          ],
        },
      }),
    ].join("\n"),
  );

  return path;
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-sweep-home-"));
  claudeConfig = await mkdtemp(join(tmpdir(), "isy-sweep-claude-"));
  elsewhere = await mkdtemp(join(tmpdir(), "isy-sweep-plain-"));

  process.env.ISY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  // A sweep is not scoped to a directory, so it would otherwise walk whatever
  // Codex and Kimi sessions the machine running the tests happens to hold.
  process.env.CODEX_HOME = join(elsewhere, "no-codex");
  process.env.KIMI_HOME = join(elsewhere, "no-kimi");

  repo = await mkdtemp(join(tmpdir(), "isy-sweep-repo-"));
  await run("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await run("git", ["config", "user.email", "t@e.com"], { cwd: repo });
  await run("git", ["config", "user.name", "T"], { cwd: repo });
  await writeFile(join(repo, "a.txt"), "one");
  await run("git", ["add", "."], { cwd: repo });
  await run("git", ["commit", "-q", "-m", "first"], { cwd: repo });
  await run("git", ["remote", "add", "origin", "git@github.com:unwinned/ISY.git"], { cwd: repo });

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        const decoded =
          req.headers["content-encoding"] === "gzip" && raw.length > 0
            ? gunzipSync(raw).toString("utf8")
            : raw.toString("utf8");
        const body = JSON.parse(decoded) as {
          sessionId: string;
          git: { remote: string; branch: string };
        };
        if (nextStatus < 300) {
          uploads.push({ remote: body.git.remote, branch: body.git.branch, sessionId: body.sessionId });
        }
      } catch {
        // The queue drain posts nothing here; only real uploads are counted.
      }
      res.writeHead(nextStatus, { "content-type": "application/json" });
      res.end(
        nextStatus < 300
          ? JSON.stringify({ id: "ses_1", deduplicated: false })
          : JSON.stringify({ error: "rate limit is 60 uploads per hour" }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";

  await writeSession("-some-other-slug-entirely", "swept", repo);
  await writeSession("-not-a-repo", "outside", elsewhere);
  await writeSession("-no-directory", "rootless", undefined);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [variable, value] of [
    ["ISY_HOME", saved.isy],
    ["CLAUDE_CONFIG_DIR", saved.claude],
    ["CODEX_HOME", saved.codex],
    ["KIMI_HOME", saved.kimi],
  ] as const) {
    if (value === undefined) delete process.env[variable];
    else process.env[variable] = value;
  }
});

beforeEach(async () => {
  uploads.length = 0;
  nextStatus = 200;
  // What a sweep already sent is the whole subject here, so each test starts
  // from a machine that has never swept rather than from whatever ran above it.
  await rm(sessionStatePath(), { force: true });
  await writeConfig({ token: "test-token", apiBaseUrl: baseUrl });
});

test("finds every session on the machine without being told a directory", async () => {
  const sessions = await allClaudeSessions();
  assert.equal(sessions.length, 3);
  assert.deepEqual(
    sessions.map((session) => session.sessionId).sort(),
    ["outside", "rootless", "swept"],
  );
});

test("reads the working directory out of the transcript, not out of the folder name", async () => {
  const sessions = await allClaudeSessions();
  const swept = sessions.find((session) => session.sessionId === "swept")!;

  assert.equal(await firstCwd(swept.path), repo);
  assert.equal(await claudeAgent.cwdOf(swept.path), repo);
});

test("a sweep uploads the session whose directory is a repository and no other", async () => {
  const report = await runUpload({ silent: true, sweep: true }, elsewhere);

  assert.equal(report.scanned, 3);
  assert.equal(report.sent, 1);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.remote, "unwinned/ISY");
  assert.equal(uploads[0]?.branch, "main");
  assert.equal(uploads[0]?.sessionId, "swept");
});

test("a second sweep sends nothing: the transcript has not changed", async () => {
  await runUpload({ silent: true, sweep: true }, elsewhere);
  uploads.length = 0;

  // The session outside a repository stays a candidate at every sweep — the
  // directory it ran in could be `git init`ed tomorrow — but it is dropped
  // before anything is read or sent.
  const report = await runUpload({ silent: true, sweep: true }, elsewhere);
  assert.equal(report.sent, 0);
  assert.equal(report.scanned, 3);
  assert.equal(uploads.length, 0);
});

test("a session that grew since the last sweep is sent again", async () => {
  await runUpload({ silent: true, sweep: true }, elsewhere);
  uploads.length = 0;

  const sessions = await allClaudeSessions();
  const swept = sessions.find((session) => session.sessionId === "swept")!;
  const grown = `${await readFile(swept.path, "utf8")}\n${JSON.stringify({
    type: "user",
    uuid: "u2",
    parentUuid: "a-swept",
    sessionId: "swept",
    cwd: repo,
    timestamp: "2026-09-12T11:00:00Z",
    message: { role: "user", content: "more" },
  })}`;
  await writeFile(swept.path, grown);

  const report = await runUpload({ silent: true, sweep: true }, elsewhere);
  assert.equal(report.sent, 1);
  assert.equal(uploads.length, 1);
});

test("a rate-limited sweep keeps its sessions instead of spending their retries", async () => {
  await runUpload({ silent: true, sweep: true }, elsewhere);
  uploads.length = 0;

  // A machine whose backlog is larger than an hour's allowance: the answer says
  // "later", which is not something any of these sessions did wrong.
  nextStatus = 429;
  const sessions = await allClaudeSessions();
  const swept = sessions.find((session) => session.sessionId === "swept")!;
  await writeFile(swept.path, `${await readFile(swept.path, "utf8")}\n`);

  const report = await runUpload({ silent: true, sweep: true }, elsewhere);
  nextStatus = 200;

  assert.equal(report.throttled, true);
  assert.equal(report.sent, 0);
  assert.equal(report.queued, 0);
  assert.equal(report.abandoned, 0);
  assert.equal((await listPending()).length, 0);

  // Still changed as far as the client is concerned, so the next run sends it.
  const next = await runUpload({ silent: true, sweep: true }, elsewhere);
  assert.equal(next.sent, 1);
});

test("a transcript nobody has touched in a fortnight is looked at and left alone", async () => {
  const path = await writeSession("-ancient", "ancient", repo);
  const old = new Date("2026-01-01T00:00:00Z");

  try {
    await utimes(path, old, old);

    // Counted as scanned — it is a session on this machine — but never opened:
    // a sweep has no baseline, so without the window the first one on any
    // machine would upload every transcript the CLI ever wrote.
    const report = await runUpload({ silent: true, sweep: true }, elsewhere);
    assert.equal(report.scanned, 4);
    assert.equal(uploads.some((upload) => upload.sessionId === "ancient"), false);
  } finally {
    await rm(path);
  }
});

test("two sweeps do not run at once", async () => {
  assert.equal(await claimSweep(), true);
  assert.equal(await claimSweep(), false, "the second CLI to start finds the lock held");

  await releaseSweep();
  assert.equal(await claimSweep(), true, "and gets it once the first is done");
  await releaseSweep();
});

test("sessions with no id of their own do not all upload as one", async () => {
  const first = await writeSession("-anon-a", "anon-a", repo, { withId: false });
  const second = await writeSession("-anon-b", "anon-b", repo, { withId: false });

  try {
    // The server keys a session by its id, so one fallback shared across a run
    // would have each of these replace the last.
    await runUpload({ silent: true, sweep: true }, elsewhere);
    const sent = uploads.map((upload) => upload.sessionId).sort();
    assert.deepEqual(sent, ["anon-a", "anon-b", "swept"]);
  } finally {
    await rm(first);
    await rm(second);
  }
});

test("a sweep sends small sessions before the big one still growing", async () => {
  // Listed first, the big one would spend the run's budget and leave the rest
  // behind at every session start.
  const big = await writeSession("-a-big", "big", repo);
  await writeFile(
    big,
    `${await readFile(big, "utf8")}\n${JSON.stringify({
      type: "user",
      uuid: "u-big-2",
      parentUuid: "a-big",
      sessionId: "big",
      cwd: repo,
      timestamp: "2026-09-12T11:00:00Z",
      message: { role: "user", content: "x".repeat(50_000) },
    })}`,
  );
  const small = await writeSession("-z-small", "small", repo);

  try {
    await runUpload({ silent: true, sweep: true }, elsewhere);
    const sent = uploads.map((upload) => upload.sessionId);
    assert.ok(sent.indexOf("small") < sent.indexOf("big"), sent.join(", "));
  } finally {
    await rm(big);
    await rm(small);
  }
});

test("a parked alert is taken once and only once", async () => {
  await parkAlert("ISY: session uploaded");
  await parkAlert("ISY: 1 queued session(s) sent");

  assert.equal(await drainAlerts(), "ISY: session uploaded\nISY: 1 queued session(s) sent");
  assert.equal(await drainAlerts(), "");
});

test("a scan reports where sessions were found and which directories they ran in", async () => {
  const report = await collectScan();

  const claude = report.agents.find((agent) => agent.id === "claude")!;
  assert.equal(claude.present, true);
  assert.equal(claude.sessions, 3);
  // The one with no directory recorded is counted as scanned, never as located.
  assert.equal(claude.located, 2);

  const repository = claude.directories.find((entry) => entry.repository);
  assert.ok(repository, "the repository the sessions ran in is reported");
  assert.equal(report.agents.find((agent) => agent.id === "codex")?.present, false);
});

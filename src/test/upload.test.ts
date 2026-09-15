import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  MIN_UPLOAD_BYTES_PER_SECOND,
  UPLOAD_TIMEOUT_MS,
  buildTranscriptFields,
  uploadSession,
  uploadTimeoutMs,
} from "../api.js";
import type { UploadPayload } from "../api.js";
import { writeConfig } from "../config.js";
import { formatUploadAlert, runUpload } from "../commands/upload.js";
import { MAX_ATTEMPTS, enqueue, listPending, recordFailure } from "../queue.js";
import { projectSlug, queueDir } from "../paths.js";

const run = promisify(execFile);

let home: string;
let claudeConfig: string;
let repo: string;
let server: Server;
let baseUrl: string;

const requests: { status: number; body: unknown }[] = [];
let nextStatus = 200;
let nextDeduplicated = false;
let nextBody: string | undefined;

const savedHome = process.env.ISY_HOME;
const savedClaude = process.env.CLAUDE_CONFIG_DIR;

function samplePayload(sessionId = "s1"): UploadPayload {
  return {
    sessionId,
    contentHash: "sha256:abc123def456",
    startedAt: "2026-08-16T09:00:00Z",
    endedAt: "2026-08-16T10:00:00Z",
    claudeVersion: "2.0.0",
    isyVersion: "0.1.0",
    git: { remote: "unwinned/ISY", branch: "main", headSha: "a".repeat(40), recentShas: [] },
    transcript: "H4sIAAAAAAAAA",
  };
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-up-home-"));
  claudeConfig = await mkdtemp(join(tmpdir(), "isy-up-claude-"));
  process.env.ISY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;

  repo = await mkdtemp(join(tmpdir(), "isy-up-repo-"));
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
      const raw = Buffer.concat(chunks);
      const decoded =
        req.headers["content-encoding"] === "gzip" && raw.length > 0
          ? gunzipSync(raw).toString("utf8")
          : raw.toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(decoded);
      } catch {
        body = decoded;
      }
      requests.push({ status: nextStatus, body });
      res.writeHead(nextStatus, { "content-type": "application/json" });
      res.end(
        nextBody ??
          (nextStatus < 300
            ? JSON.stringify({ id: "ses_1", deduplicated: nextDeduplicated })
            : JSON.stringify({ ok: false })),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";

  const dir = join(claudeConfig, "projects", projectSlug(repo));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "sess.jsonl"),
    [
      JSON.stringify({
        type: "user",
        uuid: "u",
        parentUuid: null,
        sessionId: "sess",
        cwd: repo,
        version: "2.0.0",
        timestamp: "2026-08-16T09:00:00Z",
        message: { role: "user", content: "go" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a",
        parentUuid: "u",
        sessionId: "sess",
        timestamp: "2026-08-16T10:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "Edit",
              input: { file_path: join(repo, "a.txt"), old_string: "one", new_string: "two" },
            },
            { type: "text", text: "api_key = sk-abcdefghij0123456789XYZ" },
          ],
        },
      }),
    ].join("\n"),
  );
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedHome === undefined) delete process.env.ISY_HOME;
  else process.env.ISY_HOME = savedHome;
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedClaude;
});

beforeEach(async () => {
  requests.length = 0;
  nextStatus = 200;
  nextDeduplicated = false;
  nextBody = undefined;
  await mkdir(queueDir(), { recursive: true });
  for (const name of await readdir(queueDir())) await unlink(join(queueDir(), name));
  await writeConfig({ token: "test-token", apiBaseUrl: baseUrl });
});

test("hashes and compresses the transcript reproducibly", async () => {
  const first = await buildTranscriptFields(["{}", "{}"]);
  const second = await buildTranscriptFields(["{}", "{}"]);

  assert.equal(first.contentHash, second.contentHash);
  assert.match(first.contentHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(gunzipSync(Buffer.from(first.transcript, "base64")).toString("utf8"), "{}\n{}\n");
});

test("sends a gzip body with the bearer token and the documented fields", async () => {
  const outcome = await uploadSession(samplePayload(), { baseUrl, token: "test-token" });
  assert.deepEqual(outcome, { status: "ok", sessionId: "ses_1", deduplicated: false });

  const body = requests[0]?.body as UploadPayload;
  assert.equal(body.sessionId, "s1");
  assert.equal(body.git.remote, "unwinned/ISY");
  assert.match(body.contentHash, /^sha256:/);
});

test("treats authentication and size failures as permanent", async () => {
  for (const status of [401, 403, 413, 400, 422]) {
    nextStatus = status;
    const outcome = await uploadSession(samplePayload(), { baseUrl, token: "bad" });
    assert.equal(outcome.status, "permanent", `status ${status}`);
  }
});

test("treats an exhausted hourly allowance as a pause, not a failure", async () => {
  // 429 is the one refusal that says nothing about the session: it is kept as
  // it is, out of the retry queue, and sent again by the next run.
  nextStatus = 429;
  const outcome = await uploadSession(samplePayload(), { baseUrl, token: "test-token" });
  assert.equal(outcome.status, "throttled");
});

test("treats server and network failures as retryable", async () => {
  for (const status of [500, 502, 503]) {
    nextStatus = status;
    const outcome = await uploadSession(samplePayload(), { baseUrl, token: "test-token" });
    assert.equal(outcome.status, "retry", `status ${status}`);
  }

  const unreachable = await uploadSession(samplePayload(), {
    baseUrl: "http://127.0.0.1:1",
    token: "test-token",
  });
  assert.equal(unreachable.status, "retry");
});

test("gives a long session the time its size needs, but not past a waiting hook's deadline", () => {
  const minute = MIN_UPLOAD_BYTES_PER_SECOND * 60;
  assert.equal(uploadTimeoutMs(0), UPLOAD_TIMEOUT_MS);
  assert.equal(uploadTimeoutMs(minute), UPLOAD_TIMEOUT_MS + 60_000);

  const now = 1_000_000;
  assert.equal(uploadTimeoutMs(minute, now + 30_000, now), 30_000);
  assert.equal(uploadTimeoutMs(0, now + 30_000, now), UPLOAD_TIMEOUT_MS);
  // A run already out of budget still gets the base, not an instant abort.
  assert.equal(uploadTimeoutMs(minute, now - 1, now), UPLOAD_TIMEOUT_MS);
});

test("gives up on a queued session after three attempts", async () => {
  const path = await enqueue(samplePayload("queued"), "first failure");
  let items = await listPending();
  assert.equal(items.length, 1);

  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
    const result = await recordFailure(items[0]!, "still failing");
    assert.equal(result, "retained");
    items = await listPending();
    assert.equal(items.length, 1);
  }

  const final = await recordFailure(items[0]!, "last failure");
  assert.equal(final, "abandoned");
  assert.deepEqual(await listPending(), []);

  const names = await readdir(queueDir());
  assert.ok(names.some((name) => name.endsWith(".failed")), `expected a .failed marker in ${names}`);
  assert.ok(path.endsWith(".json"));
});

test("queues the session when the server is unreachable, then sends it on the next run", async () => {
  await writeConfig({ token: "test-token", apiBaseUrl: "http://127.0.0.1:1" });
  const queuedRun = await runUpload({ silent: true }, repo);
  assert.equal(queuedRun.queued, 1);
  assert.equal(queuedRun.sent, 0);
  assert.equal((await listPending()).length, 1);

  await writeConfig({ token: "test-token", apiBaseUrl: baseUrl });
  const drainRun = await runUpload({ silent: true }, repo);
  assert.equal(drainRun.sent, 1);
  assert.equal(drainRun.drained, 1);
  assert.deepEqual(await listPending(), []);
});

test("never retries a session that was already given up on", async () => {
  await writeConfig({ token: "test-token", apiBaseUrl: "http://127.0.0.1:1" });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await runUpload({ silent: true }, repo);
  }

  const names = await readdir(queueDir());
  assert.equal(names.filter((name) => name.endsWith(".failed")).length, 1);
  assert.equal(names.filter((name) => name.endsWith(".json")).length, 0);

  const afterGivingUp = await runUpload({ silent: true }, repo);
  assert.equal(afterGivingUp.queued, 0);
  assert.match(afterGivingUp.skipped ?? "", /given up on/);
  assert.deepEqual(await readdir(queueDir()), names);
});

test("uploads a redacted transcript with git metadata attached", async () => {
  const report = await runUpload({ silent: true }, repo);
  assert.equal(report.sent, 1);

  const body = requests.at(-1)?.body as UploadPayload;
  assert.equal(body.sessionId, "sess");
  assert.equal(body.git.remote, "unwinned/ISY");
  assert.equal(body.git.branch, "main");
  assert.equal(body.claudeVersion, "2.0.0");
  assert.match(body.git.headSha, /^[0-9a-f]{40}$/);

  const jsonl = gunzipSync(Buffer.from(body.transcript, "base64")).toString("utf8");
  assert.ok(jsonl.includes("[ISY_REDACTED:openai_key]"), "secret should be redacted before upload");
  assert.ok(!jsonl.includes("sk-abcdefghij0123456789XYZ"), "raw secret must never leave the machine");
});

test("stays silent and uploads nothing when the directory is not a git repository", async () => {
  const plain = await mkdtemp(join(tmpdir(), "isy-up-plain-"));
  const report = await runUpload({ silent: true }, plain);

  assert.equal(report.sent, 0);
  assert.equal(report.queued, 0);
  assert.match(report.skipped ?? "", /not-a-repository|no .* transcript/);
  assert.equal(requests.length, 0);
});

test("stays silent when no token is configured", async () => {
  await writeConfig({ apiBaseUrl: baseUrl });
  const report = await runUpload({ silent: true }, repo);

  assert.match(report.skipped ?? "", /no token/);
  assert.equal(requests.length, 0);
});

test("sends nothing for a session that holds no turn yet", async () => {
  // Codex writes its rollout before the first turn: opened and closed again, it
  // is a session_meta line and nothing else.
  const codex = await mkdtemp(join(tmpdir(), "isy-up-codex-"));
  const day = join(codex, "sessions", "2026", "08", "16");
  await mkdir(day, { recursive: true });
  const id = "01a09166-e4b3-75f1-8c17-9cabd6ebfd09";
  await writeFile(
    join(day, `rollout-2026-08-16T09-00-00-${id}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { id, cwd: repo } })}\n`,
  );

  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codex;
  try {
    const report = await runUpload({ silent: true, agent: "codex" }, repo);
    assert.equal(report.sent, 0);
    assert.equal(report.queued, 0);
    assert.equal(requests.length, 0);
    assert.equal(formatUploadAlert(report), undefined);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});

test("records the upload time in the config after a successful send", async () => {
  await runUpload({ silent: true }, repo);
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as {
    lastUploadAt?: string;
  };
  assert.ok(config.lastUploadAt, "lastUploadAt should be recorded");
});

test("passes the server's deduplicated flag back to the caller", async () => {
  nextDeduplicated = true;
  const outcome = await uploadSession(samplePayload(), { baseUrl, token: "test-token" });
  assert.deepEqual(outcome, { status: "ok", sessionId: "ses_1", deduplicated: true });
});

test("an upload learns which client the server expects", async () => {
  nextBody = JSON.stringify({ id: "ses_1", deduplicated: false, clientVersion: "0.9.0" });
  const outcome = await uploadSession(samplePayload(), { baseUrl, token: "t" });
  assert.deepEqual(outcome, { status: "ok", sessionId: "ses_1", deduplicated: false, clientVersion: "0.9.0" });
});

test("accepts an upload whose response body is not JSON", async () => {
  nextBody = "created";
  assert.deepEqual(await uploadSession(samplePayload(), { baseUrl, token: "t" }), { status: "ok" });
});

test("announces an upload without promising an analysis that has not started", () => {
  assert.equal(
    formatUploadAlert({ agent: "claude", sent: 1, fresh: 1, queued: 0, abandoned: 0, drained: 0, deduplicated: false }),
    "ISY: session uploaded, analysis runs when it reaches a pull request",
  );
  assert.equal(
    formatUploadAlert({ agent: "claude", sent: 1, fresh: 0, queued: 0, abandoned: 0, drained: 0, deduplicated: true }),
    "ISY: session already uploaded, nothing new to analyse",
  );
});

test("stays quiet when there is nothing worth interrupting the session for", () => {
  assert.equal(
    formatUploadAlert({ agent: "claude", sent: 0, fresh: 0, queued: 0, abandoned: 0, drained: 0, deduplicated: false }),
    undefined,
  );
  assert.equal(
    formatUploadAlert({
      agent: "claude",
      sent: 0,
      fresh: 0,
      queued: 0,
      abandoned: 0,
      drained: 0,
      deduplicated: false,
      skipped: "no token configured",
    }),
    undefined,
  );
});

test("an out-of-date client hears about it as the session ends", () => {
  const report = {
    agent: "claude" as const,
    sent: 1,
    fresh: 1,
    queued: 0,
    abandoned: 0,
    drained: 0,
    deduplicated: false,
    updateNotice:
      "isy 0.9.0 is available (you have 0.1.0) — update: npm install -g @nightloom/isy@latest",
  };

  assert.match(formatUploadAlert(report) ?? "", / · isy 0\.9\.0 is available /);
  // Worth the line even when the run had nothing else to say.
  assert.equal(
    formatUploadAlert({ ...report, sent: 0, fresh: 0, skipped: "nothing new to upload" }),
    `ISY: ${report.updateNotice}`,
  );
});

test("reports a retry and a drained backlog in the same alert", () => {
  assert.equal(
    formatUploadAlert({ agent: "claude", sent: 0, fresh: 0, queued: 1, abandoned: 0, drained: 2, deduplicated: false }),
    "ISY: 2 queued session(s) sent · upload failed, queued for retry",
  );
});

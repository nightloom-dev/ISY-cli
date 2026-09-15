import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { awaitPairedKey, openPairing, parsePairing, pollPairing } from "../pairing.js";

let server: Server;
let baseUrl: string;
const savedHome = process.env.ISY_HOME;

/** What the stub answers next, per route. Each test sets what it needs. */
let openStatus = 201;
let openBody: unknown = {};
let pollAnswers: { status: number; body: unknown }[] = [];
const polled: string[] = [];

function reply(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

before(async () => {
  // The pairing logs its failures, and without a home of its own that log is
  // the developer's real one.
  process.env.ISY_HOME = await mkdtemp(join(tmpdir(), "isy-pairing-home-"));
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = request.url ?? "";
    if (request.method === "POST" && url === "/api/v1/cli/pairings") {
      reply(response, openStatus, openBody);
      return;
    }
    if (request.method === "GET" && url.startsWith("/api/v1/cli/pairings/")) {
      polled.push(decodeURIComponent(url.slice("/api/v1/cli/pairings/".length)));
      const next = pollAnswers.shift() ?? { status: 200, body: { status: "pending" } };
      reply(response, next.status, next.body);
      return;
    }
    reply(response, 404, { error: "no such route" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (savedHome === undefined) delete process.env.ISY_HOME;
  else process.env.ISY_HOME = savedHome;
});

beforeEach(() => {
  openStatus = 201;
  openBody = {};
  pollAnswers = [];
  polled.length = 0;
});

const SAMPLE = {
  deviceCode: "device-secret",
  userCode: "ABCD-EFGH",
  connectUrl: "https://isy.example/settings/api_keys?connect=ABCD-EFGH",
  expiresInMs: 600_000,
  pollIntervalMs: 5,
};

test("parsePairing takes an answer apart and refuses a half of one", () => {
  assert.deepEqual(parsePairing(SAMPLE), SAMPLE);

  // Missing halves, and a `connectUrl` that is not somewhere a browser goes:
  // whatever this is, it is not a server that knows the pairing route.
  assert.equal(parsePairing({ ...SAMPLE, deviceCode: "" }), undefined);
  assert.equal(parsePairing({ ...SAMPLE, userCode: undefined }), undefined);
  assert.equal(parsePairing({ ...SAMPLE, connectUrl: "/settings/api_keys" }), undefined);
  assert.equal(parsePairing({ ...SAMPLE, connectUrl: "javascript:alert(1)" }), undefined);
  assert.equal(parsePairing(undefined), undefined);
  assert.equal(parsePairing("ok"), undefined);

  // The two numbers are hints; an answer without them still pairs.
  const bare = parsePairing({
    deviceCode: SAMPLE.deviceCode,
    userCode: SAMPLE.userCode,
    connectUrl: SAMPLE.connectUrl,
  });
  assert.equal(bare?.expiresInMs, 600_000);
  assert.equal(bare?.pollIntervalMs, 2000);
});

test("a server that does not know the route pairs with nobody, and says so quietly", async () => {
  openStatus = 404;
  openBody = { error: "not found" };
  assert.equal(await openPairing(baseUrl), undefined);

  // Unreachable is the same answer: `isy init` falls back to the page that
  // prints a token rather than failing.
  assert.equal(await openPairing("http://127.0.0.1:1"), undefined);
});

test("openPairing returns what the server described", async () => {
  openBody = SAMPLE;
  assert.deepEqual(await openPairing(baseUrl), SAMPLE);
});

test("polling reads the three answers apart", async () => {
  pollAnswers = [
    { status: 200, body: { status: "pending" } },
    { status: 404, body: { status: "expired" } },
    { status: 200, body: { status: "ready", token: "isy_secret", githubLogin: "octocat" } },
  ];

  assert.deepEqual(await pollPairing(baseUrl, "d"), { status: "pending" });
  assert.deepEqual(await pollPairing(baseUrl, "d"), { status: "expired" });
  assert.deepEqual(await pollPairing(baseUrl, "d"), {
    status: "ready",
    key: { token: "isy_secret", githubLogin: "octocat" },
  });

  const unreachable = await pollPairing("http://127.0.0.1:1", "d");
  assert.equal(unreachable.status, "unreachable");
});

test("awaitPairedKey keeps asking until the browser answers", async () => {
  pollAnswers = [
    { status: 200, body: { status: "pending" } },
    { status: 200, body: { status: "pending" } },
    { status: 200, body: { status: "ready", token: "isy_secret", githubLogin: "octocat" } },
  ];

  const key = await awaitPairedKey(
    baseUrl,
    { ...SAMPLE, deviceCode: "d1" },
    new AbortController().signal,
  );
  assert.deepEqual(key, { token: "isy_secret", githubLogin: "octocat" });
  assert.deepEqual(polled, ["d1", "d1", "d1"]);
});

test("awaitPairedKey stops on an expired pairing and on a paste that won the race", async () => {
  pollAnswers = [{ status: 404, body: { status: "expired" } }];
  assert.equal(
    await awaitPairedKey(baseUrl, { ...SAMPLE, deviceCode: "d2" }, new AbortController().signal),
    undefined,
  );
  assert.deepEqual(polled, ["d2"]);

  // Aborted before the first ask: the reader pasted a key instead, and the
  // wait must not hold the process open behind them.
  polled.length = 0;
  const aborted = AbortSignal.abort();
  assert.equal(await awaitPairedKey(baseUrl, { ...SAMPLE, deviceCode: "d3" }, aborted), undefined);
  assert.deepEqual(polled, []);
});

test("awaitPairedKey gives up when the pairing outlives its window", async () => {
  let clock = 0;
  pollAnswers = [
    { status: 200, body: { status: "pending" } },
    { status: 200, body: { status: "pending" } },
  ];

  const key = await awaitPairedKey(
    baseUrl,
    { ...SAMPLE, deviceCode: "d4", expiresInMs: 10 },
    new AbortController().signal,
    () => (clock += 6),
  );
  assert.equal(key, undefined);
});

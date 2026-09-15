import { errorMessage, logLine } from "./log.js";

/**
 * Being handed a key by the browser instead of asking for one to be pasted.
 *
 * `isy init` used to open the sign-in page, print a token there and wait for
 * the reader to carry it back across the screen — or, if they closed the page,
 * to run a second command with it. The terminal is still open, so it can wait
 * to be told: this opens a pairing on the server, sends the browser to the keys
 * screen with the half of it a human reads, and polls for the answer with the
 * half that never left this machine — so the key is handed back to something
 * no browser, and no one reading over a shoulder, could have seen.
 *
 * Every failure here is soft. The paste is still on offer the whole time, so a
 * server too old to know this route, a browser on another machine, and a
 * pairing that timed out all end in the same place they did before.
 */

/** The pairing as the server described it. */
export interface Pairing {
  /** The secret this machine polls with. Not in the URL, not in the browser. */
  deviceCode: string;
  /** `ABCD-EFGH` — printed here and shown on the page, so the two can be compared. */
  userCode: string;
  /** Where to send the browser. Built by the server: only it knows the dashboard's address. */
  connectUrl: string;
  expiresInMs: number;
  pollIntervalMs: number;
}

export interface PairedKey {
  token: string;
  /** Whose account handed the key over. Printed, because it is the one thing worth checking. */
  githubLogin?: string;
}

const OPEN_TIMEOUT_MS = 10_000;
const POLL_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
/** Matches `PAIRING_TTL_MS` on the server; used only if the answer left it out. */
const DEFAULT_EXPIRY_MS = 10 * 60 * 1000;

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Never throws: an older server answers 404 here, and that is a fallback, not an error. */
export function parsePairing(value: unknown): Pairing | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.deviceCode !== "string" || record.deviceCode.length === 0) return undefined;
  if (typeof record.userCode !== "string" || record.userCode.length === 0) return undefined;
  if (typeof record.connectUrl !== "string" || !/^https?:\/\//.test(record.connectUrl)) {
    return undefined;
  }
  return {
    deviceCode: record.deviceCode,
    userCode: record.userCode,
    connectUrl: record.connectUrl,
    expiresInMs: isNumber(record.expiresInMs) ? record.expiresInMs : DEFAULT_EXPIRY_MS,
    pollIntervalMs: isNumber(record.pollIntervalMs)
      ? record.pollIntervalMs
      : DEFAULT_POLL_INTERVAL_MS,
  };
}

export async function openPairing(baseUrl: string): Promise<Pairing | undefined> {
  try {
    const response = await fetch(new URL("/api/v1/cli/pairings", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(OPEN_TIMEOUT_MS),
    });
    if (!response.ok) {
      logLine(`init: pairing unavailable (${response.status})`);
      return undefined;
    }
    return parsePairing(await response.json().catch(() => undefined));
  } catch (error) {
    logLine(`init: pairing unavailable (${errorMessage(error)})`);
    return undefined;
  }
}

export type PollOutcome =
  | { status: "pending" }
  | { status: "ready"; key: PairedKey }
  /** The pairing is gone: taken, expired, or never known here. */
  | { status: "expired" }
  /** The server could not be reached this time. Polling keeps going. */
  | { status: "unreachable"; error: string };

/**
 * The poll's own timeout, plus whatever the caller uses to give up.
 *
 * Both, not either: a request still in flight holds the event loop open, so a
 * paste that ended the wait would otherwise leave `isy init` looking hung for
 * as long as the timeout. `AbortSignal.any` is Node 20.3; on anything older the
 * timeout alone still ends it, just later.
 */
function untilEither(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function pollPairing(
  baseUrl: string,
  deviceCode: string,
  signal?: AbortSignal,
): Promise<PollOutcome> {
  let response: Response;
  try {
    response = await fetch(
      new URL(`/api/v1/cli/pairings/${encodeURIComponent(deviceCode)}`, baseUrl),
      { signal: untilEither(signal, POLL_TIMEOUT_MS) },
    );
  } catch (error) {
    return { status: "unreachable", error: errorMessage(error) };
  }

  if (response.status === 404) return { status: "expired" };
  if (!response.ok) return { status: "unreachable", error: `server returned ${response.status}` };

  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== "object" || body === null) return { status: "pending" };
  const record = body as Record<string, unknown>;
  if (record.status !== "ready" || typeof record.token !== "string") return { status: "pending" };

  return {
    status: "ready",
    key: {
      token: record.token,
      ...(typeof record.githubLogin === "string" && record.githubLogin.length > 0
        ? { githubLogin: record.githubLogin }
        : {}),
    },
  };
}

/** Resolves when the sleep is over, or at once when the wait is abandoned. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    // Not `unref`ed: between two polls this timer is the only thing left on the
    // event loop when there is no TTY to hold stdin open, and a loop that empties
    // is a process that exits — `isy init` would end mid-wait, having printed a
    // URL and asked for nothing. Giving up early is what the abort is for, and it
    // resolves this sleep on the spot.
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Ask until the browser answers, the pairing expires, or the caller gives up —
 * the last of which is what happens when the reader pasted a key instead.
 *
 * A poll that could not reach the server is not the end: the machine that just
 * opened a browser is not always the one with the steady connection, and the
 * pairing outlives a few failed asks. Only the deadline and an explicit
 * `expired` stop the loop.
 */
export async function awaitPairedKey(
  baseUrl: string,
  pairing: Pairing,
  signal: AbortSignal,
  now: () => number = Date.now,
): Promise<PairedKey | undefined> {
  const deadline = now() + pairing.expiresInMs;

  while (!signal.aborted && now() < deadline) {
    const outcome = await pollPairing(baseUrl, pairing.deviceCode, signal);
    if (outcome.status === "ready") return outcome.key;
    if (outcome.status === "expired") return undefined;
    if (outcome.status === "unreachable") logLine(`init: pairing poll failed: ${outcome.error}`);
    await sleep(pairing.pollIntervalMs, signal);
  }

  return undefined;
}

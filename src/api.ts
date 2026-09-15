import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { GitMetadata } from "./git.js";
import { errorMessage } from "./log.js";
import { parsePlan } from "./plan.js";
import type { PlanStatus } from "./plan.js";
import type { CommitMark } from "./state.js";

const gzipAsync = promisify(gzip);

export const UPLOAD_TIMEOUT_MS = 10_000;
/**
 * The slowest uplink an upload is sized for. One fixed timeout cannot fit both
 * ends: 10 s is plenty for a short session and hopeless for a long one, whose
 * body is megabytes. On an ordinary home uplink such a session was aborted on
 * every attempt and given up on without ever reaching the server.
 */
export const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;
export const MAX_BODY_BYTES = 50 * 1024 * 1024;

/**
 * How long one upload may take: the base for the round trip plus what the body
 * needs at the slowest expected uplink. A run someone waits on passes its
 * deadline — a CLI holding its exit for a SessionEnd hook must not be kept for
 * minutes by one transcript — and a body that does not fit is queued, to go out
 * with its whole allowance from a run nobody waits on (a sweep, a push).
 */
export function uploadTimeoutMs(bodyBytes: number, deadline?: number, now = Date.now()): number {
  const needed = UPLOAD_TIMEOUT_MS + Math.ceil((bodyBytes / MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
  if (deadline === undefined) return needed;
  return Math.max(UPLOAD_TIMEOUT_MS, Math.min(needed, deadline - now));
}
export const DEFAULT_API_BASE_URL = "https://iseeyaai.com";

export interface UploadPayload {
  sessionId: string;
  /** Which CLI recorded this. The server cannot tell Codex from Claude Code. */
  agent?: string;
  contentHash: string;
  startedAt: string;
  endedAt: string;
  claudeVersion: string;
  isyVersion: string;
  git: GitMetadata;
  transcript: string;
  /**
   * How many records the transcript held at each commit this session spans,
   * oldest first. Turns a record index into the commit it belongs to, which is
   * what lets a report say when a decision was made rather than only where.
   */
  commits?: CommitMark[];
}

export type UploadOutcome =
  | {
      status: "ok";
      sessionId?: string;
      deduplicated?: boolean;
      clientVersion?: string;
      /** Where the account stands with its plan, as of this upload. */
      plan?: PlanStatus;
    }
  | { status: "retry"; error: string }
  | { status: "permanent"; error: string }
  // Too many uploads this hour. Not a failure: the session is kept as it is,
  // and the run stops rather than spending the retries of every session behind
  // it on an answer that will not change.
  | { status: "throttled" };

export interface ApiOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  /** Epoch ms an upload has to finish by. Unset, it gets the whole time its size needs. */
  deadline?: number;
}

export async function buildTranscriptFields(
  lines: readonly string[],
): Promise<{ contentHash: string; transcript: string }> {
  const jsonl = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  const contentHash = `sha256:${createHash("sha256").update(jsonl).digest("hex")}`;
  const transcript = (await gzipAsync(Buffer.from(jsonl, "utf8"))).toString("base64");
  return { contentHash, transcript };
}

function accepted(body: string): UploadOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: "ok" };
  }

  if (typeof parsed !== "object" || parsed === null) return { status: "ok" };
  const record = parsed as {
    id?: unknown;
    deduplicated?: unknown;
    clientVersion?: unknown;
    plan?: unknown;
  };

  const plan = parsePlan(record.plan);
  return {
    status: "ok",
    sessionId: typeof record.id === "string" ? record.id : undefined,
    deduplicated: record.deduplicated === true,
    // The upload is the one call every hook makes: the version the server
    // expects rides back on it rather than costing a request of its own, and so
    // does what is left of the plan.
    ...(typeof record.clientVersion === "string" ? { clientVersion: record.clientVersion } : {}),
    ...(plan ? { plan } : {}),
  };
}

function classify(status: number, body: string): UploadOutcome {
  if (status >= 200 && status < 300) return accepted(body);
  if (status === 401 || status === 403) {
    return { status: "permanent", error: `authentication rejected (${status}), run: isy init` };
  }
  if (status === 413) return { status: "permanent", error: "transcript rejected as too large (413)" };
  // A backlog is drained over hours rather than given up on: a sweep can find
  // more sessions than an hour's allowance, and they are not at fault for it.
  if (status === 429) return { status: "throttled" };
  if (status === 400 || status === 422) {
    return { status: "permanent", error: `server rejected the payload (${status}) ${body}`.trim() };
  }
  return { status: "retry", error: `server returned ${status} ${body}`.trim() };
}

export async function uploadSession(
  payload: UploadPayload,
  options: ApiOptions,
): Promise<UploadOutcome> {
  const body = await gzipAsync(Buffer.from(JSON.stringify(payload), "utf8"));

  if (body.byteLength > MAX_BODY_BYTES) {
    return {
      status: "permanent",
      error: `compressed body is ${body.byteLength} bytes, above the ${MAX_BODY_BYTES} byte limit`,
    };
  }

  let response: Response;
  try {
    response = await fetch(new URL("/api/v1/sessions", options.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        Authorization: `Bearer ${options.token}`,
      },
      body,
      signal: AbortSignal.timeout(
        options.timeoutMs ?? uploadTimeoutMs(body.byteLength, options.deadline),
      ),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "retry", error: `upload failed: ${reason}` };
  }

  const text = await response.text().catch(() => "");
  return classify(response.status, text.slice(0, 200));
}

export async function verifyToken(
  options: ApiOptions,
): Promise<{ ok: true; githubLogin?: string } | { ok: false; error: string }> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/v1/me", options.baseUrl), {
      headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `could not reach ${options.baseUrl}: ${reason}` };
  }

  if (!response.ok) return { ok: false, error: `token rejected (${response.status})` };

  const parsed: unknown = await response.json().catch(() => undefined);
  const githubLogin =
    typeof parsed === "object" && parsed !== null && "githubLogin" in parsed
      ? String((parsed as { githubLogin: unknown }).githubLogin)
      : undefined;

  return { ok: true, githubLogin };
}

/** One finding as the terminal shows it, task included. */
export interface Note {
  label: string;
  severity: string;
  confidence: number;
  file: string | null;
  line: number | null;
  prompt: string;
}

export interface NotesResponse {
  repo: string;
  prNumber: number;
  branch: string | null;
  analysisId: string;
  notes: Note[];
}

/**
 * A call the user is waiting on. Errors are thrown rather than returned as an
 * outcome union: unlike an upload there is nothing to queue and retry — someone
 * is at the terminal and wants the reason now.
 */
async function apiJson<T>(options: ApiOptions, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, options.baseUrl), {
      method: body === undefined ? "GET" : "PUT",
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`could not reach ${options.baseUrl}: ${errorMessage(error)}`);
  }

  const parsed: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `request failed (${response.status})`;
    throw new Error(message);
  }

  return parsed as T;
}

/** The findings for one branch, already written as tasks for a coding agent. */
export async function fetchNotes(
  options: ApiOptions & { repo: string; branch?: string; pr?: number },
): Promise<NotesResponse> {
  const query = new URLSearchParams({ repo: options.repo });
  if (options.pr !== undefined) query.set("pr", String(options.pr));
  else if (options.branch) query.set("branch", options.branch);

  return apiJson<NotesResponse>(options, `/api/v1/notes?${query}`);
}

/**
 * What this account chose to see, in the same words `.isy.yml` uses. Unknown
 * keys never come back: the server answers with what it actually stored.
 */
export type Settings = Record<string, unknown>;

export async function fetchSettings(options: ApiOptions): Promise<Settings> {
  const { settings } = await apiJson<{ settings: Settings }>(options, "/api/v1/settings");
  return settings ?? {};
}

export async function putSettings(options: ApiOptions, settings: Settings): Promise<Settings> {
  const stored = await apiJson<{ settings: Settings }>(options, "/api/v1/settings", settings);
  return stored.settings ?? {};
}

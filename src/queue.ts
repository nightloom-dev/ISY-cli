import { access, chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { queueDir } from "./paths.js";
import type { UploadPayload } from "./api.js";

/**
 * Attempts are spaced rather than made once per run: the wait before the next
 * one doubles from ten minutes, so the last comes nearly two days after the
 * session was queued. Runs come minutes apart — a session's start and end,
 * every commit — so counted per run, one short outage would use them all up.
 */
export const MAX_ATTEMPTS = 8;
const RETRY_AFTER_MS = 10 * 60_000;
const FAILED_SUFFIX = ".failed";

export interface QueueEntry {
  sessionId: string;
  contentHash: string;
  attempts: number;
  queuedAt: string;
  /** When the last attempt failed. isy 1.0 did not record it; `queuedAt` stands in. */
  lastAttemptAt?: string;
  lastError?: string;
  payload: UploadPayload;
}

export interface QueueItem {
  path: string;
  entry: QueueEntry;
}

function entryName(sessionId: string, contentHash: string): string {
  const safeSession = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const digest = contentHash.replace(/^sha256:/, "").slice(0, 12);
  return `${safeSession}.${digest}.json`;
}

export async function isAbandoned(sessionId: string, contentHash: string): Promise<boolean> {
  const path = join(queueDir(), `${entryName(sessionId, contentHash)}${FAILED_SUFFIX}`);
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function enqueue(payload: UploadPayload, lastError?: string): Promise<string> {
  const dir = queueDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const path = join(dir, entryName(payload.sessionId, payload.contentHash));
  const existing = await readEntry(path);
  const now = new Date().toISOString();

  const entry: QueueEntry = {
    sessionId: payload.sessionId,
    contentHash: payload.contentHash,
    attempts: existing ? existing.attempts : 0,
    queuedAt: existing ? existing.queuedAt : now,
    // The send that failed starts the wait, or the drain closing the same run
    // would try again a second later. Queued again by a later failed send, an
    // entry keeps both this and `attempts`: the queue keeps its own schedule.
    lastAttemptAt: existing ? existing.lastAttemptAt : now,
    lastError,
    payload,
  };

  await writeFile(path, JSON.stringify(entry), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

async function readEntry(path: string): Promise<QueueEntry | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as QueueEntry;
  } catch {
    return undefined;
  }
}

async function listBySuffix(suffix: string): Promise<QueueItem[]> {
  let names: string[];
  try {
    names = await readdir(queueDir());
  } catch {
    return [];
  }

  const items: QueueItem[] = [];
  for (const name of names) {
    // ".json" also matches ".json.failed", so the pending list excludes it.
    if (!name.endsWith(suffix)) continue;
    if (suffix === ".json" && name.endsWith(FAILED_SUFFIX)) continue;
    const path = join(queueDir(), name);
    const entry = await readEntry(path);
    if (entry) items.push({ path, entry });
  }

  items.sort((a, b) => a.entry.queuedAt.localeCompare(b.entry.queuedAt));
  return items;
}

export async function listPending(): Promise<QueueItem[]> {
  return listBySuffix(".json");
}

/** Whether a queued upload has waited out the delay since it last failed. */
export function isDue(entry: QueueEntry, now = Date.now()): boolean {
  const last = Date.parse(entry.lastAttemptAt ?? entry.queuedAt);
  return Number.isNaN(last) || now - last >= RETRY_AFTER_MS * 2 ** entry.attempts;
}

/** Uploads that ran out of attempts. Their `lastError` is the only record of why. */
export async function listFailed(): Promise<QueueItem[]> {
  return listBySuffix(FAILED_SUFFIX);
}

export async function recordFailure(
  item: QueueItem,
  error: string,
): Promise<"retained" | "abandoned"> {
  const attempts = item.entry.attempts + 1;
  const lastAttemptAt = new Date().toISOString();
  const updated: QueueEntry = { ...item.entry, attempts, lastAttemptAt, lastError: error };
  await writeFile(item.path, JSON.stringify(updated), { mode: 0o600 });

  if (attempts >= MAX_ATTEMPTS) {
    await rename(item.path, `${item.path}${FAILED_SUFFIX}`);
    return "abandoned";
  }
  return "retained";
}

export async function drop(item: Pick<QueueItem, "path">): Promise<void> {
  try {
    await unlink(item.path);
  } catch {
    return;
  }
}

/** Bytes that went up some other way: a copy waiting out its delay here is done. */
export async function forget(sessionId: string, contentHash: string): Promise<void> {
  await drop({ path: join(queueDir(), entryName(sessionId, contentHash)) });
}

export async function abandon(item: QueueItem, error: string): Promise<void> {
  const updated: QueueEntry = { ...item.entry, attempts: MAX_ATTEMPTS, lastError: error };
  await writeFile(item.path, JSON.stringify(updated), { mode: 0o600 });
  await rename(item.path, `${item.path}${FAILED_SUFFIX}`);
}

export async function countQueue(): Promise<{ pending: number; failed: number }> {
  let entries: string[];
  try {
    entries = await readdir(queueDir());
  } catch {
    return { pending: 0, failed: 0 };
  }

  let pending = 0;
  let failed = 0;
  for (const entry of entries) {
    if (entry.endsWith(FAILED_SUFFIX)) failed += 1;
    else if (entry.endsWith(".json")) pending += 1;
  }
  return { pending, failed };
}

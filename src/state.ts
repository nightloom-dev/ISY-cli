import { mkdir, rename, stat, unlink, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isyHome, sessionStatePath } from "./paths.js";
import type { Candidate } from "./types.js";

/**
 * Entries past this are dropped, least recently touched first.
 *
 * Sized for the sweep, which tracks every session on the machine rather than
 * every session in one directory: an entry evicted while its transcript is
 * still inside `SWEEP_WINDOW_MS` reads as changed again and is re-uploaded, so
 * the cap has to sit above a fortnight's worth of sessions with room to spare.
 */
const MAX_SESSIONS = 2000;
/** Mirrors the server's `recentShas` cap: one session never spans more usefully. */
const MAX_COMMITS = 100;

export interface CommitMark {
  sha: string;
  /** Records the transcript held when this commit was made. */
  records: number;
}

/** What isy already did with one session. */
export interface SessionState {
  /** contentHash of the last upload the server accepted. */
  uploadedHash?: string;
  /**
   * Transcript size and mtime at that upload. Both unchanged means the bytes
   * are unchanged, which lets a scan skip reading a transcript entirely.
   */
  sizeBytes?: number;
  modifiedMs?: number;
  /**
   * SHA of the newest commit mark that upload carried. A commit made after the
   * session ended leaves the transcript alone, yet its SHA is what a pull request
   * is matched on, so it has to count as a change.
   */
  uploadedCommit?: string;
  /** Candidate keys already printed, so a later commit does not repeat them. */
  shown?: string[];
  /** Record count at each commit, oldest first: maps a record index to a commit. */
  commits?: CommitMark[];
  /** Last write to this entry, for pruning. */
  touchedMs?: number;
}

/**
 * Keyed by absolute transcript path, not by session id: the scan has the path
 * before it has parsed anything, which is what lets an unchanged transcript be
 * skipped without being read.
 */
export type ClientState = Record<string, SessionState>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Never throws. A corrupt or unreadable state file must not stop an upload —
 * the worst it costs is a repeated send the server answers with `deduplicated`.
 */
export async function readState(): Promise<ClientState> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionStatePath(), "utf8"));
    return isObject(parsed) ? (parsed as ClientState) : {};
  } catch {
    return {};
  }
}

/** Past this a lock is treated as abandoned: a sweep's own budget is 30s. */
const SWEEP_LOCK_MS = 5 * 60_000;

function sweepLockPath(): string {
  return join(isyHome(), "sweep.lock");
}

/**
 * Whether this process may sweep. Only one at a time: a sweep is spawned at
 * every SessionStart, so two CLIs opened together would otherwise scan the same
 * transcripts, upload each of them twice against an hourly allowance, and race
 * each other's `updateSession` — which has no lock precisely because its writers
 * were assumed not to touch the same fields.
 *
 * `wx` is the whole mechanism: creating a file that must not already exist is
 * atomic on every filesystem isy runs on. A lock left behind by a killed sweep
 * expires rather than blocking the machine forever.
 */
export async function claimSweep(): Promise<boolean> {
  const path = sweepLockPath();

  try {
    await mkdir(isyHome(), { recursive: true, mode: 0o700 });
    await writeFile(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    // Either someone holds it or the write failed; the stale check tells us which.
  }

  try {
    const held = await stat(path);
    if (Date.now() - held.mtime.getTime() < SWEEP_LOCK_MS) return false;
    await unlink(path);
    await writeFile(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    // Another process took it between the unlink and the write, or the lock
    // cannot be written at all. Not sweeping is the safe answer to both.
    return false;
  }
}

export async function releaseSweep(): Promise<void> {
  try {
    await unlink(sweepLockPath());
  } catch {
    // A lock that cannot be removed expires on its own.
  }
}

function prune(state: ClientState): ClientState {
  const entries = Object.entries(state);
  if (entries.length <= MAX_SESSIONS) return state;

  entries.sort(([, a], [, b]) => (b.touchedMs ?? 0) - (a.touchedMs ?? 0));
  return Object.fromEntries(entries.slice(0, MAX_SESSIONS));
}

/**
 * Read-modify-write, atomically enough that a reader never sees a torn file.
 *
 * ponytail: two isy processes writing at once can lose one update — `commit`
 * spawns the uploader, and both touch this file. The fields they write are
 * disjoint and a lost one only costs a reprint or a resend, so there is no lock.
 * Add one if a third writer ever needs a field the others also set.
 */
export async function updateSession(
  transcriptPath: string,
  patch: (current: SessionState) => SessionState,
): Promise<void> {
  const state = await readState();
  const next = { ...patch(state[transcriptPath] ?? {}), touchedMs: Date.now() };

  const path = sessionStatePath();
  const temporary = join(dirname(path), `.sessions.json.isy-${process.pid}`);

  try {
    await mkdir(isyHome(), { recursive: true, mode: 0o700 });
    await writeFile(
      temporary,
      `${JSON.stringify(prune({ ...state, [transcriptPath]: next }), null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, path);
  } catch {
    // A cache that cannot be written is still a cache. Never fail the caller.
  }
}

/**
 * Identity of one candidate across runs. A transcript is append-only, so a
 * record that exists keeps its index and uuid as the session grows — the same
 * finding produces the same key at every later commit.
 */
export function candidateKey(candidate: Candidate): string {
  return [
    candidate.category,
    candidate.filePath ?? "",
    candidate.uuid ?? "",
    candidate.toolUseId ?? "",
    candidate.recordIndex,
    // Escaped, never a raw byte: a NUL in the source makes git treat the file as binary.
  ].join("\x00");
}

/** Candidates this session has not printed before. */
export function unseen(state: SessionState, candidates: readonly Candidate[]): Candidate[] {
  const shown = new Set(state.shown ?? []);
  return candidates.filter((candidate) => !shown.has(candidateKey(candidate)));
}

/**
 * Append this commit's mark, replacing any earlier mark for the same SHA so an
 * amend or a re-run does not record the commit twice.
 */
export function withCommit(
  state: SessionState,
  mark: CommitMark | undefined,
): CommitMark[] | undefined {
  if (!mark) return state.commits;
  const kept = (state.commits ?? []).filter((entry) => entry.sha !== mark.sha);
  return [...kept, mark].slice(-MAX_COMMITS);
}

/**
 * Whether the transcript or its commit marks changed since the last accepted
 * upload. Size and mtime both matching means the bytes match, so the file need
 * not be read at all.
 */
export function looksUnchanged(
  state: SessionState,
  file: { sizeBytes: number; modifiedAt: Date },
): boolean {
  if (state.uploadedHash === undefined) return false;
  if (state.commits?.at(-1)?.sha !== state.uploadedCommit) return false;
  return state.sizeBytes === file.sizeBytes && state.modifiedMs === file.modifiedAt.getTime();
}

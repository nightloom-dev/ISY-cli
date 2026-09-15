import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isyHome, logPath } from "./paths.js";

/**
 * ponytail: past this size the oldest half is dropped in place. A journal
 * nobody rotates fills a disk, and nothing here is worth a rotation scheme.
 */
const MAX_LOG_BYTES = 512 * 1024;

/**
 * Operations that run unattended. A failure in one of these is invisible until
 * something goes looking, which is what `isy health` is for. Failures of the
 * commands a user typed are already on their screen.
 */
const UNATTENDED = new Set(["upload", "commit", "check"]);

export type LogLevel = "info" | "error";

export interface JournalEntry {
  at: string;
  level: LogLevel;
  message: string;
  /** The word before the first colon: which operation wrote this, when it says. */
  operation?: string;
}

function trim(): void {
  try {
    if (statSync(logPath()).size <= MAX_LOG_BYTES) return;
    const lines = readFileSync(logPath(), "utf8").split("\n");
    writeFileSync(logPath(), lines.slice(Math.floor(lines.length / 2)).join("\n"), { mode: 0o600 });
  } catch {
    return;
  }
}

function write(level: LogLevel, message: string): void {
  try {
    mkdirSync(isyHome(), { recursive: true, mode: 0o700 });
    trim();
    appendFileSync(logPath(), `${new Date().toISOString()} ${level} ${message}\n`, { mode: 0o600 });
  } catch {
    return;
  }
}

export function logLine(message: string): void {
  write("info", message);
}

/** A failure `isy health` must be able to find long after it happened. */
export function logError(message: string): void {
  write("error", message);
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function operationOf(message: string): string | undefined {
  const colon = message.indexOf(":");
  if (colon <= 0) return undefined;
  const head = message.slice(0, colon);
  return /^[a-z-]+$/.test(head) ? head : undefined;
}

function parseEntry(line: string): JournalEntry {
  const space = line.indexOf(" ");
  const at = space > 0 ? line.slice(0, space) : "";
  const rest = space > 0 ? line.slice(space + 1) : line;

  // Lines written before levels existed are informational by definition:
  // logError did not exist to write them.
  const levelled = /^(info|error) (.*)$/s.exec(rest);
  const level = (levelled?.[1] ?? "info") as LogLevel;
  const message = levelled?.[2] ?? rest;

  return { at, level, message, operation: operationOf(message) };
}

export function readJournal(limit = 200): JournalEntry[] {
  let contents: string;
  try {
    contents = readFileSync(logPath(), "utf8");
  } catch {
    return [];
  }

  const entries = contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseEntry);

  return entries.slice(-limit);
}

/**
 * Failures of unattended work that no later success has answered for. An upload
 * that failed and then succeeded is history; one that failed after the last
 * success is a machine that is still broken.
 */
export function unresolvedErrors(lastSuccessAt?: string, entries = readJournal()): JournalEntry[] {
  const since = lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NaN;

  return entries.filter((entry) => {
    if (entry.level !== "error") return false;
    if (entry.operation !== undefined && !UNATTENDED.has(entry.operation)) return false;
    if (Number.isNaN(since)) return true;
    const at = Date.parse(entry.at);
    return Number.isNaN(at) || at > since;
  });
}

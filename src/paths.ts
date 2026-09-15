import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { SessionFile } from "./types.js";

export async function packageVersion(): Promise<string> {
  try {
    const contents = await readFile(join(import.meta.dirname, "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed as { version: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    return "0.0.0";
  }
  return "0.0.0";
}

export function isyHome(): string {
  return process.env.ISY_HOME ?? join(homedir(), ".isy");
}

export function configPath(): string {
  return join(isyHome(), "config.json");
}

export function logPath(): string {
  return join(isyHome(), "isy.log");
}

export function queueDir(): string {
  return join(isyHome(), "queue");
}

/**
 * Where an alert waits when it could not be shown at the moment it happened.
 * Kimi discards hook stdout on its lifecycle events, so an alert raised as a
 * session ends is parked here and drained at the next prompt.
 */
export function pendingAlertPath(): string {
  return join(isyHome(), "pending-alert");
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function claudeProjectsDir(): string {
  return join(claudeConfigDir(), "projects");
}

export function claudeSettingsPath(): string {
  return join(claudeConfigDir(), "settings.json");
}

export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export function projectDir(cwd: string): string {
  return join(claudeProjectsDir(), projectSlug(cwd));
}

/** The transcripts in one project folder, unsorted: the callers below sort. */
async function sessionsInDir(dir: string): Promise<SessionFile[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const sessions: SessionFile[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      sessions.push({
        sessionId: basename(entry, ".jsonl"),
        path,
        sizeBytes: info.size,
        modifiedAt: info.mtime,
      });
    } catch {
      continue;
    }
  }

  return sessions;
}

function newestFirst(sessions: SessionFile[]): SessionFile[] {
  return sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
}

export async function findSessions(cwd: string): Promise<SessionFile[]> {
  return newestFirst(await sessionsInDir(projectDir(cwd)));
}

export async function latestSession(cwd: string): Promise<SessionFile | undefined> {
  const sessions = await findSessions(cwd);
  return sessions[0];
}

/**
 * Every Claude session on this machine, newest first, without opening a single
 * transcript: a scan that runs on a timer must cost `readdir` and `stat`, not a
 * read per session. Which directory each one ran in is `firstCwd`'s job, asked
 * only about the sessions that turned out to have changed.
 */
export async function allClaudeSessions(): Promise<SessionFile[]> {
  const root = claudeProjectsDir();

  let projects: string[];
  try {
    projects = await readdir(root);
  } catch {
    return [];
  }

  const sessions: SessionFile[] = [];
  for (const project of projects) sessions.push(...(await sessionsInDir(join(root, project))));

  return newestFirst(sessions);
}

/**
 * How far into a transcript to look for the working directory. Claude opens a
 * session with records that carry none — a resumed session starts with a
 * `summary` — so the first line alone is not enough, and reading the whole file
 * to answer one question is too much.
 */
const CWD_SCAN_LINES = 40;

/**
 * Where a Claude session ran, read from the transcript rather than derived from
 * the folder it sits in: `projectSlug` replaces every non-alphanumeric character
 * with a dash, so the directory cannot be recovered from the name. This is the
 * same field `mask-paths` roots its rewriting on.
 */
export async function firstCwd(path: string, limit = CWD_SCAN_LINES): Promise<string | undefined> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });

  try {
    let seen = 0;
    for await (const line of reader) {
      if (seen++ >= limit) return undefined;
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) continue;
        const cwd = (parsed as { cwd?: unknown }).cwd;
        if (typeof cwd === "string" && cwd.length > 0) return cwd;
      } catch {
        continue;
      }
    }
    return undefined;
  } finally {
    reader.close();
    input.destroy();
  }
}

/** The first line of a file, without reading the rest: transcripts get large. */
export async function firstLine(path: string): Promise<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) return line;
    return "";
  } finally {
    reader.close();
    input.destroy();
  }
}

/**
 * What this client already did with each session: what was uploaded, what was
 * printed, which commits it spans. A cache — losing it costs one repeated
 * upload the server deduplicates, never correctness.
 */
export function sessionStatePath(): string {
  return join(isyHome(), "sessions.json");
}

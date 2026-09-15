import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { AGENTS } from "../agents/index.js";
import type { Agent, AgentId } from "../agents/index.js";
import { collectGitMetadata } from "../git.js";
import { maskPath } from "../mask-paths.js";
import { packageVersion } from "../paths.js";
import type { DiscoveredSession } from "../types.js";

/**
 * How many of the newest sessions are opened to read the directory they ran in.
 * The scan answers "can isy find these at all", which the newest few settle;
 * opening every session on a busy machine would turn a diagnostic into a job.
 */
const SCAN_SESSIONS = 25;

/** Caps on looking inside a directory isy was never taught to read. */
const PROBE_DEPTH = 3;
const PROBE_FILES = 2000;
const PROBE_ENTRIES = 12;

/** One working directory sessions were recorded in. */
export interface ScanDirectory {
  cwd: string;
  sessions: number;
  /** Whether an upload from here would have a repository to attach itself to. */
  repository: boolean;
  /** Why not, when it is not: `not-a-repository`, `no-remote`, `no-commits`. */
  reason?: string;
}

export interface ScanAgent {
  id: AgentId;
  label: string;
  present: boolean;
  transcriptRoot: string;
  /** Sessions found on this machine, as `allSessions` counts them. */
  sessions: number;
  /** Of the newest sessions opened, how many name a directory. */
  located: number;
  opened: number;
  newestAt?: string;
  directories: ScanDirectory[];
}

/**
 * A directory that might hold sessions. Known roots answer "is isy looking in
 * the right place"; the rest are probes — a desktop build keeps its sessions
 * somewhere, and nothing in this repository knows where until someone looks.
 */
export interface ScanRoot {
  path: string;
  exists: boolean;
  /** Set when this root is one an adapter already reads. */
  agent?: AgentId;
  /** Transcript-shaped files under it, counted to a cap. */
  transcripts?: number;
  /** What is in there, so an unknown layout can be recognised from the output. */
  entries?: string[];
}

export interface ScanReport {
  version: string;
  platform: string;
  node: string;
  agents: ScanAgent[];
  roots: ScanRoot[];
}

/**
 * Paths are printed with the home directory folded to `~`, the same rewrite
 * `isy/mask-paths` applies to a transcript. This output exists to be pasted
 * into an issue — the layout is the answer, the account name is not.
 */
function short(path: string): string {
  return maskPath(path, { home: homedir() });
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Transcript-shaped files under a directory, counted to a cap. */
async function countTranscripts(root: string): Promise<number> {
  let found = 0;
  let seen = 0;

  const descend = async (dir: string, depth: number): Promise<void> => {
    if (depth > PROBE_DEPTH || seen >= PROBE_FILES) return;

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (seen >= PROBE_FILES) return;
      seen += 1;
      if (entry.isDirectory()) await descend(join(dir, entry.name), depth + 1);
      else if (entry.name.endsWith(".jsonl")) found += 1;
    }
  };

  await descend(root, 0);
  return found;
}

async function probe(path: string, agent?: AgentId): Promise<ScanRoot> {
  if (!(await isDirectory(path))) return { path: short(path), exists: false, ...(agent ? { agent } : {}) };

  let entries: string[] = [];
  try {
    entries = (await readdir(path)).sort().slice(0, PROBE_ENTRIES);
  } catch {
    entries = [];
  }

  return {
    path: short(path),
    exists: true,
    ...(agent ? { agent } : {}),
    transcripts: await countTranscripts(path),
    entries,
  };
}

/**
 * Where a desktop build might keep its sessions. Guesses, and named as such:
 * the CLIs write to a dotfile directory under the home, while a packaged app on
 * each platform writes to that platform's application-data directory, and no
 * code here knows which of these — if any — a given build actually uses. The
 * scan reports what it finds so the answer comes from a machine rather than
 * from a plausible-looking constant.
 */
function candidateRoots(): string[] {
  const home = homedir();
  const names = ["Claude Code", "Claude", "claude", "Codex", "codex", "Kimi", "kimi"];

  const bases: string[] = [];
  if (process.platform === "darwin") {
    bases.push(join(home, "Library", "Application Support"), join(home, "Library", "Logs"));
  } else if (process.platform === "win32") {
    for (const variable of ["APPDATA", "LOCALAPPDATA"]) {
      const base = process.env[variable];
      if (base) bases.push(base);
    }
  } else {
    bases.push(join(home, ".config"), join(home, ".local", "share"));
  }

  return bases.flatMap((base) => names.map((name) => join(base, name)));
}

/** The directories the sessions of one agent ran in, newest sessions first. */
async function directoriesOf(agent: Agent, sessions: readonly DiscoveredSession[]): Promise<ScanDirectory[]> {
  const counts = new Map<string, number>();

  for (const session of sessions) {
    const cwd = session.cwd ?? (await agent.cwdOf(session.path));
    if (!cwd) continue;
    counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
  }

  // Concurrently: this is four `git` processes per directory, and the command
  // exists to be run by someone whose install is already not working.
  const directories = await Promise.all(
    [...counts].map(async ([cwd, found]): Promise<ScanDirectory> => {
      const git = await collectGitMetadata(cwd);
      return {
        cwd: short(cwd),
        sessions: found,
        repository: git.ok,
        ...(git.ok ? {} : { reason: git.reason }),
      };
    }),
  );

  return directories.sort((a, b) => b.sessions - a.sessions);
}

export async function collectScan(): Promise<ScanReport> {
  const agents: ScanAgent[] = [];
  const knownRoots: ScanRoot[] = [];

  for (const agent of AGENTS) {
    const present = await agent.present();
    const root = agent.transcriptRoot();
    knownRoots.push(await probe(root, agent.id));

    const sessions = present ? await agent.allSessions() : [];
    const opened = sessions.slice(0, SCAN_SESSIONS);
    const directories = await directoriesOf(agent, opened);

    agents.push({
      id: agent.id,
      label: agent.label,
      present,
      transcriptRoot: short(root),
      sessions: sessions.length,
      opened: opened.length,
      located: directories.reduce((total, entry) => total + entry.sessions, 0),
      ...(sessions[0] ? { newestAt: sessions[0].modifiedAt.toISOString() } : {}),
      directories,
    });
  }

  // Fourteen independent directory walks; there is no reason to queue them.
  const candidates = await Promise.all(candidateRoots().map((path) => probe(path)));

  return {
    version: await packageVersion(),
    platform: process.platform,
    node: process.version,
    agents,
    // Absent probes last: what was found is the part worth reading.
    roots: [...knownRoots, ...candidates.filter((root) => root.exists)],
  };
}

function agentLines(agent: ScanAgent): string[] {
  const lines = [`${agent.label}${agent.present ? "" : " — not installed here"}`];
  lines.push(`  root       ${agent.transcriptRoot}`);

  if (!agent.present) return lines;

  const newest = agent.newestAt ? `, newest ${agent.newestAt}` : "";
  lines.push(`  sessions   ${agent.sessions}${newest}`);

  if (agent.opened > 0) {
    lines.push(`  located    ${agent.located} of the ${agent.opened} newest name a directory`);
  }

  for (const directory of agent.directories) {
    const state = directory.repository ? "repository" : (directory.reason ?? "not a repository");
    lines.push(`    ${directory.sessions.toString().padStart(4)}  ${directory.cwd}  ${state}`);
  }

  return lines;
}

export function formatScan(report: ScanReport): string {
  const lines = [`ISY ${report.version} scan · ${report.platform} · node ${report.node}`, ""];

  for (const agent of report.agents) {
    lines.push(...agentLines(agent));
    lines.push("");
  }

  lines.push("roots on this machine");
  for (const root of report.roots) {
    if (!root.exists) {
      lines.push(`  absent   ${root.path}`);
      continue;
    }
    const transcripts = `${root.transcripts ?? 0} .jsonl`;
    const entries = root.entries?.length ? ` · ${root.entries.join(" ")}` : "";
    lines.push(`  found    ${root.path}  ${transcripts}${entries}`);
  }

  lines.push("");
  lines.push(
    "A desktop build fires no SessionEnd hook, so isy finds its sessions by scanning.",
  );
  lines.push(
    "If a root above holds transcripts no adapter reads, that output is the bug report:",
  );
  lines.push("it says where they live and what shape they are in.");

  return lines.join("\n");
}

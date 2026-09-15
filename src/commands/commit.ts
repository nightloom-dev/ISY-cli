import { relative } from "node:path";
import { newestSession } from "../agents/index.js";
import type { AgentId } from "../agents/index.js";
import { readConfig } from "../config.js";
import { headSha } from "../git.js";
import { parseLines } from "../parser.js";
import { spawnIsy } from "../spawn.js";
import { runStage0 } from "../stage0.js";
import { candidateKey, readState, unseen, updateSession, withCommit } from "../state.js";
import type { Candidate } from "../types.js";

export interface CommitReport {
  agent?: AgentId;
  cwd: string;
  sessionId?: string;
  sha?: string;
  records: number;
  /** Only what this commit adds — findings an earlier commit printed stay quiet. */
  candidates: Candidate[];
  uploaded: "spawned" | "not-attempted";
  skipped?: string;
}

const COLUMN_GAP = 2;
/** A line printed after every commit earns its place; a screenful does not. */
const MAX_LINES = 6;
/** Past this, a category is one counted line rather than one line per file. */
const MAX_PER_CATEGORY = 2;

export async function runCommit(
  options: { json?: boolean; noUpload?: boolean },
  cwd: string,
): Promise<CommitReport> {
  const report: CommitReport = { cwd, records: 0, candidates: [], uploaded: "not-attempted" };

  const newest = await newestSession(cwd);
  if (!newest) {
    report.skipped = "no session recorded for this directory";
    return report;
  }

  report.agent = newest.agent.id;
  report.sessionId = newest.file.sessionId;
  report.sha = await headSha(cwd);

  const config = await readConfig();
  const lines = await newest.agent.redactedLines(newest.file.path, {
    extraPatterns: config.extraRedactPatterns,
    cwd,
  });
  const session = parseLines(lines);
  report.records = session.records.length;

  // Stage 0 always sees the whole transcript: the detectors reason across the
  // session — an abandoned branch forks early, a revert compares a late edit
  // with an early one — so a window would cost exactly the signals worth having.
  const stage0 = runStage0(session);
  const state = (await readState())[newest.file.path] ?? {};
  report.candidates = unseen(state, stage0.candidates);

  await updateSession(newest.file.path, (current) => ({
    ...current,
    shown: [...new Set([...(current.shown ?? []), ...stage0.candidates.map(candidateKey)])],
    // What the transcript held at this commit, so a record index can later be
    // told which commit it belongs to.
    commits: withCommit(
      current,
      report.sha ? { sha: report.sha, records: session.records.length } : undefined,
    ),
  }));

  // Detached: a commit must never wait on the network, and an upload has a 30
  // second budget of its own. The SessionEnd hook and the sweep are both still
  // there as backstops if this one never lands.
  if (!options.noUpload) report.uploaded = spawnIsy(["upload", "--silent", "--all"], cwd);
  return report;
}

function pad(value: string, width: number): string {
  return value.padEnd(width + COLUMN_GAP, " ");
}

/** Inside the repository, the path the user would type. Outside it, as it is. */
function shortPath(cwd: string, filePath: string | undefined): string {
  if (!filePath) return "";
  const relativePath = relative(cwd, filePath);
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : filePath;
}

function strongestFirst(a: Candidate, b: Candidate): number {
  if (a.weight !== b.weight) return b.weight - a.weight;
  return a.recordIndex - b.recordIndex;
}

interface Row {
  category: string;
  subject: string;
  detail: string;
}

/**
 * One row per finding, except where a category repeats across many files: a
 * session that edited twenty files unread is one fact, not twenty, and printing
 * it twenty times buries the finding next to it that is worth reading.
 */
function rows(report: CommitReport): Row[] {
  const byCategory = new Map<string, Candidate[]>();
  for (const candidate of [...report.candidates].sort(strongestFirst)) {
    byCategory.set(candidate.category, [...(byCategory.get(candidate.category) ?? []), candidate]);
  }

  const out: Row[] = [];
  for (const [category, candidates] of byCategory) {
    if (candidates.length <= MAX_PER_CATEGORY) {
      for (const candidate of candidates) {
        out.push({
          category,
          subject: shortPath(report.cwd, candidate.filePath),
          detail: candidate.detail,
        });
      }
      continue;
    }

    const files = new Set(candidates.map((candidate) => candidate.filePath ?? "")).size;
    out.push({
      category,
      subject: `${files} file${files === 1 ? "" : "s"}`,
      detail: candidates[0]!.detail,
    });
  }

  return out;
}

/**
 * Silence is the default: a commit that surfaced nothing new prints nothing at
 * all, the same rule the pull request comment follows.
 */
export function formatCommit(report: CommitReport): string | undefined {
  if (report.candidates.length === 0) return undefined;

  const all = rows(report);
  const shown = all.slice(0, MAX_LINES);

  const categoryWidth = Math.max(...shown.map((entry) => entry.category.length));
  const subjectWidth = Math.max(...shown.map((entry) => entry.subject.length));

  const lines = shown.map(
    (entry) =>
      `  ${pad(entry.category, categoryWidth)}${pad(entry.subject, subjectWidth)}${entry.detail}`,
  );

  if (all.length > shown.length) {
    lines.push(`  ${all.length - shown.length} more — run: isy analyze`);
  }

  const count = report.candidates.length;
  // "Possible": these are stage 0 candidates, and the pull request comment keeps
  // only what stage 2 confirms. Calling them signals promised a note that often
  // never came.
  return [`ISY: ${count} possible signal${count === 1 ? "" : "s"} in this session`, ...lines].join("\n");
}

export async function runCommitCommand(
  options: { json: boolean; hook: boolean },
  cwd: string,
): Promise<void> {
  const report = await runCommit({}, cwd);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const rendered = formatCommit(report);
  if (rendered) console.log(rendered);
  else if (!options.hook && report.skipped) console.log(`isy: ${report.skipped}`);
}

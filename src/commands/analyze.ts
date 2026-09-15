import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { codexAgent, kimiAgent } from "../agents/index.js";
import { isCodexTranscript } from "../agents/codex-records.js";
import { isKimiTranscript } from "../agents/kimi-records.js";
import { isKimiWireTranscript } from "../agents/kimi-wire.js";
import { readConfig } from "../config.js";
import { parseLines } from "../parser.js";
import { firstLine, packageVersion } from "../paths.js";
import { redactTranscriptFile } from "../redact.js";
import { countByCategory, runStage0 } from "../stage0.js";
import type { IneligibleReason, Stage0Result } from "../stage0.js";
import type { Candidate, SignalCategory } from "../types.js";

export const SUPPORTED_STAGES = new Set(["0", "stage0"]);

export interface AnalyzedSession {
  file: string;
  sessionId?: string;
  records: number;
  assistantRecords: number;
  editToolUses: number;
  thinkingBlocks: number;
  eligible: boolean;
  reason?: IneligibleReason;
  knownGapReachable: boolean;
  candidates: Candidate[];
}

export interface AnalyzeReport {
  isyVersion: string;
  stage: string;
  sessions: AnalyzedSession[];
  totals: {
    files: number;
    eligible: number;
    silent: number;
    candidates: number;
    byCategory: Record<string, number>;
  };
}

export async function expandInputs(inputs: readonly string[]): Promise<string[]> {
  const files: string[] = [];

  for (const input of inputs) {
    let info;
    try {
      info = await stat(input);
    } catch {
      throw new Error(`cannot read ${input}`);
    }

    if (info.isDirectory()) {
      for (const entry of await readdir(input, { withFileTypes: true, recursive: true })) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(join(entry.parentPath, entry.name));
        }
      }
      continue;
    }

    files.push(input);
  }

  return [...new Set(files)].sort();
}

/**
 * Which CLI wrote this file. Sniffing beats a flag: a directory handed to
 * `isy analyze` can hold transcripts from more than one.
 */
async function transcriptLines(
  file: string,
  extraPatterns: readonly string[] | undefined,
): Promise<string[]> {
  const head = await firstLine(file);

  // Two Kimi layouts: the older `context.jsonl` and the newer event log.
  if (isKimiTranscript(head) || isKimiWireTranscript(head)) {
    return kimiAgent.redactedLines(file, { extraPatterns });
  }
  if (isCodexTranscript(head)) return codexAgent.redactedLines(file, { extraPatterns });

  const { lines } = await redactTranscriptFile(file, { extraPatterns });
  return lines;
}

export async function analyzeFiles(
  files: readonly string[],
  extraPatterns: readonly string[] | undefined,
): Promise<AnalyzedSession[]> {
  const sessions: AnalyzedSession[] = [];

  for (const file of files) {
    const lines = await transcriptLines(file, extraPatterns);
    const session = parseLines(lines);
    const result: Stage0Result = runStage0(session);

    sessions.push({
      file,
      sessionId: result.sessionId,
      records: session.records.length,
      assistantRecords: session.meta.assistantRecords,
      editToolUses: session.meta.editToolUses,
      thinkingBlocks: result.thinkingBlocks,
      eligible: result.eligible,
      reason: result.reason,
      knownGapReachable: result.knownGapReachable,
      candidates: result.candidates,
    });
  }

  return sessions;
}

export function buildReport(
  isyVersion: string,
  stage: string,
  sessions: AnalyzedSession[],
): AnalyzeReport {
  const candidates = sessions.flatMap((session) => session.candidates);
  const eligible = sessions.filter((session) => session.eligible);

  return {
    isyVersion,
    stage,
    sessions,
    totals: {
      files: sessions.length,
      eligible: eligible.length,
      silent: eligible.filter((session) => session.candidates.length === 0).length,
      candidates: candidates.length,
      byCategory: countByCategory(candidates),
    },
  };
}

export interface Snapshot {
  session: string;
  eligible: boolean;
  reason?: IneligibleReason;
  knownGapReachable: boolean;
  candidates: {
    category: SignalCategory;
    filePath?: string;
    recordIndex: number;
    weight: number;
    detail: string;
  }[];
}

export type SnapshotStatus = "ok" | "changed" | "missing" | "written";

export function snapshotOf(session: AnalyzedSession): Snapshot {
  return {
    session: basename(session.file, ".jsonl"),
    eligible: session.eligible,
    ...(session.reason ? { reason: session.reason } : {}),
    knownGapReachable: session.knownGapReachable,
    candidates: session.candidates.map((candidate) => ({
      category: candidate.category,
      ...(candidate.filePath ? { filePath: candidate.filePath } : {}),
      recordIndex: candidate.recordIndex,
      weight: candidate.weight,
      detail: candidate.detail,
    })),
  };
}

export async function compareExpected(
  dir: string,
  sessions: readonly AnalyzedSession[],
  update: boolean,
): Promise<{ name: string; status: SnapshotStatus }[]> {
  if (update) await mkdir(dir, { recursive: true });

  const results: { name: string; status: SnapshotStatus }[] = [];

  for (const session of sessions) {
    const snapshot = snapshotOf(session);
    const path = join(dir, `${snapshot.session}.json`);
    const rendered = `${JSON.stringify(snapshot, null, 2)}\n`;

    if (update) {
      await writeFile(path, rendered);
      results.push({ name: snapshot.session, status: "written" });
      continue;
    }

    let stored: string;
    try {
      stored = await readFile(path, "utf8");
    } catch {
      results.push({ name: snapshot.session, status: "missing" });
      continue;
    }

    results.push({ name: snapshot.session, status: stored === rendered ? "ok" : "changed" });
  }

  return results;
}

/**
 * `elapsedMs` is passed in rather than measured here so the report stays a pure
 * function of the sessions — it is omitted from the last line when absent.
 */
export function formatReport(report: AnalyzeReport, elapsedMs?: number): string {
  const lines: string[] = [];

  for (const session of report.sessions) {
    lines.push(`${session.file}`);
    lines.push(
      `  session ${session.sessionId ?? "unknown"} · ${session.records} records · ` +
        `${session.assistantRecords} assistant · ${session.editToolUses} file edits`,
    );

    if (!session.eligible) {
      lines.push(`  gated out: ${session.reason}`);
      lines.push("");
      continue;
    }

    if (session.candidates.length === 0) {
      lines.push("  no candidates");
      lines.push("");
      continue;
    }

    for (const candidate of session.candidates) {
      const where = candidate.filePath ? ` · ${candidate.filePath}` : "";
      lines.push(
        `  [${candidate.weight.toFixed(2)}] ${candidate.category}${where}\n` +
          `        ${candidate.detail}`,
      );
    }
    if (!session.knownGapReachable) {
      lines.push("  note: no thinking blocks, known_gap is unreachable for this session");
    }
    lines.push("");
  }

  const totals = report.totals;
  lines.push(
    `${totals.files} file(s) · ${totals.eligible} eligible · ${totals.silent} silent · ` +
      `${totals.candidates} candidate(s)`,
  );
  for (const [category, count] of Object.entries(totals.byCategory).sort()) {
    lines.push(`  ${String(count).padStart(4)}  ${category}`);
  }
  lines.push("");
  const took = elapsedMs === undefined ? "" : ` in ${(elapsedMs / 1000).toFixed(1)}s`;
  lines.push(
    `\u2714 ${totals.files} file(s) scanned${took} · 0 bytes sent · ` +
      "stage 0 is deterministic, runs locally, no model calls",
  );

  return lines.join("\n");
}

export async function runAnalyze(
  options: {
    files: readonly string[];
    stage?: string;
    json: boolean;
    expect?: string;
    update?: boolean;
  },
): Promise<void> {
  if (options.files.length === 0) {
    throw new Error("no transcripts given. Usage: isy analyze <file.jsonl|directory> [--stage 0]");
  }

  const stage = options.stage ?? "0";
  if (!SUPPORTED_STAGES.has(stage)) {
    throw new Error(
      `stage '${stage}' is not available offline. Stages 1 and 2 call the model provider and run server-side; use --stage 0`,
    );
  }

  const files = await expandInputs(options.files);
  if (files.length === 0) throw new Error("no .jsonl transcripts found");

  const config = await readConfig();
  const started = Date.now();
  const sessions = await analyzeFiles(files, config.extraRedactPatterns);
  const elapsedMs = Date.now() - started;
  const report = buildReport(await packageVersion(), stage, sessions);

  console.log(
    options.json ? JSON.stringify(report, null, 2) : formatReport(report, elapsedMs),
  );

  if (!options.expect) return;

  const results = await compareExpected(options.expect, sessions, options.update === true);
  const note = options.json ? console.error : console.log;
  for (const { name, status } of results) note(`${status.padEnd(8)} ${name}`);

  const stale = results.filter((result) => result.status !== "ok" && result.status !== "written");
  if (stale.length > 0) {
    throw new Error(
      `${stale.length} snapshot(s) do not match ${options.expect}: ` +
        `${stale.map((result) => result.name).join(", ")}. Re-run with --update to accept`,
    );
  }
}

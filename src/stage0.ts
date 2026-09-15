import {
  detectAbandonedApproach,
  detectDestructiveCommand,
  detectErrorSuppressed,
  detectExternalDependency,
  detectStaleContext,
  detectTestModifiedToPass,
  detectUnverifiedAssumption,
  detectUnverifiedFix,
} from "./detectors.js";
import { looksAbsolute, maskPath } from "./mask-paths.js";
import type { Candidate, ParsedSession, SignalCategory } from "./types.js";

export const MIN_ASSISTANT_RECORDS = 20;

export type IneligibleReason = "too-short" | "no-file-edits";

export interface Stage0Result {
  sessionId?: string;
  eligible: boolean;
  reason?: IneligibleReason;
  thinkingBlocks: number;
  knownGapReachable: boolean;
  candidates: Candidate[];
}

export function eligibility(session: ParsedSession): IneligibleReason | undefined {
  if (session.meta.assistantRecords < MIN_ASSISTANT_RECORDS) return "too-short";
  if (!session.meta.hasFileEdits) return "no-file-edits";
  return undefined;
}

function order(a: Candidate, b: Candidate): number {
  if (a.recordIndex !== b.recordIndex) return a.recordIndex - b.recordIndex;
  if (a.category !== b.category) return a.category < b.category ? -1 : 1;
  return (a.filePath ?? "").localeCompare(b.filePath ?? "");
}

/**
 * A finding about a file no repository holds — `/tmp/reset.py`, a scratch
 * script — has nothing to say to a pull request. Masking decides it the way the
 * upload does: under the session's directory a path turns relative, under the
 * home it turns `~/…`, and only what stays absolute lies outside both. The
 * server reads transcripts already masked, `cwd` included (it reads `.`), so
 * there the paths are judged as they are.
 *
 * ponytail: a repository outside the home, with the session started in one of
 * its subdirectories, loses findings on sibling directories; the git root
 * recorded at upload is the way up.
 */
function inTree(candidate: Candidate, cwd: string | undefined): boolean {
  if (candidate.filePath === undefined || cwd === undefined) return true;
  return !looksAbsolute(maskPath(candidate.filePath, looksAbsolute(cwd) ? { cwd } : {}));
}

export function runStage0(session: ParsedSession): Stage0Result {
  const thinkingBlocks = session.meta.thinkingBlocks;
  const reason = eligibility(session);

  if (reason) {
    return {
      sessionId: session.sessionId,
      eligible: false,
      reason,
      thinkingBlocks,
      knownGapReachable: thinkingBlocks > 0,
      candidates: [],
    };
  }

  const abandoned = detectAbandonedApproach(session);
  // A `git reset --hard` that threw away this session's own edits is already
  // reported as an abandoned approach. Saying it twice, under two headings, is
  // one command and two notes for the reviewer to reconcile.
  const alreadyReported = new Set(abandoned.map((candidate) => candidate.toolUseId));

  const candidates = [
    ...abandoned,
    ...detectTestModifiedToPass(session),
    ...detectExternalDependency(session),
    ...detectUnverifiedAssumption(session),
    ...detectUnverifiedFix(session),
    ...detectErrorSuppressed(session),
    ...detectStaleContext(session),
    ...detectDestructiveCommand(session).filter((c) => !alreadyReported.has(c.toolUseId)),
  ]
    .filter((candidate) => inTree(candidate, session.meta.cwd))
    .sort(order);

  return {
    sessionId: session.sessionId,
    eligible: true,
    thinkingBlocks,
    knownGapReachable: thinkingBlocks > 0,
    candidates,
  };
}

export function countByCategory(candidates: readonly Candidate[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.category] = (counts[candidate.category] ?? 0) + 1;
  }
  return counts;
}

export function runStage0All(sessions: readonly ParsedSession[]): {
  results: Stage0Result[];
  candidates: Candidate[];
  byCategory: Record<SignalCategory, number> | Record<string, number>;
  silent: boolean;
} {
  const results = sessions.map(runStage0);
  const candidates = results.flatMap((result) => result.candidates);
  return {
    results,
    candidates,
    byCategory: countByCategory(candidates),
    silent: candidates.length === 0,
  };
}

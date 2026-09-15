import { stat } from "node:fs/promises";
import { detectAgent, presentAgents } from "../agents/index.js";
import type { Agent, AgentId, HookInput } from "../agents/index.js";
import { DEFAULT_API_BASE_URL, buildTranscriptFields, uploadSession } from "../api.js";
import type { ApiOptions, UploadPayload } from "../api.js";
import { readConfig, updateConfig } from "../config.js";
import { collectGitMetadata } from "../git.js";
import { autoInstallGitHook } from "../githook.js";
import type { GitMetadata, GitResult } from "../git.js";
import type { DiscoveredSession, IsyConfig } from "../types.js";
import { logError, logLine } from "../log.js";
import { parseLines } from "../parser.js";
import { packageVersion } from "../paths.js";
import { MAX_ATTEMPTS, abandon, drop, enqueue, isAbandoned, listPending, recordFailure } from "../queue.js";
import { updateNotice } from "../update.js";
import { planNotice } from "../plan.js";
import type { PlanStatus } from "../plan.js";
import { looksUnchanged, readState, updateSession } from "../state.js";
import type { ClientState, CommitMark } from "../state.js";

export const TOTAL_BUDGET_MS = 30_000;

export type { HookInput } from "../agents/index.js";

export interface UploadReport {
  agent: AgentId;
  sent: number;
  /** Of those sent, how many the server had not already seen. */
  fresh: number;
  queued: number;
  abandoned: number;
  drained: number;
  deduplicated: boolean;
  skipped?: string;
  /** Set when the server expects a newer client than the one that ran. */
  updateNotice?: string;
  /** What a SessionEnd run did about this repository's git hooks, when it did anything. */
  gitHook?: "installed" | "shared-hooks";
  /** Set when the plan has nothing left: the next pull request will not be analysed. */
  planNotice?: string;
  /** Sessions a sweep looked at, across every CLI and every directory. */
  scanned?: number;
  /** The server's hourly upload allowance ran out; nothing was lost by it. */
  throttled?: boolean;
}

export async function readHookInput(
  stream: NodeJS.ReadStream = process.stdin,
): Promise<HookInput | undefined> {
  if (stream.isTTY) return undefined;

  const chunks: Buffer[] = [];
  const guard = setTimeout(() => stream.destroy(), 2000);
  try {
    for await (const chunk of stream) chunks.push(chunk as Buffer);
  } catch {
    return undefined;
  } finally {
    clearTimeout(guard);
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return undefined;

  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return parsed as HookInput;
  } catch {
    return undefined;
  }
}

export async function buildPayload(
  agent: Agent,
  transcriptPath: string,
  git: GitMetadata,
  options: { extraPatterns?: readonly string[]; cwd?: string; commits?: CommitMark[] },
  fallbackSessionId: string,
): Promise<UploadPayload | undefined> {
  // Whatever the CLI's native format, this comes back Claude-record shaped:
  // the server re-parses the upload with the same parseLines (cascade.ts).
  const lines = await agent.redactedLines(transcriptPath, options);
  // Codex writes a rollout before the first turn, so a session opened and
  // closed again is a file with no turn in it. Nothing to analyse, and no
  // ledger mark either: once it grows a turn it is sent like any other.
  if (lines.length === 0) return undefined;
  const session = parseLines(lines);
  const { contentHash, transcript } = await buildTranscriptFields(lines);
  const now = new Date().toISOString();

  return {
    sessionId: session.sessionId ?? fallbackSessionId,
    agent: agent.id,
    contentHash,
    startedAt: session.meta.startedAt ?? now,
    endedAt: session.meta.endedAt ?? now,
    claudeVersion: session.meta.claudeVersion ?? "unknown",
    isyVersion: await packageVersion(),
    git,
    transcript,
    ...(options.commits && options.commits.length > 0 ? { commits: options.commits } : {}),
  };
}

/** The server's answer says which client it expects; remember it either way. */
async function noteClientVersion(
  version: string | undefined,
  current: string,
  report: UploadReport,
): Promise<void> {
  if (!version) return;
  report.updateNotice = updateNotice(version, current);
  // Kept so `isy status` and `isy check` can say it too, without a call.
  await updateConfig({ latestVersion: version });
}

/**
 * What the answer said about the plan. Stored like the client version, and for
 * the same reason: the upload is the only call a hook makes, so every other
 * command reads this rather than asking again.
 */
async function notePlan(plan: PlanStatus | undefined, report: UploadReport): Promise<void> {
  if (!plan) return;
  report.planNotice = planNotice(plan);
  await updateConfig({ plan });
}

async function drainQueue(api: ApiOptions, deadline: number, report: UploadReport): Promise<void> {
  for (const item of await listPending()) {
    if (Date.now() >= deadline) return;

    const outcome = await uploadSession(item.entry.payload, api);
    if (outcome.status === "ok") {
      await noteClientVersion(outcome.clientVersion, item.entry.payload.isyVersion, report);
      await notePlan(outcome.plan, report);
      await drop(item);
      report.drained += 1;
      continue;
    }

    // The rest would get the same answer. They wait in the queue, attempts untouched.
    if (outcome.status === "throttled") {
      report.throttled = true;
      logLine("upload: rate limited, the queue keeps its place for the next run");
      return;
    }

    if (outcome.status === "permanent") {
      await abandon(item, outcome.error);
      report.abandoned += 1;
      logError(`upload: abandoned queued session ${item.entry.sessionId}: ${outcome.error}`);
      continue;
    }

    const result = await recordFailure(item, outcome.error);
    if (result === "abandoned") {
      report.abandoned += 1;
      logError(`upload: gave up on queued session ${item.entry.sessionId}: ${outcome.error}`);
    }
  }
}

interface Target {
  agent: Agent;
  path: string;
  /** Set when the target came from a scan, which already knows size and mtime. */
  file?: DiscoveredSession;
  /**
   * Where this session ran. Only a sweep sets it: every other path knows the
   * directory before it knows the session, because a hook named it.
   */
  cwd?: string;
}

/**
 * Every session recorded for this directory whose bytes are not already on the
 * server, across every CLI installed here.
 *
 * Size and mtime both matching the last accepted upload means the content
 * matches, so an unchanged transcript is never read — and a session that ended
 * without a commit is still picked up here, however long ago it ended.
 */
async function changedSessions(cwd: string, state: ClientState): Promise<Target[]> {
  const targets: Target[] = [];

  for (const agent of await presentAgents()) {
    for (const file of await agent.sessionsIn(cwd)) {
      if (looksUnchanged(state[file.path] ?? {}, file)) continue;
      targets.push({ agent, path: file.path, file });
    }
  }

  return targets;
}

/**
 * How far back a sweep looks. A sweep has no baseline to start from — every
 * session it has never seen reads as changed — so without a window the first
 * one on a machine would upload years of transcripts from every directory the
 * CLI was ever used in. Nothing older than this can reach an analysis anyway:
 * sessions are matched to a pull request by commit SHA, and a transcript
 * untouched for a fortnight belongs to commits that were pushed long ago.
 *
 * ponytail: a fixed window, not a high-water mark. A machine that was offline
 * longer than this loses the tail; move the boundary to a `lastSweepAt` in the
 * config if that ever happens to anyone.
 */
const SWEEP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Every recently changed session on this machine, whatever directory it ran in.
 *
 * What a sweep starts from, and the answer to a CLI with no clear end to a
 * session: a desktop app fires no SessionEnd hook, so there is no moment that
 * names a working directory and no transcript path handed to us. The directory
 * is read back out of the transcript instead (`Agent.cwdOf`), and only for the
 * sessions that actually grew — size and mtime settle that with a `stat`, so a
 * machine with hundreds of sessions costs a `stat` each and nothing more.
 *
 * `scanned` counts what was looked at rather than what was sent: it is the one
 * number that tells a quiet sweep apart from a sweep that found no sessions.
 */
async function sweptSessions(state: ClientState, report: UploadReport): Promise<Target[]> {
  const targets: Target[] = [];
  const oldest = Date.now() - SWEEP_WINDOW_MS;
  let rootless = 0;
  report.scanned = 0;

  for (const agent of await presentAgents()) {
    for (const file of await agent.allSessions()) {
      report.scanned += 1;
      if (file.modifiedAt.getTime() < oldest) continue;
      if (looksUnchanged(state[file.path] ?? {}, file)) continue;

      // A session whose directory cannot be read is one nothing can be said
      // about: without it there is no repository, no branch and no root to make
      // the transcript's paths relative to. Kimi's listing already knows.
      const cwd = file.cwd ?? (await agent.cwdOf(file.path));
      if (!cwd) {
        rootless += 1;
        continue;
      }

      targets.push({ agent, path: file.path, file, cwd });
    }
  }

  // Counted, not listed. A sweep runs at every session start and the same
  // sessions are skipped every time; one line each would push everything worth
  // reading out of the journal `isy health` shows.
  if (rootless > 0) logLine(`upload: ${rootless} swept session(s) record no working directory`);

  // Smallest first. The run budget is checked between sessions, and the session
  // still open in the CLI that started this sweep is the biggest and always reads
  // as changed: listed first, it spent the budget on every start and the sessions
  // behind it never went out.
  return targets.sort((a, b) => a.file!.sizeBytes - b.file!.sizeBytes);
}

/** Size and mtime of a transcript, for the "did it change" check on the next run. */
async function fingerprint(target: Target): Promise<{ sizeBytes: number; modifiedMs: number }> {
  if (target.file) {
    return { sizeBytes: target.file.sizeBytes, modifiedMs: target.file.modifiedAt.getTime() };
  }
  const info = await stat(target.path);
  return { sizeBytes: info.size, modifiedMs: info.mtime.getTime() };
}

async function sendOne(
  target: Target,
  git: GitMetadata,
  state: ClientState,
  config: IsyConfig,
  api: ApiOptions,
  workingDir: string,
  fallbackSessionId: string,
  report: UploadReport,
): Promise<void> {
  const payload = await buildPayload(
    target.agent,
    target.path,
    git,
    {
      extraPatterns: config.extraRedactPatterns,
      // A swept session ran where the transcript says it ran, not where this
      // process happens to stand: masking is rooted on it.
      cwd: target.cwd ?? workingDir,
      commits: state[target.path]?.commits,
    },
    fallbackSessionId,
  );
  if (!payload) return;

  if (await isAbandoned(payload.sessionId, payload.contentHash)) {
    report.skipped = `session ${payload.sessionId} was given up on after ${MAX_ATTEMPTS} attempts`;
    logError(`upload: ${report.skipped}`);
    return;
  }

  const outcome = await uploadSession(payload, api);
  if (outcome.status === "ok") {
    report.sent += 1;
    await noteClientVersion(outcome.clientVersion, payload.isyVersion, report);
    await notePlan(outcome.plan, report);
    if (outcome.deduplicated !== true) report.fresh += 1;
    // Recorded only once the server has it: a failed send must stay "changed"
    // so the next commit tries again rather than skipping it forever.
    const seen = await fingerprint(target);
    await updateSession(target.path, (current) => ({
      ...current,
      uploadedHash: payload.contentHash,
      uploadedCommit: payload.commits?.at(-1)?.sha,
      ...seen,
    }));
    await updateConfig({ lastUploadAt: new Date().toISOString() });
  } else if (outcome.status === "throttled") {
    // Neither queued nor failed: the transcript still reads as changed, so the
    // next sweep or hook picks it up once the hour turns over, and a queue would
    // only burn its attempts.
    report.throttled = true;
    logLine(`upload: ${payload.sessionId} not sent, this hour's uploads are spent`);
  } else if (outcome.status === "retry") {
    await enqueue(payload, outcome.error);
    report.queued += 1;
    logLine(`upload: queued ${payload.sessionId} for retry: ${outcome.error}`);
  } else {
    report.abandoned += 1;
    logError(`upload: dropped ${payload.sessionId}: ${outcome.error}`);
  }
}

export async function runUpload(
  options: { silent: boolean; agent?: string; all?: boolean; hook?: boolean; sweep?: boolean },
  cwd: string,
): Promise<UploadReport> {
  const report: UploadReport = {
    agent: "claude",
    sent: 0,
    fresh: 0,
    queued: 0,
    abandoned: 0,
    drained: 0,
    deduplicated: false,
  };
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  const config = await readConfig();
  if (!config.token) {
    report.skipped = "no token configured, run: isy init";
    logLine(`upload: ${report.skipped}`);
    return report;
  }

  const api: ApiOptions = {
    baseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    token: config.token,
    // A hook is the run a CLI may be waiting on: Claude Code and Kimi hold
    // their exit for it, Codex detaches it, and the hook cannot tell which.
    ...(options.hook ? { deadline } : {}),
  };

  const hook = await readHookInput();
  const agent = detectAgent(hook, options.agent);
  report.agent = agent.id;

  const workingDir = hook?.cwd ?? cwd;
  const state = await readState();

  const targets = options.sweep
    ? await sweptSessions(state, report)
    : options.all
      ? await changedSessions(workingDir, state)
      : await (async (): Promise<Target[]> => {
          const path = await agent.transcriptFor(hook, workingDir);
          return path ? [{ agent, path }] : [];
        })();

  if (targets.length === 0) {
    report.skipped = options.sweep
      ? `nothing new to upload from ${report.scanned ?? 0} session(s) on this machine`
      : options.all
        ? `nothing new to upload for ${workingDir}`
        : `no ${agent.label} transcript found for ${workingDir}`;
    logLine(`upload: ${report.skipped}`);
    await drainQueue(api, deadline, report);
    return report;
  }

  // One git call per directory, however many sessions ran in it.
  const repositories = new Map<string, GitResult>();
  const gitFor = async (directory: string): Promise<GitResult> => {
    const known = repositories.get(directory);
    if (known) return known;
    const result = await collectGitMetadata(directory);
    repositories.set(directory, result);
    return result;
  };

  // A sweep finds sessions from directories that were never repositories, and
  // that is not a fault worth reporting: it skips them one by one below. Every
  // other caller was pointed at one directory and deserves to hear why nothing
  // came of it.
  if (!options.sweep) {
    const git = await gitFor(workingDir);
    if (!git.ok) {
      report.skipped = `${workingDir} is not usable: ${git.reason}`;
      logLine(`upload: ${report.skipped}`);
      await drainQueue(api, deadline, report);
      return report;
    }
  }

  // Only on a session's own hook: that is a repository the developer works in,
  // and `isy init` already asked them once whether isy may hook into it. The
  // flag, not stdin, says so: a Codex hook installed before the payload went
  // over fd 3 still runs with stdin on /dev/null.
  if (options.hook) {
    try {
      const outcome = await autoInstallGitHook(workingDir);
      if (outcome === "installed" || outcome === "shared-hooks") {
        report.gitHook = outcome;
        logLine(`upload: git hooks ${outcome} in ${workingDir}`);
      }
    } catch (error) {
      logError(`upload: git hooks not installed in ${workingDir}: ${String(error)}`);
    }
  }

  // Sessions whose directory is no repository. Counted for one line at the end
  // rather than one line each, for the same reason as the rootless ones above:
  // a directory that is not a repository today is skipped at every sweep, and
  // could be `git init`ed tomorrow.
  let outside = 0;

  for (const target of targets) {
    // The budget covers the whole run, queue included: a directory holding a
    // dozen stale sessions must not turn one commit into a minute of network.
    if (Date.now() >= deadline) {
      logLine(`upload: out of budget with ${targets.length - report.sent} session(s) left`);
      break;
    }
    // One "throttled" answers for every session in the run.
    if (report.throttled) break;

    const git = await gitFor(target.cwd ?? workingDir);
    if (!git.ok) {
      outside += 1;
      continue;
    }

    await sendOne(
      target,
      git.metadata,
      state,
      config,
      api,
      workingDir,
      // Per target, not per run: a run covers many sessions, and one fallback
      // shared between them would file them all under the same id — which the
      // server keys on, so each would replace the last.
      target.file?.sessionId ?? hook?.session_id ?? "unknown",
      report,
    );
  }

  if (outside > 0) logLine(`upload: ${outside} changed session(s) ran outside a repository`);

  // "Nothing new to analyse" only when every session sent was already known.
  report.deduplicated = report.sent > 0 && report.fresh === 0;

  await drainQueue(api, deadline, report);
  return report;
}

export function formatUploadReport(report: UploadReport): string {
  if (report.skipped) {
    const nothing = `isy: nothing uploaded (${report.skipped})`;
    return report.updateNotice ? `${nothing}\nisy: ${report.updateNotice}` : nothing;
  }

  const parts: string[] = [];
  if (report.sent > 0) parts.push("session uploaded");
  if (report.throttled) parts.push("rate limited, the rest go out on the next run");
  if (report.queued > 0) parts.push("session queued for retry");
  if (report.drained > 0) parts.push(`${report.drained} queued session(s) sent`);
  if (report.abandoned > 0) parts.push(`${report.abandoned} session(s) given up on`);

  const line = parts.length > 0 ? `isy: ${parts.join(", ")}` : "isy: nothing to upload";
  // Its own line rather than another clause: this one is about the account, and
  // it is the only part of the summary the reader has to act on.
  const tail = [report.planNotice, report.updateNotice].filter((notice) => notice !== undefined);
  return [line, ...tail.map((notice) => `isy: ${notice}`)].join("\n");
}

// The client never sees the analysis itself: a job is created when a pull request
// webhook matches this session by commit SHA, which can be minutes later or
// never. The alert says what actually happened, not what we hope happens next.
export function formatUploadAlert(report: UploadReport): string | undefined {
  // An update notice is worth the line even when there was nothing to upload:
  // the end of a session is the moment the developer is not mid-thought.
  if (report.skipped) return report.updateNotice ? `ISY: ${report.updateNotice}` : undefined;

  const parts: string[] = [];
  if (report.sent > 0) {
    parts.push(
      report.deduplicated
        ? "session already uploaded, nothing new to analyse"
        : "session uploaded, analysis runs when it reaches a pull request",
    );
  }
  if (report.drained > 0) parts.push(`${report.drained} queued session(s) sent`);
  if (report.queued > 0) parts.push("upload failed, queued for retry");
  if (report.throttled) parts.push("rate limited, the rest upload on the next run");
  if (report.abandoned > 0) parts.push(`${report.abandoned} session(s) given up on`);
  if (report.gitHook === "installed") parts.push("commit and push hooks added to this repository");
  if (report.gitHook === "shared-hooks") {
    parts.push("no git hooks here: they live in a shared directory, run isy init to add them");
  }
  if (report.planNotice) parts.push(report.planNotice);
  if (report.updateNotice) parts.push(report.updateNotice);

  return parts.length > 0 ? `ISY: ${parts.join(" · ")}` : undefined;
}

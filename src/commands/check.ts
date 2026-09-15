import { detectAgent, presentAgents } from "../agents/index.js";
import type { AgentId } from "../agents/index.js";
import { DEFAULT_API_BASE_URL, verifyToken } from "../api.js";
import { readConfig } from "../config.js";
import { gitHookInstalled, gitHooksDir } from "../githook.js";
import { unresolvedErrors } from "../log.js";
import { packageVersion } from "../paths.js";
import { countQueue } from "../queue.js";
import { updateNotice } from "../update.js";
import { planNotice } from "../plan.js";

export const PING_TIMEOUT_MS = 3_000;

export interface AgentStatus {
  id: AgentId;
  label: string;
  missingHooks: string[];
}

export interface CheckReport {
  ok: boolean;
  configured: boolean;
  version: string;
  githubLogin?: string;
  apiBaseUrl: string;
  /** Agents installed on this machine. An absent CLI is not a problem to report. */
  agents: AgentStatus[];
  /** Flattened for display, labelled once more than one agent is installed. */
  missingHooks: string[];
  /**
   * The per-repository post-commit hook. Undefined when the caller gave no
   * working directory to look in, which is not the same as it being absent.
   */
  gitHook?: "installed" | "missing" | "not-a-repository";
  queue: { pending: number; failed: number };
  /**
   * Failures of unattended work that no later upload has answered for. The one
   * signal here that `isy health` owns: it is what turns the launch line into a
   * nudge, and the only way a background failure ever reaches the user.
   */
  journalErrors: number;
  lastUploadAt?: string;
  /** Set when the last upload heard the server expects a newer client. */
  update?: string;
  /** Set when the plan is spent: uploads still land, analyses do not run. */
  plan?: string;
  api?: string;
  action?: string;
}

export function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";

  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / (60 * 24))}d ago`;
}

export async function collectCheck(
  options: { ping?: boolean; cwd?: string } = {},
): Promise<CheckReport> {
  const [version, config, queue, installed] = await Promise.all([
    packageVersion(),
    readConfig(),
    countQueue(),
    presentAgents(),
  ]);

  const update = updateNotice(config.latestVersion, version);

  const apiBaseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;

  const agents: AgentStatus[] = [];
  for (const agent of installed) {
    const present = await agent.hooksInstalled();
    agents.push({
      id: agent.id,
      label: agent.label,
      missingHooks: agent.hooks().map((hook) => hook.event).filter((event) => !present.includes(event)),
    });
  }

  // With one CLI installed the event name alone is unambiguous; with two it is not.
  const missingHooks = agents.flatMap((entry) =>
    entry.missingHooks.map((event) => (agents.length > 1 ? `${entry.label} ${event}` : event)),
  );

  // Only in a repository: outside one there is no hook to be missing, and
  // nagging about it every time isy runs elsewhere would be noise.
  let gitHook: CheckReport["gitHook"];
  if (options.cwd !== undefined) {
    if ((await gitHooksDir(options.cwd)) === undefined) gitHook = "not-a-repository";
    else gitHook = (await gitHookInstalled(options.cwd)) ? "installed" : "missing";
  }

  const token = typeof config.token === "string" && config.token.length > 0 ? config.token : undefined;

  const plan = planNotice(config.plan);

  const report: CheckReport = {
    ok: false,
    configured: token !== undefined,
    version,
    githubLogin: config.githubLogin,
    apiBaseUrl,
    agents,
    missingHooks,
    ...(gitHook ? { gitHook } : {}),
    queue,
    journalErrors: unresolvedErrors(config.lastUploadAt).length,
    lastUploadAt: config.lastUploadAt,
    ...(update ? { update } : {}),
    ...(plan ? { plan } : {}),
  };

  if (!token) {
    report.action = "run: isy init";
    return report;
  }

  if (options.ping) {
    const verified = await verifyToken({
      baseUrl: apiBaseUrl,
      token,
      timeoutMs: PING_TIMEOUT_MS,
    });
    report.api = verified.ok ? "ok" : verified.error;
    if (verified.ok && verified.githubLogin) report.githubLogin = verified.githubLogin;
  }

  const incomplete = missingHooks.length > 0 || gitHook === "missing";
  if (incomplete) report.action = "run: isy init";
  else if (report.journalErrors > 0) report.action = "run: isy health";
  report.ok =
    !incomplete &&
    report.journalErrors === 0 &&
    (report.api === undefined || report.api === "ok");

  return report;
}

export function series(items: readonly string[], conjunction = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** "SessionStart hook missing", or per CLI once more than one is installed. */
function missingDescription(report: CheckReport): string | undefined {
  const incomplete = report.agents.filter((agent) => agent.missingHooks.length > 0);

  const labelled = report.agents.length > 1;
  const parts = incomplete.map((agent) => {
    const noun = agent.missingHooks.length > 1 ? "hooks" : "hook";
    const events = series(agent.missingHooks);
    return labelled ? `${agent.label} ${events} ${noun} missing` : `${events} ${noun} missing`;
  });

  // Reported separately from the CLI hooks: they live in the repository, not in
  // any one agent's config, and they are the piece that starts the whole loop.
  if (report.gitHook === "missing") parts.push("git hooks missing");

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function formatCheck(report: CheckReport, now: number): string {
  if (!report.configured) {
    return `ISY ${report.version} is not configured — run: isy init`;
  }

  const parts: string[] = [report.ok ? `ISY ${report.version} active` : `ISY ${report.version}`];
  if (report.githubLogin) parts.push(report.githubLogin);
  if (report.plan) parts.push(report.plan);

  parts.push(missingDescription(report) ?? "hooks ok");

  if (report.api) parts.push(report.api === "ok" ? "api ok" : `api unreachable (${report.api})`);
  parts.push(`last upload ${relativeTime(report.lastUploadAt, now)}`);

  if (report.queue.pending > 0) parts.push(`${report.queue.pending} queued`);
  if (report.queue.failed > 0) parts.push(`${report.queue.failed} gave up`);
  if (report.journalErrors > 0) {
    const n = report.journalErrors;
    parts.push(`${n} background failure${n === 1 ? "" : "s"} since the last upload`);
  }
  if (report.update) parts.push(report.update);
  if (report.action) parts.push(report.action);

  return parts.join(" · ");
}

export async function runCheck(
  options: {
    json?: boolean;
    hook?: boolean;
    ping?: boolean;
    agent?: string;
    /** Starts a detached sweep of what changed on this machine; the CLI passes one, tests a stub. */
    catchUp?: () => unknown;
  },
): Promise<void> {
  if (!options.hook) {
    const report = await collectCheck({ ping: options.ping, cwd: process.cwd() });
    console.log(options.json ? JSON.stringify(report, null, 2) : formatCheck(report, Date.now()));
    return;
  }

  // A SessionStart hook must never delay or break the session it announces:
  // no network, and any failure means silence rather than a broken launch.
  try {
    // Deliberately without `cwd`: the post-commit hook is per repository and
    // only an accelerator — SessionEnd still uploads without it. Nagging about
    // it at the start of every session in every repo would be noise, so it is
    // reported by `isy check` and `isy status`, where the user asked.
    const report = await collectCheck();
    // Each CLI shows a line its own way: Claude and Codex render systemMessage
    // from stdout, Kimi discards it and needs the terminal written to directly.
    // Delivered before the sweep is started, so the backlog it drains is the one
    // that was already there rather than a line raised a moment ago.
    await detectAgent(undefined, options.agent).deliver(formatCheck(report, Date.now()), "SessionStart");

    // The start of a session is the end of the last one — the only such moment
    // a desktop app gives us, where a CLI would have fired SessionEnd. A killed
    // session never runs SessionEnd either (Codex skips it on any signal), so
    // its tail sits unsent until a commit, if one comes. Detached and
    // stat-cheap: a machine whose transcripts have not changed costs one `stat`
    // per session and no network at all.
    //
    // Not gated on the directory the way the per-repository catch-up was: the
    // sweep reads each transcript's own cwd, so where this session was launched
    // from says nothing about what there is to send.
    if (options.catchUp && report.configured) options.catchUp();
  } catch {
    return;
  }
}

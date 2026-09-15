import { presentAgents } from "../agents/index.js";
import { series } from "./check.js";
import type { AgentId } from "../agents/index.js";
import { DEFAULT_API_BASE_URL } from "../api.js";
import { readConfig } from "../config.js";
import { gitHookInstalled, gitHooksDir } from "../githook.js";
import { packageVersion, projectSlug } from "../paths.js";
import { countQueue } from "../queue.js";
import { updateNotice } from "../update.js";
import { planNotice } from "../plan.js";

interface QueueCounts {
  pending: number;
  failed: number;
}

interface LatestSessionReport {
  agent: AgentId;
  sessionId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  records: number;
  assistantRecords: number;
  sidechainRecords: number;
  toolUses: number;
  editedFiles: number;
  thinkingBlocks: number;
  malformedLines: number;
  unknownTypes: Record<string, number>;
}

export interface AgentSessions {
  id: AgentId;
  label: string;
  transcriptDir: string;
  sessions: number;
  latest?: LatestSessionReport;
}

export interface StatusReport {
  version: string;
  tokenConfigured: boolean;
  githubLogin?: string;
  apiBaseUrl: string;
  lastUploadAt?: string;
  /** Set when the last upload heard the server expects a newer client. */
  update?: string;
  /** Plan and allowance as of the last upload; the notice is set only when it is spent. */
  plan?: { tier: string; analysesLeft: number; credits: number; notice?: string };
  queue: QueueCounts;
  project: {
    cwd: string;
    slug: string;
    /** Across every CLI installed here. */
    sessions: number;
    /** The per-repository git hooks that start the fast loop. */
    gitHook: "installed" | "missing" | "not-a-repository";
  };
  agents: AgentSessions[];
  /** The newest session for this directory, whichever CLI produced it. */
  latestSession?: LatestSessionReport;
}

export async function collectStatus(cwd: string): Promise<StatusReport> {
  const [version, config, queue, installed] = await Promise.all([
    packageVersion(),
    readConfig(),
    countQueue(),
    presentAgents(),
  ]);

  const agents: AgentSessions[] = [];
  for (const agent of installed) {
    const sessions = await agent.sessionsIn(cwd);
    const entry: AgentSessions = {
      id: agent.id,
      label: agent.label,
      transcriptDir: agent.transcriptDir(cwd),
      sessions: sessions.length,
    };

    const latest = sessions[0];
    if (latest) {
      const parsed = await agent.parsedSession(latest.path, cwd);
      entry.latest = {
        agent: agent.id,
        sessionId: parsed.sessionId ?? latest.sessionId,
        path: latest.path,
        sizeBytes: latest.sizeBytes,
        modifiedAt: latest.modifiedAt.toISOString(),
        records: parsed.records.length,
        assistantRecords: parsed.meta.assistantRecords,
        sidechainRecords: parsed.meta.sidechainRecords,
        toolUses: parsed.toolUses.length,
        editedFiles: parsed.fileEdits.size,
        thinkingBlocks: parsed.meta.thinkingBlocks,
        malformedLines: parsed.skipped.malformedJson + parsed.skipped.notAnObject,
        unknownTypes: parsed.skipped.unknownTypes,
      };
    }

    agents.push(entry);
  }

  const update = updateNotice(config.latestVersion, version)
  const plan = config.plan
    ? {
        tier: config.plan.tier,
        analysesLeft: config.plan.analysesLeft,
        credits: config.plan.credits,
        ...(planNotice(config.plan) ? { notice: planNotice(config.plan)! } : {}),
      }
    : undefined;

  const gitHook: StatusReport["project"]["gitHook"] =
    (await gitHooksDir(cwd)) === undefined
      ? "not-a-repository"
      : (await gitHookInstalled(cwd))
        ? "installed"
        : "missing";

  const newest = agents
    .map((entry) => entry.latest)
    .filter((latest) => latest !== undefined)
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))[0];

  return {
    version,
    tokenConfigured: typeof config.token === "string" && config.token.length > 0,
    githubLogin: config.githubLogin,
    apiBaseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL,
    lastUploadAt: config.lastUploadAt,
    ...(update ? { update } : {}),
    ...(plan ? { plan } : {}),
    queue,
    project: {
      cwd,
      slug: projectSlug(cwd),
      sessions: agents.reduce((total, entry) => total + entry.sessions, 0),
      gitHook,
    },
    agents,
    latestSession: newest,
  };
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(14)}${value}`;
}

export function formatStatus(report: StatusReport): string {
  const lines: string[] = [`isy ${report.version}`, ""];
  if (report.plan?.notice) lines.push(`  ${report.plan.notice}`, "");
  if (report.update) lines.push(`  ${report.update}`, "");

  lines.push(
    row(
      "token",
      report.tokenConfigured
        ? `configured${report.githubLogin ? ` (${report.githubLogin})` : ""}`
        : "not configured, run: isy init",
    ),
  );
  lines.push(row("api", report.apiBaseUrl));
  lines.push(row("queue", `${report.queue.pending} pending, ${report.queue.failed} failed`));
  lines.push(row("last upload", report.lastUploadAt ?? "never"));
  if (report.plan) {
    const credits = report.plan.credits > 0 ? `, ${report.plan.credits} credit(s)` : "";
    lines.push(row("plan", `${report.plan.tier} — ${report.plan.analysesLeft} analyses left${credits}`));
  }
  lines.push("");
  lines.push(row("project", report.project.cwd));
  if (report.project.gitHook !== "not-a-repository") {
    lines.push(
      row(
        "git hooks",
        report.project.gitHook === "installed"
          ? "installed"
          : "missing — run isy init here to analyse on every commit and push",
      ),
    );
  }

  // One block per CLI installed here, so it is obvious which one a session
  // came from and where to go looking when the count is zero.
  for (const agent of report.agents) {
    lines.push("");
    lines.push(row(agent.label, `${agent.sessions} session(s)`));
    lines.push(row("", agent.transcriptDir));
  }

  const latest = report.latestSession;
  if (!latest) {
    lines.push("");
    lines.push(
      report.agents.length === 0
        ? "  no supported CLI found. Looked for Claude Code, Kimi CLI and Codex CLI."
        : `  no ${series(report.agents.map((agent) => agent.label), "or")} sessions recorded for this directory`,
    );
    return lines.join("\n");
  }

  const source = report.agents.find((agent) => agent.id === latest.agent)?.label ?? latest.agent;

  const unknown = Object.entries(latest.unknownTypes)
    .map(([type, count]) => `${type}(${count})`)
    .join(", ");

  lines.push("");
  lines.push(row("latest", `${latest.sessionId} (${source})`));
  lines.push(row("size", `${humanSize(latest.sizeBytes)}, ${latest.modifiedAt}`));
  lines.push(
    row(
      "records",
      `${latest.records} (${latest.assistantRecords} assistant, ${latest.sidechainRecords} sidechain)`,
    ),
  );
  lines.push(row("tools", `${latest.toolUses} calls, ${latest.editedFiles} files edited`));
  lines.push(row("thinking", `${latest.thinkingBlocks} blocks`));
  lines.push(row("unparsed", latest.malformedLines === 0 ? "none" : `${latest.malformedLines} lines`));
  if (unknown) lines.push(row("unknown types", unknown));

  return lines.join("\n");
}

export async function runStatus(options: { json?: boolean }, cwd: string): Promise<void> {
  const report = await collectStatus(cwd);
  console.log(options.json ? JSON.stringify(report, null, 2) : formatStatus(report));
}

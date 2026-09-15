import { readdir, readFile } from "node:fs/promises";
import { presentAgents } from "../agents/index.js";
import { readConfig } from "../config.js";
import { errorMessage, readJournal, unresolvedErrors } from "../log.js";
import type { JournalEntry } from "../log.js";
import { configPath, isyHome, logPath, packageVersion, queueDir, sessionStatePath } from "../paths.js";
import { listFailed } from "../queue.js";
import { collectCheck, formatCheck } from "./check.js";
import { collectScan, formatScan } from "./scan.js";
import type { CheckReport } from "./check.js";

/** Journal lines carried into the work order: the ones before a failure tell the story. */
const JOURNAL_CONTEXT = 30;

/**
 * One thing that is wrong, described as evidence rather than as a diagnosis.
 * ISY deliberately does not say what caused it: a fixed table of causes only
 * ever covers failures someone already saw, and reads as authoritative when it
 * is wrong. Naming the cause is the repairing agent's job.
 */
export interface HealthProblem {
  id: string;
  /** What ISY observed, in the past tense. Never "you should", never a cause. */
  summary: string;
  /** The operation that was running. */
  attempted: string;
  /** The failure verbatim, never reworded — the exact text is the evidence. */
  evidence: string;
  /** What ISY could not determine, so the agent knows where to start. */
  unknown: string;
  files: string[];
}

export interface HealthReport {
  ok: boolean;
  version: string;
  problems: HealthProblem[];
  /** Checks that passed, so a repairing agent does not spend turns re-running them. */
  verified: string[];
  /** Recent journal lines, both levels: an error is rarely legible on its own. */
  journal: JournalEntry[];
  /** Undefined when the configuration check itself threw. */
  check?: CheckReport;
}

async function configProblems(verified: string[]): Promise<HealthProblem[]> {
  try {
    const config = await readConfig();
    if (config.token) verified.push(`the config at ${configPath()} parses and holds a token`);
    return [];
  } catch (error) {
    return [
      {
        id: "config-unreadable",
        summary: "the config file could not be read",
        attempted: `read and parse ${configPath()}`,
        evidence: errorMessage(error),
        unknown: "what left the file in this state",
        files: [configPath()],
      },
    ];
  }
}

function checkProblems(check: CheckReport, verified: string[]): HealthProblem[] {
  const problems: HealthProblem[] = [];

  if (!check.configured) {
    problems.push({
      id: "not-configured",
      summary: "no API token is stored, so nothing is ever uploaded",
      attempted: "read the token from the config",
      evidence: `no "token" field in ${configPath()}`,
      unknown: "whether the user ever ran isy init on this machine",
      files: [configPath()],
    });
  }

  if (check.missingHooks.length > 0) {
    problems.push({
      id: "hooks-missing",
      summary: `${check.missingHooks.join(", ")} not installed, so sessions are never collected`,
      attempted: "list the hooks each installed CLI has registered for isy",
      evidence: `installed: ${check.agents
        .map((agent) => `${agent.label} missing ${agent.missingHooks.join(", ") || "nothing"}`)
        .join("; ")}`,
      unknown: "whether the hook was never written or was removed later",
      files: [isyHome()],
    });
  } else if (check.agents.length > 0) {
    verified.push(`hooks are installed for ${check.agents.map((agent) => agent.label).join(", ")}`);
  }

  if (check.gitHook === "missing") {
    problems.push({
      id: "git-hook-missing",
      summary: "this repository is missing an isy git hook, so commits or pushes do not trigger an upload",
      attempted: "look for the isy block in the repository's post-commit and pre-push hooks",
      evidence: "the managed block between '# isy:begin' and '# isy:end' is absent",
      unknown: "whether another tool rewrote the hook file",
      files: [],
    });
  } else if (check.gitHook === "installed") {
    verified.push("the repository's post-commit and pre-push hooks carry the isy block");
  }

  if (check.api !== undefined && check.api !== "ok") {
    problems.push({
      id: "api-unreachable",
      summary: `the server did not accept the token at ${check.apiBaseUrl}`,
      attempted: `GET ${check.apiBaseUrl}/api/v1/me with the stored token`,
      evidence: check.api,
      unknown: "whether the token, the URL, or the network is at fault",
      files: [configPath()],
    });
  } else if (check.api === "ok") {
    verified.push(`the server at ${check.apiBaseUrl} answered and accepted the token`);
  }

  return problems;
}

/**
 * The transcript directory is read on every upload, and `sessionsIn` reports an
 * unreadable directory the same way it reports an empty one. Health reads it
 * directly so the difference survives. A directory that does not exist yet is
 * normal: no session has run in this repository.
 */
async function agentProblems(cwd: string, verified: string[]): Promise<HealthProblem[]> {
  const problems: HealthProblem[] = [];

  for (const agent of await presentAgents()) {
    const dir = agent.transcriptDir(cwd);
    try {
      await readdir(dir);
      verified.push(`${agent.label}'s transcript directory ${dir} is readable`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      problems.push({
        id: `transcripts-unreadable-${agent.id}`,
        summary: `${agent.label}'s transcripts could not be listed, so its sessions are invisible`,
        attempted: `list ${dir}`,
        evidence: errorMessage(error),
        unknown: "why the directory cannot be read",
        files: [dir],
      });
    }
  }

  return problems;
}

async function stateProblems(verified: string[]): Promise<HealthProblem[]> {
  const path = sessionStatePath();

  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    // Nothing uploaded yet on this machine, which is not a fault.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [
      {
        id: "state-unreadable",
        summary: "the upload cache could not be read, so every session looks unsent",
        attempted: `read ${path}`,
        evidence: errorMessage(error),
        unknown: "why the file cannot be read",
        files: [path],
      },
    ];
  }

  try {
    JSON.parse(contents);
    verified.push(`the upload cache at ${path} parses`);
    return [];
  } catch (error) {
    return [
      {
        id: "state-corrupt",
        summary: "the upload cache is not valid JSON, so every session looks unsent",
        attempted: `parse ${path}`,
        evidence: errorMessage(error),
        unknown: "what interrupted the write that left it this way",
        files: [path],
      },
    ];
  }
}

/** Uploads that used up all three attempts. Their stored `lastError` is the evidence. */
async function queueProblems(): Promise<HealthProblem[]> {
  const failed = await listFailed();
  if (failed.length === 0) return [];

  return [
    {
      id: "uploads-abandoned",
      summary: `${failed.length} session${failed.length === 1 ? "" : "s"} never reached the server`,
      attempted: "POST /api/v1/sessions for each queued session, three times",
      evidence: failed
        .map((item) => `${item.entry.sessionId}: ${item.entry.lastError ?? "no error recorded"}`)
        .join("\n"),
      unknown: "whether the cause was the payload, the token or the network",
      files: [queueDir()],
    },
  ];
}

/**
 * Failures nothing else here explains. This is the part that must not be a
 * lookup table: an error ISY has never seen still lands in the work order with
 * its text intact, and the agent reads it rather than a category ISY guessed.
 */
function journalProblems(
  entries: readonly JournalEntry[],
  lastUploadAt: string | undefined,
  explained: readonly HealthProblem[],
): HealthProblem[] {
  const unresolved = unresolvedErrors(lastUploadAt, [...entries]);
  if (unresolved.length === 0) return [];

  // The structural checks above already carry their own evidence; a journal
  // entry is worth reporting on its own only when nothing else accounts for it.
  if (explained.length > 0) return [];

  return [
    {
      id: "journal-errors",
      summary: `${unresolved.length} unattended failure${
        unresolved.length === 1 ? "" : "s"
      } recorded since the last successful upload, with everything else looking correct`,
      attempted: unresolved[unresolved.length - 1]?.operation
        ? `run isy ${unresolved[unresolved.length - 1]!.operation!}`
        : "run isy in the background",
      evidence: unresolved.map((entry) => `${entry.at} ${entry.message}`).join("\n"),
      unknown:
        "everything: the configuration, the server and the file system all check out, so the cause is not in the places isy knows to look",
      files: [logPath()],
    },
  ];
}

export async function collectHealth(cwd: string): Promise<HealthReport> {
  const version = await packageVersion();
  const verified: string[] = [];
  const problems: HealthProblem[] = [];

  problems.push(...(await configProblems(verified)));

  let check: CheckReport | undefined;
  try {
    check = await collectCheck({ ping: true, cwd });
    problems.push(...checkProblems(check, verified));
  } catch (error) {
    // A diagnostic that dies on a broken system is useless exactly when needed.
    problems.push({
      id: "check-threw",
      summary: "the configuration check itself threw before it could finish",
      attempted: "collect the report that `isy check` prints",
      evidence: errorMessage(error),
      unknown: "which of the checks threw",
      files: [isyHome()],
    });
  }

  problems.push(...(await agentProblems(cwd, verified)));
  problems.push(...(await stateProblems(verified)));
  problems.push(...(await queueProblems()));

  const journal = readJournal(JOURNAL_CONTEXT);
  const config = check ? { lastUploadAt: check.lastUploadAt } : {};
  problems.push(...journalProblems(journal, config.lastUploadAt, problems));

  return { ok: problems.length === 0, version, problems, verified, journal, check };
}

export function formatHealth(report: HealthReport, now: number): string {
  if (report.ok && report.check) return formatCheck(report.check, now);
  if (report.ok) return `ISY ${report.version} healthy`;

  const count = report.problems.length;
  const lines = [`ISY ${report.version} · ${count} problem${count === 1 ? "" : "s"}`, ""];

  report.problems.forEach((problem, index) => {
    lines.push(`${index + 1}. ${problem.summary}`);
    lines.push(`   tried  ${problem.attempted}`);
    for (const line of problem.evidence.split("\n")) lines.push(`   got    ${line}`);
    lines.push("");
  });

  lines.push("run: isy health --fix   — writes a work order for your coding agent");
  return lines.join("\n");
}

/**
 * The prompt handed to a coding agent. It states what was tried, what happened
 * and what has already been ruled out, then stops: no suggested cause, no
 * suggested patch. The agent has the whole repository and can read further; a
 * cause invented here would only anchor it on ISY's guess.
 */
export function formatWorkOrder(report: HealthReport, cwd: string): string {
  const sections: string[] = [
    "# ISY self-repair work order",
    "",
    "ISY is a CLI that collects coding-agent session transcripts and uploads them to a",
    "server, which analyses them and comments on the matching pull request. It has just",
    "failed its own health check. Find the cause and fix it.",
    "",
    "## Environment",
    "",
    "```",
    `isy       ${report.version}`,
    `node      ${process.version} on ${process.platform}`,
    `cwd       ${cwd}`,
    `home      ${isyHome()}`,
    `config    ${configPath()}`,
    `journal   ${logPath()}`,
    "```",
    "",
    "## What is broken",
    "",
  ];

  report.problems.forEach((problem, index) => {
    sections.push(`### ${index + 1}. ${problem.summary}`);
    sections.push("");
    sections.push(`- **Operation:** ${problem.attempted}`);
    sections.push("- **Result, verbatim:**");
    sections.push("");
    sections.push("```");
    sections.push(problem.evidence);
    sections.push("```");
    sections.push("");
    sections.push(`- **Not determined:** ${problem.unknown}`);
    if (problem.files.length > 0) {
      sections.push(`- **Paths involved:** ${problem.files.join(", ")}`);
    }
    sections.push("");
  });

  if (report.verified.length > 0) {
    sections.push("## Already verified — do not spend turns re-checking these");
    sections.push("");
    for (const item of report.verified) sections.push(`- ${item}`);
    sections.push("");
  }

  if (report.journal.length > 0) {
    sections.push(`## Journal, last ${report.journal.length} entries`);
    sections.push("");
    sections.push("```");
    for (const entry of report.journal) {
      sections.push(`${entry.at} ${entry.level} ${entry.message}`);
    }
    sections.push("```");
    sections.push("");
  }

  sections.push(
    "## How to work this",
    "",
    "1. The headings above are what ISY observed, not a diagnosis. ISY does not know the",
    "   cause — if it did, it would have fixed it. Read the verbatim output and the",
    "   journal and work out the cause yourself; do not take a heading as the answer.",
    "2. Reproduce before you change anything. `isy health --json` prints the same state",
    "   in machine-readable form.",
    "3. Change the smallest thing that makes the check pass. Never make a check pass by",
    "   disabling, skipping or loosening the check itself.",
    "4. If the cause is the user's environment rather than ISY's code — a revoked token,",
    "   a permission, a missing directory — say so and stop. Do not edit ISY's source to",
    "   work around a broken machine.",
    "",
    "## Done when",
    "",
    "`isy health` exits 0. Run it and show the output.",
  );

  return sections.join("\n");
}

/**
 * Both go to stderr, never to stdout: stdout is the prompt itself, and a line
 * telling the reader to paste it somewhere would be nonsense inside the prompt.
 * Shown only on a terminal — a pipe means the user already knows where it goes.
 *
 * Printed at both ends because the work order is long: a banner only at the top
 * scrolls away, and one only at the bottom is read after the user has already
 * started reading a prompt that was never addressed to them.
 */
const RULE = "  " + "\u2550".repeat(72);

export const FIX_BANNER = [
  "",
  RULE,
  "   \u26a0  THIS IS A PROMPT FOR AN AI AGENT \u2014 NOT A REPORT FOR YOU TO READ.",
  "",
  "      COPY EVERYTHING BELOW AND PASTE IT INTO YOUR CODING AGENT",
  "      (Claude Code, Kimi CLI, Codex \u2014 whichever you use). IT WILL FIX ISY.",
  "",
  "      Or hand it over directly:  isy health --fix | claude -p",
  RULE,
  "",
].join("\n");

export const FIX_REMINDER = [
  "",
  RULE,
  "   \u26a0  EVERYTHING ABOVE IS THE PROMPT. PASTE IT INTO YOUR CODING AGENT.",
  RULE,
  "",
].join("\n");

export async function runHealth(
  options: { json?: boolean; fix?: boolean; scan?: boolean },
  cwd: string,
): Promise<void> {
  // A scan is a different question from a health check: not "is this install
  // working" but "where does this machine keep its sessions at all". It reports
  // rather than judges, so it never sets an exit code.
  if (options.scan) {
    const scan = await collectScan();
    console.log(options.json ? JSON.stringify(scan, null, 2) : formatScan(scan));
    return;
  }

  const report = await collectHealth(cwd);

  // A work order for a healthy install would be a prompt to fix nothing.
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (options.fix && !report.ok) {
    if (process.stdout.isTTY) console.error(FIX_BANNER);
    console.log(formatWorkOrder(report, cwd));
    if (process.stdout.isTTY) console.error(FIX_REMINDER);
  } else {
    console.log(formatHealth(report, Date.now()));
  }

  // The exit code is the contract a repairing agent checks against.
  if (!report.ok) process.exitCode = 1;
}

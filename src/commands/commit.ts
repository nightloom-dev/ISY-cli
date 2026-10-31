import { basename, relative } from "node:path";
import { latestSessions } from "../agents/index.js";
import type { Agent, AgentId } from "../agents/index.js";
import { readConfig } from "../config.js";
import { branchExists, currentBranch, filesInHead, headSha, maskRootsFor } from "../git.js";
import { maskPath } from "../mask-paths.js";
import { gitCommands, mayWrite, parseLines, shellOnlyLooks, shellWrites } from "../parser.js";
import { spawnIsy } from "../spawn.js";
import { runStage0 } from "../stage0.js";
import { candidateKey, namedBranch, readState, unseen, updateSession, withCommit } from "../state.js";
import type { ClientState, SessionState } from "../state.js";
import type { Candidate, DiscoveredSession, ParsedSession, ToolUse } from "../types.js";

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
/** The longest Claude Code lets a shell call run, so how long one can read as running. */
const SHELL_CALL_MS = 10 * 60_000;
/**
 * What telling sessions apart may add to a hook someone is waiting on, at every
 * pick of a rebase. Time is checked between reads and only size before one, so
 * both: 16 MB of transcript takes about half a second to read as it is.
 */
const TELLING_APART_MS = 1_000;
const TELLING_APART_BYTES = 16 * 1024 * 1024;

/** The transcript holds a shell call before the command starts, and its answer only after. */
function isRunning(use: ToolUse): boolean {
  return (
    (use.name === "Bash" || use.name === "PowerShell") &&
    use.result === undefined &&
    Date.now() - Date.parse(use.timestamp ?? "") < SHELL_CALL_MS
  );
}

/** A call that wrote files without naming them the way an edit tool does. */
function writesUnnamed(use: ToolUse): boolean {
  const { command } = use.input;
  if (use.name === "Bash" && typeof command === "string" && shellWrites(command)) return true;
  return mayWrite(use.name, use.input);
}

/**
 * The words of a tool call's input that could be a file's name. By word, and
 * looked up rather than searched for, because a commit of thousands of files
 * against a long session is a search of minutes in a hook someone is waiting on.
 */
export function wordsOf(input: unknown): string[] {
  return JSON.stringify(input).split(/\\.|[\s/"'`$=:;,|&<>(){}[\]*?!#]+/);
}

/**
 * Whether HEAD holds what the session left uncommitted: an edit past its last
 * mark to a file HEAD changed, or a write it could not name that mentions one.
 *
 * ponytail: by file, not by line, and for the unnamed writes by base name, so a
 * commit that happens to touch such a file counts, and a script that writes files
 * it never mentions or a name with a space in it does not. Compare with
 * `FileEdit.newString` and read the redirect targets if either shows up.
 */
async function carriesItsWork(
  session: ParsedSession,
  state: SessionState,
  sessionCwd: string,
  cwd: string,
): Promise<boolean> {
  const since = state.commits?.at(-1)?.records ?? 0;
  const files = await filesInHead(cwd);
  const committed = new Set(files);
  // A transcript read as it is holds paths as the agent wrote them, and git names
  // a file from the top of the tree: the rule the upload rewrites them by.
  const roots = await maskRootsFor(sessionCwd);
  for (const [path, edits] of session.fileEdits) {
    if (edits.some((edit) => edit.recordIndex >= since) && committed.has(maskPath(path, roots))) return true;
  }

  const names = new Set(files.map((file) => basename(file)));
  return session.toolUses.some(
    (use) =>
      use.recordIndex >= since &&
      writesUnnamed(use) &&
      wordsOf(use.input).some((word) => names.has(word)),
  );
}

/** How an agent leaves for another branch itself. A rename is told by the old name being gone. */
const BRANCH_MOVERS = new Set(["switch", "checkout"]);

function movesBranch(use: ToolUse): boolean {
  const { command } = use.input;
  return typeof command === "string" && gitCommands(command).some((subcommand) => BRANCH_MOVERS.has(subcommand));
}

/** A call after which nobody can say what it left in the tree. */
function leavesUnknown(use: ToolUse): boolean {
  const { command } = use.input;
  if (use.name === "Bash" && typeof command === "string") return !shellOnlyLooks(command);
  return mayWrite(use.name, use.input);
}

/**
 * Whether a commit that does not show itself to be this session's can still be. A
 * commit is what moves a session to another pull request, so one that ended on
 * another branch must not take every commit made here afterwards. It is refused only
 * on evidence: the session stands on another branch, and since its last mark it has
 * done nothing but look and write files it named, which are not these.
 *
 * Its own branch is the one its row stands on (`SessionState.branch`) before the
 * one its transcript last named, which a resume that only read has moved. The
 * transcript wins when the row has fallen behind it: the agent left for that branch
 * itself, or the name in the row is on no branch any more. No branch known, as with
 * a session on a detached HEAD, is no reason to refuse.
 *
 * ponytail: a session that ran a build or `npm test` since its last mark takes an
 * unrelated commit on another branch, as it did before branches were looked at,
 * since a command line cannot say what those wrote. List such a runner in
 * `shellOnlyLooks` if one proves to move sessions to the wrong pull request.
 */
async function isItsCommit(
  session: ParsedSession,
  state: SessionState,
  branch: string | undefined,
  cwd: string,
): Promise<boolean> {
  const own = state.branch ?? session.meta.gitBranch;
  if (!branch || !own || own === "HEAD" || own === branch) return true;
  const since = state.commits?.at(-1)?.records ?? 0;
  const calls = session.toolUses.filter((use) => use.recordIndex >= since);
  if (calls.some(leavesUnknown)) return true;
  return session.meta.gitBranch === branch && (calls.some(movesBranch) || !(await branchExists(cwd, own)));
}

/** The git commands that fire the post-commit hook, each pick of a rebase included. */
const COMMIT_MAKERS = new Set(["commit", "rebase", "cherry-pick", "revert", "am", "pull"]);

/** A shell call still running whose command makes commits, so this one may have come out of it. */
function isCommitting(use: ToolUse): boolean {
  const { command } = use.input;
  if (typeof command !== "string" || !isRunning(use)) return false;
  return gitCommands(command).some((subcommand) => COMMIT_MAKERS.has(subcommand));
}

/**
 * The session a commit just made goes to, of the ones in the tree newest first.
 * The hook is not told who made it, and the newest is not always that one: an
 * agent waiting on its `git commit` writes nothing while another session goes on
 * writing. So one making a commit this moment comes first, then one whose work the
 * commit holds, as when a human commits what an agent left, and only then the newest
 * that can take it (`isItsCommit`).
 *
 * Read as they are, because a transcript's redaction costs five times its read and
 * only the session this ends on goes up. Past the first, one the budget does not
 * reach is left out rather than waited for.
 *
 * ponytail: left out by size, so a long session running `git commit` beside a
 * shorter one that goes on writing loses the commit to it, as it always did. Two
 * sessions running git at once go the same way, and so does a commit one of them is
 * making in another repository. Read the tail of a long one if that shows up.
 */
async function sessionOfCommit(
  latest: Awaited<ReturnType<typeof latestSessions>>,
  branch: string | undefined,
  cwd: string,
  states: ClientState,
): Promise<{ agent: Agent; file: DiscoveredSession } | { skipped: string }> {
  // Alone and on its own branch there is nothing to tell apart.
  const alone = latest.length === 1 && latest[0]!;
  if (alone && branch && states[alone.file.path]?.branch === branch) return alone;

  const deadline = Date.now() + TELLING_APART_MS;
  let bytes = 0;
  const read = [];
  for (const { agent, file } of latest) {
    if (read.length > 0) {
      if (Date.now() >= deadline) break;
      if (bytes + file.sizeBytes > TELLING_APART_BYTES) continue;
      bytes += file.sizeBytes;
    }
    let session: ParsedSession;
    try {
      session = await agent.parsedSession(file.path, file.cwd ?? cwd);
    } catch {
      // Listed a moment ago: gone since, or never this user's to read. One such
      // file says nothing about the commit, and the others are still there to ask.
      continue;
    }
    const entry = { agent, file, session };
    if (session.toolUses.some(isCommitting)) return entry;
    read.push(entry);
  }
  if (read.length === 0) return { skipped: "no session here could be read" };

  for (const entry of read) {
    if (await carriesItsWork(entry.session, states[entry.file.path] ?? {}, entry.file.cwd ?? cwd, cwd)) return entry;
  }
  for (const entry of read) {
    if (await isItsCommit(entry.session, states[entry.file.path] ?? {}, branch, cwd)) return entry;
  }
  return { skipped: "the sessions here are on another branch and this commit holds none of their work" };
}

export async function runCommit(
  options: { json?: boolean; noUpload?: boolean },
  cwd: string,
): Promise<CommitReport> {
  const report: CommitReport = { cwd, records: 0, candidates: [], uploaded: "not-attempted" };

  const latest = await latestSessions(cwd, SHELL_CALL_MS);
  if (latest.length === 0) {
    report.skipped = "no session recorded for this directory";
    return report;
  }

  report.sha = await headSha(cwd);

  const config = await readConfig();
  const states = await readState();
  const branch = await currentBranch(cwd);
  const chosen = await sessionOfCommit(latest, branch, cwd, states);
  if ("skipped" in chosen) {
    report.skipped = chosen.skipped;
    return report;
  }
  const { agent, file } = chosen;
  report.agent = agent.id;
  report.sessionId = file.sessionId;

  let session: ParsedSession;
  try {
    const lines = await agent.redactedLines(file.path, {
      extraPatterns: config.extraRedactPatterns,
      cwd: file.cwd ?? cwd,
    });
    session = parseLines(lines);
  } catch {
    report.skipped = "the session this commit goes to could not be read";
    return report;
  }
  report.records = session.records.length;
  const state = states[file.path] ?? {};

  // Stage 0 always sees the whole transcript: the detectors reason across the
  // session — an abandoned branch forks early, a revert compares a late edit
  // with an early one — so a window would cost exactly the signals worth having.
  const stage0 = runStage0(session);
  report.candidates = unseen(state, stage0.candidates);

  await updateSession(file.path, (current) => ({
    ...current,
    branch: namedBranch(branch, current.branch),
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

import { basename, relative } from "node:path";
import { latestSessions } from "../agents/index.js";
import type { AgentId } from "../agents/index.js";
import { readConfig } from "../config.js";
import { currentBranch, filesInHead, headSha } from "../git.js";
import { mayWrite, parseLines, shellWrites } from "../parser.js";
import { spawnIsy } from "../spawn.js";
import { runStage0 } from "../stage0.js";
import { candidateKey, namedBranch, readState, unseen, updateSession, withCommit } from "../state.js";
import type { ClientState, SessionState } from "../state.js";
import type { Candidate, ParsedSession, ToolUse } from "../types.js";

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
/** What telling sessions apart may add to a hook someone is waiting on, checked between them. */
const TELLING_APART_MS = 5_000;

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
  cwd: string,
): Promise<boolean> {
  const since = state.commits?.at(-1)?.records ?? 0;
  const files = await filesInHead(cwd);
  const edited = files.some((file) =>
    session.fileEdits.get(file)?.some((edit) => edit.recordIndex >= since),
  );
  if (edited) return true;

  const names = new Set(files.map((file) => basename(file)));
  return session.toolUses.some(
    (use) =>
      use.recordIndex >= since &&
      writesUnnamed(use) &&
      wordsOf(use.input).some((word) => names.has(word)),
  );
}

/**
 * Whether the commit just made belongs to this session. The hook only knows who
 * looks likeliest (`sessionOfCommit`), and a commit is what moves a session to
 * another pull request, so one that ended on another branch must not take every
 * commit made here afterwards. It belongs if the agent is making it this moment,
 * if it lands on the session's own branch, or, on any other, if it carries the
 * session's work: an agent that edited on main and a human who branched and
 * committed that.
 *
 * Its own branch is the one its row stands on (`SessionState.branch`) before the
 * one its transcript last named, which a resume that only read has moved. No
 * branch known, as with a session on a detached HEAD, is no reason to refuse.
 *
 * ponytail: only one session is asked, so a commit it refuses goes to no one, and
 * a session quiet for longer than `SHELL_CALL_MS` relies on the branch fallback on
 * the server. Walk on through `sessionsInTree` if one of them ever needs the mark.
 */
async function isItsCommit(
  session: ParsedSession,
  state: SessionState,
  branch: string | undefined,
  cwd: string,
): Promise<boolean> {
  if (session.toolUses.some(isRunning)) return true;
  const own = state.branch ?? session.meta.gitBranch;
  if (!branch || !own || own === "HEAD" || own === branch) return true;
  return carriesItsWork(session, state, cwd);
}

/** A shell call still running that could be the one this commit came out of. */
function mayBeCommitting(use: ToolUse): boolean {
  const { command } = use.input;
  if (typeof command !== "string" || !isRunning(use)) return false;
  return wordsOf(command).some((word) => word === "git" || word === "commit");
}

/**
 * The session a commit just made goes to, of the ones in the tree newest first.
 * The hook is not told who made it, and the newest is not always that one: an
 * agent waiting on its `git commit` writes nothing while another session goes on
 * writing. So one making a commit this moment comes first, then one whose work the
 * commit holds, as when a human commits what an agent left, and only then the newest.
 *
 * ponytail: the newest session's read, which runCommit needs anyway, is the only
 * one sure to happen. A long transcript takes seconds to read, so past
 * `TELLING_APART_MS` the rest are not asked and the newest of those read so far can
 * take a commit that was not its own. Two sessions running git at once go the same way.
 */
async function sessionOfCommit(
  latest: Awaited<ReturnType<typeof latestSessions>>,
  cwd: string,
  states: ClientState,
  extraPatterns: readonly string[] | undefined,
) {
  const deadline = Date.now() + TELLING_APART_MS;
  const read = [];
  for (const { agent, file } of latest) {
    if (read.length > 0 && Date.now() >= deadline) break;
    let session: ParsedSession;
    try {
      session = parseLines(await agent.redactedLines(file.path, { extraPatterns, cwd: file.cwd ?? cwd }));
    } catch {
      // Listed a moment ago: gone since, or never this user's to read. One such
      // file says nothing about the commit, and the others are still there to ask.
      continue;
    }
    const entry = { agent, file, session };
    if (session.toolUses.some(mayBeCommitting)) return entry;
    read.push(entry);
  }

  if (read.length > 1) {
    for (const entry of read) {
      if (await carriesItsWork(entry.session, states[entry.file.path] ?? {}, cwd)) return entry;
    }
  }
  return read[0];
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
  const chosen = await sessionOfCommit(latest, cwd, states, config.extraRedactPatterns);
  if (!chosen) {
    report.skipped = "no session here could be read";
    return report;
  }
  const { agent, file, session } = chosen;
  report.agent = agent.id;
  report.sessionId = file.sessionId;
  report.records = session.records.length;

  const state = states[file.path] ?? {};
  const branch = await currentBranch(cwd);
  if (!(await isItsCommit(session, state, branch, cwd))) {
    report.skipped = "the newest session here is on another branch and this commit holds none of its work";
    return report;
  }

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

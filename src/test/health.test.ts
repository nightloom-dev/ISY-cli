import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { FIX_BANNER, FIX_REMINDER, collectHealth, formatHealth, formatWorkOrder } from "../commands/health.js";
import type { HealthReport } from "../commands/health.js";
import { logError, logLine, readJournal, unresolvedErrors } from "../log.js";

const saved = {
  home: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  kimi: process.env.KIMI_HOME,
  codex: process.env.CODEX_HOME,
};

let home: string;
let claude: string;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-health-home-"));
  claude = await mkdtemp(join(tmpdir(), "isy-health-claude-"));
  process.env.ISY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claude;
  // Whether this machine has Kimi or Codex installed must not change assertions.
  process.env.KIMI_HOME = join(home, "no-kimi-here");
  process.env.CODEX_HOME = join(home, "no-codex-here");
});

after(() => {
  for (const [key, value] of Object.entries({
    ISY_HOME: saved.home,
    CLAUDE_CONFIG_DIR: saved.claude,
    KIMI_HOME: saved.kimi,
    CODEX_HOME: saved.codex,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({}));
  await writeFile(join(home, "isy.log"), "");
  await mkdir(join(home, "queue"), { recursive: true });
});

test("the journal keeps its level, and lines written before levels existed still parse", async () => {
  await writeFile(join(home, "isy.log"), "2026-08-01T00:00:00.000Z upload: an older format line\n");
  logLine("upload: nothing new to upload");
  logError("upload: dropped abc: fetch failed");

  const entries = readJournal();
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((entry) => entry.level),
    ["info", "info", "error"],
  );
  // The operation is what makes an entry attributable to a piece of the pipeline.
  assert.deepEqual(
    entries.map((entry) => entry.operation),
    ["upload", "upload", "upload"],
  );
  assert.equal(entries[2]!.message, "upload: dropped abc: fetch failed");
});

test("only unattended failures the last upload has not answered for count", () => {
  const at = (iso: string, level: "info" | "error", message: string) => ({
    at: iso,
    level,
    message,
    operation: message.slice(0, message.indexOf(":")),
  });

  const entries = [
    at("2026-08-01T00:00:00.000Z", "error", "upload: dropped abc: fetch failed"),
    at("2026-08-03T00:00:00.000Z", "error", "commit: could not spawn the upload: EACCES"),
    at("2026-08-03T00:00:00.000Z", "info", "upload: nothing new to upload"),
    // A command the user typed: its failure was already on their screen.
    at("2026-08-03T00:00:00.000Z", "error", "analyze: no such file"),
  ];

  const since = unresolvedErrors("2026-08-02T00:00:00.000Z", entries);
  assert.deepEqual(
    since.map((entry) => entry.operation),
    ["commit"],
  );

  // Nothing ever uploaded: every unattended failure is still open.
  assert.equal(unresolvedErrors(undefined, entries).length, 2);
  // A later success closes them all.
  assert.equal(unresolvedErrors("2026-09-01T00:00:00.000Z", entries).length, 0);
});

test("a corrupt upload cache is reported with the parser's own words", async () => {
  await writeFile(join(home, "sessions.json"), "{not json");

  const report = await collectHealth(process.cwd());
  const problem = report.problems.find((entry) => entry.id === "state-corrupt");

  assert.ok(problem, "the corrupt cache was not reported");
  assert.equal(report.ok, false);
  assert.match(problem.attempted, /sessions\.json$/);
  // The evidence is the thrown message verbatim, never a rewording of it.
  assert.match(problem.evidence, /JSON/i);
});

test("an unreadable journal entry nobody explains becomes a problem of its own", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ token: "t", githubLogin: "me" }));
  logError("upload: dropped abc: something nobody has ever seen");

  const report = await collectHealth(process.cwd());
  const problem = report.problems.find((entry) => entry.id === "journal-errors");

  // Structural checks fail here too (no hooks in a temp home), and those carry
  // their own evidence — the journal is only its own problem when nothing else
  // accounts for it.
  const explained = report.problems.some((entry) => entry.id !== "journal-errors");
  assert.equal(problem !== undefined, !explained);
});

test("the work order hands over evidence, not a diagnosis", () => {
  const report: HealthReport = {
    ok: false,
    version: "0.1.0",
    problems: [
      {
        id: "transcripts-unreadable-claude",
        summary: "Claude Code's transcripts could not be listed",
        attempted: "list /home/x/.claude/projects/-home-x-p",
        evidence: "EACCES: permission denied, scandir '/home/x/.claude/projects/-home-x-p'",
        unknown: "why the directory cannot be read",
        files: ["/home/x/.claude/projects/-home-x-p"],
      },
    ],
    verified: ["the server answered and accepted the token"],
    journal: [{ at: "2026-08-22T10:00:00.000Z", level: "error", message: "upload: EACCES" }],
  };

  const order = formatWorkOrder(report, "/home/x/p");

  assert.match(order, /EACCES: permission denied, scandir/);
  assert.match(order, /Already verified — do not spend turns re-checking/);
  assert.match(order, /not a diagnosis/);
  assert.match(order, /`isy health` exits 0/);
  // Never make a check pass by weakening the check: the one rule that keeps a
  // repairing agent from "fixing" health by deleting the failing assertion.
  assert.match(order, /disabling, skipping or loosening/);
});

test("a healthy report prints one line and never a work order", () => {
  const healthy: HealthReport = {
    ok: true,
    version: "0.1.0",
    problems: [],
    verified: [],
    journal: [],
  };
  assert.equal(formatHealth(healthy, Date.now()), "ISY 0.1.0 healthy");
});

test("the paste instruction stays out of the prompt it describes", () => {
  assert.match(FIX_BANNER, /PASTE IT INTO YOUR CODING AGENT/);
  // Both ends: a long work order scrolls the leading banner off the screen.
  assert.match(FIX_REMINDER, /PASTE IT INTO YOUR CODING AGENT/);

  // It goes to stderr, so a pipe carries only the prompt. A line telling the
  // reader to paste this somewhere would be nonsense inside the prompt itself.
  const report: HealthReport = {
    ok: false,
    version: "0.1.0",
    problems: [
      {
        id: "x",
        summary: "s",
        attempted: "a",
        evidence: "e",
        unknown: "u",
        files: [],
      },
    ],
    verified: [],
    journal: [],
  };
  assert.ok(!formatWorkOrder(report, "/tmp").includes("PASTE"));
});

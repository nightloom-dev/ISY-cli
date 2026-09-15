#!/usr/bin/env node
import { parseArgs } from "node:util";
import { agentById } from "./agents/index.js";
import { parkAlert } from "./alert.js";
import { claimSweep, releaseSweep } from "./state.js";
import { runAnalyze } from "./commands/analyze.js";
import { runCheck } from "./commands/check.js";
import { runCommitCommand } from "./commands/commit.js";
import { runHealth } from "./commands/health.js";
import { runInit } from "./commands/init.js";
import { runLogout } from "./commands/logout.js";
import { runNotes } from "./commands/notes.js";
import { runSettings } from "./commands/settings.js";
import { runStatus } from "./commands/status.js";
import { formatUploadAlert, formatUploadReport, runUpload } from "./commands/upload.js";
import { errorMessage, logError } from "./log.js";
import { spawnIsy } from "./spawn.js";

const COMMANDS = new Set([
  "init",
  "status",
  "check",
  "health",
  "upload",
  "sweep",
  "commit",
  "logout",
  "analyze",
  "notes",
  "settings",
]);
const USAGE =
  "Usage: isy <init|status|logout> [--silent] [--json] [--token <token>]\n" +
  "       isy upload [--silent] [--hook] [--all] [--agent <claude|kimi|codex>]\n" +
  "       isy sweep [--silent] [--json]\n" +
  "       isy commit [--hook] [--json]\n" +
  "       isy check [--ping] [--json] [--hook] [--agent <claude|kimi|codex>]\n" +
  "       isy health [--json] [--fix] [--scan]\n" +
  "       isy notes [--pr <number>] [--json]\n" +
  "       isy settings [set|unset <key> [value]] [--json]\n" +
  "       isy analyze <file.jsonl|directory>... [--stage 0] [--json]\n" +
  "                   [--expect <dir>] [--update]";

const silentRequested =
  process.argv.includes("--silent") || process.argv.includes("--hook");

function fail(message: string, silent: boolean): never {
  logError(message);
  if (!silent) console.error(`isy: ${message}`);
  process.exit(silent ? 0 : 1);
}

function parse() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        silent: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        token: { type: "string" },
        stage: { type: "string" },
        expect: { type: "string" },
        update: { type: "boolean", default: false },
        hook: { type: "boolean", default: false },
        ping: { type: "boolean", default: false },
        all: { type: "boolean", default: false },
        agent: { type: "string" },
        fix: { type: "boolean", default: false },
        scan: { type: "boolean", default: false },
        pr: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    fail(errorMessage(error), silentRequested);
  }
}

async function run(
  command: string,
  values: {
    json: boolean;
    silent: boolean;
    token?: string;
    stage?: string;
    expect?: string;
    update: boolean;
    hook: boolean;
    ping: boolean;
    all: boolean;
    agent?: string;
    fix: boolean;
    scan: boolean;
    pr?: string;
  },
  positionals: string[],
): Promise<void> {
  switch (command) {
    case "status":
      return runStatus({ json: values.json }, process.cwd());
    case "check":
      return runCheck({
        json: values.json,
        hook: values.hook,
        ping: values.ping,
        agent: values.agent,
        catchUp: () => spawnIsy(["sweep", "--silent"]),
      });
    case "notes": {
      const pr = values.pr === undefined ? undefined : Number(values.pr);
      if (pr !== undefined && !Number.isInteger(pr)) throw new Error("--pr takes a pull request number");
      return runNotes({ json: values.json, pr }, process.cwd());
    }
    case "settings":
      return runSettings({
        json: values.json,
        action: positionals[1],
        key: positionals[2],
        value: positionals[3],
      });
    case "health":
      return runHealth({ json: values.json, fix: values.fix, scan: values.scan }, process.cwd());
    case "init":
      return runInit({ token: values.token }, process.cwd());
    case "logout":
      return runLogout(process.cwd());
    // post-commit runs this. Git ignores what it returns — the commit is already
    // made — but it must still never throw, or the user sees a stack trace after
    // every commit.
    case "commit": {
      if (values.hook) {
        try {
          await runCommitCommand({ json: values.json, hook: true }, process.cwd());
        } catch {
          return;
        }
        return;
      }
      return runCommitCommand({ json: values.json, hook: false }, process.cwd());
    }
    case "upload": {
      // A SessionEnd hook must not break the session it reports on.
      if (values.hook) {
        try {
          const report = await runUpload(
            { silent: true, agent: values.agent, all: values.all, hook: true },
            process.cwd(),
          );
          const alert = formatUploadAlert(report);
          // Each CLI displays a line its own way; the wording is the same.
          if (alert) await agentById(report.agent).deliver(alert, "SessionEnd");
        } catch {
          return;
        }
        return;
      }

      const report = await runUpload(
        { silent: values.silent, agent: values.agent, all: values.all },
        process.cwd(),
      );
      if (!values.silent) console.log(formatUploadReport(report));
      return;
    }
    // What stands in for SessionEnd where a CLI has none: every session on the
    // machine, whatever directory it ran in. Run detached from any CLI — by a
    // SessionStart hook, later by a timer — so a line worth showing is parked
    // for the next session start rather than written to a stdout nobody reads.
    case "sweep": {
      // One sweep at a time on a machine: two CLIs opened together would scan
      // the same transcripts and upload each of them twice.
      if (!(await claimSweep())) {
        if (!values.silent) console.log("isy: a sweep is already running");
        return;
      }

      try {
        const report = await runUpload({ silent: values.silent, sweep: true }, process.cwd());
        if (values.json) {
          console.log(JSON.stringify(report, null, 2));
          return;
        }
        if (values.silent) {
          const alert = formatUploadAlert(report);
          if (alert) await parkAlert(alert);
          return;
        }
        console.log(formatUploadReport(report));
      } catch (error) {
        // Spawned detached with its output discarded, so an uncaught throw would
        // leave nothing anywhere — and `isy health` reads the journal to answer
        // exactly this question.
        logError(`sweep: ${String(error)}`);
      } finally {
        await releaseSweep();
      }
      return;
    }
    case "analyze":
      return runAnalyze({
        files: positionals.slice(1),
        stage: values.stage,
        json: values.json,
        expect: values.expect,
        update: values.update,
      });
    default:
      throw new Error("not implemented yet");
  }
}

const { values, positionals } = parse();
const silent = values.silent;
const command = positionals[0] ?? "status";

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

if (!COMMANDS.has(command)) {
  fail(`unknown command '${command}'. ${USAGE}`, silent);
}

try {
  await run(command, values, positionals);
} catch (error) {
  fail(`${command}: ${errorMessage(error)}`, silent);
}

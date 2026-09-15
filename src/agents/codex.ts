import type { Dirent } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { parkAlert, withParkedAlerts } from "../alert.js";
import { installHookIn, installedHooksIn, removeHookIn } from "../hook.js";
import type { HookFile } from "../hook.js";
import { parseLines } from "../parser.js";
import { firstLine } from "../paths.js";
import { redactLines } from "../redact.js";
import type { ParsedSession, SessionFile } from "../types.js";
import { toClaudeRecords } from "./codex-records.js";
import type { Agent, AgentHook, HookInput } from "./types.js";

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

export function codexHooksPath(): string {
  return join(codexHome(), "hooks.json");
}

export function codexSessionsDir(): string {
  return join(codexHome(), "sessions");
}

/**
 * Codex files sessions by date (`sessions/2026/08/20/rollout-<time>-<id>.jsonl`)
 * with no index by working directory, so finding a project's sessions means
 * opening rollouts and reading the `cwd` off their first line. Newest first,
 * and only this many are looked at.
 *
 * ponytail: linear scan capped at the newest rollouts; build an index if a
 * machine ever has enough sessions for this to show up.
 */
const SCAN_LIMIT = 500;

const ROLLOUT_ID = /^rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function codexHooks(): AgentHook[] {
  // Codex's hook payload is field-for-field Claude Code's, so the agent cannot
  // be told from the payload: these say which CLI they belong to outright.
  return [
    {
      event: "SessionStart",
      command: "npx @nightloom/isy check --hook --agent codex",
      superseded: ["npx isy check --hook --agent codex"],
    },
    {
      event: "SessionEnd",
      // Detached on purpose. An upload has a 30s budget of its own, and Codex
      // is tearing the session down while this runs, so the hook shell returns
      // at once and the upload outlives it. A background job's stdin is
      // /dev/null, so the payload is handed over on fd 3 first: without it the
      // upload took the newest rollout in the cwd, which is the wrong session
      // whenever two share a directory.
      //
      // ponytail: POSIX `&`, so no Windows. Codex's own `commandWindows`
      // override is the way up if anyone runs ISY there.
      command: "exec 3<&0; nohup npx @nightloom/isy upload --hook --agent codex <&3 >/dev/null 2>&1 &",
      superseded: [
        "npx isy upload --hook --agent codex",
        "nohup npx isy upload --hook --agent codex >/dev/null 2>&1 </dev/null &",
        "exec 3<&0; nohup npx isy upload --hook --agent codex <&3 >/dev/null 2>&1 &",
      ],
    },
  ];
}

function hookFile(): HookFile {
  return { path: codexHooksPath(), hooks: codexHooks() };
}

/** Every rollout file on this machine, newest first. */
async function rolloutPaths(): Promise<string[]> {
  // The tree is sessions/YYYY/MM/DD and rollout names open with an ISO
  // timestamp, so sorting names descending at every level is chronological.
  // Depth is not assumed: any directory under the root is walked.
  const descend = async (dir: string): Promise<string[]> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const names = (keep: (entry: Dirent) => boolean): string[] =>
      entries.filter(keep).map((entry) => entry.name).sort().reverse();

    const found = names(
      (entry) => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl"),
    ).map((name) => join(dir, name));

    for (const name of names((entry) => entry.isDirectory())) {
      found.push(...(await descend(join(dir, name))));
    }
    return found;
  };

  return descend(codexSessionsDir());
}

async function sessionCwd(path: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await firstLine(path));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const payload = (parsed as { payload?: unknown }).payload;
    if (typeof payload !== "object" || payload === null) return undefined;
    const cwd = (payload as { cwd?: unknown }).cwd;
    return typeof cwd === "string" ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function sessionIdOf(path: string): string {
  const name = basename(path, ".jsonl");
  return ROLLOUT_ID.exec(name)?.[1] ?? name;
}

/**
 * The newest rollouts as the rest of isy sees a session, newest first.
 *
 * Rollout names open with an ISO timestamp under a date tree, so the paths
 * arrive in creation order — but mtime is what a sweep compares against, and a
 * resumed session is appended to long after it was named, so the sort is by
 * mtime. `keep` runs before the `stat`, which is what lets a per-directory
 * listing cost one first line per rollout rather than a first line and a stat.
 */
async function scanRollouts(keep?: (path: string) => Promise<boolean>): Promise<SessionFile[]> {
  const sessions: SessionFile[] = [];

  for (const path of (await rolloutPaths()).slice(0, SCAN_LIMIT)) {
    if (keep && !(await keep(path))) continue;
    try {
      const info = await stat(path);
      if (!info.isFile()) continue;
      sessions.push({
        sessionId: sessionIdOf(path),
        path,
        sizeBytes: info.size,
        modifiedAt: info.mtime,
      });
    } catch {
      continue;
    }
  }

  sessions.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());
  return sessions;
}

async function codexRecords(path: string, cwd?: string): Promise<string[]> {
  const rollout = (await readFile(path, "utf8")).split("\n");
  return toClaudeRecords(rollout, { cwd });
}

export const codexAgent: Agent = {
  id: "codex",
  label: "Codex CLI",

  async present(): Promise<boolean> {
    try {
      await access(codexHome());
      return true;
    } catch {
      return false;
    }
  },

  configLocation(): string {
    return codexHooksPath();
  },

  hooks: codexHooks,

  // Codex keeps every project's sessions in one date tree, so this is the tree
  // itself rather than a per-project directory.
  transcriptDir(): string {
    return codexSessionsDir();
  },

  transcriptRoot: codexSessionsDir,

  // Filtered before the `stat`, never after: this runs on every post-commit and
  // every pre-push, and the first line is what decides which rollouts are even
  // this directory's.
  sessionsIn(cwd: string): Promise<SessionFile[]> {
    return scanRollouts(async (path) => (await sessionCwd(path)) === cwd);
  },

  allSessions: () => scanRollouts(),

  cwdOf: sessionCwd,

  async parsedSession(path: string, cwd?: string): Promise<ParsedSession> {
    const session = parseLines(await codexRecords(path, cwd));
    session.filePath = path;
    return session;
  },

  // Codex sends `transcript_path` under the same name Claude Code does.
  async transcriptFor(hook: HookInput | undefined, cwd: string): Promise<string | undefined> {
    return hook?.transcript_path ?? (await codexAgent.sessionsIn(cwd))[0]?.path;
  },

  async redactedLines(
    path: string,
    options: { extraPatterns?: readonly string[]; cwd?: string },
  ): Promise<string[]> {
    const records = await codexRecords(path, options.cwd);
    return redactLines(records, { extraPatterns: options.extraPatterns, cwd: options.cwd }).lines;
  },

  hooksInstalled: () => installedHooksIn(hookFile()),
  installHooks: () => installHookIn(hookFile()),
  removeHooks: () => removeHookIn(hookFile()),

  // Codex only trusts a hook it has seen the user approve, and records the
  // approval in config.toml keyed by the hook's position in hooks.json.
  afterInstall: "Codex will ask you to approve these hooks the next time it starts.",

  /**
   * Codex renders a SessionStart hook's stdout as `systemMessage`, but has no
   * output schema for SessionEnd at all — whatever an upload has to say is
   * dropped there. So a SessionEnd line is parked and shown at the next
   * SessionStart. The park file is shared with Kimi and with the sweep on
   * purpose: they write the same wording for the same human, and whichever CLI
   * starts first shows it.
   *
   * ponytail: if Codex itself discards the systemMessage the alert is still
   * lost — no client-side signal says whether it was shown.
   */
  async deliver(message: string, event?: string): Promise<void> {
    if (event === "SessionEnd") return parkAlert(message);
    console.log(JSON.stringify({ systemMessage: await withParkedAlerts(message) }));
  },
};

import { access } from "node:fs/promises";
import { withParkedAlerts } from "../alert.js";
import { ISY_HOOKS, installHook, installedHooks, removeHook, settingsLocation } from "../hook.js";
import { parseTranscriptFile } from "../parser.js";
import {
  allClaudeSessions,
  claudeConfigDir,
  claudeProjectsDir,
  findSessions,
  firstCwd,
  projectDir,
} from "../paths.js";
import { redactTranscriptFile } from "../redact.js";
import type { Agent, AgentHook, HookInput } from "./types.js";

/**
 * Claude Code. This is a thin front onto the code that already shipped —
 * hook.ts, paths.ts and redact.ts are unchanged and still carry their own tests.
 */
export const claudeAgent: Agent = {
  id: "claude",
  label: "Claude Code",

  async present(): Promise<boolean> {
    try {
      await access(claudeConfigDir());
      return true;
    } catch {
      return false;
    }
  },

  configLocation(): string {
    return settingsLocation();
  },

  hooks(): AgentHook[] {
    return ISY_HOOKS;
  },

  transcriptDir(cwd: string): string {
    return projectDir(cwd);
  },

  transcriptRoot: claudeProjectsDir,

  sessionsIn(cwd: string) {
    return findSessions(cwd);
  },

  allSessions: allClaudeSessions,

  cwdOf(path: string) {
    return firstCwd(path);
  },

  parsedSession(path: string) {
    return parseTranscriptFile(path);
  },

  async transcriptFor(hook: HookInput | undefined, cwd: string): Promise<string | undefined> {
    return hook?.transcript_path ?? (await findSessions(cwd))[0]?.path;
  },

  async redactedLines(
    path: string,
    options: { extraPatterns?: readonly string[]; cwd?: string },
  ): Promise<string[]> {
    // Streams the file rather than loading it: real transcripts reach tens of MB.
    const { lines } = await redactTranscriptFile(path, {
      extraPatterns: options.extraPatterns,
      cwd: options.cwd,
    });
    return lines;
  },

  hooksInstalled: installedHooks,
  installHooks: installHook,
  removeHooks: removeHook,

  // Claude Code renders `systemMessage` from a hook's stdout for the user. At
  // SessionStart that stdout is also the only route a line parked by unattended
  // work has — a sweep spawned with its output going nowhere, an alert raised
  // where another CLI had no terminal — so the backlog goes out ahead of it.
  async deliver(message: string, event?: string): Promise<void> {
    const text = event === "SessionStart" ? await withParkedAlerts(message) : message;
    console.log(JSON.stringify({ systemMessage: text }));
  },
};

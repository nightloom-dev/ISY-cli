import type { DiscoveredSession, ParsedSession, SessionFile } from "../types.js";

export type AgentId = "claude" | "kimi" | "codex";

/**
 * What a CLI hands us on stdin when it fires a hook. Claude Code and Codex CLI
 * both send `transcript_path` under the same field names; Kimi sends no path,
 * and only its older builds name themselves in `client_type` (see `detectAgent`).
 * Because Codex's payload is indistinguishable from Claude's, its hooks pass
 * `--agent codex` explicitly.
 */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  client_type?: string;
}

export interface AgentHook {
  event: string;
  command: string;
  /** Commands an older isy wrote for the same job: replace, never stack. */
  superseded?: string[];
}

/**
 * One coding CLI ISY can watch. Only the parts that genuinely differ between
 * CLIs live here — parsing, redaction, detectors and upload are shared.
 */
export interface Agent {
  id: AgentId;
  label: string;

  /** Is this CLI actually installed? We never write config for one that is not. */
  present(): Promise<boolean>;
  /** Where this agent's hooks live, for messages to the user. */
  configLocation(): string;
  hooks(): AgentHook[];

  /** Where this agent keeps transcripts for a working directory. */
  transcriptDir(cwd: string): string;
  /**
   * The directory every session of this agent lives under, whatever directory
   * it ran in. For Claude that is the parent of the per-project folders; for
   * the other two it is the same thing `transcriptDir` already returns.
   */
  transcriptRoot(): string;
  /** Every session recorded for a working directory, newest first. */
  sessionsIn(cwd: string): Promise<SessionFile[]>;
  /**
   * Every session this CLI recorded on this machine, newest first, without
   * opening any of them. What a sweep starts from: a desktop app fires no hook
   * and names no working directory, so there is nothing to scope the scan to.
   *
   * `cwd` comes back set only where listing already had to read it (Kimi).
   */
  allSessions(): Promise<DiscoveredSession[]>;
  /**
   * Where one session ran, for the adapters whose listing does not know. Separate
   * from `allSessions` on purpose: it costs a read, and a sweep only needs it for
   * the sessions that grew since last time.
   */
  cwdOf(path: string): Promise<string | undefined>;
  /** Parse one transcript without redacting it — for local inspection only. */
  parsedSession(path: string, cwd?: string): Promise<ParsedSession>;
  /** Resolve the transcript this hook invocation is about. */
  transcriptFor(hook: HookInput | undefined, cwd: string): Promise<string | undefined>;
  /**
   * Redacted, Claude-record-shaped JSONL lines, ready for parseLines and upload.
   * Agents whose native format differs normalize here, so everything downstream
   * — including the server's own parseLines — sees one shape.
   */
  redactedLines(
    path: string,
    options: { extraPatterns?: readonly string[]; cwd?: string },
  ): Promise<string[]>;

  /** Anything the user must still do after hooks are written, if anything. */
  afterInstall?: string;

  hooksInstalled(): Promise<string[]>;
  installHooks(): Promise<"installed" | "already-present">;
  removeHooks(): Promise<"removed" | "absent">;

  /**
   * Show one line to the user. Each CLI displays text its own way, and the same
   * CLI can differ per event: Codex renders a hook's stdout at SessionStart but
   * discards it at SessionEnd, so the event decides the route.
   */
  deliver(message: string, event?: string): Promise<void>;
}

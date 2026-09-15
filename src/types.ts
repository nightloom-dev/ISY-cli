export interface TranscriptMessage {
  role?: string;
  model?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface TranscriptRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  isSidechain?: boolean;
  requestId?: string;
  message?: TranscriptMessage;
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export interface ContentBlock {
  type: string;
  recordIndex: number;
  uuid?: string;
  timestamp?: string;
  isSidechain: boolean;
  text?: string;
  raw: Record<string, unknown>;
}

export interface ToolResult {
  recordIndex: number;
  uuid?: string;
  timestamp?: string;
  isError: boolean;
  text: string;
  stdout?: string;
  stderr?: string;
  fileContent?: string;
  interrupted: boolean;
}

export type SignalCategory =
  | "abandoned_approach"
  | "unverified_assumption"
  | "known_gap"
  | "test_modified_to_pass"
  | "external_dependency"
  | "unverified_fix"
  | "error_suppressed"
  | "destructive_command"
  | "user_correction_ignored"
  | "stale_context";

export interface Candidate {
  category: SignalCategory;
  sessionId?: string;
  uuid?: string;
  toolUseId?: string;
  filePath?: string;
  recordIndex: number;
  startedAt?: string;
  endedAt?: string;
  weight: number;
  detail: string;
}

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  recordIndex: number;
  uuid?: string;
  timestamp?: string;
  isSidechain: boolean;
  result?: ToolResult;
}

export interface FileEdit {
  toolUseId: string;
  tool: string;
  filePath: string;
  oldString?: string;
  newString?: string;
  content?: string;
  recordIndex: number;
  uuid?: string;
  timestamp?: string;
}

export interface SkipStats {
  lines: number;
  blank: number;
  malformedJson: number;
  notAnObject: number;
  unknownTypes: Record<string, number>;
}

export interface SessionMeta {
  cwd?: string;
  gitBranch?: string;
  claudeVersion?: string;
  startedAt?: string;
  endedAt?: string;
  assistantRecords: number;
  thinkingBlocks: number;
  editToolUses: number;
  /** Touched a file by any means — see parser.ts:shellWrites. Gates analysis. */
  hasFileEdits: boolean;
  sidechainRecords: number;
}

export interface ParsedSession {
  sessionId?: string;
  filePath?: string;
  records: TranscriptRecord[];
  blocks: ContentBlock[];
  toolUses: ToolUse[];
  fileEdits: Map<string, FileEdit[]>;
  filesRead: Set<string>;
  byUuid: Map<string, TranscriptRecord>;
  mainPath: Set<string>;
  meta: SessionMeta;
  skipped: SkipStats;
}

export interface SessionFile {
  sessionId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/**
 * A session found by a scan that had no working directory to start from, so the
 * directory it ran in is an answer rather than a question. Read from the
 * transcript, never derived from its path: `projectSlug` is lossy, and Kimi and
 * Codex file sessions by workspace hash and by date respectively.
 */
export interface DiscoveredSession extends SessionFile {
  cwd?: string;
}

export interface IsyConfig {
  token?: string;
  githubLogin?: string;
  apiBaseUrl?: string;
  extraRedactPatterns?: string[];
  lastUploadAt?: string;
  /** The client version the server last said it expects. */
  latestVersion?: string;
  /**
   * What the last upload heard about the plan (`plan.ts`). Kept so `isy status`
   * and `isy check` can say the allowance is gone without a call of their own.
   */
  plan?: {
    tier: string;
    analysesLeft: number;
    credits: number;
    resetsAt?: string;
  };
}

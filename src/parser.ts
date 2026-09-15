import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type {
  ContentBlock,
  FileEdit,
  ParsedSession,
  SkipStats,
  ToolResult,
  ToolUse,
  TranscriptRecord,
} from "./types.js";

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const LOOKUP_TOOLS = new Set(["Read", "Grep", "Glob"]);

const KNOWN_RECORD_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "ai-title",
  "agent-name",
  "mode",
  "permission-mode",
  "queue-operation",
  "last-prompt",
  "bridge-session",
  "file-history-snapshot",
  "file-history-delta",
]);

interface ParseState {
  records: TranscriptRecord[];
  blocks: ContentBlock[];
  toolUses: ToolUse[];
  toolUseById: Map<string, ToolUse>;
  fileEdits: Map<string, FileEdit[]>;
  filesRead: Set<string>;
  skipped: SkipStats;
  thinkingBlocks: number;
  editToolUses: number;
  shellWrote: boolean;
  sawUnknownTool: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function createState(): ParseState {
  return {
    records: [],
    blocks: [],
    toolUses: [],
    toolUseById: new Map(),
    fileEdits: new Map(),
    filesRead: new Set(),
    skipped: { lines: 0, blank: 0, malformedJson: 0, notAnObject: 0, unknownTypes: {} },
    thinkingBlocks: 0,
    editToolUses: 0,
    shellWrote: false,
    sawUnknownTool: false,
  };
}

function blockText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (isObject(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

function extractText(block: Record<string, unknown>): string | undefined {
  if (block.type === "text") return asString(block.text);
  if (block.type === "thinking") return asString(block.thinking);
  if (block.type === "tool_result") return blockText(block);
  return undefined;
}

function buildToolResult(
  record: TranscriptRecord,
  block: Record<string, unknown>,
  recordIndex: number,
): ToolResult {
  const detail = isObject(record.toolUseResult) ? record.toolUseResult : undefined;
  const fallback = typeof record.toolUseResult === "string" ? record.toolUseResult : "";
  const file = detail && isObject(detail.file) ? detail.file : undefined;
  const whole = file && file.startLine === 1 && file.numLines === file.totalLines;

  return {
    recordIndex,
    uuid: record.uuid,
    timestamp: record.timestamp,
    isError: block.is_error === true,
    text: blockText(block) || fallback,
    stdout: detail && typeof detail.stdout === "string" ? detail.stdout : undefined,
    stderr: detail && typeof detail.stderr === "string" ? detail.stderr : undefined,
    fileContent: whole && typeof file.content === "string" ? file.content : undefined,
    interrupted: detail?.interrupted === true,
  };
}

function pushFileEdits(state: ParseState, use: ToolUse): void {
  const filePath = asString(use.input.file_path) ?? asString(use.input.notebook_path);
  if (!filePath) return;

  const base = {
    toolUseId: use.id,
    tool: use.name,
    filePath,
    recordIndex: use.recordIndex,
    uuid: use.uuid,
    timestamp: use.timestamp,
  };

  const entries: FileEdit[] = [];
  if (Array.isArray(use.input.edits)) {
    for (const edit of use.input.edits) {
      if (!isObject(edit)) continue;
      entries.push({
        ...base,
        oldString: asString(edit.old_string),
        newString: asString(edit.new_string),
      });
    }
  } else {
    entries.push({
      ...base,
      oldString: asString(use.input.old_string),
      newString: asString(use.input.new_string) ?? asString(use.input.new_source),
      content: asString(use.input.content),
    });
  }

  const existing = state.fileEdits.get(filePath);
  if (existing) existing.push(...entries);
  else state.fileEdits.set(filePath, entries);
}

function pushLookup(state: ParseState, use: ToolUse): void {
  const target = asString(use.input.file_path) ?? asString(use.input.path);
  if (target) state.filesRead.add(target);
}

/**
 * A heredoc opener: `<<EOF`, `<<-EOF`, `<<'PY'`. The delimiter is what ends the
 * body, and quoting it changes nothing about where the body stops.
 */
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/**
 * The command with every heredoc body cut out.
 *
 * `python3 - <<'PY' … PY` carries a whole file inside one command: a document
 * quoting `npm install`, a fixture holding `DROP DATABASE`, a test asserting on
 * `rm -rf`. Everything that reads a command reads it segment by segment, and a
 * body's lines are segments, so without this the detectors report a dozen
 * commands the agent never ran. The opening line stays — that one really
 * did run.
 */
export function withoutHeredocs(command: string): string {
  if (!command.includes("<<")) return command;

  const kept: string[] = [];
  let terminator: string | undefined;

  for (const line of command.split("\n")) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined;
      continue;
    }
    kept.push(line);
    terminator = HEREDOC.exec(line)?.[2];
  }

  return kept.join("\n");
}

/**
 * A command split into the pieces a shell would run on its own, with quoting
 * honoured: `grep -E "DELETE FROM|DROP TABLE" file` is one reader, not a reader
 * followed by a DROP. The corpus trips over exactly that — an alternation
 * inside a search pattern is the commonest way a `|` shows up in a command that
 * runs nothing at all.
 *
 * ponytail: quotes nest as a single state, and a backslash escape only counts
 * inside double quotes, which is what a shell does anyway. Real parsing is a
 * dependency, and this is here to stop three regexes from lying.
 */
export function commandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | undefined;

  // A command substitution runs its own command: `node x $(grep -rl "DROP TABLE" .)`
  // greps, it does not drop. Lifted out first so it is judged on its own, and
  // so the text it carries stops belonging to the command around it.
  const substituted: string[] = [];
  const flat = command.replace(/\$\(([^()]*)\)/g, (_match, body: string) => {
    substituted.push(body);
    return " ";
  });

  for (let i = 0; i < flat.length; i += 1) {
    const char = flat[i]!;

    if (quote !== undefined) {
      current += char;
      if (char === quote && (quote === "'" || flat[i - 1] !== "\\")) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "\n" || char === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if (char === "|" || char === "&") {
      // `&&` and `||` split in the same place their single-character forms do.
      if (flat[i + 1] === char) i += 1;
      segments.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  segments.push(current);
  // The bodies hold no substitutions of their own — the pattern above stops at
  // the first parenthesis — so this recursion is one level deep.
  return [...segments, ...substituted.flatMap((body) => commandSegments(body))];
}

const SHELL_READERS =
  /^\s*(?:sudo\s+)?(cat|head|tail|less|more|bat|nl|wc|sed|awk|rg|grep|egrep|fgrep|jq|yq|xxd|od|file|stat|diff|git\s+show|git\s+diff|git\s+log|git\s+blame)\b/;

/**
 * Tools known not to write a file. Anything outside these and the edit tools is
 * a name some CLI invented — Kimi's `StrReplaceFile` next to its plain `Grep`,
 * the next Codex harness — and the parser cannot say whether it wrote one.
 */
const OTHER_KNOWN_TOOLS = new Set([
  // Claude Code
  "Task", "Agent", "TodoWrite", "WebFetch", "WebSearch", "Skill", "AskUserQuestion",
  "EnterPlanMode", "ExitPlanMode", "ToolSearch", "BashOutput", "KillShell", "KillBash",
  "TaskOutput", "TaskStop", "Monitor", "LS", "NotebookRead", "SlashCommand",
  "ListMcpResourcesTool", "ReadMcpResourceTool",
  // Codex, kept under its own name by agents/codex-records.ts
  "update_plan", "view_image", "web_search", "web__run", "image_gen__imagegen", "wait",
]);

function isKnownTool(name: string): boolean {
  return (
    EDIT_TOOLS.has(name) ||
    LOOKUP_TOOLS.has(name) ||
    name === "Bash" ||
    name.startsWith("mcp__") ||
    OTHER_KNOWN_TOOLS.has(name)
  );
}

/** A redirect into a file: `> a.ts`, `>> log`, `2> out`. Not `2>&1`, not `/dev/null`. */
const REDIRECT_WRITE = /(?:^|[^<>&\d])\d*>>?(?!&)\s*(?!\/dev\/|\/tmp\/)[^\s&|;<>]/;
const TEE_WRITE = /\btee\s+(?:-a\s+)?(?!\/dev\/|\/tmp\/)[^\s&|;-]/;
const FILE_MUTATORS =
  /^\s*(?:sudo\s+)?(?:patch|truncate|mv|cp|git\s+(?:apply|mv|rm|restore|checkout\s+--))\b/;
const IN_PLACE_EDITORS = /^\s*(?:sudo\s+)?(?:g?sed|perl)\b/;
/** An interpreter fed a script on stdin: whatever the script writes, the command line cannot say. */
const INTERPRETER_HEREDOC =
  /(?:^|[\s;&|(])(?:python[0-9.]*|node|deno|bun|tsx|ruby|perl|php|bash|sh|zsh)\b[^\n]*<</;

/**
 * Whether a shell command could have changed a file in the repository.
 *
 * This answers only "did this session touch files at all", which is what the
 * no-file-edits gate asks, and never "which file" — so it errs toward yes. A
 * wrong yes costs one pass of stage 0 with no model call; a wrong no drops the
 * whole session from its pull request, which is what happened to every agent
 * that edits through the shell before this existed.
 *
 * ponytail: no paths. A heredoc into python writes where the script says, and
 * the script is not read here. Parse the command properly and feed the
 * detectors if a signal ever needs to name a file written this way.
 * Plain `rm` is left out on purpose: it is mostly `rm -rf dist`, and `git rm`
 * covers a tracked file.
 */
export function shellWrites(command: string): boolean {
  const ran = withoutHeredocs(command);
  if (INTERPRETER_HEREDOC.test(ran)) return true;

  for (const segment of commandSegments(ran)) {
    // What sits inside quotes is an argument, not an operator: `grep "->" a`.
    const bare = segment.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
    if (REDIRECT_WRITE.test(bare) || TEE_WRITE.test(bare) || FILE_MUTATORS.test(bare)) return true;
    if (IN_PLACE_EDITORS.test(bare) && (IN_PLACE.test(bare) || /\bperl\s+-\w*i/.test(bare))) return true;
  }
  return false;
}

/** `sed -i` rewrites the file; whatever else it is, it is not a look at it. */
const IN_PLACE = /(?:^|\s)(?:-i(?:\.\S+)?|--in-place)(?:\s|$)/;

/** Tools whose first non-flag argument is a program, not a path. */
const SCRIPTED = /^\s*(?:sudo\s+)?(?:sed|awk)\b/;

export function shellReadPaths(command: string): string[] {
  const paths: string[] = [];

  for (const segment of commandSegments(withoutHeredocs(command))) {
    if (!SHELL_READERS.test(segment)) continue;
    if (IN_PLACE.test(segment)) continue;

    // `sed 's/^/UNPUSHED: /'` has slashes in it and is not a path: read as one
    // it yields "/", which then matches every absolute path there is.
    let script = SCRIPTED.test(segment);

    for (const raw of segment.trim().split(/\s+/).slice(1)) {
      if (/^\d*[<>]|^&/.test(raw)) break;

      const token = raw.replace(/["'`]/g, "");
      if (token.startsWith("-") || token.startsWith("$")) continue;
      if (script) {
        script = false;
        continue;
      }

      const path = token.includes(":") ? token.slice(token.lastIndexOf(":") + 1) : token;
      if (path.includes("*") || path.includes("?")) continue;
      // "/" and "." name no file, and "/" matches every path there is.
      if (/^[./]+$/.test(path)) continue;
      if (!/\.[A-Za-z0-9]+$/.test(path) && !path.includes("/")) continue;

      paths.push(path.replace(/^\.\//, ""));
    }
  }

  return paths;
}

function pushToolUse(
  state: ParseState,
  record: TranscriptRecord,
  block: Record<string, unknown>,
  recordIndex: number,
): void {
  const id = asString(block.id);
  const name = asString(block.name);
  if (!id || !name) return;

  const use: ToolUse = {
    id,
    name,
    input: isObject(block.input) ? block.input : {},
    recordIndex,
    uuid: record.uuid,
    timestamp: record.timestamp,
    isSidechain: record.isSidechain === true,
  };

  state.toolUses.push(use);
  state.toolUseById.set(id, use);

  if (EDIT_TOOLS.has(name)) {
    state.editToolUses += 1;
    pushFileEdits(state, use);
  }
  if (LOOKUP_TOOLS.has(name)) pushLookup(state, use);
  if (name === "Bash" && typeof use.input.command === "string") {
    for (const path of shellReadPaths(use.input.command)) state.filesRead.add(path);
    if (shellWrites(use.input.command)) state.shellWrote = true;
  }

  if (!isKnownTool(name)) state.sawUnknownTool = true;
}

function pushBlocks(state: ParseState, record: TranscriptRecord, recordIndex: number): void {
  const content = record.message?.content;
  const raw: unknown[] = typeof content === "string"
    ? [{ type: "text", text: content }]
    : Array.isArray(content)
      ? content
      : [];

  for (const item of raw) {
    if (!isObject(item)) continue;
    const type = asString(item.type) ?? "unknown";

    state.blocks.push({
      type,
      recordIndex,
      uuid: record.uuid,
      timestamp: record.timestamp,
      isSidechain: record.isSidechain === true,
      text: extractText(item),
      raw: item,
    });

    if (type === "thinking") state.thinkingBlocks += 1;
    if (type === "tool_use") pushToolUse(state, record, item, recordIndex);
    if (type === "tool_result") {
      const target = asString(item.tool_use_id);
      const use = target ? state.toolUseById.get(target) : undefined;
      if (use) use.result = buildToolResult(record, item, recordIndex);
    }
  }
}

function pushLine(state: ParseState, line: string): void {
  state.skipped.lines += 1;

  const trimmed = line.trim();
  if (trimmed.length === 0) {
    state.skipped.blank += 1;
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    state.skipped.malformedJson += 1;
    return;
  }

  if (!isObject(parsed)) {
    state.skipped.notAnObject += 1;
    return;
  }

  const type = asString(parsed.type) ?? "unknown";
  if (!KNOWN_RECORD_TYPES.has(type)) {
    state.skipped.unknownTypes[type] = (state.skipped.unknownTypes[type] ?? 0) + 1;
  }

  const record = { ...parsed, type } as TranscriptRecord;
  state.records.push(record);
  pushBlocks(state, record, state.records.length - 1);
}

function buildByUuid(records: TranscriptRecord[]): Map<string, TranscriptRecord> {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const record of records) {
    if (typeof record.uuid === "string") byUuid.set(record.uuid, record);
  }
  return byUuid;
}

function buildMainPath(
  records: TranscriptRecord[],
  byUuid: Map<string, TranscriptRecord>,
): Set<string> {
  let tip: TranscriptRecord | undefined;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i]!;
    if (typeof record.uuid === "string" && record.isSidechain !== true) {
      tip = record;
      break;
    }
  }

  const path = new Set<string>();
  let current = tip;
  while (current && typeof current.uuid === "string" && !path.has(current.uuid)) {
    path.add(current.uuid);
    current = typeof current.parentUuid === "string" ? byUuid.get(current.parentUuid) : undefined;
  }
  return path;
}

function finish(state: ParseState): ParsedSession {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let claudeVersion: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let assistantRecords = 0;
  let sidechainRecords = 0;

  for (const record of state.records) {
    sessionId ??= asString(record.sessionId);
    cwd = asString(record.cwd) ?? cwd;
    gitBranch = asString(record.gitBranch) ?? gitBranch;
    claudeVersion = asString(record.version) ?? claudeVersion;
    const timestamp = asString(record.timestamp);
    if (timestamp) {
      startedAt ??= timestamp;
      endedAt = timestamp;
    }
    if (record.type === "assistant") assistantRecords += 1;
    if (record.isSidechain === true) sidechainRecords += 1;
  }

  const byUuid = buildByUuid(state.records);

  return {
    sessionId,
    records: state.records,
    blocks: state.blocks,
    toolUses: state.toolUses,
    fileEdits: state.fileEdits,
    filesRead: state.filesRead,
    byUuid,
    mainPath: buildMainPath(state.records, byUuid),
    meta: {
      cwd,
      gitBranch,
      claudeVersion,
      startedAt,
      endedAt,
      assistantRecords,
      thinkingBlocks: state.thinkingBlocks,
      editToolUses: state.editToolUses,
      // Not the same question as editToolUses > 0: a file written from the
      // shell counts, and a tool this parser does not know is "cannot tell",
      // which must not read as "edited nothing".
      hasFileEdits: state.editToolUses > 0 || state.shellWrote || state.sawUnknownTool,
      sidechainRecords,
    },
    skipped: state.skipped,
  };
}

export function parseLines(lines: Iterable<string>): ParsedSession {
  const state = createState();
  for (const line of lines) pushLine(state, line);
  return finish(state);
}

export async function parseTranscriptFile(filePath: string): Promise<ParsedSession> {
  const state = createState();
  const input = createReadStream(filePath, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  for await (const line of reader) pushLine(state, line);
  const session = finish(state);
  session.filePath = filePath;
  return session;
}

export function onMainPath(session: ParsedSession, uuid: string | undefined): boolean {
  return typeof uuid === "string" && session.mainPath.has(uuid);
}

export function onAbandonedBranch(session: ParsedSession, uuid: string | undefined): boolean {
  if (typeof uuid !== "string" || session.mainPath.size === 0) return false;
  if (session.mainPath.has(uuid)) return false;

  const visited = new Set<string>();
  let current = session.byUuid.get(uuid);

  while (current && typeof current.uuid === "string" && !visited.has(current.uuid)) {
    visited.add(current.uuid);
    const parent = current.parentUuid;
    if (typeof parent !== "string") return false;
    if (session.mainPath.has(parent)) return true;
    current = session.byUuid.get(parent);
  }

  return false;
}

export function hasSkips(skipped: SkipStats): boolean {
  return (
    skipped.malformedJson > 0 ||
    skipped.notAnObject > 0 ||
    Object.keys(skipped.unknownTypes).length > 0
  );
}

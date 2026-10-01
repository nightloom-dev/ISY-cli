import { posix } from "node:path";
import { fileLines } from "./lines.js";
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

/**
 * Every record type Claude Code writes to a session file: the table its 2.1.285
 * session writer routes each append by, plus `progress`, which older builds
 * wrote inline. A type outside it is kept and counted in `skipped.unknownTypes`,
 * which is what `isy status` reports as records it could not place — so a type
 * missing here reads to the user as a transcript this client half-understood.
 */
const KNOWN_RECORD_TYPES = new Set([
  "user",
  "assistant",
  "attachment",
  "system",
  "progress",
  "summary",
  "custom-title",
  "ai-title",
  "agent-name",
  "agent-color",
  "agent-setting",
  "tag",
  "relocated",
  "ended-by-model",
  "continued-in",
  "mode",
  "permission-mode",
  "memory-mode",
  "isolation-latch",
  "atis-latch",
  "dev-mods",
  "queue-operation",
  "last-prompt",
  "bridge-session",
  "pr-link",
  "frame-link",
  "worktree-state",
  "cost-state",
  "history-suppression",
  "artifact-comment-monitor",
  "artifact-autoreact-ledger",
  "file-history-snapshot",
  "file-history-delta",
  "attribution-snapshot",
  "content-replacement",
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "fork-context-ref",
  "observer-ref",
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
  hiddenThinkingBlocks: number;
  editToolUses: number;
  shellWrote: boolean;
  /** A call the parser cannot see into that could have written a file (`mayWrite`). */
  opaqueWrite: boolean;
  /** A subagent's result says it edited files, whether or not its own records came along. */
  delegatedEdits: boolean;
  /** Calls whose subagent's own records are in the stream (`parentToolUseID`). */
  delegated: Set<string>;
  /** Calls whose result counted the subagent's edits, whatever the count. */
  counted: Set<string>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A string as written, empty included: `new_string: ""` is how an edit deletes lines. */
function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
    hiddenThinkingBlocks: 0,
    editToolUses: 0,
    shellWrote: false,
    opaqueWrite: false,
    delegatedEdits: false,
    delegated: new Set(),
    counted: new Set(),
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
        newString: asText(edit.new_string),
      });
    }
  } else {
    entries.push({
      ...base,
      oldString: asString(use.input.old_string),
      newString: asText(use.input.new_string) ?? asText(use.input.new_source),
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
 * Tools known not to write a file: delegation, planning, task lists, schedules,
 * the web, the harness talking to the person. Claude Code's are its 2.1.285
 * inventory together with the names it still accepts for older ones (`Task` is
 * `Agent`, `KillShell` and `KillBash` are `TaskStop`, `Brief` is
 * `SendUserMessage`). A subagent's edits are its own tool calls, spliced into the
 * session (`subagents.ts`), so the call that started it is not one — unless
 * nothing of the subagent came back (`delegatedUnseen`).
 */
const OTHER_KNOWN_TOOLS = new Set([
  // Claude Code
  "Task", "Agent", "SubagentHandback", "SendMessage", "ListAgents", "ListPeers", "Workflow",
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "GetTask", "TaskOutput", "TaskStop",
  "BashOutput", "KillShell", "KillBash", "Monitor",
  "WebFetch", "WebSearch", "Skill", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "ToolSearch",
  "EnterWorktree", "ExitWorktree", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "RemoteTrigger",
  "SendUserMessage", "Brief", "SendUserFile", "SendFile", "PushNotification", "ReadNotifications",
  "FetchInboxMessage", "ReportFindings", "EndConversation", "Poll", "Sleep", "StructuredOutput", "LSP",
  "Artifact", "ArtifactComments", "ArtifactData", "DesignSync", "ClaudeDesign", "Projects",
  "SuggestSkills", "SuggestPluginInstall", "SuggestConnectors", "SearchMcpRegistry", "ListConnectors",
  "ListPlugins", "ListSkills", "SearchPlugins", "SearchSkills", "ShowOnboardingRolePicker",
  "ShareOnboardingGuide", "LS", "NotebookRead", "SlashCommand",
  "ListMcpResources", "ListMcpResourcesTool", "ReadMcpResource", "ReadMcpResourceTool",
  "ReadMcpResourceDir", "ReadMcpResourceDirTool",
  // Codex, kept under its own name by agents/codex-records.ts
  "update_plan", "view_image", "web_search", "web__run", "image_gen__imagegen", "wait",
  // Kimi, where agents/kimi-tools.ts has no Claude name to give: `GetGoal`
  // takes no arguments, which alone would read as a possible edit. The Tower
  // tools run Kimi Code's multi-agent workspace: they plan, message and review
  // under `.tower/`, and their workers are subagents like any other.
  "Think", "SendDMail", "AgentSwarm", "WaitFor", "CreateGoal", "GetGoal", "UpdateGoal", "SetGoalBudget",
  "TowerInit", "TowerPlan", "TowerSpawn", "TowerSend", "TowerInbox", "TowerFinding", "TowerReview",
  "TowerMission", "TowerStatus", "TowerTeardown",
]);

/** Tools that run code of their own, which writes wherever it says: a shell the parser cannot read. */
const CODE_RUNNERS = new Set(["PowerShell", "REPL", "JavaScript"]);

/**
 * Tools that change files without naming them in an argument `mayWrite` reads:
 * Codex's `apply_patch`, as `codex-records.ts` passes it on when the patch
 * would not parse (the files are inside `input`), and Kimi Code's `TowerMerge`,
 * a git merge of a worker's branch into the checkout.
 */
const UNNAMED_WRITERS = new Set(["apply_patch", "TowerMerge"]);

function isKnownTool(name: string): boolean {
  return (
    EDIT_TOOLS.has(name) ||
    LOOKUP_TOOLS.has(name) ||
    name === "Bash" ||
    name.startsWith("mcp__") ||
    OTHER_KNOWN_TOOLS.has(name)
  );
}

/**
 * Arguments that say what a call works on. A tool that writes a file has to be
 * told which one, or be handed code that decides; a tool that files a task,
 * messages a teammate or opens a worktree is told neither.
 */
const TARGET_ARGUMENT =
  /^(?:file_?path|filePath|notebook_path|(?:relative_)?path|paths|file|files|filename|target_file|command|cmd|code|script|patch|edits?)$/;

/** Words an MCP tool's name carries when it changes something rather than reads it. */
const MCP_WRITE_VERBS = new Set([
  "write", "edit", "replace", "insert", "patch", "apply", "create", "update", "delete", "remove", "move", "rename", "push",
]);

/** A tool name's words, whichever way it is spelled: `replace_symbol_body`, `writeFile`, `edit-file`. */
function nameWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/);
}

/**
 * Whether a call the parser has no rule for could have written a file.
 *
 * Every Claude Code release adds tools, nearly all of them bookkeeping —
 * `TaskCreate`, `SendMessage`, `EnterWorktree` — and when any unknown name
 * counted as an edit, every session on 2.1 read as one that edited files. So an
 * unknown tool counts only when its arguments could name a file or carry code,
 * or when there are none to read: arguments an adapter could not parse are not
 * arguments that say nothing. A tool an adapter has no Claude name for,
 * told a `path`, and a Codex `exec {script}` still count; `TaskCreate {subject}`
 * does not.
 *
 * An MCP tool is named by its server, and most of them only read — a
 * filesystem server's `read_file {path}`, GitHub's `get_file_contents {path}`.
 * One counts when its name says it changes something and it is told where:
 * `write_file {path}`, Serena's `replace_symbol_body {relative_path}`.
 *
 * ponytail: judged by names. A writer that takes its file under an argument
 * outside `TARGET_ARGUMENT`, or an MCP writer whose name has none of
 * `MCP_WRITE_VERBS`, reads as no edit; add the name when a CLI or server ships one.
 */
export function mayWrite(name: string, input: Record<string, unknown>): boolean {
  if (CODE_RUNNERS.has(name) || UNNAMED_WRITERS.has(name)) return true;
  const keys = Object.keys(input);
  const told = keys.some((key) => TARGET_ARGUMENT.test(key));
  if (name.startsWith("mcp__")) {
    return told && nameWords(name.slice(name.lastIndexOf("__") + 2)).some((word) => MCP_WRITE_VERBS.has(word));
  }
  if (isKnownTool(name)) return false;
  return keys.length === 0 || told;
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

/**
 * `sed -i` rewrites the file; whatever else it is, it is not a look at it. GNU
 * takes any backup suffix (`-i.bak`, `-ie`), the flag rides in a cluster
 * (`-Ei`), and BSD spells it `-I`.
 */
const IN_PLACE = /(?:^|\s)(?:-[a-zA-Z]*[iI]\S*|--in-place\S*)(?:\s|$)/;

/** Tools whose first non-flag argument is a program, not a path. */
const SCRIPTED = /^\s*(?:sudo\s+)?(?:sed|awk)\b/;

export function shellReadPaths(command: string): string[] {
  const paths: string[] = [];

  for (const segment of commandSegments(withoutHeredocs(command))) {
    if (!SHELL_READERS.test(segment)) continue;
    // Only sed's: `grep -i foo src/a.ts` is a look, and was taken for a write.
    if (SCRIPTED.test(segment) && IN_PLACE.test(segment)) continue;

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

      // A glob stays one: `cat src/*.js` read every file it expanded to, and
      // `detectors.ts:samePath` matches it against the file edited.
      const path = token.includes(":") ? token.slice(token.lastIndexOf(":") + 1) : token;
      // "/" and "." name no file, and "/" matches every path there is.
      if (/^[./]+$/.test(path)) continue;
      if (!/\.[A-Za-z0-9]+$/.test(path) && !path.includes("/")) continue;

      paths.push(path.replace(/^\.\//, ""));
    }
  }

  return paths;
}

/** A shell word, quotes and all: `'s/a b/c/'` is one word, not two. */
const SHELL_WORD = /(?:'[^']*'|"(?:[^"\\]|\\.)*"|[^\s'"])+/g;

/**
 * Flags whose next word is the script, not a file. Only the bare ones for sed:
 * `sed -ie` is `-i` with the backup suffix "e", while `perl -pe` is `-p -e`.
 */
const SED_SCRIPT_FLAG = /^(?:-e|--expression|-f|--file)$/;
const PERL_SCRIPT_FLAG = /^-[a-zA-Z]*e$/;

/**
 * The files `sed -i` and `perl -i` rewrite: every argument after the script.
 * What the edit changed stays unseen — a sed script is a program, not the text
 * it replaces — but where it landed is on the command line, and without it a
 * session editing through sed read to the detectors as one that edited nothing.
 *
 * Given the directory the command ran in, a relative path is resolved against
 * it, `cd` within the command included, so `sed -i` and Edit on one file land
 * under one key — before masking (both absolute) and after (both relative to
 * a working directory of "."). Without it, or past a `cd` it cannot follow
 * (`cd ~`, `cd -`, `cd $DIR`), paths stay as typed, like `shellReadPaths`.
 *
 * ponytail: in-place editors only. A redirect, `tee` or a heredoc into python
 * still names no file to the detectors (`shellWrites` knows only that one was
 * written); a glob names files this cannot list.
 */
export function shellEditPaths(command: string, cwd?: string): string[] {
  const paths: string[] = [];
  let dir = cwd;

  for (const segment of commandSegments(withoutHeredocs(command))) {
    if (/^\s*cd(?:\s|$)/.test(segment)) {
      const to = /^\s*cd\s+(\S+)\s*$/.exec(segment)?.[1]?.replace(/["']/g, "");
      if (to?.startsWith("/")) dir = posix.normalize(to);
      else dir = dir === undefined || to === undefined || /^[~$-]/.test(to) ? undefined : posix.join(dir, to);
      continue;
    }
    if (!IN_PLACE_EDITORS.test(segment)) continue;
    const perl = /^\s*(?:sudo\s+)?perl\b/.test(segment);
    // The same test `shellWrites` applies, on the same unquoted text, so the two
    // agree on what was written: `sed 's/ -i //' a.ts` only prints.
    const bare = segment.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
    if (!(perl ? /\bperl\s+-\w*i/.test(bare) : IN_PLACE.test(bare))) continue;

    let scriptSeen = false;
    let scriptNext = false;
    const words = segment.replace(/^\s*sudo\s+/, "").match(SHELL_WORD) ?? [];
    for (const word of words.slice(1)) {
      if (/^\d*[<>|]|^&/.test(word)) break;
      const token = word.replace(/["']/g, "");
      if (scriptNext) {
        scriptNext = false;
        continue;
      }
      if ((perl ? PERL_SCRIPT_FLAG : SED_SCRIPT_FLAG).test(token)) {
        scriptSeen = true;
        scriptNext = true;
        continue;
      }
      if (/^--(?:expression|file)=/.test(token)) scriptSeen = true;
      // An empty word is BSD sed's backup suffix: `sed -i '' 's/a/b/' f`.
      if (token.length === 0 || token.startsWith("-") || token.startsWith("$")) continue;
      if (!scriptSeen) {
        scriptSeen = true;
        continue;
      }
      if (/[*?]/.test(token) || /^[./]+$/.test(token)) continue;
      if (dir === undefined || token.startsWith("~")) paths.push(token.replace(/^\.\//, ""));
      else paths.push(token.startsWith("/") ? posix.normalize(token) : posix.join(dir, token));
    }
  }

  return paths;
}

function pushShellEdits(state: ParseState, use: ToolUse, command: string, cwd: unknown): void {
  for (const filePath of shellEditPaths(command, asString(cwd))) {
    const edit: FileEdit = {
      toolUseId: use.id,
      tool: use.name,
      filePath,
      recordIndex: use.recordIndex,
      uuid: use.uuid,
      timestamp: use.timestamp,
    };
    const existing = state.fileEdits.get(filePath);
    if (existing) existing.push(edit);
    else state.fileEdits.set(filePath, [edit]);
  }
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
    pushShellEdits(state, use, use.input.command, record.cwd);
  }

  if (mayWrite(name, use.input)) state.opaqueWrite = true;
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

    // Reasoning counts when there is something in it to read. Claude Code 2.1
    // records most thinking with the text left out — only the signature — and
    // `redacted_thinking` is encrypted outright: both show the model thought,
    // neither says what, so neither makes `known_gap` reachable.
    if (type === "thinking" && typeof item.thinking === "string" && item.thinking.trim().length > 0) {
      state.thinkingBlocks += 1;
    } else if (type === "thinking" || type === "redacted_thinking") {
      state.hiddenThinkingBlocks += 1;
    }
    if (type === "tool_use") pushToolUse(state, record, item, recordIndex);
    if (type === "tool_result") {
      const target = asString(item.tool_use_id);
      const use = target ? state.toolUseById.get(target) : undefined;
      if (use) use.result = buildToolResult(record, item, recordIndex);
      const edited = subagentEdits(record);
      if (edited !== undefined && target) state.counted.add(target);
      if (edited !== undefined && edited > 0) state.delegatedEdits = true;
    }
  }
}

/**
 * How many files a subagent's result says it edited. Claude Code 2.1 keeps a
 * subagent's calls in a file of its own and totals them on the call's result
 * (`toolStats.editFileCount`), so a session uploaded without that file — by a
 * client older than the splicing in `subagents.ts` — still says it touched files.
 * Only a subagent that ran to the end is counted: one sent to the background
 * answers at once, with no total (`delegatedUnseen`).
 */
function subagentEdits(record: TranscriptRecord): number | undefined {
  const detail = isObject(record.toolUseResult) ? record.toolUseResult : undefined;
  const stats = detail && isObject(detail.toolStats) ? detail.toolStats : undefined;
  return typeof stats?.editFileCount === "number" ? stats.editFileCount : undefined;
}

/**
 * Tools that hand work to subagents whose records come back linked to the call
 * (`parentToolUseID`): Claude's, which Kimi's `Agent` is translated to, and
 * Kimi Code's `AgentSwarm` and `TowerSpawn`, whose subagents it links the same way.
 */
const DELEGATION_TOOLS = new Set(["Agent", "Task", "AgentSwarm", "TowerSpawn"]);

/**
 * Whether a subagent was sent off and neither its records nor a count of its
 * edits came back: a background subagent's result is only "launched", and a
 * session uploaded without the subagent's file — by an older client, or with
 * the file gone — carries nothing else of it. What it did cannot be seen, so
 * it may have edited. A call that failed started nothing.
 */
function delegatedUnseen(state: ParseState): boolean {
  return state.toolUses.some(
    (use) =>
      DELEGATION_TOOLS.has(use.name) &&
      use.result?.isError !== true &&
      !state.delegated.has(use.id) &&
      !state.counted.has(use.id),
  );
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
  if (record.isSidechain === true && typeof record.parentToolUseID === "string") {
    state.delegated.add(record.parentToolUseID);
  }
  pushBlocks(state, record, state.records.length - 1);
}

function buildByUuid(records: TranscriptRecord[]): Map<string, TranscriptRecord> {
  const byUuid = new Map<string, TranscriptRecord>();
  for (const record of records) {
    if (typeof record.uuid === "string") byUuid.set(record.uuid, record);
  }
  return byUuid;
}

/**
 * The record this one continues. Its parent — or, where a compaction started the
 * chain over, the record the compaction summarised: Claude Code writes the
 * `compact_boundary` with no parent and names what it follows in
 * `logicalParentUuid`. Walking parents alone stopped at the boundary, and the
 * whole session before its last compaction fell off the main path.
 */
function parentOf(record: TranscriptRecord): string | undefined {
  if (typeof record.parentUuid === "string") return record.parentUuid;
  return typeof record.logicalParentUuid === "string" ? record.logicalParentUuid : undefined;
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
    const parent = parentOf(current);
    current = parent === undefined ? undefined : byUuid.get(parent);
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
      hiddenThinkingBlocks: state.hiddenThinkingBlocks,
      editToolUses: state.editToolUses,
      // Not the same question as editToolUses > 0: a file written from the
      // shell counts, a call the parser cannot see into is "cannot tell", which
      // must not read as "edited nothing", and so is a subagent that says it
      // edited, or whose work never came back to say.
      hasFileEdits:
        state.editToolUses > 0 ||
        state.shellWrote ||
        state.opaqueWrite ||
        state.delegatedEdits ||
        delegatedUnseen(state),
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

/** `parseLines` for lines that arrive one at a time, as a stream or a generator does. */
export async function parseLineStream(lines: AsyncIterable<string>): Promise<ParsedSession> {
  const state = createState();
  for await (const line of lines) pushLine(state, line);
  return finish(state);
}

export async function parseTranscriptFile(filePath: string): Promise<ParsedSession> {
  const session = await parseLineStream(fileLines(filePath));
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
    const parent = parentOf(current);
    if (parent === undefined) return false;
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

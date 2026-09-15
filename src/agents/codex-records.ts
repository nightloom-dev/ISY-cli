/**
 * Codex CLI keeps a session as a `rollout-*.jsonl` event log: one JSON object
 * per line, `{timestamp, type, payload}`. The conversation lives in
 * `type: "response_item"` lines; everything else is bookkeeping.
 *
 * Output is Claude-Code-record-shaped JSONL, because the server re-parses the
 * uploaded transcript with the same parseLines this package exports. One shape
 * downstream, one adapter here.
 *
 * Everything here is deliberately tolerant: an unrecognised shape yields no
 * record rather than a wrong one.
 */

/** Codex runs shell commands under several tool names across builds. */
const SHELL_TOOLS = new Set(["exec_command", "shell", "shell_command", "local_shell_call"]);

/** A call into the `exec` harness's own tools, inside the JS snippet Codex runs. */
const HARNESS_CALL = /tools\.(exec_command|apply_patch)\s*\(/g;
/** `({cmd:"…"` — bare or quoted key — and nothing glued onto the literal after it. */
const CMD_ARGUMENT = /^\s*\{[^}]*?(?:\bcmd|"cmd")\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/s;
/** `("*** Begin Patch…")` — one string literal and nothing glued onto it. */
const PATCH_ARGUMENT = /^\s*("(?:[^"\\]|\\.)*")\s*[,)]/s;
/** Any call into the harness, to tell a script that only looks from one that may write. */
const ANY_HARNESS_CALL = /tools\.([A-Za-z0-9_]+)\s*\(/g;
/** Harness tools that fetch or look and never touch the working tree. */
const READ_ONLY_HARNESS = new Set(["web__run", "view_image", "image_gen__imagegen"]);
/** An `exec` script that outran its yield; a later `wait` names this cell. */
const RUNNING_CELL = /^Script running with cell ID (\S+)/;
/** A command that outran its yield leaves its shell session's id in the result. */
const EXEC_SESSION = /"session_id"\s*:\s*(\d+)/g;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A Codex rollout opens with its session_meta line. */
export function isCodexTranscript(firstLine: string): boolean {
  try {
    const parsed: unknown = JSON.parse(firstLine);
    return isObject(parsed) && parsed.type === "session_meta";
  } catch {
    return false;
  }
}

/** Text out of a content array of `{type, text}` parts, or a plain string. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (isObject(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/**
 * Reasoning Codex actually recorded in the clear. `encrypted_content` is an
 * opaque blob — megabytes of it per session — and is deliberately dropped:
 * it cannot be analysed and must never reach the server.
 */
function reasoningText(payload: Record<string, unknown>): string | undefined {
  const summary = contentText(payload.summary);
  const content = contentText(payload.content);
  const text = [summary, content].filter((part) => part.length > 0).join("\n");
  return text.length > 0 ? text : undefined;
}

interface PatchEdit {
  tool: string;
  input: Record<string, unknown>;
}

interface Hunk {
  old_string: string;
  new_string: string;
}

/**
 * One `apply_patch` envelope as Claude-shaped edit tool calls.
 *
 * A patch can touch several files, so this returns one call per file:
 * `MultiEdit` carries every hunk of an updated file as an `edits` array, which
 * is the shape parser.ts already unpacks into per-hunk FileEdits.
 */
export function parseApplyPatch(patch: string): PatchEdit[] {
  const edits: PatchEdit[] = [];

  /** The file section being read: an update collecting hunks, or a new file. */
  let update: { path: string; hunks: Hunk[]; open?: { old: string[]; new: string[] } } | undefined;
  let added: { path: string; body: string[] } | undefined;

  const closeHunk = (): void => {
    if (!update?.open) return;
    // A section with no `+`/`-` at all is context Codex emitted for position only.
    if (update.open.old.length > 0 || update.open.new.length > 0) {
      update.hunks.push({
        old_string: update.open.old.join("\n"),
        new_string: update.open.new.join("\n"),
      });
    }
    update.open = undefined;
  };

  const closeFile = (): void => {
    closeHunk();

    if (update) {
      if (update.hunks.length > 0) {
        edits.push({ tool: "MultiEdit", input: { file_path: update.path, edits: update.hunks } });
      } else {
        // A file named by the patch with nothing parsed under it: still an edit,
        // just one whose before and after we could not recover.
        edits.push({ tool: "Edit", input: { file_path: update.path } });
      }
      update = undefined;
    }

    if (added) {
      edits.push({ tool: "Write", input: { file_path: added.path, content: added.body.join("\n") } });
      added = undefined;
    }
  };

  for (const line of patch.split("\n")) {
    const updating = /^\*\*\* (?:Update|Move) File: (.+)$/.exec(line);
    if (updating) {
      closeFile();
      update = { path: updating[1]!.trim(), hunks: [] };
      continue;
    }

    const adding = /^\*\*\* Add File: (.+)$/.exec(line);
    if (adding) {
      closeFile();
      added = { path: adding[1]!.trim(), body: [] };
      continue;
    }

    const deleting = /^\*\*\* Delete File: (.+)$/.exec(line);
    if (deleting) {
      closeFile();
      // Nothing records what the file held, so this is an edit with no diff.
      edits.push({ tool: "Edit", input: { file_path: deleting[1]!.trim() } });
      continue;
    }

    if (/^\*\*\* (?:Begin|End) Patch\s*$/.test(line)) {
      closeFile();
      continue;
    }

    if (added) {
      if (line.startsWith("+")) added.body.push(line.slice(1));
      continue;
    }

    if (!update) continue;

    if (line.startsWith("@@")) {
      closeHunk();
      update.open = { old: [], new: [] };
      continue;
    }

    update.open ??= { old: [], new: [] };
    if (line.startsWith("-")) update.open.old.push(line.slice(1));
    else if (line.startsWith("+")) update.open.new.push(line.slice(1));
    else if (line.startsWith(" ")) {
      // Context belongs to both sides, so old_string and new_string stay
      // anchored the way an Edit's own strings are.
      update.open.old.push(line.slice(1));
      update.open.new.push(line.slice(1));
    }
  }

  closeFile();
  return edits;
}


/** A JS string literal as its text, when it is also valid JSON. */
function literalText(literal: string): string | undefined {
  try {
    const text: unknown = JSON.parse(literal);
    return typeof text === "string" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Every tool call an `exec` harness script makes, in order: each
 * `tools.exec_command` as a Bash call and each `tools.apply_patch` as the edits
 * it applies. Newer Codex builds route nearly everything through this harness,
 * so reading only its first command left their edits invisible to stage 0.
 *
 * `opaque` says a call was there whose argument is not one plain literal —
 * `{cmd: "sed -n '" + range + "p' a.ts"}`, a variable, a patch that parsed to
 * nothing. Half a command would lie to the shell detectors, so such a call is
 * left out, and the script keeps its own name beside what was read.
 *
 * ponytail: literal arguments only; reading the rest means running the snippet.
 */
function harnessCalls(script: string): { calls: PatchEdit[]; opaque: boolean } {
  const calls: PatchEdit[] = [];
  let opaque = false;

  for (const match of script.matchAll(HARNESS_CALL)) {
    const rest = script.slice(match.index + match[0].length);
    const shell = match[1] === "exec_command";
    const literal = (shell ? CMD_ARGUMENT : PATCH_ARGUMENT).exec(rest)?.[1];
    const text = literal === undefined ? undefined : literalText(literal);
    const read: PatchEdit[] =
      text === undefined ? [] : shell ? [{ tool: "Bash", input: { command: text } }] : parseApplyPatch(text);

    if (read.length === 0) opaque = true;
    calls.push(...read);
  }
  return { calls, opaque };
}

/**
 * The shell session a script does nothing but poll: one `tools.write_stdin`
 * that types nothing. It is how Codex waits on a command that outran its
 * yield, as `wait` is for a script. Typing into the shell is an act of its own,
 * and stays a tool.
 */
function polledSession(script: string): string | undefined {
  const used = [...script.matchAll(ANY_HARNESS_CALL)];
  if (used.length !== 1 || used[0]![1] !== "write_stdin") return undefined;
  if (!/\bchars"?\s*:\s*""/.test(script)) return undefined;
  return /\bsession_id"?\s*:\s*(\d+)/.exec(script)?.[1];
}

/** JSON arguments, whether Codex sent an object or a serialised string. */
function toolArguments(payload: Record<string, unknown>): Record<string, unknown> {
  const raw = payload.arguments ?? payload.input;
  if (isObject(raw)) return raw;
  if (typeof raw !== "string") return {};

  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    // A truncated or non-JSON argument string: keep the call, lose the
    // arguments. Better than dropping the tool use entirely.
    return {};
  }
}

/**
 * An argv array as a command line. A `sh -c` wrapper unwraps to its script;
 * anything else is the command itself, joined whole.
 */
function argvCommand(argv: unknown[]): string | undefined {
  const parts = argv.filter((part): part is string => typeof part === "string");
  if (parts.length === 0) return undefined;
  // `["bash", "-lc", "<script>"]` — the script is the command that ran.
  const shellish = /(?:^|\/)(?:ba|z)?sh$/.test(parts[0]!);
  const flag = shellish ? parts.findIndex((part, i) => i > 0 && /^-[a-z]*c/.test(part)) : -1;
  if (flag >= 0) return flag + 1 < parts.length ? parts[flag + 1] : undefined;
  return parts.join(" ");
}

/** The shell command behind a Codex tool call, whatever wrapper it arrived in. */
function shellCommand(name: string, payload: Record<string, unknown>): string | undefined {
  if (SHELL_TOOLS.has(name)) {
    const args = toolArguments(payload);
    const direct = asString(args.cmd) ?? asString(args.command);
    if (direct) return direct;
    // Older builds send an argv array, as the Responses API shell tool does;
    // `local_shell_call` keeps it under `action.command` instead.
    const argv = Array.isArray(args.command)
      ? args.command
      : isObject(payload.action) && Array.isArray(payload.action.command)
        ? payload.action.command
        : undefined;
    return argv ? argvCommand(argv) : undefined;
  }

  return undefined;
}

/**
 * Tool_use blocks for calls that share one Codex call id. Only the block at
 * `owner` keeps the bare id, so the tool result still lands on it; the rest
 * are suffixed to stay unique.
 */
function sharedIdBlocks(calls: PatchEdit[], callId: string, owner: number): Record<string, unknown>[] {
  return calls.map((call, index) => ({
    type: "tool_use",
    id: index === owner ? callId : `${callId}#${index}`,
    name: call.tool,
    input: call.input,
  }));
}

/** Claude-shaped tool_use blocks for one Codex tool call. */
function toolUseBlocks(payload: Record<string, unknown>): Record<string, unknown>[] {
  // A `local_shell_call` has no `name` — its type is the tool's name.
  const name = asString(payload.name) ?? (payload.type === "local_shell_call" ? "local_shell_call" : undefined);
  const callId = asString(payload.call_id) ?? asString(payload.id);
  if (!name || !callId) return [];

  if (name === "exec") {
    const script = asString(payload.input) ?? "";
    // A script that only searches the web or looks at an image writes nothing,
    // so it keeps the harness tool's own name, which parser.ts knows is no edit.
    const used = [...script.matchAll(ANY_HARNESS_CALL)].map((match) => match[1]!);
    if (used.length > 0 && used.every((tool) => READ_ONLY_HARNESS.has(tool))) {
      const looks = used.map((tool, index) => ({ tool, input: index === 0 ? { script } : {} }));
      return sharedIdBlocks(looks, callId, 0);
    }

    const { calls, opaque } = harnessCalls(script);
    // Nothing read, or not all of it: the harness stays in view under its own
    // name, which parser.ts counts as a tool that may have edited a file.
    if (calls.length === 0 || opaque) calls.push({ tool: "exec", input: { script: payload.input } });
    // One result comes back for the whole script, and it goes to the first
    // command: the failure detectors read Bash results, an edit has none.
    // ponytail: a script running several commands pins all their output on the
    // first; splitting it needs the harness's `text()` parts matched to calls.
    const firstCommand = calls.findIndex((call) => call.tool === "Bash");
    return sharedIdBlocks(calls, callId, Math.max(firstCommand, 0));
  }

  const command = shellCommand(name, payload);
  if (command !== undefined) {
    return [{ type: "tool_use", id: callId, name: "Bash", input: { command } }];
  }

  if (name === "apply_patch") {
    const patch = asString(payload.input) ?? asString(toolArguments(payload).input);
    const edits = patch ? parseApplyPatch(patch) : [];
    if (edits.length > 0) return sharedIdBlocks(edits, callId, 0);
  }

  // Anything else — update_plan, MCP calls — is kept under its own name so it
  // still counts as a tool use.
  return [{ type: "tool_use", id: callId, name, input: toolArguments(payload) }];
}

/** The text of a tool result, whichever output shape Codex used. */
function outputText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (typeof output === "string") return output;
  return contentText(output);
}

/**
 * Codex exec output carries its exit code — as "Process exited with code N" in
 * plain text, as `metadata.exit_code` in a JSON envelope, or as `exit_code` in
 * each result object an `exec` script prints under its plain-text header, so
 * the output never parses whole. A non-zero code is what Claude records as
 * `is_error`, and the failure detectors key off it; any failing command fails
 * the call. An `exit_code` quoted inside an output string is escaped, and does
 * not match.
 */
function execFailed(text: string): boolean {
  const exited = /Process exited with code (\d+)/.exec(text);
  if (exited) return exited[1] !== "0";
  return [...text.matchAll(/"exit_code"\s*:\s*(-?\d+)/g)].some((code) => code[1] !== "0");
}

export interface CodexOptions {
  sessionId?: string;
  cwd?: string;
  version?: string;
}

/** Turn one Codex rollout into Claude-shaped transcript records. */
export function toClaudeRecords(rollout: Iterable<string>, options: CodexOptions = {}): string[] {
  const out: string[] = [];
  let index = 0;
  let parent: string | null = null;

  let sessionId = options.sessionId;
  let cwd = options.cwd;
  let version = options.version;

  /** Call ids of `exec` scripts: only their output can name a running cell. */
  const scripts = new Set<string>();
  /** A script that outran its yield, by cell id, to the call id that started it. */
  const cells = new Map<string, string>();
  /** A `wait` on a known cell, to that script's call id. */
  const waits = new Map<string, string>();
  /** A shell session still running, by its id, to the script that started it. */
  const shells = new Map<string, string>();

  const emit = (record: Record<string, unknown>): void => {
    const uuid = `codex-${index}`;
    out.push(
      JSON.stringify({
        ...record,
        uuid,
        parentUuid: parent,
        sessionId,
        cwd,
        version: version ?? "codex",
        isSidechain: false,
      }),
    );
    parent = uuid;
    index += 1;
  };

  for (const line of rollout) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;

    const timestamp = asString(parsed.timestamp);
    const payload = isObject(parsed.payload) ? parsed.payload : undefined;
    if (!payload) continue;

    if (parsed.type === "session_meta") {
      // `base_instructions` is the frozen system prompt: never ours to analyse
      // and never worth uploading.
      sessionId ??= asString(payload.session_id) ?? asString(payload.id);
      cwd ??= asString(payload.cwd);
      version ??= asString(payload.cli_version);
      continue;
    }

    // `event_msg` restates what `response_item` already records, and
    // `turn_context` / `world_state` are bookkeeping.
    if (parsed.type !== "response_item") continue;

    const kind = asString(payload.type);

    if (kind === "message") {
      const role = asString(payload.role);
      // `developer` messages are harness-injected context, not the user's work.
      if (role !== "user" && role !== "assistant") continue;

      const text = contentText(payload.content);
      if (!text) continue;

      emit({
        type: role,
        timestamp,
        message: { role, content: [{ type: "text", text }] },
      });
      continue;
    }

    if (kind === "reasoning") {
      const thinking = reasoningText(payload);
      if (!thinking) continue;
      emit({
        type: "assistant",
        timestamp,
        message: { role: "assistant", content: [{ type: "thinking", thinking }] },
      });
      continue;
    }

    if (kind === "function_call" || kind === "custom_tool_call" || kind === "local_shell_call") {
      const callId = asString(payload.call_id);
      if (callId && payload.name === "exec") {
        // A poll on a shell this rollout started folds into the script that
        // started it, for the same reason a `wait` does below.
        const polled = shells.get(polledSession(asString(payload.input) ?? "") ?? "");
        if (polled) {
          waits.set(callId, polled);
          continue;
        }
        scripts.add(callId);
      }
      // `wait` polls a script that outran its yield. The script is the tool use
      // and the wait only how its result arrived, so the result goes back to the
      // script, where the failure detectors read its exit code. A wait on a cell
      // this rollout never started stays a tool of its own.
      if (callId && payload.name === "wait") {
        const script = cells.get(String(toolArguments(payload).cell_id));
        if (script) {
          waits.set(callId, script);
          continue;
        }
      }
      const blocks = toolUseBlocks(payload);
      if (blocks.length === 0) continue;
      emit({ type: "assistant", timestamp, message: { role: "assistant", content: blocks } });
      continue;
    }

    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const callId = asString(payload.call_id);
      if (!callId) continue;
      const text = outputText(payload);
      const failed = execFailed(text);

      const running = scripts.has(callId) ? RUNNING_CELL.exec(text) : null;
      if (running) cells.set(running[1]!, callId);
      if (scripts.has(callId)) {
        for (const shell of text.matchAll(EXEC_SESSION)) if (!shells.has(shell[1]!)) shells.set(shell[1]!, callId);
      }
      // Each poll replaces the result before it — the parser keeps a tool's last
      // one — so the script ends up carrying its final exit code.
      // ponytail: earlier polls' output is replaced, not joined; join them when
      // a detector needs the whole output of a long script.
      const id = waits.get(callId) ?? callId;

      emit({
        type: "user",
        timestamp,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: id, content: text, ...(failed ? { is_error: true } : {}) },
          ],
        },
        toolUseResult: { stdout: text },
      });
    }
  }

  return out;
}

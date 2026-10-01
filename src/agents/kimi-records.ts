import { claudeTool, wholeFileRead } from "./kimi-tools.js";

/**
 * Kimi CLI keeps a session as `context.jsonl` (kosong Message records) plus an
 * append-only `wire.jsonl` event log. Neither is documented field by field, so
 * everything here is deliberately tolerant: an unrecognised shape yields no
 * record rather than a wrong one.
 *
 * Output is Claude-Code-record-shaped JSONL, because the server re-parses the
 * uploaded transcript with the same parseLines this package exports. One shape
 * downstream, one adapter here.
 */

/** Kimi's own bookkeeping roles, which are not conversation turns. */
const CONTROL_ROLES = new Set(["_system_prompt", "_usage", "_checkpoint"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A Kimi transcript opens with the frozen system prompt record. */
export function isKimiTranscript(firstLine: string): boolean {
  try {
    const parsed: unknown = JSON.parse(firstLine);
    return isObject(parsed) && parsed.role === "_system_prompt";
  } catch {
    return false;
  }
}

/** Text out of `content`, which may be a plain string or an array of parts. */
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
 * Reasoning, wherever this Kimi build happens to put it: a `reasoning_content`
 * field, or content parts — `think` is Kimi CLI's own (`{type: "think", think}`),
 * and the only one it writes, so reading `thinking` and `reasoning` alone lost
 * every thought a real session recorded. A part left empty still says the model
 * reasoned (the parser counts it as hidden), so it comes through as an empty
 * block rather than as nothing.
 */
function reasoningParts(line: Record<string, unknown>): string[] | undefined {
  const direct = asString(line.reasoning_content) ?? asString(line.reasoning);
  if (direct) return [direct];

  const content = line.content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    if (part.type !== "think" && part.type !== "thinking" && part.type !== "reasoning") continue;
    const text = [part.think, part.thinking, part.text, part.reasoning].find((value) => typeof value === "string");
    parts.push(typeof text === "string" ? text : "");
  }
  return parts.length > 0 ? parts : undefined;
}

/** Kimi CLI prefixes a failed call's result with this, and has no other error flag here. */
const FAILED_RESULT = /^<system>ERROR:/;
/** The status line Kimi CLI puts ahead of a result: `<system>…</system>`. */
const RESULT_STATUS = /^<system>([\s\S]*?)<\/system>/;

/** Tool calls, whether OpenAI-style `tool_calls` or inline content parts. */
function toolUseBlocks(line: Record<string, unknown>): Record<string, unknown>[] {
  const raw: unknown[] = Array.isArray(line.tool_calls)
    ? line.tool_calls
    : Array.isArray(line.content)
      ? line.content.filter(
          (part) => isObject(part) && (part.type === "tool_call" || part.type === "tool_use"),
        )
      : [];

  const blocks: Record<string, unknown>[] = [];
  for (const call of raw) {
    if (!isObject(call)) continue;

    const fn = isObject(call.function) ? call.function : call;
    const name = asString(fn.name);
    const id = asString(call.id) ?? asString(call.tool_call_id);
    if (!name || !id) continue;

    const rawArgs = fn.arguments ?? fn.input ?? call.input;
    let input: Record<string, unknown> = {};
    if (isObject(rawArgs)) {
      input = rawArgs;
    } else if (typeof rawArgs === "string") {
      try {
        const parsed: unknown = JSON.parse(rawArgs);
        if (isObject(parsed)) input = parsed;
      } catch {
        // A truncated or streaming-partial argument string: keep the call,
        // lose the arguments. Better than dropping the tool use entirely.
      }
    }

    const use = claudeTool(name, input);
    blocks.push({ type: "tool_use", id, name: use.name, input: use.input });
  }
  return blocks;
}

export interface KimiOptions {
  sessionId: string;
  cwd?: string;
  version?: string;
  /** `wire.jsonl` lines, if present: they hold turns a rewind discarded. */
  wire?: Iterable<string>;
}

/** Identity of a turn, used to tell surviving context from discarded wire. */
function digest(line: Record<string, unknown>): string {
  const tools = toolUseBlocks(line)
    .map((block) => `${String(block.name)}(${JSON.stringify(block.input)})`)
    .join(",");
  return `${String(line.role)}|${contentText(line.content).trim().replace(/\s+/g, " ")}|${tools}`;
}

function parseLines(lines: Iterable<string>): Record<string, unknown>[] {
  const parsed: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isObject(value)) parsed.push(value);
    } catch {
      continue;
    }
  }
  return parsed;
}

/**
 * Pull message-shaped payloads out of wire events. The wire schema is not
 * documented, so we look for a `role` at the top level or under the handful of
 * keys an event stream plausibly nests one in. An unrecognised event yields
 * nothing, which degrades this to context-only rather than to wrong output.
 */
function wireMessages(lines: Iterable<string>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const event of parseLines(lines)) {
    for (const candidate of [event, event.message, event.data, event.payload]) {
      if (!isObject(candidate)) continue;
      if (typeof candidate.role !== "string") continue;
      if (CONTROL_ROLES.has(candidate.role)) continue;
      found.push(candidate);
      break;
    }
  }
  return found;
}

/**
 * Turn one Kimi session into Claude-shaped transcript records.
 *
 * Surviving `context.jsonl` turns form the main path. Turns that appear only in
 * `wire.jsonl` were discarded by a `_checkpoint` rewind: they hang off the fork
 * point as a side branch, which is exactly the shape onAbandonedBranch already
 * understands, so abandoned_approach works here as it does on Claude.
 */
export function toClaudeRecords(context: Iterable<string>, options: KimiOptions): string[] {
  const lines = parseLines(context);
  const surviving = new Set(lines.filter((line) => !CONTROL_ROLES.has(String(line.role))).map(digest));

  const discarded = options.wire
    ? wireMessages(options.wire).filter((message) => !surviving.has(digest(message)))
    : [];

  const firstCheckpoint = lines.findIndex((line) => line.role === "_checkpoint");
  // Only graft a branch when real work follows the fork, so the session's last
  // record — the tip buildMainPath walks back from — is always a surviving one.
  const forkAt = firstCheckpoint >= 0 && firstCheckpoint < lines.length - 1 ? firstCheckpoint : -1;

  const out: string[] = [];
  let index = 0;
  let tail: string | null = null;

  const emit = (record: Record<string, unknown>, parent: string | null): string => {
    const uuid = `kimi-${index}`;
    out.push(
      JSON.stringify({
        ...record,
        uuid,
        parentUuid: parent,
        sessionId: options.sessionId,
        cwd: options.cwd,
        version: options.version ?? "kimi",
        isSidechain: false,
      }),
    );
    index += 1;
    return uuid;
  };

  /** What each call asked for, by id: a `ReadFile` result is only the file given its call. */
  const calls = new Map<string, Record<string, unknown>>();

  const emitTurn = (line: Record<string, unknown>, parent: string | null): string | undefined => {
    const role = String(line.role);
    const timestamp = asString(line.timestamp) ?? asString(line.created_at);

    if (role === "tool") {
      const id = asString(line.tool_call_id);
      if (!id) return undefined;
      const text = contentText(line.content);
      const failed = FAILED_RESULT.test(text);
      // What the tool printed, without the status line Kimi put ahead of it.
      const status = RESULT_STATUS.exec(text);
      const output = status ? text.slice(status[0].length).replace(/^\n/, "") : text;
      const call = calls.get(id);
      const file =
        call?.name === "Read" && !failed && typeof call.input === "object" && status
          ? wholeFileRead(output, status[1]!)
          : undefined;
      const filePath = isObject(call?.input) ? call.input.file_path : undefined;
      return emit(
        {
          type: "user",
          timestamp,
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, content: text, ...(failed ? { is_error: true } : {}) }],
          },
          toolUseResult:
            file !== undefined && typeof filePath === "string"
              ? {
                  type: "text",
                  file: {
                    filePath,
                    content: file,
                    numLines: file.split("\n").length,
                    startLine: 1,
                    totalLines: file.split("\n").length,
                  },
                }
              : { stdout: output },
        },
        parent,
      );
    }

    if (role === "assistant") {
      const blocks: Record<string, unknown>[] = [];
      for (const thinking of reasoningParts(line) ?? []) blocks.push({ type: "thinking", thinking });
      const text = contentText(line.content);
      if (text) blocks.push({ type: "text", text });
      const uses = toolUseBlocks(line);
      for (const use of uses) calls.set(String(use.id), use);
      blocks.push(...uses);
      if (blocks.length === 0) return undefined;

      return emit(
        { type: "assistant", timestamp, message: { role: "assistant", content: blocks } },
        parent,
      );
    }

    if (role !== "user") return undefined;
    const text = contentText(line.content);
    if (!text) return undefined;
    return emit(
      { type: "user", timestamp, message: { role: "user", content: [{ type: "text", text }] } },
      parent,
    );
  };

  lines.forEach((line, position) => {
    if (position === forkAt) {
      // The discarded branch forks from the turn before the checkpoint and is
      // deliberately left off the main chain: `tail` does not move.
      let branch = tail;
      for (const message of discarded) branch = emitTurn(message, branch) ?? branch;
      return;
    }
    if (CONTROL_ROLES.has(String(line.role))) return;

    const uuid = emitTurn(line, tail);
    if (uuid) tail = uuid;
  });

  return out;
}

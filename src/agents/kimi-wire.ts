import { renameArgs } from "./kimi-records.js";

/**
 * The second shape a Kimi session can take on disk. Newer builds keep no
 * `context.jsonl` at all: the whole session is one append-only event log at
 * `agents/<name>/wire.jsonl`, whose records are wrapper events rather than
 * messages.
 *
 * Kept apart from the `context.jsonl` reader rather than folded into it: the
 * two formats share no field, and a reader that tried to serve both would
 * guess. Which one a session uses is decided by sniffing its first line.
 *
 * ponytail: a rewind has no representation here that this corpus shows, so the
 * output is one linear chain and `onAbandonedBranch` finds nothing — the
 * content-revert detectors still fire. Graft the branch once a real rewound
 * session shows what marks the fork.
 */

const CONTENT_EVENTS = new Set(["content.part", "tool.call", "tool.result"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A wire log opens with its own protocol metadata. */
export function isKimiWireTranscript(firstLine: string): boolean {
  try {
    const parsed: unknown = JSON.parse(firstLine);
    return isObject(parsed) && parsed.type === "metadata" && "protocol_version" in parsed;
  } catch {
    return false;
  }
}

function stamp(time: unknown): string | undefined {
  if (typeof time !== "number" || !Number.isFinite(time)) return undefined;
  return new Date(time).toISOString();
}

/** Text out of a tool result, which carries `output` and an optional `note`. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!isObject(result)) return "";
  return asString(result.output) ?? asString(result.note) ?? "";
}

export interface KimiWireOptions {
  sessionId: string;
  cwd?: string;
  version?: string;
}

export function wireToClaudeRecords(
  lines: Iterable<string>,
  options: KimiWireOptions,
): string[] {
  const out: string[] = [];
  let index = 0;
  let parent: string | null = null;

  const emit = (record: Record<string, unknown>): void => {
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
    parent = uuid;
    index += 1;
  };

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;

    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      // A half-written last line while the session is still running.
      continue;
    }
    if (!isObject(event)) continue;

    const timestamp = stamp(event.time);

    // A whole user or assistant message, appended outside the agent loop.
    if (event.type === "context.append_message" && isObject(event.message)) {
      const message = event.message;
      const role = asString(message.role);
      if (role !== "user" && role !== "assistant") continue;

      const content = Array.isArray(message.content)
        ? message.content
            .filter((part): part is Record<string, unknown> => isObject(part) && part.type === "text")
            .map((part) => ({ type: "text", text: asString(part.text) ?? "" }))
            .filter((part) => part.text.length > 0)
        : typeof message.content === "string" && message.content.length > 0
          ? [{ type: "text", text: message.content }]
          : [];
      if (content.length === 0) continue;

      emit({ type: role, timestamp, message: { role, content } });
      continue;
    }

    if (event.type !== "context.append_loop_event" || !isObject(event.event)) continue;

    const inner = event.event;
    const kind = asString(inner.type);
    if (!kind || !CONTENT_EVENTS.has(kind)) continue;

    if (kind === "content.part" && isObject(inner.part)) {
      const part = inner.part;
      // Kimi calls reasoning "think"; the detectors look for Claude's "thinking".
      const thinking = asString(part.think) ?? asString(part.thinking);
      const said = asString(part.text);
      const block =
        part.type === "think" && thinking
          ? { type: "thinking", thinking }
          : said
            ? { type: "text", text: said }
            : undefined;
      if (!block) continue;

      emit({ type: "assistant", timestamp, message: { role: "assistant", content: [block] } });
      continue;
    }

    if (kind === "tool.call") {
      const name = asString(inner.name);
      const id = asString(inner.toolCallId);
      if (!name || !id) continue;
      const args = isObject(inner.args) ? inner.args : {};

      emit({
        type: "assistant",
        timestamp,
        message: {
          role: "assistant",
          // Kimi names the file argument `path`; every downstream detector
          // reads `file_path`, so the rename happens once, here.
          content: [{ type: "tool_use", id, name, input: renameArgs(name, args) }],
        },
      });
      continue;
    }

    const id = asString(inner.toolCallId);
    if (!id) continue;
    const output = resultText(inner.result);
    // Kimi 0.38 flags a failed call with `isError`.
    const failed = isObject(inner.result) && (inner.result.isError === true || inner.result.error !== undefined);

    emit({
      type: "user",
      timestamp,
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: output, ...(failed ? { is_error: true } : {}) },
        ],
      },
      toolUseResult: { stdout: output },
    });
  }

  return out;
}

import { claudeTool, wholeFileRead } from "./kimi-tools.js";
import { Timelines, boundOf, stamped } from "./timeline.js";

/**
 * Kimi CLI's own event log — `wire.jsonl` beside `state.json`, as the Python
 * `kimi-cli` 1.x writes it up to its last release, 1.52. The first line is
 * `{"type":"metadata","protocol_version":"1.10"}`; every line after it is an
 * envelope, `{"timestamp": <epoch seconds>, "message": {"type", "payload"}}`.
 *
 * This log is the session, not `context.jsonl` next to it: the context is what
 * the model is shown and is rotated away on `/clear`, compaction and D-Mail, it
 * carries no time and no error flag, and it never holds a subagent's calls. The
 * wire log has all of that, each foreground subagent's events wrapped in
 * `SubagentEvent` under the `Agent` call that started it. A subagent sent to the
 * background writes to its own log only, `subagents/<id>/wire.jsonl`, and the
 * session's log says no more than that it started: the call's result names the
 * agent. That log goes in by time from there (`timeline.ts`), the way a Claude
 * Code subagent does; a foreground subagent's own log repeats what the
 * session's already holds, and is not read.
 *
 * Output is Claude-Code-record-shaped JSONL, because the server re-parses the
 * uploaded transcript with the same parseLines this package exports. A
 * subagent's records come out as a sidechain with its own chain, linked to its
 * call by `parentToolUseID` — the shape `subagents.ts` gives Claude's.
 *
 * ponytail: a D-Mail revert (`SendDMail`) rewinds the context, but the log goes
 * on linearly past it, so what it discarded stays on the main path; the
 * content-revert detectors still see an undone edit. Graft a branch when a
 * session shows how a revert is marked in the log.
 *
 * ponytail: a subagent is read one way for the whole session — from the
 * session's log once any of its runs was in the foreground, from its own log
 * otherwise — so the background runs of one that also ran in the foreground are
 * left out. Split its own log into runs at `TurnBegin` if that shows up.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** An event line as the reader sees it, whichever log it came from. */
interface Envelope {
  type: string;
  payload: Record<string, unknown>;
}

function envelope(value: unknown): Envelope | undefined {
  if (!isObject(value) || typeof value.type !== "string" || !isObject(value.payload)) return undefined;
  return { type: value.type, payload: value.payload };
}

/**
 * Whether these lines are this log: a metadata header followed by envelopes.
 * Kimi Code writes a header of the same shape and different events after it
 * (`kimi-wire.ts`), so the first event line decides, not the header.
 */
export function isKimiCliWire(lines: readonly string[]): boolean {
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isObject(parsed)) return false;
      if (parsed.type === "metadata") continue;
      return typeof parsed.timestamp === "number" && envelope(parsed.message) !== undefined;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Epoch seconds, as `time.time()` writes them, in milliseconds. A time no date
 * can hold is no time: one bad line must not make the whole session unreadable.
 */
function millis(time: unknown): number | undefined {
  if (typeof time !== "number" || !Number.isFinite(time)) return undefined;
  const at = time * 1000;
  return Number.isNaN(new Date(at).getTime()) ? undefined : at;
}

function stamp(time: unknown): string | undefined {
  const at = millis(time);
  return at === undefined ? undefined : new Date(at).toISOString();
}

/** One log's events with the time each was written, a line that does not parse left out. */
function* entries(lines: Iterable<string>): Generator<{ event: Envelope; time: unknown }> {
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A half-written last line while the session is still running.
      continue;
    }
    if (!isObject(parsed)) continue;
    const event = envelope(parsed.message);
    if (event) yield { event, time: parsed.timestamp };
  }
}

/** Text out of a user input or a tool's output: a string, or a list of content parts. */
function partsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is Record<string, unknown> => isObject(part) && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isObject(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isObject(parsed) ? parsed : {};
  } catch {
    // Arguments cut off mid-stream: keep the call, lose the arguments.
    return {};
  }
}

export interface KimiCliWireOptions {
  sessionId: string;
  cwd?: string;
  /** The Kimi CLI version that ran the session, when anything on disk says. */
  version?: string;
  /** The model the session ran on, when anything on disk says. */
  model?: string;
  /** Each subagent's own log, `subagents/<id>/wire.jsonl`, by agent id. */
  subagents?: ReadonlyMap<string, Iterable<string>>;
}

/** One conversation's place in the output: the session's own, or one subagent's. */
interface Thread {
  parent: string | null;
  /**
   * Its records' ids, `<name>-<n>`, numbered within its own log rather than
   * the output: a background subagent's records land between the session's by
   * time, and a count over both would renumber the session's every time the
   * subagent wrote more — and with them what `state.ts:candidateKey` keys on.
   * A subagent read from its own log is named apart from one the session's log
   * carried, since the same agent can have run both ways.
   */
  name: string;
  emitted: number;
  sidechain?: { agentId?: string; call?: string };
}

export function kimiCliWireToClaudeRecords(lines: Iterable<string>, options: KimiCliWireOptions): string[] {
  const out: string[] = [];
  const main: Thread = { parent: null, name: "kimi", emitted: 0 };
  /** Subagents whose events came through the session's own log, by agent id — or call, where no id was written. */
  const inline = new Map<string, Thread>();
  /** Subagents read from their own log, by agent id. */
  const background = new Map<string, Thread>();
  const running = new Timelines<{ thread: Thread; event: Envelope; time: unknown }>();
  /** What each call asked for, by id: a `ReadFile` result is only the file given its call. */
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();

  const logOf = (thread: Thread, source: Iterable<string>, from: number) =>
    stamped(
      [...entries(source)].map((entry) => ({ thread, ...entry })),
      (item) => millis(item.time),
      from,
    );

  /**
   * An `Agent` call's result names the subagent it ran. One whose events never
   * came through the session's log ran in the background, and its own log goes
   * in from here; named again, it was resumed, and what it writes from now on
   * answers this call.
   */
  const named = (agentId: string, call: string, at: number): void => {
    if (inline.has(agentId)) return;
    const known = background.get(agentId);
    if (known) {
      if (known.sidechain) known.sidechain.call = call;
      return;
    }
    const source = options.subagents?.get(agentId);
    if (!source) return;
    const thread: Thread = { parent: null, name: `kimi-log-${agentId}`, emitted: 0, sidechain: { agentId, call } };
    background.set(agentId, thread);
    running.add(logOf(thread, source, at));
  };

  const emit = (thread: Thread, record: Record<string, unknown>): void => {
    const uuid = `${thread.name}-${thread.emitted}`;
    thread.emitted += 1;
    out.push(
      JSON.stringify({
        ...record,
        uuid,
        parentUuid: thread.parent,
        sessionId: options.sessionId,
        cwd: options.cwd,
        ...(options.version ? { version: options.version } : {}),
        isSidechain: thread.sidechain !== undefined,
        ...(thread.sidechain?.agentId ? { agentId: thread.sidechain.agentId } : {}),
        ...(thread.sidechain?.call ? { parentToolUseID: thread.sidechain.call } : {}),
      }),
    );
    thread.parent = uuid;
  };

  const say = (thread: Thread, timestamp: string | undefined, block: Record<string, unknown>): void => {
    emit(thread, {
      type: "assistant",
      timestamp,
      message: { role: "assistant", ...(options.model ? { model: options.model } : {}), content: [block] },
    });
  };

  const handle = (thread: Thread, event: Envelope, timestamp: string | undefined, at: number): void => {
    const { type, payload } = event;

    if (type === "TurnBegin" || type === "SteerInput") {
      const text = partsText(payload.user_input);
      if (text) emit(thread, { type: "user", timestamp, message: { role: "user", content: [{ type: "text", text }] } });
      return;
    }

    if (type === "ContentPart") {
      if (payload.type === "think") {
        // `encrypted` is an opaque signature or ciphertext: never ours to read,
        // never worth sending. An empty `think` still marks that reasoning happened.
        say(thread, timestamp, { type: "thinking", thinking: typeof payload.think === "string" ? payload.think : "" });
      } else if (payload.type === "text" && asString(payload.text)) {
        say(thread, timestamp, { type: "text", text: payload.text });
      }
      return;
    }

    if (type === "ToolCall") {
      const fn = isObject(payload.function) ? payload.function : {};
      const id = asString(payload.id);
      const name = asString(fn.name);
      if (!id || !name) return;
      const use = claudeTool(name, parseArguments(fn.arguments));
      calls.set(id, use);
      say(thread, timestamp, { type: "tool_use", id, name: use.name, input: use.input });
      return;
    }

    if (type === "ToolResult") {
      const id = asString(payload.tool_call_id);
      const value = isObject(payload.return_value) ? payload.return_value : {};
      if (!id) return;

      const output = partsText(value.output);
      const message = typeof value.message === "string" ? value.message : "";
      const failed = value.is_error === true;
      const call = calls.get(id);
      const file =
        call?.name === "Read" && !failed && typeof call.input.file_path === "string"
          ? wholeFileRead(output, message)
          : undefined;

      emit(thread, {
        type: "user",
        timestamp,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              // The message is where Kimi says what went wrong ("`a.ts` does not
              // exist.", "Command failed with exit code: 1."), so it leads.
              content: [message, output].filter((part) => part.length > 0).join("\n"),
              ...(failed ? { is_error: true } : {}),
            },
          ],
        },
        toolUseResult: file !== undefined
          ? {
              type: "text",
              file: {
                filePath: call!.input.file_path,
                content: file,
                numLines: file.split("\n").length,
                startLine: 1,
                totalLines: file.split("\n").length,
              },
            }
          : { stdout: output },
      });

      const agentId = call?.name === "Agent" && !failed ? /^agent_id: (\S+)$/m.exec(output)?.[1] : undefined;
      if (agentId) named(agentId, id, at);
      return;
    }

    if (type === "SubagentEvent") {
      const inner = envelope(payload.event);
      if (!inner) return;
      const agentId = asString(payload.agent_id);
      // Older builds named the call `task_tool_call_id`, after the `Task` tool.
      const call = asString(payload.parent_tool_call_id) ?? asString(payload.task_tool_call_id);
      const key = agentId ?? call ?? "subagent";
      let sub = inline.get(key);
      if (!sub) {
        sub = { parent: null, name: `kimi-${key}`, emitted: 0, sidechain: { agentId, call } };
        inline.set(key, sub);
      }
      // A resumed subagent keeps its thread and answers the call that resumed it.
      if (call && sub.sidechain) sub.sidechain.call = call;
      handle(sub, inner, timestamp, at);
    }
  };

  /** An event from a subagent's own log — unless the session's log turned out to carry that subagent after all. */
  const fromLog = ({ at, item }: { at: number; item: { thread: Thread; event: Envelope; time: unknown } }): void => {
    const agentId = item.thread.sidechain?.agentId;
    if (agentId && inline.has(agentId)) return;
    handle(item.thread, item.event, stamp(item.time), at);
  };

  let at = -Infinity;
  for (const { event, time } of entries(lines)) {
    at = millis(time) ?? at;
    for (const next of running.until(boundOf(at))) fromLog(next);
    handle(main, event, stamp(time), at);
  }
  for (const next of running.until(Infinity)) fromLog(next);

  // A log no result names still did the work, and follows the session. Not when
  // the session's log carried subagents without their ids: one of those could
  // be this one, read twice.
  const anonymous = [...inline.values()].some((thread) => thread.sidechain?.agentId === undefined);
  for (const [agentId, source] of anonymous ? [] : (options.subagents ?? [])) {
    if (inline.has(agentId) || background.has(agentId)) continue;
    const thread: Thread = { parent: null, name: `kimi-log-${agentId}`, emitted: 0, sidechain: { agentId } };
    background.set(agentId, thread);
    running.add(logOf(thread, source, -Infinity));
    for (const next of running.until(Infinity)) fromLog(next);
  }

  return out;
}

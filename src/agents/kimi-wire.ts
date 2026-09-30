import { claudeTool, wholeFileRead } from "./kimi-tools.js";
import { Timelines, boundOf, stamped } from "./timeline.js";

/**
 * Kimi Code's session log: `agents/<agent>/wire.jsonl` in a session folder,
 * written by the TypeScript CLI that replaced the Python Kimi CLI (0.38 and
 * 2.x alike, protocol 1.5). Its records are wrapper events rather than
 * messages: `context.append_message` for a message appended outside the agent
 * loop, `context.append_loop_event` for what the loop did — `content.part`,
 * `tool.call`, `tool.result` — each stamped with `time` in epoch milliseconds.
 *
 * Kept apart from the `context.jsonl` reader and from Kimi CLI's envelopes
 * (`kimi-cli-wire.ts`) rather than folded into one: the formats share no
 * field, and a reader that tried to serve all of them would guess.
 *
 * What 2.x added, and how it is read:
 * - A subagent writes a log of its own (`agents/agent-<n>/wire.jsonl`), and the
 *   main log says which call started it (`subagent.spawned`, with
 *   `parentToolCallId`). Its records go in by time from that point, as a
 *   sidechain with `parentToolUseID` — the shape and the rule Claude Code's
 *   subagents get (`subagents.ts`, `timeline.ts`): one run in the background
 *   works alongside the session. A resumed subagent is spawned again under the
 *   same id and goes on in the same log, so what it writes after the second
 *   spawn answers the second call. A subagent no record names — 0.x kept that
 *   link in memory only — still did the work, and comes after the session
 *   unlinked.
 * - `context.append_message` with a user role is not always the user: its
 *   `origin` says `injection` for the CLI's own reminders, `hook_result` for a
 *   hook's output (ISY's own alert drain among them), `system_trigger` for a
 *   subagent's prompt or a stop hook — `isTurn` says which are turns.
 * - `agent.message.appended` repeats every message a second time for the UI,
 *   and is not read.
 * - `llm.request` names the model each call went to.
 *
 * ponytail: a rewind (`context.undo`) is recorded, but the log goes on
 * linearly past it, so the output is one chain and `onAbandonedBranch` finds
 * nothing there — the content-revert detectors still fire. Graft the branch
 * from `agent.switched` once a session shows how its turns map to records.
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

/**
 * Epoch milliseconds, as Kimi Code writes them — or seconds, from a build that
 * wrote those. A time no date can hold is no time: one bad line must not make
 * the whole session unreadable.
 */
function millis(time: unknown): number | undefined {
  if (typeof time !== "number" || !Number.isFinite(time)) return undefined;
  const at = time < 1e11 ? time * 1000 : time;
  return Number.isNaN(new Date(at).getTime()) ? undefined : at;
}

function stamp(time: unknown): string | undefined {
  const at = millis(time);
  return at === undefined ? undefined : new Date(at).toISOString();
}

/** The events of one log, a line that does not parse left out: a half-written last line while the session runs. */
function* events(lines: Iterable<string>): Generator<Record<string, unknown>> {
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    let event: unknown;
    try {
      event = JSON.parse(text);
    } catch {
      continue;
    }
    if (isObject(event)) yield event;
  }
}

/**
 * The events after `until`, one without a time counted at the last time before
 * it: what came before is another session's (`KimiWireOptions.copiedUntil`).
 */
function* since(events: Iterable<Record<string, unknown>>, until: number | undefined): Generator<Record<string, unknown>> {
  if (until === undefined) {
    yield* events;
    return;
  }
  let at = -Infinity;
  for (const event of events) {
    at = millis(event.time) ?? at;
    if (at > until) yield event;
  }
}

/** Text out of content parts, or a plain string. */
function partsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is Record<string, unknown> => isObject(part) && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

/**
 * Whether a user-role message opens a turn, by the rule Kimi Code shows its
 * own transcript with: the person's words — typed, a slash command, a `!`
 * shell command — a subagent's prompt, a goal carried on, a task or cron job
 * reporting back. Not the CLI's reminders (`injection`), a retry, a compaction
 * summary, nor a hook's output: Claude Code files hook output as an
 * attachment, and ISY's own alert drain is one of those hooks.
 */
function isTurn(message: Record<string, unknown>): boolean {
  const origin = isObject(message.origin) ? message.origin : undefined;
  switch (origin?.kind) {
    case "system_trigger":
      return origin.name === "subagent" || origin.name === "goal_continuation";
    case "skill_activation":
    case "plugin_command":
      return origin.trigger === "user-slash";
    case "injection":
    case "retry":
    case "compaction_summary":
    case "hook_result":
      return false;
    default:
      return true;
  }
}

export interface KimiWireOptions {
  sessionId: string;
  cwd?: string;
  version?: string;
  /** Each subagent's own log, by the agent id the main log spawns it under. */
  subagents?: ReadonlyMap<string, Iterable<string>>;
  /**
   * Up to when the logs hold another session's work — the Kimi CLI session
   * this one was imported from, or the session it was forked off — which goes
   * up as that session: every log up to then is left out.
   */
  copiedUntil?: number;
}

/** One agent's place in the output: the session's own chain, or a subagent's. */
interface Thread {
  parent: string | null;
  /**
   * Its records' ids, `<name>-<n>`, numbered within its own log rather than
   * the output: a background subagent's records land between the session's by
   * time, and a count over both would renumber the session's every time the
   * subagent wrote more — and with them what `state.ts:candidateKey` keys on.
   */
  name: string;
  emitted: number;
  model?: string;
  sidechain?: { agentId: string; call?: string };
}

export function wireToClaudeRecords(lines: Iterable<string>, options: KimiWireOptions): string[] {
  const out: string[] = [];
  /** What each call asked for, by id: a `Read` result is only the file given its call. */
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Each subagent's thread, by agent id, from the moment a log starts it. */
  const threads = new Map<string, Thread>();
  const running = new Timelines<{ thread: Thread; event: Record<string, unknown> }>();

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
        ...(thread.sidechain ? { agentId: thread.sidechain.agentId } : {}),
        ...(thread.sidechain?.call ? { parentToolUseID: thread.sidechain.call } : {}),
      }),
    );
    thread.parent = uuid;
  };

  const say = (thread: Thread, timestamp: string | undefined, block: Record<string, unknown>): void => {
    emit(thread, {
      type: "assistant",
      timestamp,
      message: { role: "assistant", ...(thread.model ? { model: thread.model } : {}), content: [block] },
    });
  };

  const logOf = (thread: Thread, source: Iterable<string>, from: number) =>
    stamped(
      [...since(events(source), options.copiedUntil)].map((event) => ({ thread, event })),
      ({ event }) => millis(event.time),
      from,
    );

  /**
   * Where a log starts a subagent, its own log goes in from here on. Spawned
   * again, it was resumed: it goes on in the same log, and what it writes from
   * now on answers this call.
   */
  const spawned = (event: Record<string, unknown>, at: number): void => {
    const agentId = asString(event.subagentId);
    if (!agentId) return;
    const call = asString(event.parentToolCallId);

    const known = threads.get(agentId);
    if (known) {
      if (call && known.sidechain) known.sidechain.call = call;
      return;
    }
    const source = options.subagents?.get(agentId);
    if (!source) return;
    const thread: Thread = { parent: null, name: `kimi-${agentId}`, emitted: 0, sidechain: { agentId, call } };
    threads.set(agentId, thread);
    running.add(logOf(thread, source, at));
  };

  /** One event of any agent's log, in the order the merge hands it over. */
  const take = (thread: Thread, event: Record<string, unknown>, at: number): void => {
    const timestamp = stamp(event.time);

    if (event.type === "llm.request") {
      thread.model = asString(event.model) ?? thread.model;
      return;
    }

    if (event.type === "subagent.spawned") {
      spawned(event, at);
      return;
    }

    // A whole user or assistant message, appended outside the agent loop.
    if (event.type === "context.append_message" && isObject(event.message)) {
      const message = event.message;
      const role = asString(message.role);
      if (role !== "user" && role !== "assistant") return;
      if (role === "user" && !isTurn(message)) return;

      const content = Array.isArray(message.content)
        ? message.content
            .filter((part): part is Record<string, unknown> => isObject(part) && part.type === "text")
            .map((part) => ({ type: "text", text: asString(part.text) ?? "" }))
            .filter((part) => part.text.length > 0)
        : typeof message.content === "string" && message.content.length > 0
          ? [{ type: "text", text: message.content }]
          : [];
      if (content.length === 0) return;

      emit(thread, { type: role, timestamp, message: { role, content } });
      return;
    }

    if (event.type !== "context.append_loop_event" || !isObject(event.event)) return;

    const inner = event.event;
    const kind = asString(inner.type);
    if (!kind || !CONTENT_EVENTS.has(kind)) return;

    if (kind === "content.part" && isObject(inner.part)) {
      const part = inner.part;
      if (part.type === "think" || part.type === "thinking") {
        // A `hidden` part repeats a reasoning summary shown elsewhere. An
        // empty one — encrypted, or a provider that returns no text — still
        // says the model reasoned, and is counted as hidden reasoning.
        if (part.hidden === true) return;
        const thinking = [part.think, part.thinking].find((value) => typeof value === "string");
        say(thread, timestamp, { type: "thinking", thinking: typeof thinking === "string" ? thinking : "" });
      } else if (asString(part.text)) {
        say(thread, timestamp, { type: "text", text: part.text });
      }
      return;
    }

    if (kind === "tool.call") {
      const name = asString(inner.name);
      const id = asString(inner.toolCallId);
      if (!name || !id) return;
      // Kimi's names and its `path` argument, as Claude's: every downstream
      // detector reads `Edit`, `Bash`, `file_path` (`kimi-tools.ts`).
      const use = claudeTool(name, isObject(inner.args) ? inner.args : {});
      calls.set(id, use);
      say(thread, timestamp, { type: "tool_use", id, name: use.name, input: use.input });
      return;
    }

    const id = asString(inner.toolCallId);
    if (!id) return;
    const result = isObject(inner.result) ? inner.result : {};
    // `output` is a string or a list of parts; `note` is Kimi's status line.
    const output = partsText(result.output);
    const note = typeof result.note === "string" ? result.note : "";
    const status = /^<system>([\s\S]*?)<\/system>$/.exec(note)?.[1] ?? note;
    // Kimi Code flags a failed call with `isError`.
    const failed = result.isError === true || result.error !== undefined;
    const call = calls.get(id);
    const file =
      call?.name === "Read" && !failed && typeof call.input.file_path === "string"
        ? wholeFileRead(output, status)
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
            content: output || status,
            ...(failed ? { is_error: true } : {}),
          },
        ],
      },
      toolUseResult:
        file !== undefined
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
  };

  const main: Thread = { parent: null, name: "kimi", emitted: 0 };
  let at = -Infinity;
  for (const event of since(events(lines), options.copiedUntil)) {
    at = millis(event.time) ?? at;
    for (const next of running.until(boundOf(at))) take(next.item.thread, next.item.event, next.at);
    take(main, event, at);
  }
  for (const next of running.until(Infinity)) take(next.item.thread, next.item.event, next.at);

  for (const [agentId, source] of options.subagents ?? []) {
    if (threads.has(agentId)) continue;
    const thread: Thread = { parent: null, name: `kimi-${agentId}`, emitted: 0, sidechain: { agentId } };
    threads.set(agentId, thread);
    running.add(logOf(thread, source, -Infinity));
    for (const next of running.until(Infinity)) take(next.item.thread, next.item.event, next.at);
  }
  return out;
}

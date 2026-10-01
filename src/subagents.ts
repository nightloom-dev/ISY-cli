import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileLines } from "./lines.js";

/**
 * Claude Code 2.1 writes every subagent to a file of its own beside the session:
 * `<session>/subagents/agent-<id>.jsonl`, with `agent-<id>.meta.json` next to it
 * naming the `Agent` call that started it (`toolUseId`). Workflow agents go one
 * level deeper (`subagents/workflows/<run>/`). The session file keeps only the
 * call and its result, so read alone it hid most of the work — in one session
 * 12 calls stood in the session file and 134 in its subagents — and a session
 * whose files were all edited by a subagent read as one that edited nothing.
 *
 * So the session is read as one transcript, each subagent's records merged in
 * as sidechain records carrying `parentToolUseID`: by time, and never ahead of
 * the record holding the call that started it. By time, because the detectors
 * read order as time, and a subagent does not always run inside its call — one
 * started in the background works alongside the session, and one resumed later
 * appends to the same file. Spliced in whole after its call, a background
 * agent's test run stood before an edit the session made a minute before it, and
 * read as the check of that edit.
 */

interface Subagent {
  agentId: string;
  path: string;
  /** The `Agent` call that started it, from the meta file. */
  toolUseId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function subagentsDir(sessionPath: string): string {
  return join(dirname(sessionPath), basename(sessionPath, ".jsonl"), "subagents");
}

/** Whether a transcript file is itself a subagent's, filed under some session. */
export function isSubagentTranscript(path: string): boolean {
  return /^agent-.+\.jsonl$/.test(basename(path)) && path.split(/[/\\]/).includes("subagents");
}

/** Every subagent transcript under a directory, at any depth, in name order. */
async function agentFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await agentFiles(path)));
    else if (entry.isFile() && /^agent-.+\.jsonl$/.test(entry.name)) found.push(path);
  }
  return found;
}

async function readMeta(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function subagentsOf(sessionPath: string): Promise<Subagent[]> {
  const agents: Subagent[] = [];
  for (const path of await agentFiles(subagentsDir(sessionPath))) {
    const meta = await readMeta(path);
    const toolUseId = typeof meta?.toolUseId === "string" && meta.toolUseId.length > 0 ? meta.toolUseId : undefined;
    agents.push({ agentId: basename(path, ".jsonl").slice("agent-".length), path, toolUseId });
  }
  return agents;
}

/**
 * Size and mtime of a session as a whole, subagents included. What decides
 * whether a session changed since its last upload (`state.ts:looksUnchanged`):
 * a background subagent keeps writing its own file after the session file went
 * quiet, and by the session file alone that work would never count as new.
 */
export async function sessionFingerprint(
  sessionPath: string,
): Promise<{ sizeBytes: number; modifiedAt: Date }> {
  const info = await stat(sessionPath);
  let sizeBytes = info.size;
  let modified = info.mtime.getTime();

  for (const path of await agentFiles(subagentsDir(sessionPath))) {
    try {
      const agent = await stat(path);
      sizeBytes += agent.size;
      modified = Math.max(modified, agent.mtime.getTime());
    } catch {
      continue;
    }
  }
  return { sizeBytes, modifiedAt: new Date(modified) };
}

/**
 * A subagent's lines, as many as can be read. Its file can go, or stop being
 * readable, between the listing and the read — and the session is worth sending
 * without it: one file that would not open stopped the whole upload, and every
 * sweep after it at the same session.
 */
async function* subagentLines(path: string): AsyncGenerator<string> {
  try {
    yield* fileLines(path);
  } catch {
    return;
  }
}

function recordOf(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function timeOf(record: Record<string, unknown> | undefined): number | undefined {
  if (typeof record?.timestamp !== "string") return undefined;
  const at = Date.parse(record.timestamp);
  return Number.isNaN(at) ? undefined : at;
}

/**
 * The record as a subagent's: a sidechain, linked to the call that started it
 * when that call is known. A line that does not parse passes as it is.
 */
function asSidechain(line: string, record: Record<string, unknown> | undefined, call: string | undefined): string {
  if (!record) return line;
  return JSON.stringify({
    ...record,
    isSidechain: true,
    ...(call !== undefined && record.parentToolUseID === undefined ? { parentToolUseID: call } : {}),
  });
}

/** Ids of the calls a record starts. */
function callsIn(record: Record<string, unknown> | undefined): string[] {
  const content = isObject(record?.message) ? record.message.content : undefined;
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => isObject(block) && block.type === "tool_use" && typeof block.id === "string")
    .map((block) => (block as { id: string }).id);
}

/**
 * The call a subagent without a meta file answered: its result in the session
 * names the agent (`toolUseResult.agentId`), and the result names the call.
 */
function answeredCall(record: Record<string, unknown> | undefined, agentId: string): string | undefined {
  if (!isObject(record?.toolUseResult) || record.toolUseResult.agentId !== agentId) return undefined;
  const content = isObject(record.message) ? record.message.content : undefined;
  const result = Array.isArray(content)
    ? content.find((block) => isObject(block) && block.type === "tool_result")
    : undefined;
  return isObject(result) && typeof result.tool_use_id === "string" ? result.tool_use_id : undefined;
}

/** Where a stream of lines comes from: the session itself, or a subagent and the call behind it. */
type Source = { subagent: false } | { subagent: true; call?: string };

/**
 * A line and the moment it stands for: its own timestamp, or — for a record
 * written without one — the last moment its stream named.
 */
interface Timed {
  line: string;
  at: number;
}

interface Head {
  next: Timed;
  rest: AsyncIterator<Timed>;
}

/**
 * The subagents one stream has started, each waiting with its next line.
 * `until` hands over every line due by a moment, earliest first, and on a tie
 * the one from the subagent that started first.
 */
class Running {
  private readonly heads: Head[] = [];

  async add(stream: AsyncIterator<Timed>): Promise<void> {
    const first = await stream.next();
    if (!first.done) this.heads.push({ next: first.value, rest: stream });
  }

  async *until(at: number): AsyncGenerator<Timed> {
    for (;;) {
      let earliest: Head | undefined;
      for (const head of this.heads) {
        if (head.next.at <= at && (earliest === undefined || head.next.at < earliest.next.at)) earliest = head;
      }
      if (earliest === undefined) return;
      yield earliest.next;
      const following = await earliest.rest.next();
      if (following.done) this.heads.splice(this.heads.indexOf(earliest), 1);
      else earliest.next = following.value;
    }
  }
}

/**
 * A Claude session's lines with every subagent's records merged in by time,
 * nested subagents into theirs the same way. A subagent whose call is nowhere
 * to be found — its meta file lost, its call in a file that was not kept —
 * still did the work, so it follows the session rather than vanishing.
 *
 * Streams: sessions reach tens of megabytes, and a subagent's file is opened
 * only once its call has been read.
 */
export async function* sessionLines(sessionPath: string): AsyncGenerator<string> {
  const agents = await subagentsOf(sessionPath);
  if (agents.length === 0) {
    yield* fileLines(sessionPath);
    return;
  }

  const byCall = new Map<string, Subagent[]>();
  for (const agent of agents) {
    if (agent.toolUseId === undefined) continue;
    byCall.set(agent.toolUseId, [...(byCall.get(agent.toolUseId) ?? []), agent]);
  }
  const unlinked = agents.filter((agent) => agent.toolUseId === undefined);
  const placed = new Set<string>();

  /** The subagents a record starts: by the call it makes, or by the result that names one with no meta file. */
  const startedBy = (record: Record<string, unknown> | undefined): { agent: Subagent; call: string }[] => {
    const started: { agent: Subagent; call: string }[] = [];
    for (const call of callsIn(record)) {
      for (const agent of byCall.get(call) ?? []) started.push({ agent, call });
    }
    for (const agent of unlinked) {
      if (placed.has(agent.agentId)) continue;
      const call = answeredCall(record, agent.agentId);
      if (call !== undefined) started.push({ agent, call });
    }
    return started;
  };

  async function* merged(lines: AsyncIterable<string>, source: Source, from: number): AsyncGenerator<Timed> {
    const running = new Running();
    let at = from;
    for await (const line of lines) {
      const record = recordOf(line);
      at = timeOf(record) ?? at;
      // What the subagents started here did up to this record goes first. A
      // stream that has named no moment yet bounds nothing — a transcript
      // without timestamps puts each subagent right after its call, whole.
      yield* running.until(at === -Infinity ? Infinity : at);
      yield { line: source.subagent ? asSidechain(line, record, source.call) : line, at };

      for (const { agent, call } of startedBy(record)) {
        if (placed.has(agent.agentId)) continue;
        placed.add(agent.agentId);
        await running.add(merged(subagentLines(agent.path), { subagent: true, call }, at));
      }
    }
    yield* running.until(Infinity);
  }

  for await (const { line } of merged(fileLines(sessionPath), { subagent: false }, -Infinity)) yield line;
  for (const agent of agents) {
    if (placed.has(agent.agentId)) continue;
    placed.add(agent.agentId);
    for await (const { line } of merged(subagentLines(agent.path), { subagent: true, call: agent.toolUseId }, -Infinity)) {
      yield line;
    }
  }
}

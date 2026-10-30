import { claudeAgent } from "./claude.js";
import { codexAgent } from "./codex.js";
import { kimiAgent } from "./kimi.js";
import { isAbsolute, relative, sep } from "node:path";
import { workTreeTop } from "../git.js";
import { SWEEP_WINDOW_MS, lastActive } from "../paths.js";
import type { DiscoveredSession } from "../types.js";
import type { Agent, AgentId, HookInput } from "./types.js";

export { claudeAgent } from "./claude.js";
export { codexAgent } from "./codex.js";
export { kimiAgent } from "./kimi.js";
export type { Agent, AgentHook, AgentId, HookInput } from "./types.js";

export const AGENTS: Agent[] = [claudeAgent, kimiAgent, codexAgent];

export function agentById(id: AgentId): Agent {
  return AGENTS.find((agent) => agent.id === id) ?? claudeAgent;
}

export function isAgentId(value: string | undefined): value is AgentId {
  return value === "claude" || value === "kimi" || value === "codex";
}

/**
 * Which CLI fired this hook. Codex sends the same fields Claude Code does and so
 * cannot be told apart from it, which is why its hooks pass `--agent codex`.
 * Older Kimi builds said so in `client_type`; Kimi Code 0.38 dropped the field,
 * but its session ids keep their own shape (`session_<uuid>`, where Claude and
 * Codex use a bare UUID). Kimi CLI's ids are bare UUIDs too, and what gives it
 * away is what it leaves out: Claude Code and Codex always send
 * `transcript_path`, and no Kimi does. A hook installed before `--agent kimi`
 * relies on these. Claude Code is the default, which keeps every existing
 * install working untouched.
 */
export function detectAgent(hook: HookInput | undefined, override?: string): Agent {
  if (isAgentId(override)) return agentById(override);
  if (hook?.client_type?.startsWith("kimi") || hook?.session_id?.startsWith("session_")) return kimiAgent;
  if (hook?.session_id !== undefined && hook.hook_event_name !== undefined && !("transcript_path" in hook)) {
    return kimiAgent;
  }
  return claudeAgent;
}

/** Agents actually installed on this machine — we never configure an absent CLI. */
export async function presentAgents(): Promise<Agent[]> {
  const present: Agent[] = [];
  for (const agent of AGENTS) if (await agent.present()) present.push(agent);
  return present;
}

function isWithin(top: string, directory: string): boolean {
  const path = relative(top, directory);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/**
 * One CLI's sessions from the work tree `cwd` stands in, newest first: the ones
 * recorded for `cwd` itself, however old, and those from any other directory of
 * the tree, as far back as a sweep looks and with that directory set as `cwd`.
 *
 * git runs its hooks at the top of the tree, whatever directory the session
 * started in and the commit ran from, so a listing by the hook's directory
 * alone never sees a session started further down. A submodule or a worktree
 * nested inside has a top of its own and stays out. Lazy because a session's
 * directory costs a read, and a commit only wants the first one.
 */
export async function* sessionsInTree(
  agent: Agent,
  cwd: string,
): AsyncGenerator<DiscoveredSession> {
  const recorded = await agent.sessionsIn(cwd);
  const top = await workTreeTop(cwd);
  if (!top) {
    yield* recorded;
    return;
  }

  const here = new Set(recorded.map((file) => file.path));
  const oldest = Date.now() - SWEEP_WINDOW_MS;
  const elsewhere = (await agent.allSessions(top)).filter(
    (file) => !here.has(file.path) && file.modifiedAt.getTime() >= oldest,
  );

  const listed: DiscoveredSession[] = [...recorded, ...elsewhere];
  const tops = new Map<string, string | undefined>();
  for (const file of listed.sort((a, b) => lastActive(b) - lastActive(a))) {
    if (here.has(file.path)) {
      yield file;
      continue;
    }
    const directory = file.cwd ?? (await agent.cwdOf(file.path));
    if (!directory || !isWithin(top, directory)) continue;
    if (!tops.has(directory)) tops.set(directory, await workTreeTop(directory));
    if (tops.get(directory) === top) yield { ...file, cwd: directory };
  }
}

/**
 * This work tree's sessions across every CLI installed here, newest first by when
 * the session itself last wrote: the ones that wrote within `withinMs`, and the
 * newest however long ago that was.
 *
 * ponytail: a subagent working for a session does not move that time, so one that
 * commits after its session has waited on it for longer than `withinMs` is not
 * looked for. Walk by `modifiedAt`, which counts subagents, if that shows up.
 */
export async function latestSessions(
  cwd: string,
  withinMs: number,
): Promise<{ agent: Agent; file: DiscoveredSession }[]> {
  const oldest = Date.now() - withinMs;
  const found: { agent: Agent; file: DiscoveredSession }[] = [];

  for (const agent of await presentAgents()) {
    for await (const file of sessionsInTree(agent, cwd)) {
      found.push({ agent, file });
      if (lastActive(file) < oldest) break;
    }
  }

  found.sort((a, b) => lastActive(b.file) - lastActive(a.file));
  return found.filter(({ file }, index) => index === 0 || lastActive(file) >= oldest);
}

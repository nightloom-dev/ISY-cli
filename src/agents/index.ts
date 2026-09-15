import { claudeAgent } from "./claude.js";
import { codexAgent } from "./codex.js";
import { kimiAgent } from "./kimi.js";
import type { SessionFile } from "../types.js";
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
 * Older Kimi builds said so in `client_type`; 0.38 dropped the field, but its
 * session ids keep their own shape (`session_<uuid>`, where Claude and Codex use
 * a bare UUID). A hook installed before `--agent kimi` relies on that. Claude
 * Code is the default, which keeps every existing install working untouched.
 */
export function detectAgent(hook: HookInput | undefined, override?: string): Agent {
  if (isAgentId(override)) return agentById(override);
  if (hook?.client_type?.startsWith("kimi") || hook?.session_id?.startsWith("session_")) return kimiAgent;
  return claudeAgent;
}

/** Agents actually installed on this machine — we never configure an absent CLI. */
export async function presentAgents(): Promise<Agent[]> {
  const present: Agent[] = [];
  for (const agent of AGENTS) if (await agent.present()) present.push(agent);
  return present;
}

/** Newest session for this directory across every CLI installed here. */
export async function newestSession(
  cwd: string,
): Promise<{ agent: Agent; file: SessionFile } | undefined> {
  let best: { agent: Agent; file: SessionFile } | undefined;

  for (const agent of await presentAgents()) {
    const file = (await agent.sessionsIn(cwd))[0];
    if (!file) continue;
    if (!best || file.modifiedAt.getTime() > best.file.modifiedAt.getTime()) {
      best = { agent, file };
    }
  }

  return best;
}

import { spawn } from "node:child_process";
import { logError } from "./log.js";

export type SpawnOutcome = "spawned" | "not-attempted";

/**
 * Run another isy command in the background and stop caring about it.
 *
 * Two callers, one reason: neither a commit nor the start of a session may wait
 * on the network. The child re-executes this same entry point rather than
 * resolving `isy` on PATH, because a hook fired by a desktop app inherits none
 * of the shell's environment and `npx` is frequently not on it.
 *
 * A failure to spawn is not reported to the user: the transcript keeps its
 * unsent hash, so the next trigger tries again.
 */
export function spawnIsy(args: readonly string[], cwd?: string): SpawnOutcome {
  const entry = process.argv[1];
  if (!entry) return "not-attempted";

  try {
    const child = spawn(process.execPath, [entry, ...args], {
      ...(cwd ? { cwd } : {}),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return "spawned";
  } catch (cause) {
    logError(`spawn: could not start isy ${args.join(" ")}: ${String(cause)}`);
    return "not-attempted";
  }
}

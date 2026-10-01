import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentHook } from "./agents/types.js";
import { claudeConfigDir, claudeSettingsPath } from "./paths.js";

export const HOOK_EVENT = "SessionEnd";
export const HOOK_COMMAND = "exec 3<&0; nohup npx @nightloom/isy upload --hook <&3 >/dev/null 2>&1 &";
export const START_HOOK_EVENT = "SessionStart";
export const START_HOOK_COMMAND = "npx @nightloom/isy check --hook";

/**
 * The scope is spelled out, and npx stays. npx resolves a bare name against the
 * registry rather than against PATH, and the registry's `isy` is an unrelated
 * package — this one publishes as `@nightloom/isy`, so a hook saying `npx isy`
 * would fetch a stranger. Keeping npx is what lets a machine that was set up
 * with `npx @nightloom/isy init` and never installed anything globally keep
 * working. Every command an older isy wrote is listed as superseded, so
 * installing over it rewrites that line in place instead of leaving two hooks
 * to fire.
 */
export const ISY_HOOKS: (AgentHook & { superseded: string[] })[] = [
  {
    event: HOOK_EVENT,
    // Detached, the way Kimi CLI's and Codex's are. Claude Code 2.1 cancels a
    // SessionEnd hook after 1.5 seconds unless it asks for more — before `npx`
    // has even started node, so every upload at the end of a session was
    // killed — and it waits out whatever a hook asks for on `/clear` and
    // `/resume` too, so a hook given the upload's own thirty seconds froze
    // both for as long as the upload took. The shell returns at once and the
    // upload outlives it. A background job's stdin is /dev/null, so the
    // payload is handed over on fd 3 first: without it the upload took the
    // newest session in the cwd, the wrong one whenever two share a directory.
    // Its line is parked for the next session start (`claude.ts:deliver`).
    //
    // ponytail: POSIX `&`. Claude Code runs hooks through bash (Git Bash on
    // Windows), so this holds wherever it does; a hook shell without `nohup`
    // loses the upload to the sweep at the next session start.
    command: HOOK_COMMAND,
    superseded: [
      "npx isy upload --silent",
      "npx isy upload --hook",
      "npx @nightloom/isy upload --hook",
    ],
  },
  { event: START_HOOK_EVENT, command: START_HOOK_COMMAND, superseded: ["npx isy check --hook"] },
];

/**
 * A JSON file holding hooks under a top-level `hooks` key. Claude Code's
 * settings.json and Codex CLI's hooks.json use the same shape down to the
 * matcher group, so one implementation serves both.
 */
export interface HookFile {
  path: string;
  hooks: readonly AgentHook[];
}

export function claudeHookFile(): HookFile {
  return { path: claudeSettingsPath(), hooks: ISY_HOOKS };
}

interface HookCommand {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

interface HookMatcher {
  hooks?: HookCommand[];
  [key: string]: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readSettings(file: HookFile): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await readFile(file.path, "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`${file.path} is not valid JSON: ${reason}`);
  }

  if (!isObject(parsed)) {
    throw new Error(`${file.path} does not contain a JSON object`);
  }
  return parsed;
}

async function writeSettings(file: HookFile, settings: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(file.path), { recursive: true });

  const temporary = join(dirname(file.path), `.${basename(file.path)}.isy-${process.pid}`);
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporary, file.path);
}

function matchers(settings: Record<string, unknown>, event: string): HookMatcher[] {
  const hooks = settings.hooks;
  if (!isObject(hooks)) return [];
  const entries = hooks[event];
  return Array.isArray(entries) ? (entries.filter(isObject) as HookMatcher[]) : [];
}

/** An entry running one of `commands`, and — when one is asked for — with that timeout. */
function runs(entry: unknown, commands: readonly string[], timeout?: number): boolean {
  if (!isObject(entry) || typeof entry.command !== "string" || !commands.includes(entry.command)) return false;
  return timeout === undefined || entry.timeout === timeout;
}

function hasHook(
  settings: Record<string, unknown>,
  event: string,
  commands: readonly string[],
  timeout?: number,
): boolean {
  return matchers(settings, event).some((matcher) =>
    Array.isArray(matcher.hooks) && matcher.hooks.some((entry) => runs(entry, commands, timeout)),
  );
}

function stripHook(
  settings: Record<string, unknown>,
  hooks: Record<string, unknown>,
  event: string,
  commands: readonly string[],
): void {
  const kept: unknown[] = [];

  for (const matcher of matchers(settings, event)) {
    if (!Array.isArray(matcher.hooks)) {
      kept.push(matcher);
      continue;
    }
    const remaining = matcher.hooks.filter(
      (entry) =>
        !(isObject(entry) && typeof entry.command === "string" && commands.includes(entry.command)),
    );
    if (remaining.length > 0) kept.push({ ...matcher, hooks: remaining });
  }

  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
}

/**
 * Swap the first entry running one of `commands` for the hook as it should be
 * written, at the same group and position, dropping any further copies, so no
 * group's index moves. The same swap brings an older command up to date and
 * gives the current one a timeout it was written without.
 */
function replaceSuperseded(groups: unknown[], commands: readonly string[], hook: AgentHook): boolean {
  let replaced = false;
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) continue;
    group.hooks = (group.hooks as unknown[]).filter((entry: unknown) => {
      if (!isObject(entry) || !runs(entry, commands)) return true;
      if (replaced) return false;
      entry.command = hook.command;
      if (hook.timeout !== undefined) entry.timeout = hook.timeout;
      replaced = true;
      return true;
    });
  }
  return replaced;
}

/**
 * Bring the entries an older isy wrote up to date, in place, and add nothing:
 * a hook that is not there at all stays away — that is the reader's call, and
 * `isy check` names it. The SessionStart hook runs this, so an upgrade needs no
 * `isy init`, which pairs the browser again, and on a plan with one key asks
 * the reader to revoke the key in use first. Whether anything changed.
 */
export async function repairHooksIn(file: HookFile): Promise<boolean> {
  const settings = await readSettings(file);
  const stale = file.hooks.filter(
    (hook) =>
      !hasHook(settings, hook.event, [hook.command], hook.timeout) &&
      hasHook(settings, hook.event, [hook.command, ...(hook.superseded ?? [])]),
  );
  if (stale.length === 0) return false;

  const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
  for (const hook of stale) {
    const existing = [...(hooks[hook.event] as unknown[])];
    replaceSuperseded(existing, [hook.command, ...(hook.superseded ?? [])], hook);
    hooks[hook.event] = existing;
  }

  await writeSettings(file, { ...settings, hooks });
  return true;
}

export async function installedHooksIn(file: HookFile): Promise<string[]> {
  const settings = await readSettings(file);
  return file.hooks.filter((hook) => hasHook(settings, hook.event, [hook.command], hook.timeout)).map(
    (hook) => hook.event,
  );
}

export async function installHookIn(file: HookFile): Promise<"installed" | "already-present"> {
  const settings = await readSettings(file);
  const missing = file.hooks.filter(
    (hook) => !hasHook(settings, hook.event, [hook.command], hook.timeout),
  );
  if (missing.length === 0) return "already-present";

  const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
  for (const hook of missing) {
    // Appended, never prepended: Codex keys its hook trust ledger by position
    // (`hooks.json:session_start:0:0`), so inserting ahead of an existing group
    // would silently untrust the user's own hooks.
    const existing = Array.isArray(hooks[hook.event]) ? [...(hooks[hook.event] as unknown[])] : [];

    // An older isy wrote a different command for the same job: swap it in
    // place. Strip-then-append would move it to the end, shifting the groups
    // after it — and with them the positions Codex keys its approvals on, so
    // the user's hooks would lose their approval and ours would inherit one it
    // was never given.
    const replaced = replaceSuperseded(existing, [hook.command, ...(hook.superseded ?? [])], hook);
    if (!replaced) {
      existing.push({
        hooks: [
          { type: "command", command: hook.command, ...(hook.timeout !== undefined ? { timeout: hook.timeout } : {}) },
        ],
      });
    }

    hooks[hook.event] = existing;
  }

  await writeSettings(file, { ...settings, hooks });
  return "installed";
}

export async function removeHookIn(file: HookFile): Promise<"removed" | "absent"> {
  const settings = await readSettings(file);
  const present = file.hooks.filter((hook) =>
    hasHook(settings, hook.event, [hook.command, ...(hook.superseded ?? [])]),
  );
  if (present.length === 0) return "absent";

  const hooks = isObject(settings.hooks) ? { ...settings.hooks } : {};
  for (const hook of present) {
    stripHook(settings, hooks, hook.event, [hook.command, ...(hook.superseded ?? [])]);
  }

  const next: Record<string, unknown> = { ...settings };
  if (Object.keys(hooks).length > 0) next.hooks = hooks;
  else delete next.hooks;

  await writeSettings(file, next);
  return "removed";
}

export async function isHookInstalled(): Promise<boolean> {
  const file = claudeHookFile();
  const settings = await readSettings(file);
  return ISY_HOOKS.every((hook) => hasHook(settings, hook.event, [hook.command], hook.timeout));
}

export function installedHooks(): Promise<string[]> {
  return installedHooksIn(claudeHookFile());
}

export function installHook(): Promise<"installed" | "already-present"> {
  return installHookIn(claudeHookFile());
}

export function removeHook(): Promise<"removed" | "absent"> {
  return removeHookIn(claudeHookFile());
}

export function repairHooks(): Promise<boolean> {
  return repairHooksIn(claudeHookFile());
}

export function settingsLocation(): string {
  return claudeSettingsPath();
}

export function configDirectory(): string {
  return claudeConfigDir();
}

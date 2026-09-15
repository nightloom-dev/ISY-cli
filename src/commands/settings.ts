import { DEFAULT_API_BASE_URL, fetchSettings, putSettings } from "../api.js";
import type { ApiOptions, Settings } from "../api.js";
import { readConfig } from "../config.js";

/**
 * The keys an account may set, in the vocabulary `.isy.yml` uses: one set
 * of words for the repository file and for the personal setting, because the
 * person reading one is about to read the other.
 */
const LIST_KEYS = new Set(["categories", "ignore_paths"]);
const NUMBER_KEYS = new Set(["publish_confidence", "display_confidence", "max_signals"]);
const BOOLEAN_KEYS = new Set(["disabled"]);

export const KEYS = [...BOOLEAN_KEYS, ...LIST_KEYS, ...NUMBER_KEYS].sort();

/** Empties a list without an empty argument, which a shell would swallow. */
const NONE = "none";

/**
 * A value as typed at the terminal. `categories none` is the one that needs
 * saying out loud: an empty list means every category is silenced, which is not
 * what an absent key means (that one leaves them all enabled).
 */
export function parseValue(key: string, value: string): unknown {
  if (BOOLEAN_KEYS.has(key)) {
    if (value === "true" || value === "false") return value === "true";
    throw new Error(`${key} takes true or false`);
  }

  if (NUMBER_KEYS.has(key)) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`${key} takes a number`);
    return parsed;
  }

  if (value === NONE) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function assertKey(key: string): void {
  if (!LIST_KEYS.has(key) && !NUMBER_KEYS.has(key) && !BOOLEAN_KEYS.has(key)) {
    throw new Error(`unknown setting '${key}'. Known: ${KEYS.join(", ")}`);
  }
}

function renderValue(value: unknown): string {
  return Array.isArray(value)
    ? value.length === 0
      ? "(none)"
      : value.join(", ")
    : String(value);
}

export function formatSettings(settings: Settings): string {
  const entries = Object.entries(settings);
  if (entries.length === 0) {
    return "no personal settings — you see everything the repository allows.\n" +
      `set one with: isy settings set <${KEYS.join("|")}> <value>`;
  }

  const width = Math.max(...entries.map(([key]) => key.length));
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key.padEnd(width)}  ${renderValue(value)}`)
    .join("\n");
}

export async function runSettings(
  options: { json?: boolean; action?: string; key?: string; value?: string },
): Promise<void> {
  const config = await readConfig();
  const token = typeof config.token === "string" && config.token.length > 0 ? config.token : undefined;
  if (!token) throw new Error("not configured — run: isy init");

  const api: ApiOptions = { baseUrl: config.apiBaseUrl ?? DEFAULT_API_BASE_URL, token };
  const action = options.action ?? "show";

  if (action === "show") {
    const settings = await fetchSettings(api);
    console.log(options.json ? JSON.stringify(settings, null, 2) : formatSettings(settings));
    return;
  }

  if (action !== "set" && action !== "unset") {
    throw new Error(`unknown action '${action}'. Usage: isy settings [set|unset] <key> [value]`);
  }

  const key = options.key;
  if (!key) throw new Error(`which setting? Known: ${KEYS.join(", ")}`);
  assertKey(key);

  // Read before write: the endpoint takes the whole object, so a partial change
  // has to be applied to what is already stored rather than replacing it.
  const current = await fetchSettings(api);

  if (action === "unset") delete current[key];
  else {
    if (options.value === undefined) throw new Error(`isy settings set ${key} <value>`);
    current[key] = parseValue(key, options.value);
  }

  const stored = await putSettings(api, current);
  console.log(options.json ? JSON.stringify(stored, null, 2) : formatSettings(stored));
}

import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";
import { createInterface } from "node:readline";
import {
  PATH_KEYS,
  REDACTION_MARKER,
  marker,
  maskPath,
  maskPaths,
  resolveRoots,
  rootOf,
} from "./mask-paths.js";
import type { MaskRoots, PreparedRoots } from "./mask-paths.js";

// The marker vocabulary lives with the path rules, which cannot import this
// module back without a cycle. Re-exported so every caller has one import.
export { REDACTION_MARKER, marker };

export interface RedactionRule {
  type: string;
  pattern: RegExp;
  replacement: string;
}

export const BUILTIN_RULES: RedactionRule[] = [
  {
    type: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
    replacement: marker("private_key"),
  },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    replacement: marker("jwt"),
  },
  {
    type: "anthropic_key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
    replacement: marker("anthropic_key"),
  },
  {
    type: "openai_key",
    pattern: /\bsk-[A-Za-z0-9_-]{16,}/g,
    replacement: marker("openai_key"),
  },
  {
    type: "github_token",
    pattern: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36}\b/g,
    replacement: marker("github_token"),
  },
  {
    type: "github_token",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: marker("github_token"),
  },
  {
    type: "aws_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: marker("aws_key"),
  },
  {
    type: "google_key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replacement: marker("google_key"),
  },
  {
    type: "connection_string",
    pattern: /\b(postgres|postgresql|mysql|mongodb\+srv|mongodb|redis|amqp):\/\/([^\s:/@]+):([^\s/@]+)@/g,
    replacement: `$1://$2:${marker("connection_string")}@`,
  },
  {
    type: "assignment",
    pattern:
      /(?<![A-Za-z0-9])(password|passwd|secret|token|api[-_]?key|private[-_]?key)(\s*[=:]\s*)(["']?)(?!\[ISY_REDACTED)[^\s"'{}()[\]<>$]{8,}/gi,
    replacement: `$1$2$3${marker("assignment")}`,
  },
];

const SENSITIVE_KEY = /^(password|passwd|secret|token|api[-_]?key|private[-_]?key)$/i;
const MIN_SENSITIVE_VALUE = 8;
const EDIT_INPUT_FIELDS = ["content", "old_string", "new_string", "new_source"];

export interface RedactionSummary {
  counts: Record<string, number>;
  replacements: number;
  lines: number;
  unparsedLines: number;
  invalidExtraPatterns: string[];
}

interface RedactContext {
  rules: RedactionRule[];
  counts: Record<string, number>;
  envToolUseIds: Set<string>;
  /**
   * Mutable: a transcript names its own working directory on every record, so a
   * caller that did not pass one still gets repository-relative paths. The
   * first record that carries one wins — a session that wanders between
   * directories is judged from where it started.
   */
  roots: PreparedRoots;
  /** Whether the working directory was given rather than read off a record. */
  rootGiven: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(context: RedactContext, type: string, amount: number): void {
  context.counts[type] = (context.counts[type] ?? 0) + amount;
}

export function compileExtraRules(
  patterns: readonly string[] | undefined,
  invalid: string[],
): RedactionRule[] {
  const rules: RedactionRule[] = [];
  for (const source of patterns ?? []) {
    try {
      rules.push({ type: "custom", pattern: new RegExp(source, "g"), replacement: marker("custom") });
    } catch {
      invalid.push(source);
    }
  }
  return rules;
}

export function applyRules(
  text: string,
  rules: readonly RedactionRule[],
  onMatch?: (type: string, amount: number) => void,
): string {
  let result = text;
  for (const rule of rules) {
    const matches = result.match(rule.pattern);
    if (!matches) continue;
    onMatch?.(rule.type, matches.length);
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

function isDotenvPath(filePath: unknown): boolean {
  return typeof filePath === "string" && basename(filePath).startsWith(".env");
}

function cutDotenvInput(input: Record<string, unknown>, context: RedactContext): void {
  for (const field of EDIT_INPUT_FIELDS) {
    if (typeof input[field] === "string") {
      input[field] = marker("dotenv");
      count(context, "dotenv", 1);
    }
  }
}

function scanDotenv(record: Record<string, unknown>, context: RedactContext): void {
  const message = record.message;
  const content = isObject(message) ? message.content : undefined;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isObject(block)) continue;

    if (block.type === "tool_use") {
      const input = isObject(block.input) ? block.input : undefined;
      if (!input) continue;
      if (!isDotenvPath(input.file_path) && !isDotenvPath(input.notebook_path)) continue;
      if (typeof block.id === "string") context.envToolUseIds.add(block.id);
      cutDotenvInput(input, context);
    }

    if (block.type === "tool_result") {
      const id = block.tool_use_id;
      if (typeof id !== "string" || !context.envToolUseIds.has(id)) continue;
      block.content = marker("dotenv");
      count(context, "dotenv", 1);
      if (record.toolUseResult !== undefined) {
        record.toolUseResult = marker("dotenv");
        count(context, "dotenv", 1);
      }
    }
  }
}

function redactValue(value: unknown, context: RedactContext, key?: string): unknown {
  if (typeof value === "string") {
    if (key && SENSITIVE_KEY.test(key) && value.length >= MIN_SENSITIVE_VALUE) {
      if (value.startsWith(`[${REDACTION_MARKER}`)) return value;
      count(context, "assignment", 1);
      return marker("assignment");
    }
    const secretsGone = applyRules(value, context.rules, (type, amount) =>
      count(context, type, amount),
    );
    // Paths last: a secret already replaced by its marker must not then be read
    // as a directory, and `[ISY_REDACTED:…]` carries no slash to be read as one.
    const mask = key && PATH_KEYS.has(key) ? maskPath : maskPaths;
    return mask(secretsGone, context.roots, (amount) => count(context, "path", amount));
  }

  if (Array.isArray(value)) return value.map((item) => redactValue(item, context));

  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      // A key holds a path too — Claude Code keys its per-file state by
      // absolute path — and `maskDeep` masks keys for the same reason. Only
      // the path rules run on it: a secret is a value, never a field name.
      const masked = maskPath(entryKey, context.roots, (amount) => count(context, "path", amount));
      result[masked] = redactValue(entryValue, context, entryKey);
    }
    return result;
  }

  return value;
}

/** The working directory this transcript recorded, before anything is rewritten. */
function learnRoot(record: Record<string, unknown>, context: RedactContext): void {
  if (context.rootGiven || context.roots.cwd) return;
  const cwd = rootOf(record);
  if (!cwd) return;
  context.roots = { ...context.roots, ...resolveRoots({ cwd }) };
}

function redactRecord(
  record: Record<string, unknown>,
  context: RedactContext,
): Record<string, unknown> {
  learnRoot(record, context);
  scanDotenv(record, context);
  return redactValue(record, context) as Record<string, unknown>;
}

export interface RedactOptions extends MaskRoots {
  extraPatterns?: readonly string[];
}

function createContext(options: RedactOptions, invalid: string[]): RedactContext {
  return {
    rules: [...BUILTIN_RULES, ...compileExtraRules(options.extraPatterns, invalid)],
    counts: {},
    envToolUseIds: new Set(),
    // The home directory is this machine's and is never in the transcript's
    // gift, so it is read here rather than passed by every caller.
    roots: resolveRoots({ cwd: options.cwd, home: options.home ?? homedir() }),
    rootGiven: Boolean(options.cwd),
  };
}

function summarize(
  context: RedactContext,
  lines: number,
  unparsedLines: number,
  invalidExtraPatterns: string[],
): RedactionSummary {
  const replacements = Object.values(context.counts).reduce((total, value) => total + value, 0);
  return { counts: context.counts, replacements, lines, unparsedLines, invalidExtraPatterns };
}

function redactOneLine(line: string, context: RedactContext): { line: string; unparsed: boolean } {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { line: trimmed, unparsed: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const secretsGone = applyRules(trimmed, context.rules, (type, amount) =>
      count(context, type, amount),
    );
    return {
      line: maskPaths(secretsGone, context.roots, (amount) => count(context, "path", amount)),
      unparsed: true,
    };
  }

  if (!isObject(parsed)) {
    return {
      line: JSON.stringify(redactValue(parsed, context)),
      unparsed: true,
    };
  }

  return { line: JSON.stringify(redactRecord(parsed, context)), unparsed: false };
}

export function redactLines(
  lines: Iterable<string>,
  options: RedactOptions = {},
): { lines: string[]; summary: RedactionSummary } {
  const invalid: string[] = [];
  const context = createContext(options, invalid);
  const output: string[] = [];
  let total = 0;
  let unparsed = 0;

  for (const line of lines) {
    total += 1;
    const result = redactOneLine(line, context);
    if (result.line.length === 0) continue;
    if (result.unparsed) unparsed += 1;
    output.push(result.line);
  }

  return { lines: output, summary: summarize(context, total, unparsed, invalid) };
}

export async function redactTranscriptFile(
  filePath: string,
  options: RedactOptions = {},
): Promise<{ lines: string[]; summary: RedactionSummary }> {
  const invalid: string[] = [];
  const context = createContext(options, invalid);
  const reader = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const output: string[] = [];
  let total = 0;
  let unparsed = 0;

  for await (const line of reader) {
    total += 1;
    const result = redactOneLine(line, context);
    if (result.line.length === 0) continue;
    if (result.unparsed) unparsed += 1;
    output.push(result.line);
  }

  return { lines: output, summary: summarize(context, total, unparsed, invalid) };
}

import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { fileLines } from "./lines.js";
import { HEREDOC, commandSegments, withoutHeredocs } from "./parser.js";
import {
  PATH_KEYS,
  REDACTION_MARKER,
  looksAbsolute,
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

/** `[pP][aA]…`: case by hand, so a rule can still tell a camelCase hump from a glued prefix. */
function anyCase(source: string): string {
  return source.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`);
}

const SECRET_WORD = anyCase("(?:password|passwd|secret|token|api[-_]?key|private[-_]?key|access[-_]?key)");

/**
 * A name that holds a secret: one of the words, wherever it sits in an
 * identifier — `PGPASSWORD`, `STRIPE_SECRET_KEY`, `aws_secret_access_key`,
 * `x-api-key` — and followed by nothing but `KEY` and `BASE` (`SECRET_KEY_BASE`).
 * That tail is the line between the secret and what is said about it:
 * `tokenHash`, `max_tokens`, `TOKENS_PER_ANALYSIS` and `PASSWORD_FILE` turn up
 * in a real corpus as often as the secrets do, and none of them is one.
 */
function secretName(atWord = ""): string {
  return String.raw`[A-Za-z0-9_.-]*?${atWord}${SECRET_WORD}${anyCase("(?:[-_]?key)?(?:[-_]?base)?")}(?![A-Za-z0-9_.-])`;
}

/** The word glued to what came before, but not as a camelCase hump. */
const PLAIN_NAME = secretName("(?!(?<=[a-z0-9])[A-Z])");
/** `adminPassword`, `_authToken`: as often a variable in code as a key in a file. */
const CAMEL_NAME = secretName("(?<=[a-z0-9])(?=[A-Z])");

/**
 * What an assigned secret looks like: long enough to be one, and not code. A
 * bare number under a quoted name is JSON's own (`"token": 1234567890`), where a
 * secret would be a string; anywhere else a number is a password like any other
 * — `DB_PASSWORD=1234567890123`, `MYSQL_ROOT_PASSWORD: 12345678`. The digit is
 * looked for first so the lookbehind runs only where a number starts.
 */
const SECRET_VALUE = String.raw`(?!\[ISY_REDACTED)(?!(?=-?\d)(?<=["']\s*:\s*)-?\d[\d.,eE+-]*(?![^\s"'{}()[\]<>$]))[^\s"'{}()[\]<>$]{8,}`;

export const BUILTIN_RULES: RedactionRule[] = [
  {
    type: "private_key",
    // `BLOCK` is how PGP armors one.
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
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
    // Secret and restricted keys; `pk_` is publishable by design.
    type: "stripe_key",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
    replacement: marker("stripe_key"),
  },
  {
    type: "slack_token",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
    replacement: marker("slack_token"),
  },
  {
    type: "npm_token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: marker("npm_token"),
  },
  {
    // After every shape a bearer token can have, so a JWT or a GitHub token
    // keeps its own label and its marker is not marked again.
    type: "bearer_token",
    pattern: /\b(Bearer\s+)(?!\[ISY_REDACTED)[A-Za-z0-9._~+/-]{20,}=*/gi,
    replacement: `$1${marker("bearer_token")}`,
  },
  {
    // Any scheme: a password in a URL is one whatever speaks it — rediss,
    // amqps, https to a bare IP. The scheme is capped because `\b` lets a match
    // start inside a dotted or dashed run: unbounded, every start rescans the
    // rest of the run, and a long one costs minutes.
    type: "connection_string",
    pattern: /\b([A-Za-z][A-Za-z0-9+.-]{0,31}):\/\/([^\s:/@]+):([^\s/@]+)@/g,
    replacement: `$1://$2:${marker("connection_string")}@`,
  },
  {
    // After the connection string: its password sits right before an `@` too.
    // Starts only where a run of local-part characters starts: with `\b`, every
    // dot, dash and `%` in a run began a new scan of the rest of it, and a
    // version list or a URL-encoded query took minutes to get through.
    type: "email",
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b/g,
    replacement: marker("email"),
  },
  {
    // The name may close a quote of its own: `"password": "…"`.
    type: "assignment",
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.-])(${PLAIN_NAME})(["']?\s*[=:]\s*)(["']?)${SECRET_VALUE}`, "g"),
    replacement: `$1$2$3${marker("assignment")}`,
  },
  {
    // A camelCase name counts where it is plainly data — a quoted key with a
    // quoted value (`{"accessToken":"…"}`) or `name=value` with no space, as
    // `.npmrc` writes `_authToken=` — and not in `adminPassword = someVariable`.
    type: "assignment",
    pattern: new RegExp(
      String.raw`(?<=["'])(${CAMEL_NAME})(["']\s*:\s*["'])${SECRET_VALUE}|(?<![A-Za-z0-9_.-])(${CAMEL_NAME})(=)${SECRET_VALUE}`,
      "g",
    ),
    replacement: `$1$2$3$4${marker("assignment")}`,
  },
  {
    // `--password hunter2000`, `--api-key "…"`: a name like any other, with a
    // space where `=` goes. `--password-file /x` has a tail no secret's name has,
    // and what starts with a dash is the next flag.
    type: "assignment",
    pattern: new RegExp(String.raw`(?<![A-Za-z0-9_.-])(-${secretName()})([ \t]+)(["']?)(?!-)${SECRET_VALUE}`, "g"),
    replacement: `$1$2$3${marker("assignment")}`,
  },
  {
    // `curl -u admin:hunter2000`. What precedes the flag is capped, as every
    // `curl` starts a new scan of the rest of its line, and a name may be a
    // marker already: an address is one by now.
    type: "assignment",
    pattern: /\b(curl\b[^\n;|]{0,200}?\s(?:-[uU]\s*|--(?:proxy-)?user[=\s]\s*)["']?(?:\[ISY_REDACTED:\w+\]|(?!\[ISY_REDACTED)[^\s:"']+):)(?!\[ISY_REDACTED)[^\s"'$][^\s"']*/g,
    replacement: `$1${marker("assignment")}`,
  },
  {
    // Tools that take the password on a flag of one letter, which says nothing
    // anywhere else: `-p` is a port to `ssh`, a directory's parents to `mkdir`,
    // and to `mysql` with a space after it only a prompt. Capped as above.
    type: "assignment",
    pattern: /\b((?:sshpass\b[^\n;|]{0,200}?\s-p\s*|(?:docker|podman)\s+login\b[^\n;|]{0,200}?\s-p\s+|redis-cli\b[^\n;|]{0,200}?\s-a\s+|(?:mysql|mariadb|mysqldump|mysqladmin)\b[^\n;|]{0,200}?\s-p(?=[^\s=]))["']?)(?!\[ISY_REDACTED)[^\s"'$][^\s"']*/g,
    replacement: `$1${marker("assignment")}`,
  },
];

/** A JSON key is data, never code, so any spelling of a secret's name counts. */
const SENSITIVE_KEY = new RegExp(`^${secretName()}$`);
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
  /** The last `!` command typed in Claude Code read or wrote a dotenv file. */
  bashInputTouchedDotenv: boolean;
  /**
   * Mutable: a transcript names its own working directory on every record, so a
   * caller that did not pass one still gets repository-relative paths. The
   * first record that carries one wins — a session that wanders between
   * directories is judged from where it started.
   */
  roots: PreparedRoots;
  /** What a relative name in a path field is relative to, when not the root. */
  base?: string;
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

/**
 * Commands that can name a dotenv file without printing any of it. The list runs
 * this way round because the other one has no end: `cut`, `node -e`, `python -c`,
 * `docker exec … cat`, anything behind `ssh` or `timeout`. A backtick still runs
 * what it holds, so a segment with one is judged as any other.
 */
const SHELL_NO_READ =
  /^\s*(?:(?:sudo|if|then|elif|else|while|until|do)\s+|[!{(]\s*)*(?:ls|ll|stat|file|wc|test|test-path|\[\[?|echo|printf|touch|chmod|chown|mkdir|rm|mv|cp|ln|cd|git\s+(?:add|rm|mv|status|commit|check-ignore|ls-files))(?:\s|$)/i;

/** Where a shell line, or the code it hands an interpreter, ends one word and starts the next. */
const WORD_BREAK = /[\s"'`(){}=,;|&<>]+/;

/**
 * `cat .env`, `cut -d= -f2 config/.env.local`, `node -e "…readFileSync('.env')…"`,
 * `source .env`: a shell call that names a dotenv file is as much a read of it as
 * `Read {file_path}` is, and what it prints may be any of the file. The command
 * itself stays — it names the file, not what is in it. A revision goes with its
 * word: `git show origin/main:.env`.
 *
 * ponytail: by the name in the command. `node scripts/x.js` opening the file
 * itself, or `load_dotenv()` with no path, still goes up; scrubbing the file's
 * values at upload is the way up.
 */
function readsDotenv(command: unknown): boolean {
  if (typeof command !== "string" || !command.includes(".env")) return false;
  return commandSegments(withoutHeredocs(command)).some(
    (segment) =>
      (!SHELL_NO_READ.test(segment) || segment.includes("`")) &&
      segment.split(WORD_BREAK).some((word) => isDotenvPath(word.replace(/^.*:/, ""))),
  );
}

/** Commands that write the file they are given: `tee` and PowerShell's own. */
const SHELL_WRITER = /^\s*(?:sudo\s+)?(?:tee|set-content|sc|add-content|ac|out-file|new-item)(?:\s|$)/i;
/** `tee` behind whatever runs it — `sudo -u app`, `doas`, `ssh host`, `/usr/bin/` — still writes. */
const TEE = /(?:^|[\s/])(?:tee|tee-object)(?=\s|$)/i;

/** A word as the shell hands it over: quotes gone, `\ ` a plain space; a Windows `\` stays. */
const unquoted = (word: string): string => word.replace(/\\( )|["'`]/g, "$1");

/** The dotenv file a statement redirects or tees into, if it writes one. */
function dotenvTarget(statement: string): string | undefined {
  for (const segment of commandSegments(statement)) {
    // A quoted or escaped word keeps its spaces: `> "My Projects/.env"`.
    for (const redirect of segment.matchAll(/>\|?\s*((?:"[^"]*"|'[^']*'|\\.|[^\s;&|<>"'\\])+)/g)) {
      if (isDotenvPath(unquoted(redirect[1]!))) return unquoted(redirect[1]!);
    }
    const writer = SHELL_WRITER.exec(segment) ?? TEE.exec(segment);
    if (!writer) continue;
    const after = segment.slice(writer.index + writer[0].length);
    const named = after.trim().split(/\s+/).map(unquoted).find(isDotenvPath);
    if (named) return named;
  }
  return undefined;
}

/**
 * A line cut where `&&`, `||` or `;` end a statement outside quotes, the
 * separators kept, and whether a quote is still open where the line ends.
 */
function statements(line: string): { parts: string[]; open: boolean } {
  const parts: string[] = [];
  let start = 0;
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (quote !== undefined) {
      if (char === quote && (quote === "'" || line[i - 1] !== "\\")) quote = undefined;
    } else if (char === '"' || char === "'" || char === "`") {
      quote = char;
    } else if (char === ";" || ((char === "&" || char === "|") && line[i + 1] === char)) {
      const width = char === ";" ? 1 : 2;
      parts.push(line.slice(start, i), line.slice(i, i + width));
      start = i + width;
      i += width - 1;
    }
  }
  parts.push(line.slice(start));
  return { parts, open: quote !== undefined };
}

/** A write that closes a group or a substitution: `{ …; } > .env`, `(…) | tee .env`, `done > .env`. */
const GROUP_WRITE = /(?:[})]|\b(?:done|fi|esac))\s*(?:\d?>|&>|\|)/;

/**
 * `cat > .env << 'EOF'`, `echo "KEY=…" >> .env.local`, `… | tee .env`: a shell
 * call that writes a dotenv file holds what it writes, so unlike a read the
 * command is cut too. Only what carries the values goes — the statement that
 * writes, with the heredoc it feeds, and a heredoc body that names the file
 * itself (`python - <<PY` opening `.env`) — and the statement keeps its target,
 * so `sed -i` beside it is still an edit and the parse still sees a write.
 */
function cutDotenvWrites(command: string): string {
  if (!command.includes(".env")) return command;
  const lines = command.split("\n");
  const kept: string[] = [];
  let written: string | undefined;
  let spread = false;
  for (let i = 0; i < lines.length; i += 1) {
    let writes = false;
    const { parts, open } = statements(lines[i]!);
    // A line that goes on in the next (`\`, a trailing pipe) is one statement
    // with it, and the values may sit on either.
    if (open || /[\\|]\s*$/.test(lines[i]!)) spread = true;
    kept.push(
      parts
        .map((part) => {
          const target = dotenvTarget(part);
          if (target === undefined) return part;
          writes = true;
          written ??= target;
          if (GROUP_WRITE.test(part)) spread = true;
          return `${/^\s*/.exec(part)![0]}${marker("dotenv")} > ${target}`;
        })
        .join(""),
    );
    const terminator = HEREDOC.exec(lines[i]!)?.[2];
    if (terminator === undefined) continue;
    let end = lines.findIndex((line, j) => j > i && line.trim() === terminator);
    if (end === -1) end = lines.length;
    const body = lines.slice(i + 1, end);
    if (writes) {
      i = end;
      continue;
    }
    const namesDotenv = body.some((line) => line.split(WORD_BREAK).some(isDotenvPath));
    kept.push(...(namesDotenv ? [marker("dotenv")] : body), ...lines.slice(end, end + 1));
    i = end;
  }
  // A group or a quoted string over several lines holds the values outside the
  // statement that names the file (`{ echo A=1; echo B=2; } > .env`), so the
  // whole command goes, and only the write is left for the parse to see.
  if (written !== undefined && spread) return `${marker("dotenv")} > ${written}`;
  return kept.join("\n");
}

/** A multi-edit keeps its steps: each is one edit to the parse, and only their strings go. */
function cutDotenvInput(input: Record<string, unknown>, context: RedactContext): void {
  for (const field of EDIT_INPUT_FIELDS) {
    if (typeof input[field] === "string") {
      input[field] = marker("dotenv");
      count(context, "dotenv", 1);
    }
  }
  if (!Array.isArray(input.edits)) return;
  for (const edit of input.edits) if (isObject(edit)) cutDotenvInput(edit, context);
}

/**
 * Whether a call that is no shell works on a dotenv file, by the argument that
 * says what it works on: `Read {file_path}`, `Grep {path}`, a filesystem
 * server's `read_file {path}`. A glob reads a gitignored file as well as a named
 * one, however it is spelled (`{.env,.env.local}`, `*.env`), so any mention
 * counts, and the worst of that is one search's result on `*.envelope.ts`. Code
 * a tool runs (`REPL {code}`, `exec {script}`) is read as a shell line is.
 *
 * ponytail: by what the call names. A search that names no file (`Grep
 * {pattern}`, `grep -r KEY .`) still goes up when `.env` is not ignored; reading
 * its result's lines for a dotenv path is the way up.
 */
const FILE_ARGUMENT = /^(?:file_?path|filePath|notebook_path|(?:relative_)?path|paths|file|files|filename|target_file)$/;

function callNamesDotenv(name: unknown, input: Record<string, unknown>): boolean {
  if (typeof input.glob === "string" && input.glob.includes(".env")) return true;
  // A workflow's script hands out prompts: it reads nothing by itself.
  if (readsDotenv(input.code) || readsDotenv(input.cmd) || (name !== "Workflow" && readsDotenv(input.script))) return true;
  return Object.entries(input).some(([key, value]) => FILE_ARGUMENT.test(key) && [value].flat().some(isDotenvPath));
}

/**
 * `! cat .env` typed in Claude Code is no tool call: the command comes as one
 * user turn, `<bash-input>…</bash-input>`, and what it printed as the next,
 * `<bash-stdout>…`. The cuts of a shell call apply across the pair.
 */
function scanBashMode(message: Record<string, unknown>, content: string, context: RedactContext): void {
  const input = /^\s*<bash-input>([\s\S]*)<\/bash-input>\s*$/.exec(content)?.[1];
  if (input !== undefined) {
    const cut = cutDotenvWrites(input);
    context.bashInputTouchedDotenv = cut !== input || readsDotenv(input);
    if (cut !== input) {
      message.content = `<bash-input>${cut}</bash-input>`;
      count(context, "dotenv", 1);
    }
    return;
  }
  if (!context.bashInputTouchedDotenv || !content.trimStart().startsWith("<bash-stdout>")) return;
  context.bashInputTouchedDotenv = false;
  message.content = marker("dotenv");
  count(context, "dotenv", 1);
}

function scanDotenv(record: Record<string, unknown>, context: RedactContext): void {
  const message = record.message;
  const content = isObject(message) ? message.content : undefined;
  if (isObject(message) && typeof content === "string") return scanBashMode(message, content, context);
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!isObject(block)) continue;

    if (block.type === "tool_use") {
      const input = isObject(block.input) ? block.input : undefined;
      if (!input) continue;
      const command = input.command;
      const cut = typeof command === "string" ? cutDotenvWrites(command) : command;
      if (cut !== command) {
        input.command = cut;
        count(context, "dotenv", 1);
      }
      const named = callNamesDotenv(block.name, input);
      if (named) cutDotenvInput(input, context);
      if ((named || cut !== command || readsDotenv(command)) && typeof block.id === "string") {
        context.envToolUseIds.add(block.id);
      }
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

/**
 * Codex and Kimi pass a tool the name the agent typed, relative to where the
 * session stood. Read from a root above that it would be another file, so it is
 * made whole here and masking spells it from the root like any other.
 */
function fromBase(value: string, base: string | undefined): string {
  if (base === undefined || value.length === 0) return value;
  if (looksAbsolute(value) || value.startsWith("~") || value.includes("://")) return value;
  return resolve(base, value);
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
    const onMask = (amount: number): void => count(context, "path", amount);
    return key && PATH_KEYS.has(key)
      ? maskPath(fromBase(secretsGone, context.base), context.roots, onMask)
      : maskPaths(secretsGone, context.roots, onMask);
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

/**
 * Claude Code's `attachment` records are the harness's context for the model:
 * the account's email (`session_context`), its organisation (`credential_org`),
 * the whole system prompt with memory and CLAUDE.md (`prompt_snapshot`), the
 * connectors' instructions. Nothing downstream reads past their `type`, so that
 * is all that goes. The record itself stays: the next record names it as its
 * `parentUuid`, and the parser walks that chain.
 *
 * Claude Code 2.1.30x also records the request it sends: `api-request-shape`
 * carries the system prompt and the tool definitions, `api-request-blob` the
 * context blocks sent beside the conversation — memory, CLAUDE.md, the email
 * again — and `api-request` the parameters, whose `safeguards` hand a
 * classifier the account's user name, home directory and permission rules.
 * `bridge-session` and `artifact-autoreact-ledger` are cut the same way: one
 * names the account and organisation that own the session's bridge, the other
 * the account. The parser reads none of them past their type, so only the
 * fields that name them go — and the ones that say a subagent made the request
 * (`subagents.ts:asSidechain`), or it is counted as the session's own.
 */
const REQUEST_RECORD_KEYS = new Set([
  "type",
  "uuid",
  "parentUuid",
  "sessionId",
  "timestamp",
  "version",
  "shapeHash",
  "hash",
  "isSidechain",
  "parentToolUseID",
  "agentId",
]);
const STRIPPED_RECORD_TYPES = new Set([
  "api-request",
  "api-request-shape",
  "api-request-blob",
  "bridge-session",
  "artifact-autoreact-ledger",
]);

function stripAttachment(record: Record<string, unknown>, context: RedactContext): void {
  if (typeof record.type === "string" && STRIPPED_RECORD_TYPES.has(record.type)) {
    for (const key of Object.keys(record)) if (!REQUEST_RECORD_KEYS.has(key)) delete record[key];
    count(context, "attachment", 1);
    return;
  }
  if (record.type !== "attachment") return;
  const kind = isObject(record.attachment) ? record.attachment.type : undefined;
  record.attachment = typeof kind === "string" ? { type: kind } : {};
  delete record.rendered;
  delete record.renderedRole;
  count(context, "attachment", 1);
}

/**
 * Harness bookkeeping Claude Code writes beside a turn, read by nothing here or
 * on the server. `wireToolInputs` repeats every call's input, out of reach of
 * the dotenv cut, which edits the copy in `message` (`scanDotenv`);
 * `serverClassifierRequest` and `serverClassifierContext` are what a permission
 * classifier was shown, the working tree's git state included;
 * `wireIngestContext` and `permissionDecision` say where a call ran and what
 * allowed it.
 */
const HARNESS_FIELDS = [
  "wireToolInputs",
  "serverClassifierRequest",
  "serverClassifierContext",
  "wireIngestContext",
  "permissionDecision",
];

function stripHarnessFields(record: Record<string, unknown>, context: RedactContext): void {
  let stripped = false;
  for (const field of HARNESS_FIELDS) {
    if (!(field in record)) continue;
    delete record[field];
    stripped = true;
  }
  if (stripped) count(context, "attachment", 1);
}

/**
 * A user record marked `isMeta` is the harness talking in the user's place: a
 * skill's body, a `<system-reminder>`, a command's caveat, an extension's
 * instructions, a peer agent's message. Read as text it is a turn the
 * developer never typed, holding files the developer never sent, so only a
 * marker goes. None carries a tool result, and the record stays where it is:
 * the next one names it as its `parentUuid`.
 */
function stripMeta(record: Record<string, unknown>, context: RedactContext): void {
  if (record.type !== "user" || record.isMeta !== true || !isObject(record.message)) return;
  record.message = { ...record.message, content: marker("meta") };
  count(context, "attachment", 1);
}

function redactRecord(
  record: Record<string, unknown>,
  context: RedactContext,
): Record<string, unknown> {
  learnRoot(record, context);
  scanDotenv(record, context);
  stripAttachment(record, context);
  stripHarnessFields(record, context);
  stripMeta(record, context);
  return redactValue(record, context) as Record<string, unknown>;
}

export interface RedactOptions extends MaskRoots {
  extraPatterns?: readonly string[];
  /** Where the session stood, when that is below `cwd`: `git.ts:maskRootsFor`. */
  base?: string;
}

function createContext(options: RedactOptions, invalid: string[]): RedactContext {
  return {
    rules: [...BUILTIN_RULES, ...compileExtraRules(options.extraPatterns, invalid)],
    counts: {},
    envToolUseIds: new Set(),
    bashInputTouchedDotenv: false,
    // The home directory is this machine's and is never in the transcript's
    // gift, so it is read here rather than passed by every caller.
    roots: resolveRoots({ cwd: options.cwd, home: options.home ?? homedir() }),
    rootGiven: Boolean(options.cwd),
    base: options.base,
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

/**
 * A transcript's lines, redacted. With no `cwd`, paths are rooted at the first
 * record that names one; with no `home`, at the home that directory implies,
 * else this machine's. Exported as `isy/redact` so the server can re-run the
 * rules over a transcript an older client uploaded: there the machine is the
 * server, so it passes `home: ""` and roots paths in the transcript alone.
 */
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

/**
 * `redactLines` for lines that arrive one at a time — a file read as it streams,
 * or a Claude session with its subagents spliced in (`subagents.ts`). One
 * context for the whole stream, so the working directory the first record names
 * roots every path after it, the subagents' included.
 */
export async function redactLineStream(
  lines: AsyncIterable<string>,
  options: RedactOptions = {},
): Promise<{ lines: string[]; summary: RedactionSummary }> {
  const invalid: string[] = [];
  const context = createContext(options, invalid);
  const output: string[] = [];
  let total = 0;
  let unparsed = 0;

  for await (const line of lines) {
    total += 1;
    const result = redactOneLine(line, context);
    if (result.line.length === 0) continue;
    if (result.unparsed) unparsed += 1;
    output.push(result.line);
  }

  return { lines: output, summary: summarize(context, total, unparsed, invalid) };
}

export function redactTranscriptFile(
  filePath: string,
  options: RedactOptions = {},
): Promise<{ lines: string[]; summary: RedactionSummary }> {
  return redactLineStream(fileLines(filePath), options);
}

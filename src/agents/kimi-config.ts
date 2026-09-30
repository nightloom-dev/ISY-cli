/**
 * Just enough TOML to find hooks in a Kimi config wherever they stand.
 *
 * Both Kimi CLIs write their own config back: Kimi CLI through `tomlkit` on
 * `/model`, login and setup, Kimi Code on login — and Kimi Code's migration
 * copies Kimi CLI's hooks across into a file of its own. What comes out keeps
 * the tables, but not the comments isy marks its block with, and it quotes the
 * strings its own way. So a hook is told by what its `command` says, read the
 * way TOML reads it, rather than by a comment around it or by how the line is
 * spelled.
 *
 * Not a TOML parser: it reads `[[hooks]]` tables and their `event`, `command`
 * and `timeout`, and steps over multi-line strings and arrays so that nothing
 * inside one is taken for a table or a key. Everything else stays text.
 */

/** One `[[hooks]]` table, and where its lines stand in the file. */
export interface HookTable {
  /** Offset of its header line. */
  start: number;
  /** Offset just past its last line, newline included. */
  stop: number;
  event?: string;
  command?: string;
  timeout?: number;
}

const HOOKS_HEADER = /^\[\[\s*(?:hooks|"hooks"|'hooks')\s*\]\]\s*(?:#.*)?$/;

/** Offset just past the line `from` is on, newline included. */
function lineEnd(text: string, from: number): number {
  const newline = text.indexOf("\n", from);
  return newline < 0 ? text.length : newline + 1;
}

const ESCAPES: Record<string, string> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  e: "\x1b",
  '"': '"',
  "\\": "\\",
};

/** A basic string's body as TOML reads it. */
function unescape(body: string): string {
  return body.replace(
    /\\(?:u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|x([0-9A-Fa-f]{2})|([btnfre"\\]))/g,
    (match, u?: string, U?: string, x?: string, short?: string) => {
      if (short !== undefined) return ESCAPES[short]!;
      const point = Number.parseInt((u ?? U ?? x)!, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : match;
    },
  );
}

/** Where a basic string's body ends: its closing quote, or undefined when the line ends first. */
function basicEnd(text: string, from: number, quotes: string): number | undefined {
  for (let at = from; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === "\\") {
      at += 1;
      continue;
    }
    if (quotes.length === 1 && char === "\n") return undefined;
    if (text.startsWith(quotes, at)) return at;
  }
  return undefined;
}

/** A value's text as read, and the offset just past it. */
interface Value {
  string?: string;
  number?: number;
  next: number;
}

/** Past a bracketed value — an array or an inline table — whatever strings and comments are inside it. */
function bracketed(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at]!;
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return at + 1;
    } else if (char === "#") at = lineEnd(text, at) - 1;
    else if (char === '"' || char === "'") at = stringValue(text, at).next - 1;
  }
  return text.length;
}

/** A string value starting at `from`, of any of TOML's four kinds. */
function stringValue(text: string, from: number): Value {
  if (text.startsWith('"""', from) || text.startsWith("'''", from)) {
    const quotes = text.slice(from, from + 3);
    const end = quotes === '"""' ? basicEnd(text, from + 3, quotes) : text.indexOf(quotes, from + 3);
    if (end === undefined || end < 0) return { next: text.length };
    // Up to two quotes of the same kind may stand right before the closing three.
    let close = end;
    while (close < end + 2 && text[close + 3] === quotes[0]) close += 1;
    let body = text.slice(from + 3, close).replace(/^\r?\n/, "");
    if (quotes === '"""') body = unescape(body.replace(/\\[ \t]*\r?\n\s*/g, ""));
    return { string: body, next: close + 3 };
  }

  if (text[from] === '"') {
    const end = basicEnd(text, from + 1, '"');
    if (end === undefined) return { next: lineEnd(text, from) - 1 };
    return { string: unescape(text.slice(from + 1, end)), next: end + 1 };
  }

  const end = text.indexOf("'", from + 1);
  const eol = lineEnd(text, from);
  if (end < 0 || end >= eol) return { next: eol - 1 };
  return { string: text.slice(from + 1, end), next: end + 1 };
}

/** The value after a key's `=`, starting at `from`. */
function valueAt(text: string, from: number): Value {
  let at = from;
  while (text[at] === " " || text[at] === "\t") at += 1;

  const char = text[at];
  if (char === '"' || char === "'") return stringValue(text, at);
  if (char === "[" || char === "{") return { next: bracketed(text, at) };

  let end = at;
  while (end < text.length && text[end] !== "\n" && text[end] !== "#") end += 1;
  const scalar = text.slice(at, end).trim().replaceAll("_", "");
  const number = /^[+-]?\d+$/.test(scalar) ? Number(scalar) : undefined;
  return { ...(number !== undefined ? { number } : {}), next: end };
}

/** Where a key's `=` stands on a line: past any quoted part of the key. */
function equalsAt(text: string, from: number, eol: number): number | undefined {
  for (let at = from; at < eol; at += 1) {
    const char = text[at];
    if (char === "=") return at;
    if (char === '"' || char === "'") {
      const end = char === '"' ? basicEnd(text, at + 1, '"') : text.indexOf("'", at + 1);
      if (end === undefined || end < 0 || end >= eol) return undefined;
      at = end;
    }
  }
  return undefined;
}

/** A key as written: bare, or one quoted part. */
function keyName(raw: string): string {
  const key = raw.trim();
  if (key.length >= 2 && key[0] === key.at(-1) && (key[0] === '"' || key[0] === "'")) {
    return key[0] === '"' ? unescape(key.slice(1, -1)) : key.slice(1, -1);
  }
  return key;
}

/** Every `[[hooks]]` table in a TOML file, in order. */
export function hookTables(contents: string): HookTable[] {
  const tables: HookTable[] = [];
  let table: HookTable | undefined;

  let at = 0;
  while (at < contents.length) {
    const eol = lineEnd(contents, at);
    const line = contents.slice(at, eol).trim();

    if (line === "" || line.startsWith("#")) {
      at = eol;
      continue;
    }

    if (line.startsWith("[")) {
      if (table) tables.push(table);
      table = HOOKS_HEADER.test(line) ? { start: at, stop: eol } : undefined;
      at = eol;
      continue;
    }

    const equals = equalsAt(contents, at, eol);
    if (equals === undefined) {
      at = eol;
      continue;
    }
    const value = valueAt(contents, equals + 1);
    const stop = lineEnd(contents, value.next);
    if (table) {
      const key = keyName(contents.slice(at, equals));
      if (key === "event" && value.string !== undefined) table.event = value.string;
      if (key === "command" && value.string !== undefined) table.command = value.string;
      if (key === "timeout" && value.number !== undefined) table.timeout = value.number;
      table.stop = stop;
    }
    at = Math.max(stop, eol);
  }

  if (table) tables.push(table);
  return tables;
}

/** A TOML basic string holding `value` exactly: a command can hold any quote a path does. */
export function basicString(value: string): string {
  const escaped = value.replace(/[\\"\u0000-\u001f\u007f]/g, (char) => {
    const short = Object.entries(ESCAPES).find(([, raw]) => raw === char && char !== "\x1b")?.[0];
    return short !== undefined ? `\\${short}` : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${escaped}"`;
}

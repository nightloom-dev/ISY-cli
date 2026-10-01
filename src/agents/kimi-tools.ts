import { EDIT_TOOLS } from "../parser.js";

/**
 * Kimi's tools under the names and arguments Claude Code gives the same tools.
 *
 * The detectors read `Bash` for commands, `Edit`/`Write`/`MultiEdit` for edits
 * and `Read` for what the agent looked at, with the file under `file_path`.
 * Kimi CLI calls these `Shell`, `StrReplaceFile`, `WriteFile` and `ReadFile`,
 * with the file under `path` — so an untranslated Kimi session showed stage 0
 * no command it ran, no file it edited and none it read. Kimi Code took
 * Claude's names but kept Kimi's arguments: its `Read` takes `path`,
 * `line_offset` and `n_lines`, its `Write` a `mode`. Translating here, once,
 * keeps parser.ts and detectors.ts free of Kimi knowledge, the way
 * `codex-records.ts` does for Codex.
 */

export interface ClaudeToolUse {
  name: string;
  input: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only the arguments that are there: a translated call must not grow `undefined` keys. */
function defined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/** `StrReplaceFile`'s `{old, new, replace_all}` as one step of Claude's `Edit`. */
function step(edit: Record<string, unknown>): Record<string, unknown> {
  return defined({ old_string: edit.old, new_string: edit.new, replace_all: edit.replace_all });
}

export function claudeTool(name: string, args: Record<string, unknown>): ClaudeToolUse {
  const { path, ...rest } = args;
  // A Claude name with Kimi's arguments is Kimi Code's, and reads as Kimi CLI's tool of that job.
  const kimiArgs = typeof path === "string" && args.file_path === undefined;
  const tool = kimiArgs && name === "Read" ? "ReadFile" : kimiArgs && name === "Write" ? "WriteFile" : name;

  switch (tool) {
    case "Shell":
      return { name: "Bash", input: args };

    case "ReadFile":
    case "ReadMediaFile": {
      const { line_offset, n_lines, ...other } = rest;
      return { name: "Read", input: defined({ file_path: path, offset: line_offset, limit: n_lines, ...other }) };
    }

    case "WriteFile": {
      const { content, mode, ...other } = rest;
      // An append adds to a file whose content the call does not show, which is
      // an edit with nothing replaced — not a `Write`, whose content the revert
      // tracker takes for the whole file.
      if (mode === "append") return { name: "Edit", input: defined({ file_path: path, new_string: content, ...other }) };
      return { name: "Write", input: defined({ file_path: path, content, ...other }) };
    }

    case "StrReplaceFile": {
      const { edit, ...other } = rest;
      if (Array.isArray(edit)) {
        return { name: "MultiEdit", input: defined({ file_path: path, edits: edit.filter(isObject).map(step), ...other }) };
      }
      return { name: "Edit", input: defined({ file_path: path, ...(isObject(edit) ? step(edit) : {}), ...other }) };
    }

    case "Glob": {
      // Kimi CLI names the folder `directory`; Kimi Code, like Claude Code, `path`.
      const { directory, ...other } = args;
      return { name: "Glob", input: directory === undefined ? args : defined({ ...other, path: directory }) };
    }

    case "SearchWeb":
      return { name: "WebSearch", input: args };
    case "FetchURL":
      return { name: "WebFetch", input: args };
    case "SetTodoList":
    case "TodoList":
      return { name: "TodoWrite", input: args };
    // Older builds delegated through `Task`, as Claude Code once did.
    case "Task":
      return { name: "Agent", input: args };
  }

  // Claude's edit names with Kimi's argument. Grep and Glob take `path` in
  // Claude Code too and are left alone.
  if (EDIT_TOOLS.has(name) && kimiArgs) return { name, input: { ...rest, file_path: path } };
  return { name, input: args };
}

/**
 * Anything in a read's status line that says the text is not the file as it is
 * on disk: a line or the output cut short (Kimi CLI: `truncated`, `Max … reached`;
 * Kimi Code: `Character limit reached`, a line `fragment`), or bytes shown other
 * than they are (`\r` escapes, a lossy or transcoded decoding).
 */
const NOT_THE_FILE =
  /truncated|Max \d+ (?:lines|bytes) reached|Character limit reached|fragment|carriage-return|Lossy|Detected file encoding/;

/**
 * The file a Kimi `ReadFile` (Kimi Code: `Read`) returned, when it returned all
 * of it.
 *
 * Kimi numbers every line the way `cat -n` does — `%6d\t<line>` in Kimi CLI,
 * `<n>\t<line>` in Kimi Code — and says in its status line how much it read.
 * Only a read that started at line 1, reached the end and cut nothing short is
 * the file: anything less, fed to the revert tracker as the file's content,
 * would invent reverts (`detectors.ts:trackContent`). Kimi Code leaves the last
 * newline off; the tracker compares content with trailing newlines trimmed.
 */
export function wholeFileRead(output: string, message: string): string | undefined {
  const read = /^(\d+) lines read from file starting from line 1\. Total lines in file: (\d+)\./.exec(message);
  if (!read || read[1] !== read[2]) return undefined;
  if (NOT_THE_FILE.test(message)) return undefined;

  const lines = output.split(/(?<=\n)/);
  if (lines.length !== Number(read[1])) return undefined;

  const content: string[] = [];
  for (const [index, line] of lines.entries()) {
    const numbered = /^ *(\d+)\t/.exec(line);
    if (!numbered || Number(numbered[1]) !== index + 1) return undefined;
    content.push(line.slice(numbered[0].length));
  }
  return content.join("");
}

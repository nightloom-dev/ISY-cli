import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  EDIT_TOOLS,
  LOOKUP_TOOLS,
  commandSegments,
  onAbandonedBranch,
  shellReadPaths,
  withoutHeredocs,
} from "./parser.js";
import type { Candidate, FileEdit, ParsedSession, ToolUse } from "./types.js";

const FAILURE_LOOKBACK_RECORDS = 10;

const TEST_PATH = /(^|\/)(tests?|__tests__)\//i;
const TEST_EXTENSION = /\.(ts|tsx|js|py|rs|go|java)$/i;
const ASSERTION = /\b(assert|expect|should)\b/i;
const TEST_BLOCK = /(\bit\s*\(|\btest\s*\(|\bdef\s+test_|#\[test\])/gi;
const SKIP_MARKER =
  /(\bskip\b|\bxfail\b|\btodo\b|\.only\b|\bt\.Skip\b|#\[ignore\]|@Disabled|pytest\.mark\.skip)/i;
const FAILURE_OUTPUT = /(FAILED|failed|panicked|AssertionError)/;

const GIT_RESET = /\bgit\s+reset\s+(--hard|--merge)\b/;
const GIT_STASH = /\bgit\s+stash\b(?!\s+(pop|apply|list|show))/;
const GIT_CHECKOUT = /\bgit\s+checkout\s+(?:--\s+)?(?<paths>[^&|;]+)/;
const GIT_RESTORE = /\bgit\s+restore\s+(?<paths>[^&|;]+)/;

function normalize(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

function digest(content: string): string {
  return createHash("sha1").update(normalize(content)).digest("hex");
}

export function isTestFile(filePath: string): boolean {
  if (TEST_PATH.test(filePath)) return true;

  const name = basename(filePath);
  if (!TEST_EXTENSION.test(name)) return false;

  const tokens = name
    .replace(TEST_EXTENSION, "")
    .split(/[^a-zA-Z0-9]+|(?=[A-Z])/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());

  return tokens.includes("test") || tokens.includes("spec");
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

function assertionLines(text: string): number {
  return text.split("\n").filter((line) => ASSERTION.test(line)).length;
}

export function weakensTest(oldString: string, newString: string): string | undefined {
  if (assertionLines(newString) < assertionLines(oldString)) {
    return "assertions removed from the test";
  }
  if (SKIP_MARKER.test(newString) && !SKIP_MARKER.test(oldString)) {
    return "test marked as skipped or ignored";
  }
  if (countMatches(newString, TEST_BLOCK) < countMatches(oldString, TEST_BLOCK)) {
    return "a test case was deleted";
  }
  return undefined;
}

function failedBefore(session: ParsedSession, recordIndex: number): ToolUse | undefined {
  return session.toolUses.find((use) => {
    if (use.name !== "Bash") return false;
    if (use.recordIndex >= recordIndex) return false;
    if (use.recordIndex < recordIndex - FAILURE_LOOKBACK_RECORDS) return false;
    const result = use.result;
    if (!result) return false;
    return (
      result.isError ||
      FAILURE_OUTPUT.test(result.stdout ?? "") ||
      FAILURE_OUTPUT.test(result.stderr ?? "") ||
      FAILURE_OUTPUT.test(result.text)
    );
  });
}

export function detectTestModifiedToPass(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];

  for (const [filePath, edits] of session.fileEdits) {
    if (!isTestFile(filePath)) continue;

    for (const edit of edits) {
      if (edit.oldString === undefined || edit.newString === undefined) continue;

      const reason = weakensTest(edit.oldString, edit.newString);
      if (!reason) continue;

      const failure = failedBefore(session, edit.recordIndex);
      candidates.push({
        category: "test_modified_to_pass",
        sessionId: session.sessionId,
        uuid: edit.uuid,
        toolUseId: edit.toolUseId,
        filePath,
        recordIndex: edit.recordIndex,
        startedAt: failure?.timestamp ?? edit.timestamp,
        endedAt: edit.timestamp,
        weight: failure ? 0.9 : 0.6,
        detail: failure
          ? `${reason}, shortly after a failing command`
          : reason,
      });
    }
  }

  // One weakening of one test file is one decision, however many separate edits
  // it took. Codex writes a file through many small patch hunks where Claude
  // Code writes one replacement, which is what made the fan-out visible.
  return dedupe(candidates);
}

interface FileState {
  content?: string;
  seen: Map<string, number>;
  lastKey?: string;
  edited: boolean;
}

function applyEdit(content: string, oldString: string, newString: string, all: boolean): string | undefined {
  if (oldString.length === 0 || !content.includes(oldString)) return undefined;
  return all ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);
}

function trackContent(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];
  const states = new Map<string, FileState>();

  const state = (filePath: string): FileState => {
    let existing = states.get(filePath);
    if (!existing) {
      existing = { seen: new Map(), edited: false };
      states.set(filePath, existing);
    }
    return existing;
  };

  const record = (file: FileState, filePath: string, use: ToolUse, isEdit: boolean): void => {
    if (file.content === undefined) return;
    const key = digest(file.content);
    const firstSeen = file.seen.get(key);
    const unchanged = key === file.lastKey;
    file.lastKey = key;

    if (!unchanged && isEdit && firstSeen !== undefined && file.edited && firstSeen < use.recordIndex) {
      candidates.push({
        category: "abandoned_approach",
        sessionId: session.sessionId,
        uuid: use.uuid,
        toolUseId: use.id,
        filePath,
        recordIndex: use.recordIndex,
        startedAt: use.timestamp,
        endedAt: use.timestamp,
        weight: 0.8,
        detail: "file returned to a state it already had earlier in the session",
      });
      return;
    }

    if (firstSeen === undefined) file.seen.set(key, use.recordIndex);
  };

  for (const use of session.toolUses) {
    const filePath =
      typeof use.input.file_path === "string" ? use.input.file_path : undefined;
    if (!filePath) continue;

    const file = state(filePath);

    if (use.name === "Read" && typeof use.result?.fileContent === "string") {
      file.content = use.result.fileContent;
      record(file, filePath, use, false);
      continue;
    }

    if (use.name === "Write" && typeof use.input.content === "string") {
      file.content = use.input.content;
      file.edited = true;
      record(file, filePath, use, true);
      continue;
    }

    if (use.name === "Edit" || use.name === "MultiEdit") {
      file.edited = true;
      const steps = Array.isArray(use.input.edits)
        ? use.input.edits
        : [{ old_string: use.input.old_string, new_string: use.input.new_string }];

      for (const step of steps) {
        if (file.content === undefined) break;
        const from = (step as { old_string?: unknown }).old_string;
        const to = (step as { new_string?: unknown }).new_string;
        if (typeof from !== "string" || typeof to !== "string") {
          file.content = undefined;
          break;
        }
        file.content = applyEdit(file.content, from, to, use.input.replace_all === true);
      }

      record(file, filePath, use, true);
    }
  }

  return candidates;
}

function detectRevertPairs(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];

  for (const [filePath, edits] of session.fileEdits) {
    for (let later = 1; later < edits.length; later += 1) {
      const current = edits[later]!;
      if (current.oldString === undefined || current.newString === undefined) continue;

      const reverted = edits.slice(0, later).some(
        (earlier) =>
          earlier.oldString !== undefined &&
          earlier.newString !== undefined &&
          earlier.oldString === current.newString &&
          earlier.newString === current.oldString,
      );
      if (!reverted) continue;

      candidates.push({
        category: "abandoned_approach",
        sessionId: session.sessionId,
        uuid: current.uuid,
        toolUseId: current.toolUseId,
        filePath,
        recordIndex: current.recordIndex,
        startedAt: current.timestamp,
        endedAt: current.timestamp,
        weight: 0.7,
        detail: "an earlier edit to this file was undone by a later one",
      });
    }
  }

  return candidates;
}

function revertTargets(command: string): { everything: boolean; paths: string[] } | undefined {
  if (GIT_RESET.test(command) || GIT_STASH.test(command)) {
    return { everything: true, paths: [] };
  }

  const match = GIT_CHECKOUT.exec(command) ?? GIT_RESTORE.exec(command);
  const raw = match?.groups?.paths;
  if (!raw) return undefined;

  const paths = raw
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0 && !part.startsWith("-"));

  return paths.length > 0 ? { everything: false, paths } : undefined;
}

function matchesPath(filePath: string, target: string): boolean {
  const cleaned = target.replace(/^\.\//, "").replace(/["']/g, "");
  if (cleaned === "." || cleaned === "*") return true;
  return filePath.endsWith(`/${cleaned}`) || basename(filePath) === basename(cleaned);
}

const REVERT_FILES_LISTED = 5;

function detectGitReverts(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];

  for (const use of session.toolUses) {
    if (use.name !== "Bash") continue;
    const command = typeof use.input.command === "string" ? use.input.command : undefined;
    if (!command) continue;

    const targets = revertTargets(command);
    if (!targets) continue;

    const discarded: string[] = [];
    let startedAt: string | undefined;

    for (const [filePath, edits] of session.fileEdits) {
      const earlier = edits.filter((edit) => edit.recordIndex < use.recordIndex);
      if (earlier.length === 0) continue;
      if (!targets.everything && !targets.paths.some((path) => matchesPath(filePath, path))) {
        continue;
      }

      discarded.push(filePath);
      const first = earlier[0]?.timestamp;
      if (first && (!startedAt || first < startedAt)) startedAt = first;
    }

    if (discarded.length === 0) continue;

    const listed = discarded.slice(0, REVERT_FILES_LISTED).map((path) => basename(path));
    const rest = discarded.length - listed.length;

    candidates.push({
      category: "abandoned_approach",
      sessionId: session.sessionId,
      uuid: use.uuid,
      toolUseId: use.id,
      filePath: discarded.length === 1 ? discarded[0] : undefined,
      recordIndex: use.recordIndex,
      startedAt,
      endedAt: use.timestamp,
      weight: 0.75,
      detail:
        discarded.length === 1
          ? "edits to this file were discarded by a git command"
          : `edits to ${discarded.length} files were discarded by a git command: ` +
            `${listed.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`,
    });
  }

  return candidates;
}

function detectAbandonedBranches(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];
  if (session.mainPath.size === 0) return candidates;

  for (const [filePath, edits] of session.fileEdits) {
    for (const edit of edits) {
      if (!onAbandonedBranch(session, edit.uuid)) continue;

      candidates.push({
        category: "abandoned_approach",
        sessionId: session.sessionId,
        uuid: edit.uuid,
        toolUseId: edit.toolUseId,
        filePath,
        recordIndex: edit.recordIndex,
        startedAt: edit.timestamp,
        endedAt: edit.timestamp,
        weight: 0.4,
        detail: "edit sits on a conversation branch the session did not continue",
      });
    }
  }

  return candidates;
}

function keepBest(candidates: Candidate[], key: (candidate: Candidate) => string): Candidate[] {
  const best = new Map<string, Candidate>();

  for (const candidate of candidates) {
    const existing = best.get(key(candidate));
    if (!existing || candidate.weight > existing.weight) best.set(key(candidate), candidate);
  }

  return [...best.values()];
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const perEvent = keepBest(
    candidates,
    (candidate) => `${candidate.category}|${candidate.filePath ?? ""}|${candidate.recordIndex}`,
  );
  const perFile = keepBest(
    perEvent,
    (candidate) => `${candidate.category}|${candidate.filePath ?? ""}|${candidate.detail}`,
  );

  return perFile.sort((a, b) => a.recordIndex - b.recordIndex);
}

export function detectAbandonedApproach(session: ParsedSession): Candidate[] {
  return dedupe([
    ...trackContent(session),
    ...detectRevertPairs(session),
    ...detectGitReverts(session),
    ...detectAbandonedBranches(session),
  ]);
}

const MANIFESTS = new Set([
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
]);

const VERSION_VALUE = /^(\*|latest|workspace:|file:|github:|npm:|link:|[\^~>=<]*\d)/;
const SHELL_BREAK = /^(&&|\|\||;|\||>|>>|<)$/;
const REDIRECTION = /^\d*[<>]|^&/;

const NOT_A_DEPENDENCY = new Set([
  "version",
  "packageManager",
  "node",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "php",
  "pip",
  "pip3",
  "poetry",
  "uv",
  "cargo",
  "go",
  "setuptools",
  "wheel",
]);

const VALUE_FLAGS = new Set([
  "--features",
  "-F",
  "--registry",
  "--tag",
  "--prefix",
  "--index-url",
  "--extra-index-url",
  "-i",
  "--python",
  "--target",
  "--rename",
]);

const INSTALL_COMMANDS: { pattern: RegExp; manager: string }[] = [
  { pattern: /\bnpm\s+(?:install|i|add)\b/, manager: "npm" },
  { pattern: /\bpnpm\s+(?:add|install)\b/, manager: "pnpm" },
  { pattern: /\byarn\s+add\b/, manager: "yarn" },
  { pattern: /\bcargo\s+add\b/, manager: "cargo" },
  { pattern: /\bpip3?\s+install\b/, manager: "pip" },
  { pattern: /\bpoetry\s+add\b/, manager: "poetry" },
  { pattern: /\bgo\s+get\b/, manager: "go" },
  { pattern: /\buv\s+(?:add|pip\s+install)\b/, manager: "uv" },
];

export function packageName(specifier: string): string {
  return /^(?:@[^/@\s]+\/)?[^<>=~!@[\s]+/.exec(specifier)?.[0] ?? specifier;
}

export function isManifest(filePath: string): boolean {
  return MANIFESTS.has(basename(filePath));
}

function jsonDependencies(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/"([@A-Za-z0-9._/-]+)"\s*:\s*"([^"]*)"/g)) {
    const [, name, value] = match;
    if (!name || !value) continue;
    if (NOT_A_DEPENDENCY.has(name)) continue;
    if (VERSION_VALUE.test(value)) names.add(name);
  }
  return names;
}

function otherDependencies(text: string): Set<string> {
  const names = new Set<string>();
  const patterns = [
    /^\s*([A-Za-z0-9._-]+)\s*(?:==|>=|<=|~=|!=)/gm,
    /^\s*gem\s+["']([^"']+)["']/gm,
    /<artifactId>([^<]+)<\/artifactId>/g,
    /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v[0-9]/gm,
    /(?:implementation|api|testImplementation)\s+["']([^"':]+:[^"':]+)/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return names;
}

/** A TOML table of dependencies: Cargo's `[dev-dependencies]`, `[target.'cfg(unix)'.dependencies]`, Poetry's `[tool.poetry.group.dev.dependencies]`. */
const TOML_DEPENDENCY_TABLE = /(?:^|\.)(?:dev-|build-)?dependencies$/;
/** Cargo's one-dependency table, `[dependencies.tokio]`. */
const TOML_DEPENDENCY_SUBTABLE = /(?:^|\.)(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/;
/** Tables whose every key holds a list of requirement strings: PEP 621 extras, PEP 735 groups. */
const TOML_REQUIREMENT_TABLES = new Set(["project.optional-dependencies", "dependency-groups"]);
/** Keys a TOML manifest gives a version, none of them a package. */
const TOML_VERSION_KEYS = new Set(["python", "version", "edition", "rust-version", "requires-python"]);
const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;
const TOML_ASSIGNMENT = /^\s*["']?([A-Za-z0-9._-]+)["']?\s*=\s*(.*)$/gm;
/** `key = [ … ]`, across lines, a `]` inside a quoted requirement (`"requests[socks]"`) included. */
const TOML_ARRAY = /^\s*["']?([A-Za-z0-9_-]+)["']?\s*=\s*\[((?:"[^"]*"|'[^']*'|[^\]"'])*)/gm;

/** Package names out of the body of a TOML array of PEP 508 requirement strings. */
function requirementNames(array: string): string[] {
  const names: string[] = [];
  for (const match of array.matchAll(/"([^"]*)"|'([^']*)'/g)) {
    // `tomli; python_version < '3.11'`: the marker is not part of the name.
    const name = packageName((match[1] ?? match[2] ?? "").split(";")[0]!.trim());
    if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !NOT_A_DEPENDENCY.has(name)) names.push(name);
  }
  return names;
}

/**
 * Dependencies out of `pyproject.toml` or `Cargo.toml`, read table by table. A
 * new manifest is mostly `name = "…"`, `description = "…"` and entry points,
 * and a guess by line shape reported every one of them as a package — two
 * false candidates were enough to lift a session over the triage floor.
 *
 * An edit is often a fragment with no header in view, and its leading lines
 * sit in a table nobody can name. There a key counts only when its value reads
 * as a version or a table (`serde = "1.0"`, `serde = { … }`), which leaves out
 * metadata and entry points (`dwmt = "dwmt.cli:main"`); a `dependencies`
 * array is PEP 621's either way.
 */
function tomlDependencies(text: string): Set<string> {
  const names = new Set<string>();
  const add = (name: string): void => {
    if (!TOML_VERSION_KEYS.has(name) && !NOT_A_DEPENDENCY.has(name)) names.add(name);
  };

  // The lines before the first header belong to the table nobody can name.
  const tables: { name: string | undefined; lines: string[] }[] = [{ name: undefined, lines: [] }];
  for (const line of text.split("\n")) {
    const header = TOML_HEADER.exec(line);
    if (header) tables.push({ name: header[1]!.replace(/["'\s]/g, ""), lines: [] });
    else tables.at(-1)!.lines.push(line);
  }

  for (const table of tables) {
    const body = table.lines.join("\n");
    const subtable = table.name === undefined ? undefined : TOML_DEPENDENCY_SUBTABLE.exec(table.name);
    if (subtable) {
      add(subtable[1]!);
      continue;
    }

    const everyArray = table.name !== undefined && TOML_REQUIREMENT_TABLES.has(table.name);
    if (everyArray || table.name === undefined || table.name === "project") {
      for (const [, key, array] of body.matchAll(TOML_ARRAY)) {
        if (everyArray || key === "dependencies") requirementNames(array!).forEach(add);
      }
      if (everyArray) continue;
    }

    const dependencyTable = table.name !== undefined && TOML_DEPENDENCY_TABLE.test(table.name);
    if (!dependencyTable && table.name !== undefined) continue;
    for (const [, key, value] of body.matchAll(TOML_ASSIGNMENT)) {
      const unquoted = value!.replace(/^["']/, "");
      const versionShaped = value!.startsWith("{") || (/^["']/.test(value!) && VERSION_VALUE.test(unquoted));
      // Cargo's dotted form, `serde.workspace = true`, names the package first.
      if (dependencyTable || versionShaped) add(key!.split(".")[0]!);
    }
  }
  return names;
}

export function addedDependencies(
  filePath: string,
  oldString: string,
  newString: string,
): string[] {
  const name = basename(filePath);
  const extract = name === "package.json" || name === "composer.json"
    ? jsonDependencies
    : name.endsWith(".toml")
      ? tomlDependencies
      : (text: string) => new Set([...jsonDependencies(text), ...otherDependencies(text)]);

  const before = extract(oldString);
  return [...extract(newString)].filter((name) => !before.has(name)).sort();
}

/**
 * What a package can be called anywhere ISY looks — npm, pip, go, cargo, gem —
 * version specifier included: `openai>=1.0`, `left-pad@^1.0.0`.
 */
const PACKAGE_NAME = /^[@A-Za-z0-9][A-Za-z0-9@._/+~^<>=!*-]*$/;

function packagesInSegment(segment: string, afterIndex: number): string[] | undefined {
  const packages: string[] = [];
  let skipNext = false;

  for (const token of segment.slice(afterIndex).trim().split(/\s+/)) {
    if (token.length === 0) continue;
    if (SHELL_BREAK.test(token) || REDIRECTION.test(token)) break;

    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (token === "-r" || token === "--requirement" || token === "-e" || token === "--editable") {
      return undefined;
    }
    if (token.startsWith("-")) {
      if (VALUE_FLAGS.has(token)) skipNext = true;
      continue;
    }

    const cleaned = token.replace(/["']/g, "");
    const trimmed = cleaned.replace(/[.,;:]+$/, "");
    // A registry name, not whatever else stood in that position: a line
    // continuation, a shell expansion whose value only the shell knows, a
    // stray brace from prose the command happened to carry.
    if (PACKAGE_NAME.test(trimmed) && !NOT_A_DEPENDENCY.has(packageName(trimmed))) {
      packages.push(trimmed);
    }
    if (trimmed !== cleaned) break;
  }

  return packages.length > 0 ? packages : undefined;
}

export function installedPackages(command: string): { manager: string; packages: string[] } | undefined {
  for (const segment of commandSegments(withoutHeredocs(command))) {
    for (const { pattern, manager } of INSTALL_COMMANDS) {
      const match = pattern.exec(segment);
      if (!match) continue;

      const packages = packagesInSegment(segment, match.index + match[0].length);
      if (packages) return { manager, packages };
    }
  }
  return undefined;
}

export function detectExternalDependency(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];
  const reported = new Set<string>();

  for (const [filePath, edits] of session.fileEdits) {
    if (!isManifest(filePath)) continue;

    for (const edit of edits) {
      const added = addedDependencies(filePath, edit.oldString ?? "", edit.newString ?? edit.content ?? "");
      if (added.length === 0) continue;
      for (const name of added) reported.add(packageName(name));

      candidates.push({
        category: "external_dependency",
        sessionId: session.sessionId,
        uuid: edit.uuid,
        toolUseId: edit.toolUseId,
        filePath,
        recordIndex: edit.recordIndex,
        startedAt: edit.timestamp,
        endedAt: edit.timestamp,
        weight: 0.7,
        detail: `added to ${basename(filePath)}: ${added.join(", ")}`,
      });
    }
  }

  for (const use of session.toolUses) {
    if (use.name !== "Bash") continue;
    const command = typeof use.input.command === "string" ? use.input.command : undefined;
    if (!command) continue;

    const installed = installedPackages(command);
    if (!installed) continue;
    if (installed.packages.every((name) => reported.has(packageName(name)))) continue;
    for (const name of installed.packages) reported.add(packageName(name));

    candidates.push({
      category: "external_dependency",
      sessionId: session.sessionId,
      uuid: use.uuid,
      toolUseId: use.id,
      recordIndex: use.recordIndex,
      startedAt: use.timestamp,
      endedAt: use.timestamp,
      weight: 0.7,
      detail: `installed with ${installed.manager}: ${installed.packages.join(", ")}`,
    });
  }

  return dedupe(candidates);
}

/**
 * Whether two paths name the same file. Reads are recorded as the agent typed
 * them — `src/api.ts` from a shell, `/repo/src/api.ts` from the Read tool — so
 * a relative path matches any absolute one ending in it, and a directory
 * matches everything under it.
 */
function samePath(known: string, filePath: string): boolean {
  if (known === filePath) return true;
  if (filePath.startsWith(known.endsWith("/") ? known : `${known}/`)) return true;
  return !known.startsWith("/") && filePath.endsWith(`/${known}`);
}

function wasLookedUp(session: ParsedSession, filePath: string): boolean {
  for (const known of session.filesRead) {
    if (samePath(known, filePath)) return true;
  }
  return false;
}

export function detectUnverifiedAssumption(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];

  for (const [filePath, edits] of session.fileEdits) {
    const first = edits[0];
    if (!first) continue;
    if (first.tool !== "Edit" && first.tool !== "MultiEdit") continue;
    if (wasLookedUp(session, filePath)) continue;

    candidates.push({
      category: "unverified_assumption",
      sessionId: session.sessionId,
      uuid: first.uuid,
      toolUseId: first.toolUseId,
      filePath,
      recordIndex: first.recordIndex,
      startedAt: first.timestamp,
      endedAt: edits[edits.length - 1]?.timestamp,
      weight: 0.35,
      detail: "file was edited without ever being read or searched in this session",
    });
  }

  return candidates;
}

/**
 * Commands that check the work: test runners, builds, type checkers, linters.
 * The list is deliberately about *running* things — a `git status` proves the
 * agent looked, not that anything still compiles.
 */
const VERIFY_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|tsc)|node\s+--test|(?:npx\s+)?(?:jest|vitest|mocha|tsc|eslint|biome|playwright|cypress|ava|tap)|pytest|python[0-9.]*\s+-m\s+(?:pytest|unittest)|tox|ruff|mypy|pyright|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|(?:mvn|gradle|\.\/gradlew)\s+\S*(?:test|build|check)|make\s+(?:test|check|build|lint)|dotnet\s+(?:test|build)|(?:bundle\s+exec\s+)?rspec|phpunit|swift\s+(?:test|build)|ctest|cmake\s+--build)\b/;

const UNVERIFIED_FILES_LISTED = 3;

const CODE_EXTENSION =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|c|cc|cpp|h|hpp|cs|kt|swift|scala|sh|sql|vue|svelte)$/i;

/** A command that ran the project's own checks, not one that merely looked around. */
function verifies(use: ToolUse): boolean {
  if (use.name !== "Bash") return false;
  const command = typeof use.input.command === "string" ? use.input.command : "";
  return VERIFY_COMMAND.test(command);
}

/**
 * Code that was changed and never run afterwards. Two shapes, and the second is
 * the sharper one: a session that never verifies anything is a session working
 * in the dark, but a session that verified, then edited again, and stopped, is
 * one whose green result describes code that no longer exists.
 *
 * Only the last edit to a file matters — earlier ones were superseded by it.
 */
export function detectUnverifiedFix(session: ParsedSession): Candidate[] {
  const checks = session.toolUses.filter(verifies);
  const lastCheck = checks[checks.length - 1]?.recordIndex ?? -1;

  const stale: FileEdit[] = [];
  for (const [filePath, edits] of session.fileEdits) {
    if (!CODE_EXTENSION.test(filePath) || isTestFile(filePath)) continue;

    const last = edits[edits.length - 1];
    if (last && last.recordIndex > lastCheck) stale.push(last);
  }
  if (stale.length === 0) return [];

  // One note per session, not one per file: "nothing was run after this" is a
  // property of how the session ended, and a reviewer reads it once. Anchored
  // at the last unchecked edit, which is where the session stopped looking.
  stale.sort((a, b) => a.recordIndex - b.recordIndex);
  const last = stale[stale.length - 1]!;
  // By name, deduplicated: two paths ending in the same file read as a mistake.
  const names = [...new Set(stale.map((edit) => basename(edit.filePath)))];
  const listed = names.slice(0, UNVERIFIED_FILES_LISTED);
  const rest = names.length - listed.length;
  const files = `${listed.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;

  return [
    {
      category: "unverified_fix",
      sessionId: session.sessionId,
      uuid: last.uuid,
      toolUseId: last.toolUseId,
      filePath: stale.length === 1 ? last.filePath : undefined,
      recordIndex: last.recordIndex,
      startedAt: stale[0]?.timestamp,
      endedAt: last.timestamp,
      weight: checks.length === 0 ? 0.5 : 0.6,
      detail:
        checks.length === 0
          ? `no test, build or lint command ran in the whole session: ${files}`
          : `edited after the last test or build run, never checked again: ${files}`,
    },
  ];
}

/**
 * Silencing rather than fixing. `test_modified_to_pass` covers the test-file
 * half of this; here it is production code, where a suppression comment has no
 * failing test to explain it and simply removes the warning from view.
 */
const SUPPRESSORS: { pattern: RegExp; detail: string }[] = [
  { pattern: /@ts-(?:ignore|nocheck|expect-error)\b/g, detail: "a TypeScript error was suppressed" },
  { pattern: /eslint-disable(?:-next-line|-line)?\b/g, detail: "an ESLint rule was disabled" },
  { pattern: /#\s*type:\s*ignore\b/g, detail: "a type error was suppressed" },
  { pattern: /#\s*noqa\b/g, detail: "a lint error was suppressed" },
  { pattern: /#\s*pylint:\s*disable\b/g, detail: "a pylint rule was disabled" },
  { pattern: /@SuppressWarnings\b/g, detail: "a compiler warning was suppressed" },
  { pattern: /#\[allow\(/g, detail: "a Rust lint was allowed" },
  { pattern: /except[^\n:]*:\s*(?:#[^\n]*)?\n\s*pass\b/g, detail: "an exception is caught and dropped" },
  { pattern: /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g, detail: "an exception is caught and dropped" },
  { pattern: /rescue\s*(?:=>\s*\w+\s*)?\n\s*end\b/g, detail: "an exception is caught and dropped" },
];

/** `|| true` on a check, and the flags that walk past a failing hook. */
const SUPPRESSING_FLAG = /--no-verify\b|--ignore-errors\b|--exit-zero\b/;

function suppressionAdded(oldString: string, newString: string): string | undefined {
  for (const { pattern, detail } of SUPPRESSORS) {
    // Counted, not tested: an edit that keeps one suppression and adds a second
    // is still an addition, and the file may have arrived with one already.
    if (countMatches(newString, pattern) > countMatches(oldString, pattern)) return detail;
  }
  return undefined;
}

export function detectErrorSuppressed(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];

  for (const [filePath, edits] of session.fileEdits) {
    // A weakened test is the same act with its own category and its own weight.
    if (isTestFile(filePath)) continue;

    for (const edit of edits) {
      const before = edit.oldString ?? "";
      const after = edit.newString ?? edit.content ?? "";
      if (after.length === 0) continue;

      const reason = suppressionAdded(before, after);
      if (!reason) continue;

      const failure = failedBefore(session, edit.recordIndex);
      candidates.push({
        category: "error_suppressed",
        sessionId: session.sessionId,
        uuid: edit.uuid,
        toolUseId: edit.toolUseId,
        filePath,
        recordIndex: edit.recordIndex,
        startedAt: failure?.timestamp ?? edit.timestamp,
        endedAt: edit.timestamp,
        weight: failure ? 0.7 : 0.45,
        detail: failure ? `${reason}, shortly after a failing command` : reason,
      });
    }
  }

  for (const use of session.toolUses) {
    if (use.name !== "Bash") continue;
    const command = typeof use.input.command === "string" ? use.input.command : undefined;
    if (!command) continue;

    // `|| true` only counts on a command that was checking something: on a
    // cleanup line it is ordinary defensive shell.
    const ignoredFailure = /\|\|\s*true\b/.test(command) && VERIFY_COMMAND.test(command);
    if (!ignoredFailure && !SUPPRESSING_FLAG.test(command)) continue;

    candidates.push({
      category: "error_suppressed",
      sessionId: session.sessionId,
      uuid: use.uuid,
      toolUseId: use.id,
      recordIndex: use.recordIndex,
      startedAt: use.timestamp,
      endedAt: use.timestamp,
      weight: 0.5,
      detail: ignoredFailure
        ? "a check was run with its failure discarded by `|| true`"
        : "a command was run with its safety check switched off",
    });
  }

  return dedupe(candidates);
}

/**
 * Commands that can destroy work the diff will never account for: an uncommitted
 * file, a colleague's commit, a table. The diff shows what exists afterwards, so
 * this is the one category a reviewer cannot reach any other way.
 */
const DESTRUCTIVE: { pattern: RegExp; weight: number; detail: string }[] = [
  { pattern: /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i, weight: 0.8, detail: "a database object was dropped" },
  { pattern: /\bTRUNCATE\s+(TABLE\s+)?\w/i, weight: 0.8, detail: "a table was truncated" },
  { pattern: /\bDELETE\s+FROM\s+\w+\s*["']?\s*(?:;|$)/i, weight: 0.8, detail: "rows were deleted with no WHERE clause" },
  { pattern: /\bgit\s+push\s+[^\n;|&]*(?:--force\b(?!-with-lease)|(?:^|\s)-f\b)/, weight: 0.7, detail: "a branch was force-pushed" },
  { pattern: /\bgit\s+clean\s+-[a-z]*[fd]/, weight: 0.6, detail: "untracked files were deleted by git clean" },
  { pattern: /\bgit\s+branch\s+-D\b/, weight: 0.5, detail: "a branch was deleted unmerged" },
  { pattern: /\bgit\s+reset\s+--hard\b/, weight: 0.6, detail: "the working tree was reset, discarding uncommitted work" },
  { pattern: /\bDROP\s+INDEX\b/i, weight: 0.5, detail: "an index was dropped" },
];

/** Paths a project regenerates from source, where deletion costs a rebuild. */
const THROWAWAY =
  /(^|\/)(node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|__pycache__|\.pytest_cache|\.venv|venv|vendor|tmp|temp)(\/|$)|^\/tmp\/|\.(log|lock|pyc|o|class)$/i;

/**
 * Commands that only look at text. A `grep "DROP TABLE"` or a heredoc quoting a
 * migration is not a migration, and the corpus is full of both.
 */
const READER = /^\s*(?:sudo\s+)?(?:cat|head|tail|less|more|bat|nl|wc|sed|awk|rg|grep|egrep|fgrep|jq|yq|xxd|od|file|stat|diff|echo|printf|git\s+(?:show|diff|log|grep))\b/;

/**
 * A path this repository owns: `~/android` is the user's machine, not the work.
 *
 * Stage 0 only ever sees a redacted transcript — `analyze.ts` redacts before it
 * parses, the server masks on the way out of storage — and redaction is what
 * makes a path inside the working directory relative. So the question is
 * the shape of the path, and there is no working directory left to compare
 * against: `.` is all that survives of it.
 */
function insideProject(path: string): boolean {
  return !path.startsWith("~") && !path.startsWith("/");
}

/**
 * `rm -rf <path>` in one command segment, minus the paths that grow back on
 * their own. Anchored at the start of a segment on purpose: `rm -rf` inside a
 * grep pattern or a quoted example is text, not a deletion.
 */
function removedPaths(session: ParsedSession, segment: string): string[] {
  const match = /^\s*(?:sudo\s+)?rm\s+((?:-[a-zA-Z]+\s+)*)(.*)$/.exec(segment);
  if (!match) return [];

  const rest = `${match[1] ?? ""}${match[2] ?? ""}`;
  if (!/(^|\s)-[a-zA-Z]*[rR]/.test(rest)) return [];

  const paths: string[] = [];
  for (const raw of (match[2] ?? "").trim().split(/\s+/)) {
    const path = raw.replace(/["']/g, "");
    if (path.length === 0 || path.startsWith("-") || path.includes("$")) continue;
    if (THROWAWAY.test(path) || !insideProject(path)) continue;
    paths.push(path);
  }

  return paths;
}

const DESTRUCTIVE_FILES_LISTED = 3;

/** As many files as a reviewer reads off one line before it stops being one. */
const STALE_FILES_LISTED = 3;

export function detectDestructiveCommand(session: ParsedSession): Candidate[] {
  const candidates: Candidate[] = [];

  for (const use of session.toolUses) {
    if (use.name !== "Bash") continue;
    const command = typeof use.input.command === "string" ? use.input.command : undefined;
    if (!command) continue;

    const found: { weight: number; detail: string }[] = [];

    for (const segment of commandSegments(withoutHeredocs(command))) {
      if (READER.test(segment)) continue;

      const removed = removedPaths(session, segment);
      if (removed.length > 0) {
        const listed = removed.slice(0, DESTRUCTIVE_FILES_LISTED);
        const rest = removed.length - listed.length;
        found.push({
          weight: 0.6,
          detail: `deleted recursively: ${listed.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`,
        });
      }
      for (const { pattern, weight, detail } of DESTRUCTIVE) {
        if (pattern.test(segment)) found.push({ weight, detail });
      }
    }
    if (found.length === 0) continue;

    // One command is one decision, however many of these patterns it matched.
    const worst = found.reduce((a, b) => (b.weight > a.weight ? b : a));
    const details = [...new Set(found.map(({ detail }) => detail))];

    candidates.push({
      category: "destructive_command",
      sessionId: session.sessionId,
      uuid: use.uuid,
      toolUseId: use.id,
      recordIndex: use.recordIndex,
      startedAt: use.timestamp,
      endedAt: use.timestamp,
      weight: worst.weight,
      detail: details.join("; "),
    });
  }

  return dedupe(candidates);
}

/**
 * A break long enough that the repository could have moved under the agent
 * while it stood still: the developer went away, pulled, switched branch, or
 * edited a file by hand. Anything shorter is the developer reading a diff
 * before approving the next call.
 *
 * ponytail: one flat threshold for every CLI. If a corpus run shows approval
 * pauses this long, raise the number rather than adding per-agent rules.
 */
const PAUSE_MS = 30 * 60_000;

/** The break as the note says it: `47m`, `2h05`. */
function breakLength(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, "0")}`;
}

/** Every path this call looked at, however the agent reached it. */
function pathsSeen(use: ToolUse): string[] {
  if (use.name === "Bash") {
    const command = typeof use.input.command === "string" ? use.input.command : "";
    return shellReadPaths(command);
  }
  if (!LOOKUP_TOOLS.has(use.name) && !EDIT_TOOLS.has(use.name)) return [];

  const paths: string[] = [];
  for (const key of ["file_path", "notebook_path", "path"]) {
    const value = use.input[key];
    if (typeof value === "string" && value.length > 0) paths.push(value);
  }
  return paths;
}

/** The last call that looked at this file, or nothing if none did. */
function lastLook(seen: ReadonlyMap<string, number>, filePath: string): number | undefined {
  let latest: number | undefined;
  for (const [known, index] of seen) {
    if (!samePath(known, filePath)) continue;
    if (latest === undefined || index > latest) latest = index;
  }
  return latest;
}

/**
 * Work resumed on what the agent knew before the break. The transcript reads as
 * one continuous session, and the diff shows none of this: an edit written at
 * 09:14 on what was read at 17:40 the day before is indistinguishable in the
 * final code from one written a second after the read.
 *
 * What makes it a signal is the gap plus the missing re-read. An agent that
 * comes back and reads the file again has checked; one that edits straight
 * away is trusting a picture of the file that nothing has confirmed since.
 *
 * One note per session, not per break and not per file. A developer who steps
 * away five times has one habit, not five findings, and on the real corpus this
 * rule alone produced more candidates than every other rule together — nine in
 * one session, 26 of 66. Weight is a flat sum against `ISY_DEEP_WEIGHT_FLOOR`,
 * so a session bought a deep run on breaks alone. The longest break is the one
 * printed: it is where the picture had the most time to move.
 */
export function detectStaleContext(session: ParsedSession): Candidate[] {
  const breaks: { use: ToolUse; filePath: string; pauseMs: number; pausedAt?: string }[] = [];
  const seen = new Map<string, number>();

  let previous: ToolUse | undefined;
  let pauseIndex: number | undefined;
  let pauseMs = 0;
  let pausedAt: string | undefined;
  let reported = false;

  for (const use of session.toolUses) {
    if (use.timestamp && previous?.timestamp) {
      const gap = Date.parse(use.timestamp) - Date.parse(previous.timestamp);
      if (Number.isFinite(gap) && gap >= PAUSE_MS) {
        pauseIndex = use.recordIndex;
        pauseMs = gap;
        pausedAt = previous.timestamp;
        reported = false;
      }
    }
    previous = use;

    if (!reported && pauseIndex !== undefined && EDIT_TOOLS.has(use.name)) {
      const filePath = typeof use.input.file_path === "string" ? use.input.file_path : undefined;
      const looked = filePath === undefined ? undefined : lastLook(seen, filePath);

      // A file nobody ever looked at is `unverified_assumption`, and saying it
      // twice under two headings is one edit and two notes to reconcile.
      if (filePath && looked !== undefined && looked < pauseIndex) {
        reported = true;
        breaks.push({ use, filePath, pauseMs, pausedAt });
      }
    }

    for (const path of pathsSeen(use)) seen.set(path, use.recordIndex);
  }

  const worst = breaks.reduce<(typeof breaks)[number] | undefined>(
    (a, b) => (a === undefined || b.pauseMs > a.pauseMs ? b : a),
    undefined,
  );
  if (!worst) return [];

  const files = [...new Set(breaks.map(({ filePath }) => basename(filePath)))];
  const listed = files.slice(0, STALE_FILES_LISTED);
  const rest = files.length - listed.length;

  return [
    {
      category: "stale_context",
      sessionId: session.sessionId,
      uuid: worst.use.uuid,
      toolUseId: worst.use.id,
      filePath: worst.filePath,
      recordIndex: worst.use.recordIndex,
      startedAt: worst.pausedAt,
      endedAt: worst.use.timestamp,
      weight: 0.4,
      detail:
        `work resumed after a ${breakLength(worst.pauseMs)} break and edited ` +
        `${listed.join(", ")}${rest > 0 ? ` and ${rest} more` : ""} ` +
        `without reading ${files.length > 1 ? "them" : "it"} again` +
        (breaks.length > 1 ? `, and ${breaks.length} breaks in this session read that way` : ""),
    },
  ];
}

/**
 * Absolute paths, rewritten so they say where a file is without saying whose
 * machine it is on.
 *
 * A transcript records paths as the agent saw them —
 * `/home/alice/work/isy/src/a.ts` — and those strings reach a pull request
 * comment, the report page and a third-party model gateway. The account name in
 * the second segment is the leak; the rest is information a reviewer wants.
 * So a path is rewritten rather than blanked:
 *
 *   inside the working directory  → `src/a.ts`
 *   elsewhere under a home        → `~/.config/gh/hosts.yml`
 *   anywhere else                 → left alone
 *
 * The repository-relative form is not a compromise, it is the form the rest of
 * ISY already wants: `context.ts:wasRead` and `detectors.ts:samePath` both
 * compare by suffix precisely because a transcript
 * is absolute and GitHub is not, and `report.ts:fileAnchor` hashes the path
 * GitHub uses. Masking makes those comparisons exact instead of lucky.
 *
 * Shared with the server through `isy/mask-paths`: the comment and the report
 * page must mask identically, and transcripts uploaded before this existed are
 * still on disk and still get published from.
 */

/** The marker vocabulary the whole redaction speaks. `redact.ts` re-exports it. */
export const REDACTION_MARKER = "ISY_REDACTED";

export function marker(type: string): string {
  return `[${REDACTION_MARKER}:${type}]`;
}

/** A machine on somebody's network, and a checkout keyed by an absolute path. */
const MASK_HOST = marker("host");
const MASK_PROJECT = marker("project");

export interface MaskRoots {
  /** Where the session ran. Paths under it become repository-relative. */
  cwd?: string;
  /** The developer's home. Paths under it become `~/…`. */
  home?: string;
}

/** `MaskRoots` split into segments once, ready for the segment-by-segment match. */
export interface PreparedRoots {
  cwd?: string[];
  home?: string[];
}

const SEPARATOR = /[\\/]/;

function split(value: string): string[] {
  return value.split(SEPARATOR).filter((part) => part.length > 0);
}

/**
 * A root as the matcher wants it, or nothing when it names no segments. `/` is
 * the case that matters: an agent started at the root of the filesystem — a
 * container, some CI images — would otherwise hand `strip` an empty prefix,
 * which matches every path there is and leaves the whole tree unmasked.
 */
function prepare(value: string | readonly string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const parts = typeof value === "string" ? split(value) : [...value];
  return parts.length > 0 ? parts : undefined;
}

/**
 * The home directory a working directory implies: `/home/alice/work/isy` can
 * only sit under `/home/alice`. Worth deriving, because knowing the account
 * name beats recognising the shape of one — with a home root, `/home/alice`
 * masks exactly and `/home/dashboard` (a route in somebody's source) is left
 * alone instead of collapsing to `~`.
 */
function homeOf(cwd: readonly string[]): string[] | undefined {
  const depth = accountAt(cwd);
  return depth < 0 || cwd.length <= depth ? undefined : cwd.slice(0, depth + 1);
}

/**
 * Roots as the matcher wants them. Accepts them already split so a caller
 * masking every string of a transcript does not re-split its own working
 * directory a hundred thousand times.
 */
export function resolveRoots(roots: MaskRoots | PreparedRoots): PreparedRoots {
  const cwd = prepare(roots.cwd);
  const home = prepare(roots.home) ?? (cwd && homeOf(cwd));
  return {
    ...(cwd ? { cwd } : {}),
    ...(home ? { home } : {}),
  };
}

/**
 * One path segment: everything a path can hold that prose around it cannot.
 * Colons, ampersands and parentheses are excluded so a compiler error
 * (`at /home/a/x.ts:12:3`), a shell line (`cd /home/a && make`) and a stack
 * frame (`(/home/a/x.ts)`) each end the path where the path actually ends.
 */
const SEG = /[^\s"'`<>:;,|&$*?()[\]{}\\/]/;

/**
 * A scheme makes it a URL, and `https://example.com/home/alice/x` names a page
 * rather than this machine. Matched first, so no path rule sees a hostname.
 */
const URL_LIKE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`<>]*/;

/**
 * The two schemes that are the exception: they carry a path on this machine
 * rather than an address on the network. Node, vitest and Next print
 * `imported from file:///home/alice/…` on an unresolved import, and that lands
 * in a tool result like any other line of stdout; an editor spells the same
 * path `vscode://file/home/alice/…`. The scheme is kept, the path masked.
 */
const LOCAL_URL = /^((?:file|vscode(?:-insiders)?):\/\/(?:file)?)(\/[^\s"'`<>]*)$/;

/**
 * `\\host\share\…`. The lookbehind keeps a drive letter out: a transcript line
 * that failed to parse is masked as text, and in JSON a Windows path is
 * written `C:\\Users\\alice\\a.ts` — read as a share, that pair of slashes
 * makes `Users` a hostname and leaves `alice` standing. A backslash is in the
 * class for the same reason one step further out: `in\\\\n/home/alice/…` is an
 * escaped escape, and read as a share it made `n` the host and left the whole
 * path behind it standing — a share's tail is not local and is never stripped.
 */
const UNC = new RegExp(
  `(?<![A-Za-z0-9:~\\\\])\\\\\\\\${SEG.source}+(?:[\\\\/]+${SEG.source}+)*[\\\\/]?`,
);

/** Separators repeat for the same reason: JSON doubles every backslash. */
const WINDOWS = new RegExp(
  `(?<![A-Za-z0-9])[A-Za-z]:[\\\\/]+(?:${SEG.source}+[\\\\/]+)*${SEG.source}*`,
);

/**
 * The lookbehind is what keeps `and/or` and `2024/01/02` out: a slash that
 * continues a word does not open a path. Nothing else belongs in the class —
 * a diff line is `+/home/alice/…` and `-/home/alice/…`, and excluding `+` and
 * `-` let the output of `git diff` carry an account name through untouched.
 * `~` stays, and that is all idempotence needs: masking twice is masking once,
 * because `./dist/b.js` and `100%/x` are under no root and come back unchanged.
 *
 * The inner lookbehind is the one exception to the letter rule: a letter that
 * is itself behind a backslash ends an escape sequence rather than a word. Tool
 * output reaches a transcript JSON-encoded twice often enough for that to
 * matter — Prisma reports `invocation in\\n/home/alice/…`, and read as a word
 * `in\\n` carried the account name through untouched.
 */
const POSIX = new RegExp(
  `(?<!~)(?<!(?<!\\\\)[A-Za-z0-9])\\/(?:${SEG.source}+\\/)*${SEG.source}+\\/?`,
);

/**
 * A path that climbs out of the tree before it names one: `../../../../home/…`,
 * an import written with one `..` too many. Without this the match would open
 * at the first slash and leave the climb behind, so the account name would be
 * rewritten but `..` would be left glued to the file it named.
 */
const RELATIVE_CLIMB = new RegExp(
  `(?<![A-Za-z0-9~.])(?:\\.\\.?[\\\\/])+(?:${SEG.source}+[\\\\/])*${SEG.source}+[\\\\/]?`,
);

const CANDIDATE = new RegExp(
  `(${URL_LIKE.source})|${UNC.source}|${WINDOWS.source}|${RELATIVE_CLIMB.source}|${POSIX.source}`,
  "g",
);

/** Trailing sentence punctuation belongs to the sentence, not to the file. */
const TRAILING = /[.,;:!?]+$/;

/**
 * Claude Code names a session directory after the checkout it belongs to, with
 * every non-alphanumeric turned into a dash (`paths.ts:projectSlug`), so
 * `-home-alice-work-isy` is an absolute path with the slashes filed off and no
 * `~` rule will ever see it. Two dashes past the home prefix keep an ordinary
 * `-home-dir` file out.
 *
 * The boundary is a name character rather than a separator because a slug turns
 * up outside a path at all: `ls ~/.claude/projects` prints one per line, and a
 * slug behind a newline is as much the account name as one behind a slash.
 */
const PROJECT_SLUG =
  /(?<![A-Za-z0-9._-])-(?:home|root|users|[a-z]-users)-[A-Za-z0-9._-]*-[A-Za-z0-9._-]+(?![A-Za-z0-9._-])/gi;

/**
 * `-home-alice`: the slug of a session that ran in the home directory itself.
 * `PROJECT_SLUG` cannot reach it — the segment it demands past the account is
 * exactly what keeps `-home-dir` out — so this one is settled against the home
 * we were told instead of against the shape. That is the trade `homeOf` already
 * makes: knowing the account name beats recognising one, and with no home
 * known nothing here fires at all.
 */
const HOME_SLUG =
  /(?<![A-Za-z0-9._-])-(?:home|root|users|[a-z]-users)-[A-Za-z0-9._]+(?![A-Za-z0-9._-])/gi;

function maskSlugs(value: string, home: readonly string[] | undefined): string {
  const masked = value.replace(PROJECT_SLUG, MASK_PROJECT);
  if (!home) return masked;
  const slug = `-${home.join("-")}`.toLowerCase();
  return masked.replace(HOME_SLUG, (match) => (match.toLowerCase() === slug ? MASK_PROJECT : match));
}

/**
 * The path with `root` taken off the front, or nothing when it is not under it.
 * Compared segment by segment so `/home/a/repo` does not swallow
 * `/home/a/repository`, and case-insensitively because macOS and Windows are —
 * only the prefix is compared, so the tail still comes back exactly as written.
 */
function strip(parts: readonly string[], root: readonly string[] | undefined): string[] | undefined {
  if (!root || parts.length < root.length) return undefined;
  for (let i = 0; i < root.length; i += 1) {
    if (parts[i]!.toLowerCase() !== root[i]!.toLowerCase()) return undefined;
  }
  return parts.slice(root.length);
}

/** Entries under `/Users` that macOS creates and nobody is called. */
const NOT_AN_ACCOUNT: ReadonlySet<string> = new Set(["shared", "public", "default"]);

/**
 * Which segment of a path would be the account name, or -1 when the path is
 * not shaped like a home at all. `/home/alice/…` and `/Users/alice/…` name it
 * second; `C:\Users\alice\…` and the Git Bash spelling `/c/Users/alice/…`
 * name it third.
 *
 * The spellings are exact because the near misses are ordinary text:
 * `/users/42/profile` is a URL and `/root/app` is a `WORKDIR`, and neither
 * holds an account name to lose. Windows keeps its case-insensitive match —
 * the filesystem is, and `C:\users\alice` is the same directory.
 */
function accountAt(parts: readonly string[]): number {
  const head = parts[0] ?? "";
  if (head === "home" || head === "Users") return 1;
  if (/^[a-z]:?$/i.test(head) && (parts[1] ?? "").toLowerCase() === "users") return 2;
  return -1;
}

/**
 * A home directory recognised by its shape rather than by a root we were told:
 * the last resort, for a transcript that names no working directory and for the
 * text the model writes, where the server knows nothing about the machine.
 *
 * A segment past the account name is required. `/home/dashboard` is a route in
 * somebody's source far more often than it is a home, and `~` is all that would
 * have survived of it — this rule runs over `old_string` and `new_string` too,
 * where a rewritten path is a rewritten literal.
 *
 * ponytail: a name is a name, so a container's `/home/node/app` masks like a
 * developer's. It has to: the second account on a machine is somebody too, and
 * only a home root says which one the session belongs to. That root is what
 * `resolveRoots` derives from the working directory, and with it the developer's
 * own home is stripped exactly rather than recognised — this rule is left
 * holding the cases where the machine is a stranger.
 */
function genericHome(parts: readonly string[]): string[] | undefined {
  const account = accountAt(parts);
  if (account < 0 || parts.length <= account + 1) return undefined;
  if (NOT_AN_ACCOUNT.has((parts[account] ?? "").toLowerCase())) return undefined;
  return parts.slice(account + 1);
}

/** `\` when the path was written the Windows way, so a `~` path keeps its shape. */
function joiner(value: string): string {
  return value.includes("\\") ? "\\" : "/";
}

/** One whole path, masked. Returns the input when there is nothing personal in it. */
function maskOne(value: string, roots: PreparedRoots): string {
  // `\\host\share\…`: the first segment is a machine on someone's network.
  if (value.startsWith("\\\\")) {
    return maskSlugs(value.replace(/^\\\\[^\\/]*/, `\\\\${MASK_HOST}`), roots.home);
  }

  const parts = split(value);
  if (parts.length === 0) return value;
  const trailing = SEPARATOR.test(value.slice(-1)) ? "/" : "";

  // `../../../../home/alice/x`: an import written with one `..` too many, which
  // an agent produces often enough to matter. The match opens at the first
  // slash, so the segments arrive with the relative prefix still on them and no
  // root can match. Dropping it loses nothing — a `..` above the root names no
  // directory the path was pointing at — and `value` is what comes back when
  // no root matches anyway, so an ordinary relative path is untouched.
  const anchor = parts.findIndex((part) => part !== "." && part !== "..");
  const rooted = anchor < 0 ? [] : parts.slice(anchor);

  // Repository-relative, always with forward slashes: this form is compared
  // against the paths GitHub reports, and those are POSIX whatever the machine.
  const inCwd = strip(rooted, roots.cwd);
  if (inCwd) return inCwd.length === 0 ? "." : maskSlugs(`${inCwd.join("/")}${trailing}`, roots.home);

  const inHome = strip(rooted, roots.home) ?? genericHome(rooted);
  if (inHome) {
    if (inHome.length === 0) return "~";
    const sep = joiner(value);
    return maskSlugs(`~${sep}${inHome.join(sep)}${trailing === "" ? "" : sep}`, roots.home);
  }

  return maskSlugs(value, roots.home);
}

/** Whether the string is a path outright, rather than text that may hold one. */
export function looksAbsolute(value: string): boolean {
  return /^(?:\\\\|[\\/]|[A-Za-z]:[\\/])/.test(value);
}

/**
 * Every absolute path inside a stretch of text — a shell command, a compiler
 * error, a line of stdout. `onMask` is called once per path actually rewritten,
 * so the redaction summary can count them the way it counts secrets.
 */
export function maskPaths(
  text: string,
  roots: MaskRoots | PreparedRoots,
  onMask?: (amount: number) => void,
): string {
  const resolved = resolveRoots(roots);
  let masked = 0;

  const rewrite = (match: string, url: string | undefined): string => {
    if (url !== undefined) {
      const local = LOCAL_URL.exec(url);
      if (!local) return match;
      const inside = maskOne(local[2]!, resolved);
      if (inside !== local[2]) masked += 1;
      return `${local[1]}${inside}`;
    }

    const cut = TRAILING.exec(match);
    const path = cut ? match.slice(0, -cut[0].length) : match;
    const tail = cut ? cut[0] : "";
    if (path.length === 0) return match;

    const rewritten = maskOne(path, resolved);
    if (rewritten !== path) masked += 1;
    return `${rewritten}${tail}`;
  };

  // Every path rule needs a separator, so text without one holds no path — but
  // it can still hold a slug, which is a path with the slashes filed off.
  const paths =
    text.includes("/") || text.includes("\\") ? text.replace(CANDIDATE, rewrite) : text;

  // Slugs last, over the whole text: `ls ~/.claude/projects` prints one per
  // line, and a pass that only rewrites paths never sees one standing alone.
  const result = maskSlugs(paths, resolved.home);
  if (result !== paths) masked += 1;

  if (masked > 0) onMask?.(masked);
  return result;
}

/**
 * A value that is a path and nothing else — `file_path`, `cwd`, `filePath`.
 * Handled apart from `maskPaths` because such a value may hold a space, which
 * inside free text is where a path ends.
 */
export function maskPath(
  value: string,
  roots: MaskRoots | PreparedRoots,
  onMask?: (amount: number) => void,
): string {
  if (!looksAbsolute(value)) return maskPaths(value, roots, onMask);

  const masked = maskOne(value, resolveRoots(roots));
  if (masked !== value) onMask?.(1);
  return masked;
}

/** The keys whose value is a path outright, wherever it sits in a record. */
export const PATH_KEYS: ReadonlySet<string> = new Set([
  "cwd",
  "file",
  "filePath",
  "file_path",
  "notebook_path",
  "path",
]);

/**
 * The working directory a transcript record names, which is the root every
 * other path in that transcript is relative to. One rule, two callers: the
 * client learns it while redacting, the server while reading a transcript back
 * off disk — and they must agree, or a comment and a report page would spell
 * the same file two ways.
 */
export function rootOf(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const cwd = (record as { cwd?: unknown }).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : undefined;
}

/**
 * Every string anywhere in a value, masked. Used where a whole record has to
 * come out clean and naming the fields one by one would mean a leak per field
 * missed — a tool result nests its payload differently for every tool, and the
 * transcript format is undocumented and moves between CLI versions.
 */
export function maskDeep<T>(
  value: T,
  roots: MaskRoots | PreparedRoots,
  onMask?: (amount: number) => void,
): T {
  return walk(value, resolveRoots(roots), onMask) as T;
}

function walk(
  value: unknown,
  roots: PreparedRoots,
  onMask: ((amount: number) => void) | undefined,
  key?: string,
): unknown {
  if (typeof value === "string") {
    return (key && PATH_KEYS.has(key) ? maskPath : maskPaths)(value, roots, onMask);
  }

  // The key travels into the array: `{"paths": ["/home/alice/My Notes/a.md"]}`
  // is a list of paths outright, and read as free text it would end at the space.
  if (Array.isArray(value)) return value.map((item) => walk(item, roots, onMask, key));

  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      // A key is a path as often as a value is: Claude Code keys its per-file
      // state by absolute path, so a walk down the values alone left the
      // account name standing in every key of that map. The original key is
      // what travels down as `key` — `PATH_KEYS` names fields, not paths.
      result[maskPath(entryKey, roots, onMask)] = walk(entryValue, roots, onMask, entryKey);
    }
    return result;
  }

  return value;
}

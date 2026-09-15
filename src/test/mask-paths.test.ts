import assert from "node:assert/strict";
import { test } from "node:test";
import { maskDeep, maskPath, maskPaths, marker } from "../mask-paths.js";

const CWD = "/home/alice/work/isy";
const HOME = "/home/alice";
const roots = { cwd: CWD, home: HOME };

/** No root at all: what the server has for a transcript uploaded long ago. */
const blind = {};

test("a file inside the working directory becomes repository-relative", () => {
  assert.equal(maskPath(`${CWD}/src/a.ts`, roots), "src/a.ts");
});

test("relativising keeps every segment below the root", () => {
  assert.equal(
    maskPath(`${CWD}/backend/server/src/report.ts`, roots),
    "backend/server/src/report.ts",
  );
});

test("the working directory itself becomes a dot", () => {
  assert.equal(maskPath(CWD, roots), ".");
  assert.equal(maskPath(`${CWD}/`, roots), ".");
});

test("a macOS checkout relativises the same way", () => {
  const mac = { cwd: "/Users/alice/Code/isy", home: "/Users/alice" };
  assert.equal(maskPath("/Users/alice/Code/isy/src/a.ts", mac), "src/a.ts");
});

test("a file under the home but outside the checkout keeps its name behind a tilde", () => {
  assert.equal(maskPath("/home/alice/.config/gh/hosts.yml", roots), "~/.config/gh/hosts.yml");
});

test("the home directory is recognised by shape when no root was given", () => {
  assert.equal(maskPath("/Users/bob/Code/other/x.ts", blind), "~/Code/other/x.ts");
  assert.equal(maskPath("/home/carol/notes.md", blind), "~/notes.md");
});

test("a path shaped like a home but holding no account name is left alone", () => {
  // Every one of these reaches the matcher as ordinary text — a route literal
  // in a diff, a request line in a log, a `WORKDIR` in a Dockerfile — and none
  // of them names anybody. Rewriting them would edit the evidence, not clean it.
  for (const path of [
    "/home/dashboard",
    "/users/42/profile",
    "/root/app",
    "/Users/Shared/config",
  ]) {
    assert.equal(maskPath(path, blind), path);
    assert.equal(maskPaths(`GET ${path} 404`, blind), `GET ${path} 404`);
  }
});

test("the home is derived from the working directory, so the account masks exactly", () => {
  // Told only where the session ran, the account name is known rather than
  // guessed: the developer's own home collapses and a route that happens to
  // start `/home/` does not.
  const learned = { cwd: CWD };
  assert.equal(maskPath(HOME, learned), "~");
  assert.equal(maskPath("/home/alice/.ssh/id_rsa", learned), "~/.ssh/id_rsa");
  assert.equal(maskPath("/home/dashboard", learned), "/home/dashboard");
});

test("a root that names no segment is no root at all", () => {
  // An agent started at the root of the filesystem: an empty prefix matches
  // every path there is, and taking it off would leave the tree unmasked.
  const atRoot = { cwd: "/" };
  assert.equal(maskPath("/home/alice/.ssh/id_rsa", atRoot), "~/.ssh/id_rsa");
  assert.equal(maskPath("/etc/hosts", atRoot), "/etc/hosts");
});

test("the root prefix is compared by segment, so a sibling directory is not eaten", () => {
  // `/home/alice/repository` starts with `/home/alice/repo` character by
  // character, and a prefix match would leave the nonsense `sitory/x.ts`.
  const narrow = { cwd: "/home/alice/repo", home: HOME };
  assert.equal(maskPath("/home/alice/repository/x.ts", narrow), "~/repository/x.ts");
  assert.equal(maskPath("/home/alice/repo/x.ts", narrow), "x.ts");
});

test("a Windows checkout relativises with forward slashes", () => {
  const win = { cwd: "C:\\Users\\alice\\proj", home: "C:\\Users\\alice" };
  assert.equal(maskPath("C:\\Users\\alice\\proj\\src\\a.ts", win), "src/a.ts");
});

test("a Windows path with no root keeps the shape it was written in", () => {
  assert.equal(maskPath("C:\\Users\\alice\\proj\\src\\a.ts", blind), "~\\proj\\src\\a.ts");
  assert.equal(maskPath("/c/Users/alice/proj/src/a.ts", blind), "~/proj/src/a.ts");
});

test("a UNC path loses the machine and keeps the share", () => {
  assert.equal(
    maskPath("\\\\build-01\\shared\\proj\\a.ts", blind),
    `\\\\${marker("host")}\\shared\\proj\\a.ts`,
  );
});

test("a project slug is an absolute path with the slashes filed off", () => {
  assert.equal(
    maskPath("/home/alice/.claude/projects/-home-alice-work-isy/6f2.jsonl", roots),
    `~/.claude/projects/${marker("project")}/6f2.jsonl`,
  );
});

test("a session that ran in the home directory is a slug too", () => {
  // `-home-alice` has no segment past the account, so the shape rule cannot
  // have it without swallowing `-home-dir` as well. The home we were told can.
  assert.equal(
    maskPath(`/tmp/claude-1000/-home-alice/6f2/scratchpad`, roots),
    `/tmp/claude-1000/${marker("project")}/6f2/scratchpad`,
  );
  // Told nothing, the shape rule is all there is, and it still lets it past.
  assert.equal(maskPath("/tmp/claude-1000/-home-alice/6f2", blind), "/tmp/claude-1000/-home-alice/6f2");
  // And a file that only looks like one is left alone either way.
  assert.equal(maskPath("/etc/default/-home-dir", roots), "/etc/default/-home-dir");
});

test("a slug standing outside a path is still the account name", () => {
  // `ls ~/.claude/projects` prints one per line and holds no path at all.
  const listing = "-home-alice-work-isy\n-home-alice-work-api\n-home-alice";
  assert.equal(
    maskPaths(listing, roots),
    `${marker("project")}\n${marker("project")}\n${marker("project")}`,
  );
  // A flag is not a slug: the dash before it is part of the flag.
  assert.equal(maskPaths("--home-alice-work-isy", roots), "--home-alice-work-isy");
});

test("a hyphenated name that is not a slug is left alone", () => {
  assert.equal(maskPath("/etc/default/-home-dir", blind), "/etc/default/-home-dir");
});

test("a path inside a shell command is masked where it stands", () => {
  assert.equal(maskPaths(`cd ${CWD} && npm test`, roots), "cd . && npm test");
  assert.equal(
    maskPaths(`rm -rf ${CWD}/dist && npm run build`, roots),
    "rm -rf dist && npm run build",
  );
});

test("a compiler error keeps its line and column", () => {
  assert.equal(
    maskPaths(`error TS2304 at ${CWD}/src/a.ts:12:3`, roots),
    "error TS2304 at src/a.ts:12:3",
  );
});

test("a stack frame in parentheses ends where the frame ends", () => {
  assert.equal(
    maskPaths(`    at run (${CWD}/src/a.ts:12:3)`, roots),
    "    at run (src/a.ts:12:3)",
  );
});

test("a sentence keeps its full stop", () => {
  assert.equal(maskPaths(`wrote ${CWD}/src/a.ts.`, roots), "wrote src/a.ts.");
});

test("a system path carries no name and is left alone", () => {
  for (const path of ["/etc/hosts", "/usr/lib/x.so", "/tmp/build.log", "/var/log/syslog"]) {
    assert.equal(maskPath(path, roots), path);
    assert.equal(maskPaths(`opened ${path} ok`, roots), `opened ${path} ok`);
  }
});

test("a relative path is already what masking aims at", () => {
  assert.equal(maskPath("src/a.ts", roots), "src/a.ts");
  assert.equal(maskPaths("see src/a.ts and ./dist/b.js", roots), "see src/a.ts and ./dist/b.js");
});

test("a home-looking segment inside a URL names a page, not this machine", () => {
  const url = "https://example.com/home/alice/x";
  assert.equal(maskPaths(`fetched ${url} ok`, roots), `fetched ${url} ok`);
  assert.equal(maskPaths("git+ssh://git@github.com/home/alice/r.git", roots),
    "git+ssh://git@github.com/home/alice/r.git");
});

test("a path is masked wherever a line of output puts it", () => {
  // `git diff` output in a tool result: the path opens the line behind a marker.
  assert.equal(maskPaths(`+${CWD}/dist`, roots), "+dist");
  assert.equal(maskPaths("-/home/alice/secret/notes.md", roots), "-~/secret/notes.md");
});

test("a local URL names this machine and is masked like the path it is", () => {
  assert.equal(
    maskPaths(`Cannot find module 'x' imported from file://${CWD}/src/a.ts`, roots),
    "Cannot find module 'x' imported from file://src/a.ts",
  );
  assert.equal(maskPaths("vscode://file/home/alice/notes.md", roots), "vscode://file~/notes.md");
});

test("a slash that continues a word does not open a path", () => {
  for (const text of ["and/or", "2024/01/02", "read src/**/*.ts", "a 50/50 chance"]) {
    assert.equal(maskPaths(text, roots), text);
  }
});

test("masking twice is masking once", () => {
  const texts = [
    `${CWD}/src/a.ts`,
    `+${CWD}/dist`,
    "./dist/b.js",
    "100%/x",
    `file://${CWD}/src/a.ts`,
    "/home/alice/.config/gh/hosts.yml",
    "\\\\build-01\\shared\\a.ts",
    `cd ${CWD} && npm test`,
    "/home/alice/.claude/projects/-home-alice-work-isy/6f2.jsonl",
    "C:\\Users\\alice\\proj\\src\\a.ts",
  ];

  for (const text of texts) {
    const once = maskPaths(text, roots);
    assert.equal(maskPaths(once, roots), once, text);
    // And with the roots the server has rather than the ones the client had.
    assert.equal(maskPaths(once, blind), once, text);
  }
});

test("a key is a path as often as a value is", () => {
  // Claude Code keys its per-file state by absolute path, so a walk down the
  // values alone left the account name standing in every key of that map.
  const masked = maskDeep(
    {
      [`${CWD}/src/a.ts`]: { readAt: 1 },
      [`${HOME}/.claude/projects/-home-alice-work-isy/6f2.jsonl`]: { readAt: 2 },
      file_path: `${CWD}/src/b.ts`,
    },
    roots,
  );

  assert.deepEqual(Object.keys(masked), [
    "src/a.ts",
    `~/.claude/projects/${marker("project")}/6f2.jsonl`,
    "file_path",
  ]);
  // The original key still decides whether the value is a path outright.
  assert.equal(masked.file_path, "src/b.ts");
});

test("a letter behind a backslash ends an escape, not a word", () => {
  // Tool output reaches a transcript JSON-encoded twice: the newline in a
  // Prisma error arrives as the two characters `\` and `n`, and read as a word
  // `in\n` kept the path behind it out of the matcher.
  assert.equal(
    maskPaths(`invocation in\\n${CWD}/src/a.ts:73:38`, roots),
    "invocation in\\nsrc/a.ts:73:38",
  );
  // A doubly-encoded result doubles the backslashes with it, and a run of them
  // is an escaped escape rather than the `\\host\\share` a network path opens with.
  for (const run of ["\\", "\\\\", "\\\\\\", "\\\\\\\\"]) {
    assert.equal(maskPaths(`in${run}n${CWD}/src/a.ts`, roots), `in${run}nsrc/a.ts`, run);
  }
  // A share still opens one, and its tail is not this machine's to relativise.
  assert.equal(maskPaths("\\\\build-01\\shared\\a.ts", roots), `\\\\${marker("host")}\\shared\\a.ts`);
  // The rule it is an exception to still holds.
  for (const text of ["and/or", "2024/01/02", "a 50/50 chance"]) {
    assert.equal(maskPaths(text, roots), text);
  }
});

test("a path that climbs out of the tree before naming one is still a path", () => {
  // An import written with one `..` too many, which an agent produces often.
  assert.equal(
    maskPaths(`from "../../../..${CWD}/src/a.ts"`, roots),
    'from "src/a.ts"',
  );
  assert.equal(maskPaths(`import "../..${HOME}/notes.md"`, roots), 'import "~/notes.md"');
  // A relative path that climbs and lands nowhere personal is left alone.
  assert.equal(maskPaths("see ../src/a.ts and ./dist/b.js", roots), "see ../src/a.ts and ./dist/b.js");
});

test("the callback counts paths actually rewritten, not paths seen", () => {
  let masked = 0;
  maskPaths(`${CWD}/a.ts and /etc/hosts and /home/bob/b.ts`, roots, (n) => (masked += n));
  assert.equal(masked, 2);

  let untouched = 0;
  maskPaths("/etc/hosts alone", roots, (n) => (untouched += n));
  assert.equal(untouched, 0);
});

test("a value that is a path outright survives a space in it", () => {
  assert.equal(maskPath(`${CWD}/My Notes/a.md`, roots), "My Notes/a.md");
});

test("nothing a transcript can hold makes the matcher find a home path", () => {
  const corpus = [
    `cd ${CWD} && npm run build 2>&1 | tail -5`,
    `Error: ENOENT: no such file or directory, open '${HOME}/.npmrc'`,
    `{"file_path":"${CWD}/src/a.ts","offset":0}`,
    "/Users/dave/Library/Caches/pnpm/store",
    "C:\\Users\\erin\\AppData\\Local\\Temp\\x.log",
    // A session killed mid-write leaves its last line truncated, so it is
    // masked as text: in JSON every backslash is doubled, and a matcher that
    // reads `\\Users` as a network share leaves the name after it standing.
    `{"file_path":"C:\\\\Users\\\\alice\\\\a.ts"`,
  ];

  for (const text of corpus) {
    const masked = maskPaths(text, roots);
    assert.doesNotMatch(masked, /\/home\/|\/Users\/|C:\\Users\\/, text);
  }
});

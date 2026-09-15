import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addedDependencies,
  detectExternalDependency,
  detectUnverifiedAssumption,
  installedPackages,
  isManifest,
  packageName,
} from "../detectors.js";
import { parseLines } from "../parser.js";
import { MIN_ASSISTANT_RECORDS, runStage0 } from "../stage0.js";
import {
  analyzeFiles,
  buildReport,
  compareExpected,
  expandInputs,
  formatReport,
  runAnalyze,
  snapshotOf,
} from "../commands/analyze.js";
import type { ParsedSession } from "../types.js";

let clock = 0;

function nextTimestamp(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 7, 17, 9, clock)).toISOString();
}

function assistant(uuid: string, parentUuid: string | null, content: unknown[]): unknown {
  return {
    type: "assistant",
    uuid,
    parentUuid,
    sessionId: "s1",
    timestamp: nextTimestamp(),
    message: { role: "assistant", content },
  };
}

function padded(records: unknown[]): ParsedSession {
  clock = 0;
  const filler: unknown[] = [];
  for (let i = 0; i < MIN_ASSISTANT_RECORDS; i += 1) {
    filler.push(assistant(`pad${i}`, i === 0 ? null : `pad${i - 1}`, [{ type: "text", text: "x" }]));
  }
  return parseLines([...filler, ...records].map((record) => JSON.stringify(record)));
}

test("recognises dependency manifests by filename", () => {
  for (const path of ["/r/package.json", "/r/Cargo.toml", "/r/go.mod", "/r/pom.xml", "/r/Gemfile"]) {
    assert.equal(isManifest(path), true, path);
  }
  assert.equal(isManifest("/r/src/app.ts"), false);
  assert.equal(isManifest("/r/package-lock.json"), false);
});

test("extracts only newly added dependencies from package.json", () => {
  const before = '"dependencies": { "react": "^18.0.0" }';
  const after = '"dependencies": { "react": "^18.0.0", "decimal.js": "^10.4.3" }';
  assert.deepEqual(addedDependencies("/r/package.json", before, after), ["decimal.js"]);
});

test("treats a version bump as no new dependency", () => {
  const before = '"dependencies": { "react": "^18.0.0" }';
  const after = '"dependencies": { "react": "^18.2.0" }';
  assert.deepEqual(addedDependencies("/r/package.json", before, after), []);
});

test("does not mistake package.json metadata for a dependency", () => {
  const after = '{ "name": "isy", "version": "0.1.0", "private": true }';
  assert.deepEqual(addedDependencies("/r/package.json", "", after), []);
});

test("extracts dependencies from non-npm manifests", () => {
  assert.deepEqual(addedDependencies("/r/requirements.txt", "", "requests==2.31.0\n"), ["requests"]);
  assert.deepEqual(addedDependencies("/r/Cargo.toml", "", 'serde = "1.0"\n'), ["serde"]);
  assert.deepEqual(addedDependencies("/r/Gemfile", "", "gem 'rails'\n"), ["rails"]);
  assert.deepEqual(addedDependencies("/r/pom.xml", "", "<artifactId>guava</artifactId>"), ["guava"]);
});

test("reads a new pyproject.toml by table, not by line shape", () => {
  const pyproject = [
    "[build-system]",
    'requires = ["hatchling"]',
    'build-backend = "hatchling.build"',
    "",
    "[project]",
    'name = "dwmt"',
    'version = "0.1.0"',
    'description = "Reset a workspace"',
    'requires-python = ">=3.11"',
    "dependencies = [",
    '  "requests[socks]>=2.31",',
    "  'click',",
    `  "tomli; python_version < '3.11'",`,
    "]",
    "",
    "[project.optional-dependencies]",
    'dev = ["pytest>=8"]',
    "",
    "[project.scripts]",
    'dwmt = "dwmt.cli:main"',
  ].join("\n");
  assert.deepEqual(addedDependencies("/r/pyproject.toml", "", pyproject), ["click", "pytest", "requests", "tomli"]);
});

test("reads Poetry and Cargo dependency tables, and nothing beside them", () => {
  const poetry = [
    "[tool.poetry]",
    'name = "app"',
    "",
    "[tool.poetry.dependencies]",
    'python = "^3.11"',
    'httpx = "^0.27"',
    "",
    "[tool.poetry.group.dev.dependencies]",
    'pytest = "*"',
  ].join("\n");
  assert.deepEqual(addedDependencies("/r/pyproject.toml", "", poetry), ["httpx", "pytest"]);

  const cargo = [
    "[package]",
    'name = "isy"',
    'version = "0.1.0"',
    'edition = "2021"',
    "",
    "[dependencies]",
    'serde = { version = "1", features = ["derive"] }',
    "",
    "[target.'cfg(unix)'.dev-dependencies]",
    'nix = "0.29"',
    "",
    "[dependencies.tokio]",
    'version = "1"',
    'features = ["full"]',
  ].join("\n");
  assert.deepEqual(addedDependencies("/r/Cargo.toml", "", cargo), ["nix", "serde", "tokio"]);
});

test("a TOML edit with no header in view counts only version-shaped keys", () => {
  // Growing an existing array: the key line is context on both sides.
  const before = 'dependencies = [\n  "click>=8",\n]';
  const after = 'dependencies = [\n  "click>=8",\n  "httpx>=0.27",\n]';
  assert.deepEqual(addedDependencies("/r/pyproject.toml", before, after), ["httpx"]);
  // Metadata and an entry point have the same `key = "…"` shape.
  const metadata = 'name = "dwmt"\nversion = "0.2.0"\nrequires-python = ">=3.11"\ndwmt = "dwmt.cli:main"\n';
  assert.deepEqual(addedDependencies("/r/pyproject.toml", "", metadata), []);
});

test("reads package names out of install commands", () => {
  assert.deepEqual(installedPackages("npm install decimal.js"), { manager: "npm", packages: ["decimal.js"] });
  assert.deepEqual(installedPackages("pnpm add -D vitest"), { manager: "pnpm", packages: ["vitest"] });
  assert.deepEqual(installedPackages("cargo add serde --features derive"), {
    manager: "cargo",
    packages: ["serde"],
  });
  assert.deepEqual(installedPackages("go get github.com/pkg/errors"), {
    manager: "go",
    packages: ["github.com/pkg/errors"],
  });
});

test("ignores installs that add nothing new", () => {
  assert.equal(installedPackages("npm install"), undefined);
  assert.equal(installedPackages("npm ci"), undefined);
  assert.equal(installedPackages("pip install -r requirements.txt"), undefined);
  assert.equal(installedPackages("npm run build"), undefined);
});

test("stops reading package names at a shell operator", () => {
  assert.deepEqual(installedPackages("npm install left-pad && npm run build"), {
    manager: "npm",
    packages: ["left-pad"],
  });
});

test("ignores shell redirections rather than reading them as packages", () => {
  assert.deepEqual(installedPackages("npm install playwright-core >/dev/null 2>&1"), {
    manager: "npm",
    packages: ["playwright-core"],
  });
  assert.deepEqual(installedPackages("npm install pm2 2>&1; echo done"), {
    manager: "npm",
    packages: ["pm2"],
  });
});

test("stops at prose that follows an install command on the same line", () => {
  assert.deepEqual(installedPackages("npm install @tanstack/react-query, chosen over SWR"), {
    manager: "npm",
    packages: ["@tanstack/react-query"],
  });
});

test("finds the install inside a multi-line script", () => {
  const script = "cd app\nnpm install decimal.js\nnpm run build";
  assert.deepEqual(installedPackages(script), { manager: "npm", packages: ["decimal.js"] });
});

test("keeps a pip version specifier intact", () => {
  assert.deepEqual(installedPackages("pip install 'openai>=1.0'"), {
    manager: "pip",
    packages: ["openai>=1.0"],
  });
});

test("reports one dependency once, even when both the manifest and the command show it", () => {
  const session = padded([
    assistant("e", "pad19", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/r/package.json",
          old_string: '"dependencies": {}',
          new_string: '"dependencies": { "decimal.js": "^10.4.3" }',
        },
      },
    ]),
    assistant("b", "e", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm install decimal.js" } }]),
  ]);

  const candidates = detectExternalDependency(session);
  assert.equal(candidates.length, 1);
  assert.ok(candidates[0]?.detail.includes("added to package.json: decimal.js"));
});

test("flags a dependency installed by command but never written to a manifest", () => {
  const session = padded([
    assistant("e", "pad19", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/r/package.json",
          old_string: '"dependencies": {}',
          new_string: '"dependencies": { "decimal.js": "^10.4.3" }',
        },
      },
    ]),
    assistant("b", "e", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm install -D vitest" } }]),
  ]);

  const details = detectExternalDependency(session).map((candidate) => candidate.detail);
  assert.equal(details.length, 2);
  assert.ok(details.some((detail) => detail.includes("installed with npm: vitest")));
});

test("keeps scoped package names whole", () => {
  assert.equal(packageName("@tanstack/react-query"), "@tanstack/react-query");
  assert.equal(packageName("@sentry/node"), "@sentry/node");
  assert.equal(packageName("openai>=1.0"), "openai");
  assert.equal(packageName("github.com/pkg/errors"), "github.com/pkg/errors");
});

test("does not collapse two different scoped packages into one candidate", () => {
  const session = padded([
    assistant("e", "pad19", [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/r/package.json",
          old_string: '"dependencies": {}',
          new_string: '"dependencies": { "@tanstack/react-query": "^5.0.0" }',
        },
      },
    ]),
    assistant("b", "e", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm install @sentry/node" } }]),
  ]);

  const details = detectExternalDependency(session).map((candidate) => candidate.detail);
  assert.equal(details.length, 2);
  assert.ok(details.some((detail) => detail.includes("installed with npm: @sentry/node")));
});

test("does not read a package manager's own name as a package", () => {
  assert.equal(installedPackages("pip install --upgrade pip"), undefined);
  assert.deepEqual(installedPackages("python3 -m pip install httpx"), { manager: "pip", packages: ["httpx"] });
});

test("flags a file edited without ever being read", () => {
  const session = padded([
    assistant("e", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/src/blind.ts", old_string: "a", new_string: "b" } },
    ]),
  ]);

  const candidates = detectUnverifiedAssumption(session);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.filePath, "/r/src/blind.ts");
});

test("does not flag a file that was read, searched, or newly written", () => {
  const session = padded([
    assistant("r", "pad19", [
      { type: "tool_use", id: "t0", name: "Read", input: { file_path: "/r/src/seen.ts" } },
      { type: "tool_use", id: "t1", name: "Grep", input: { pattern: "x", path: "/r/lib" } },
    ]),
    assistant("e", "r", [
      { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/r/src/seen.ts", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/r/lib/inside.ts", old_string: "a", new_string: "b" } },
      { type: "tool_use", id: "t4", name: "Write", input: { file_path: "/r/src/fresh.ts", content: "new file" } },
    ]),
  ]);

  assert.deepEqual(detectUnverifiedAssumption(session), []);
});

test("stage 0 reports whether known_gap is even reachable", () => {
  const withoutThinking = padded([
    assistant("e", "pad19", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "a", new_string: "b" } },
    ]),
  ]);
  assert.equal(runStage0(withoutThinking).knownGapReachable, false);

  const withThinking = padded([
    assistant("t", "pad19", [{ type: "thinking", thinking: "I have not covered the retry path" }]),
    assistant("e", "t", [
      { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/r/a.ts", old_string: "a", new_string: "b" } },
    ]),
  ]);
  assert.equal(runStage0(withThinking).knownGapReachable, true);
});

async function fixture(): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "isy-analyze-"));
  const records: unknown[] = [];
  for (let i = 0; i < MIN_ASSISTANT_RECORDS; i += 1) {
    records.push(assistant(`pad${i}`, i === 0 ? null : `pad${i - 1}`, [{ type: "text", text: "x" }]));
  }
  records.push(
    assistant("dep", `pad${MIN_ASSISTANT_RECORDS - 1}`, [
      {
        type: "tool_use",
        id: "t1",
        name: "Edit",
        input: {
          file_path: "/r/package.json",
          old_string: '"dependencies": {}',
          new_string: '"dependencies": { "decimal.js": "^10.4.3" }',
        },
      },
      { type: "text", text: "token = sk-abcdefghij0123456789XYZ" },
    ]),
  );

  clock = 0;
  const file = join(dir, "session-one.jsonl");
  await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"));
  return { dir, file };
}

test("expands a directory into the transcripts inside it", async () => {
  const { dir, file } = await fixture();
  await writeFile(join(dir, "notes.txt"), "ignored");
  assert.deepEqual(await expandInputs([dir]), [file]);
});

test("rejects an input that does not exist", async () => {
  await assert.rejects(expandInputs(["/definitely/not/here.jsonl"]), /cannot read/);
});

test("analyzes a transcript file into a deterministic report", async () => {
  const { file } = await fixture();
  const sessions = await analyzeFiles([file], undefined);
  const report = buildReport("0.1.0", "0", sessions);

  assert.equal(report.totals.files, 1);
  assert.equal(report.totals.eligible, 1);
  assert.equal(report.totals.byCategory.external_dependency, 1);
  assert.ok(
    report.sessions[0]?.candidates.some(
      (candidate) =>
        candidate.category === "external_dependency" && candidate.detail.includes("decimal.js"),
    ),
  );

  const again = buildReport("0.1.0", "0", await analyzeFiles([file], undefined));
  assert.equal(JSON.stringify(report), JSON.stringify(again), "report must be reproducible");
});

test("analyze redacts before detecting, matching what the server receives", async () => {
  const { file } = await fixture();
  const sessions = await analyzeFiles([file], undefined);
  const rendered = JSON.stringify(sessions);

  assert.ok(!rendered.includes("sk-abcdefghij0123456789XYZ"));
});

test("formats a human report and closes it with a local-run summary", async () => {
  const { file } = await fixture();
  const report = buildReport("0.1.0", "0", await analyzeFiles([file], undefined));
  const text = formatReport(report, 1400);

  assert.match(text, /external_dependency/);
  assert.match(text, /decimal\.js/);
  assert.match(text, /1 file\(s\) scanned in 1\.4s · 0 bytes sent/);
  assert.match(formatReport(report), /file\(s\) scanned · 0 bytes sent/);
});

test("refuses stages that need the model provider", async () => {
  const { file } = await fixture();
  await assert.rejects(runAnalyze({ files: [file], stage: "all", json: true }), /not available offline/);
  await assert.rejects(runAnalyze({ files: [file], stage: "2", json: true }), /not available offline/);
});

test("refuses to run with no input", async () => {
  await assert.rejects(runAnalyze({ files: [], json: true }), /no transcripts given/);
});

test("reports a directory that holds no transcripts", async () => {
  const empty = await mkdtemp(join(tmpdir(), "isy-analyze-empty-"));
  await mkdir(join(empty, "sub"), { recursive: true });
  await assert.rejects(runAnalyze({ files: [empty], json: true }), /no \.jsonl transcripts found/);
});

test("writes, matches, and then reports a drifted snapshot", async () => {
  const { file } = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "isy-expected-"));
  const sessions = await analyzeFiles([file], undefined);

  assert.deepEqual(await compareExpected(dir, sessions, true), [
    { name: "session-one", status: "written" },
  ]);
  assert.deepEqual(await compareExpected(dir, sessions, false), [
    { name: "session-one", status: "ok" },
  ]);

  const drifted = [{ ...sessions[0]!, candidates: [] }];
  assert.deepEqual(await compareExpected(dir, drifted, false), [
    { name: "session-one", status: "changed" },
  ]);
});

test("reports a snapshot that was never recorded", async () => {
  const { file } = await fixture();
  const empty = await mkdtemp(join(tmpdir(), "isy-expected-empty-"));
  const sessions = await analyzeFiles([file], undefined);

  assert.deepEqual(await compareExpected(empty, sessions, false), [
    { name: "session-one", status: "missing" },
  ]);
});

test("keeps a snapshot free of machine-specific detail", async () => {
  const { file } = await fixture();
  const sessions = await analyzeFiles([file], undefined);
  const snapshot = snapshotOf(sessions[0]!);

  assert.equal(snapshot.session, "session-one");
  assert.ok(!JSON.stringify(snapshot).includes(tmpdir()));
});

test("fails the run when a snapshot does not match", async () => {
  const { file } = await fixture();
  const empty = await mkdtemp(join(tmpdir(), "isy-expected-fail-"));
  await assert.rejects(
    runAnalyze({ files: [file], json: true, expect: empty }),
    /do not match/,
  );
});

test("an install quoted inside a heredoc is text, not an install", () => {
  const script = [
    "python3 - <<'PY'",
    "doc = 'npm install decimal.js'",
    "PY",
  ].join("\n");
  assert.equal(installedPackages(script), undefined);
});

test("what stands where a package name should be has to look like one", () => {
  // A line continuation and a shell expansion: neither is a name anyone can
  // look up, and both were reported as packages on the real corpus.
  assert.equal(installedPackages("npm install \\"), undefined);
  assert.equal(installedPackages("npm install ${pkg}"), undefined);
  assert.deepEqual(installedPackages("npm install left-pad, }"), {
    manager: "npm",
    packages: ["left-pad"],
  });
});

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { drainAlerts, parkAlert } from "../alert.js";
import { runInit } from "../commands/init.js";
import { collectStatus, formatStatus } from "../commands/status.js";
import { COMMIT_COMMAND, PUSH_COMMAND } from "../githook.js";
import { HOOK_COMMAND } from "../hook.js";

const saved = {
  home: process.env.ISY_HOME,
  claude: process.env.CLAUDE_CONFIG_DIR,
  kimi: process.env.KIMI_HOME,
  codex: process.env.CODEX_HOME,
};

let home: string;
let claude: string;
let cwd: string;
let server: Server;
let baseUrl: string;
/** Every request the server saw, as `METHOD path`. */
const asked: string[] = [];

before(async () => {
  home = await mkdtemp(join(tmpdir(), "isy-init-home-"));
  claude = await mkdtemp(join(tmpdir(), "isy-init-claude-"));
  cwd = await mkdtemp(join(tmpdir(), "isy-init-cwd-"));
  process.env.ISY_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claude;
  process.env.KIMI_HOME = join(home, "no-kimi-here");
  process.env.CODEX_HOME = join(home, "no-codex-here");

  server = createServer((request, response) => {
    asked.push(`${request.method} ${request.url}`);
    if (request.url === "/api/v1/me" && request.headers.authorization === "Bearer isy_held") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "u1", githubLogin: "unwinned" }));
      return;
    }
    response.writeHead(request.url === "/api/v1/me" ? 401 : 404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const [name, value] of [
    ["ISY_HOME", saved.home],
    ["CLAUDE_CONFIG_DIR", saved.claude],
    ["KIMI_HOME", saved.kimi],
    ["CODEX_HOME", saved.codex],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function quietly<T>(run: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => undefined;
  try {
    return await run();
  } finally {
    console.log = log;
  }
}

/** What `run` printed, one line per `console.log`. */
async function printed(run: () => Promise<unknown>): Promise<string> {
  const lines: unknown[] = [];
  const log = console.log;
  console.log = (line: unknown) => void lines.push(line);
  try {
    await run();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

test("isy init keeps a key the server still takes rather than pairing for another", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ token: "isy_held", apiBaseUrl: baseUrl }));
  asked.length = 0;

  await quietly(() => runInit({}, cwd));

  // Pairing again would issue a second key, and a plan with one refuses it.
  assert.deepEqual(asked, ["GET /api/v1/me"]);
  const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Record<string, unknown>;
  assert.equal(config.token, "isy_held");
  assert.equal(config.githubLogin, "unwinned");

  const settings = JSON.parse(await readFile(join(claude, "settings.json"), "utf8")) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  assert.equal(settings.hooks.SessionEnd?.[0]?.hooks[0]?.command, HOOK_COMMAND);
});

test("isy init signs in again when the key it holds is no longer taken", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ token: "isy_revoked", apiBaseUrl: baseUrl }));
  asked.length = 0;

  // No browser to open and no terminal to paste in: the sign-in has nothing to
  // come back with, which is enough to see that it was asked for.
  const path = process.env.PATH;
  process.env.PATH = cwd;
  try {
    await assert.rejects(quietly(() => runInit({}, cwd)), /no token provided/);
  } finally {
    process.env.PATH = path;
  }
  assert.deepEqual(asked, ["GET /api/v1/me", "POST /api/v1/cli/pairings"]);
});

test("isy init answers the alerts that sent the reader to it and keeps the rest", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ token: "isy_held", apiBaseUrl: baseUrl }));
  await parkAlert("ISY: authentication rejected (401), run: isy init");
  await parkAlert("ISY: authentication rejected (401), run: isy init · 1 session(s) given up on");
  await parkAlert("ISY: this month's analyses are used up");

  await quietly(() => runInit({}, cwd));

  assert.equal(await drainAlerts(), "ISY: 1 session(s) given up on\nISY: this month's analyses are used up");
});

test("isy init says what to add to a hook it cannot go into, and status says it was left", async () => {
  const repo = await mkdtemp(join(tmpdir(), "isy-init-foreign-"));
  await new Promise((resolve, reject) =>
    execFile("git", ["init", "-q"], { cwd: repo }, (error) => (error ? reject(error) : resolve(undefined))),
  );
  const prePush = join(repo, ".git", "hooks", "pre-push");
  const body = "#!/usr/bin/env python3\nimport sys\n";
  await writeFile(prePush, body);
  await chmod(prePush, 0o755);

  const output = await printed(() => runInit({ token: "isy_held" }, repo));

  assert.equal(await readFile(prePush, "utf8"), body);
  assert.match(output, /Added the post-commit hooks? in /);
  assert.doesNotMatch(output, /post-commit and pre-push/);
  assert.match(output, /pre-push .*not a shell script \(python3\)/);
  assert.ok(output.includes(PUSH_COMMAND), "the line to add, as it stands in a shell hook");
  assert.ok(!output.includes(COMMIT_COMMAND), "the commit hook took its block, nothing to add");

  const status = formatStatus(await collectStatus(repo));
  assert.match(status, /git hooks\s+installed, except pre-push/);
});

test("isy init ends on what is left before a first analysis", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ token: "isy_held", apiBaseUrl: baseUrl }));

  const output = await printed(() => runInit({}, cwd));
  const closing = output.slice(output.indexOf("Signed in as unwinned"));

  assert.ok(closing.includes("GitHub App"), closing);
  assert.ok(closing.includes(`${baseUrl}/docs/github-app`), closing);
  assert.ok(closing.includes("pull request"), closing);
});

test("isy init sends nobody on to a pull request when no CLI got hooks", async () => {
  await writeFile(join(home, "config.json"), JSON.stringify({ token: "isy_held", apiBaseUrl: baseUrl }));
  process.env.CLAUDE_CONFIG_DIR = join(home, "no-claude-here");
  try {
    const output = await printed(() => runInit({}, cwd));

    assert.ok(output.includes("No supported CLI found"), output);
    assert.ok(!output.includes("pull request"), output);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = claude;
  }
});

test("the README's install steps go on to the GitHub App and a pull request", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const install = readme.slice(readme.indexOf("## Install"), readme.indexOf("## Commands"));

  assert.ok(install.includes("(https://github.com/apps/iseeyaai)"), install);
  assert.ok(install.includes("pull request"), install);
});

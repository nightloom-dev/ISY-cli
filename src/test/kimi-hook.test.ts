import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { kimiAgent } from "../agents/kimi.js";
import { parseLines } from "../parser.js";

/**
 * Kimi's SessionEnd hook, run the way each Kimi CLI runs it: the command isy
 * writes into `config.toml`, handed to `sh -c` with the hook's payload on stdin.
 * `npx @nightloom/isy` resolves to this checkout.
 *
 * Kimi CLI cancels SessionEnd hooks five seconds in, so its shell must return
 * at once and the upload it left behind must still reach the server. Kimi Code
 * waits for the hook, so there the upload runs in the shell itself.
 */

const run = promisify(execFile);
const FIXTURE = join(import.meta.dirname, "fixtures", "kimi-cli-1.52", ".kimi");
const SESSION = "63ade4e9-4c75-4070-a8c6-f28b7de486b8";
const KIMI_CODE_FIXTURE = join(import.meta.dirname, "fixtures", "kimi-code-2.1.1", ".kimi-code");
const KIMI_CODE_SESSION = "session_48c39281-a12f-4c4b-83b9-2015eb5e7c3a";

let root: string;
let server: Server;
let baseUrl: string;
const uploads: Record<string, unknown>[] = [];
const saved = process.env.KIMI_HOME;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "isy-kimi-hook-"));

  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks);
      const body = request.headers["content-encoding"] === "gzip" ? gunzipSync(raw) : raw;
      if (request.url === "/api/v1/sessions") uploads.push(JSON.parse(body.toString("utf8")) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ deduplicated: false }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = typeof address === "object" && address ? `http://127.0.0.1:${address.port}` : "";
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (saved === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = saved;
});

/** A repository for the payload to name, `npx @nightloom/isy` as this checkout, and isy's config. */
async function machine(name: string): Promise<{ repo: string; env: NodeJS.ProcessEnv }> {
  const base = join(root, name);
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["config", "user.email", "t@e.com"],
    ["config", "user.name", "T"],
    ["commit", "-q", "--allow-empty", "-m", "first"],
    ["remote", "add", "origin", "git@github.com:acme/kshop.git"],
  ]) {
    await run("git", args, { cwd: repo });
  }

  const isy = join(base, "isy");
  await mkdir(isy);
  await writeFile(join(isy, "config.json"), JSON.stringify({ token: "test-token", apiBaseUrl: baseUrl }));

  const bin = join(base, "bin");
  await mkdir(bin);
  const tsx = import.meta.resolve("tsx");
  const entry = join(import.meta.dirname, "..", "index.ts");
  await writeFile(
    join(bin, "npx"),
    `#!/bin/sh\n[ "$1" = "@nightloom/isy" ] && shift\nexec "${process.execPath}" --import "${tsx}" "${entry}" "$@"\n`,
  );
  await chmod(join(bin, "npx"), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    ISY_HOME: isy,
    CLAUDE_CONFIG_DIR: join(base, "no-claude"),
    CODEX_HOME: join(base, "no-codex"),
  };
  return { repo, env };
}

/** The hook's command through `sh -c`, as the CLI runs it; resolves when the shell exits. */
async function runHook(command: string, repo: string, env: NodeJS.ProcessEnv, payload: object): Promise<number> {
  const started = Date.now();
  await new Promise<void>((resolve, reject) => {
    const shell = spawn("sh", ["-c", command], { cwd: repo, env, stdio: ["pipe", "ignore", "ignore"] });
    shell.on("error", reject);
    shell.on("exit", () => resolve());
    shell.stdin.end(JSON.stringify(payload));
  });
  return Date.now() - started;
}

async function nextUpload(count: number): Promise<Record<string, unknown>> {
  for (let waited = 0; uploads.length < count && waited < 30_000; waited += 200) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(uploads.length, count, "the upload reached the server");
  return uploads[count - 1]!;
}

function transcriptOf(upload: Record<string, unknown>): ReturnType<typeof parseLines> {
  return parseLines(gunzipSync(Buffer.from(String(upload.transcript), "base64")).toString("utf8").split("\n"));
}

test("Kimi CLI's SessionEnd hook returns at once and still uploads its session", async () => {
  // The recorded session's home, with the package its log names where it says.
  const kimi = join(root, "kimi-cli", ".kimi");
  await cp(FIXTURE, kimi, { recursive: true });
  const site = join(root, "kimi-cli", "site-packages");
  await mkdir(join(site, "kimi_cli-1.52.0.dist-info"), { recursive: true });
  const log = join(kimi, "logs", "kimi.log");
  await writeFile(log, (await readFile(log, "utf8")).replaceAll("@SITE_PACKAGES@", site));

  const { repo, env } = await machine("kimi-cli");
  process.env.KIMI_HOME = kimi;
  const hook = kimiAgent.hooks().find((entry) => entry.event === "SessionEnd");
  assert.ok(hook);

  // What Kimi CLI 1.52 sends a SessionEnd hook: no transcript path, a bare UUID.
  const took = await runHook(hook.command, repo, { ...env, KIMI_HOME: kimi }, {
    hook_event_name: "SessionEnd",
    session_id: SESSION,
    cwd: repo,
    reason: "exit",
  });
  assert.ok(took < 2_000, "the hook shell returns before Kimi CLI's five seconds are up");

  const upload = await nextUpload(1);
  assert.equal(upload.agent, "kimi");
  assert.equal(upload.sessionId, SESSION);
  assert.equal(upload.claudeVersion, "1.52.0");
  assert.equal((upload.git as { remote: string }).remote, "acme/kshop");

  const session = transcriptOf(upload);
  assert.deepEqual(
    [...new Set(session.toolUses.map((use) => use.name))],
    ["Read", "Grep", "Bash", "Agent", "Edit", "Write", "TodoWrite"],
  );
  assert.equal(session.meta.sidechainRecords > 0, true);
  assert.equal(session.meta.hasFileEdits, true);
});

test("Kimi Code's SessionEnd hook uploads the session with its subagent's log", async () => {
  const kimi = join(root, "kimi-code", ".kimi-code");
  await cp(KIMI_CODE_FIXTURE, kimi, { recursive: true });

  const { repo, env } = await machine("kimi-code");
  process.env.KIMI_HOME = kimi;
  const hook = kimiAgent.hooks().find((entry) => entry.event === "SessionEnd");
  assert.ok(hook);

  // What Kimi Code 2.1.1 sends: its own `session_<uuid>` id and `client_type`.
  await runHook(hook.command, repo, { ...env, KIMI_HOME: kimi }, {
    hook_event_name: "SessionEnd",
    session_id: KIMI_CODE_SESSION,
    cwd: repo,
    client_type: "kimi_code_cli",
    reason: "exit",
    session_title: "SCENARIO-KCMAIN: the add test fails, fix it",
  });

  const upload = await nextUpload(2);
  assert.equal(upload.agent, "kimi");
  assert.equal(upload.sessionId, KIMI_CODE_SESSION);

  const session = transcriptOf(upload);
  const subagent = session.records.filter((record) => record.isSidechain === true);
  assert.equal(subagent.length, 7, "the subagent's own log went up inside the session");
  assert.deepEqual([...session.fileEdits.keys()].sort(), ["NOTES.md", "src/app.js"]);
});

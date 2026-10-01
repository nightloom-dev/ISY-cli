// Plumbing for driving a real Claude Code against this checkout's build: an
// isolated home per run, a PATH whose `npx` sends `@nightloom/isy` to dist/,
// the mock API from the ISY repository, and the agent itself — in print mode
// or through a pseudo-terminal. live.mjs is built on it; so is anything that
// records sessions for the offline evals, which is why it is its own module.
//
// Nothing here touches the real ~/.claude or ~/.isy: every run gets its own
// HOME, CLAUDE_CONFIG_DIR and ISY_HOME, and the environment an agent sees is
// built from scratch rather than inherited, so no variable of the shell (or of
// a Claude Code session running this script) leaks into it. The one thing
// shared with the real home is the sign-in: `.credentials.json` is a symlink.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const CLI_ROOT = resolve(import.meta.dirname, "..");
export const ISY_CLI = join(CLI_ROOT, "dist", "index.js");
export const WORK = resolve(process.env.ISY_E2E_DIR ?? join(tmpdir(), "isy-e2e"));
export const ISY_REPO = resolve(process.env.ISY_REPO ?? join(CLI_ROOT, "..", "ISY"));
export const CREDENTIALS = process.env.CLAUDE_CREDENTIALS ?? join(homedir(), ".claude", ".credentials.json");
export const SHIM = join(WORK, "shim");
/** Claude Code's subscription allows only so many agents at once. */
export const MAX_AGENTS = Number(process.env.ISY_E2E_MAX_AGENTS) || 3;
/** Cheap and quick: the scenarios test the client, not the model. */
export const DEFAULT_MODEL = process.env.ISY_E2E_MODEL ?? "haiku";

/** `CLAUDE_BIN` may be a bare name; the agent's PATH is built from scratch, so resolve it here. */
export const CLAUDE_BIN = (() => {
  const named = process.env.CLAUDE_BIN ?? "claude";
  if (named.includes("/")) return resolve(named);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, named))) return join(dir, named);
  }
  return named;
})();

/** Thrown when the credentials symlink was replaced: the real sign-in may be stale now. */
export class CredentialsReplaced extends Error {}

// ---------------------------------------------------------------- processes

export function exec(command, args, { cwd, env, input, timeoutMs = 120_000 } = {}) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

/**
 * Where agent slots are claimed. Shared between processes on purpose: the
 * limit is the subscription's, and a second script recording sessions next to
 * this one draws on the same allowance.
 */
export const SLOTS = resolve(process.env.ISY_E2E_SLOTS ?? join(tmpdir(), "isy-e2e-slots"));

/** Whether the process that wrote a slot is still there to release it. */
async function heldByLiveProcess(path) {
  try {
    process.kill(Number((await readFile(path, "utf8")).trim()), 0);
    return true;
  } catch (error) {
    // EPERM: alive, someone else's. Anything unreadable is left to its writer.
    return error.code !== "ESRCH";
  }
}

/**
 * One slot per agent process, whoever starts it. A slot is a file created with
 * `wx`; one whose writer died is taken over.
 *
 * ponytail: polled once a second and not fair; fine for a handful of agents.
 */
export async function withAgentSlot(work) {
  await mkdir(SLOTS, { recursive: true });
  let slot;
  while (!slot) {
    for (let index = 0; index < MAX_AGENTS && !slot; index += 1) {
      const path = join(SLOTS, `slot-${index}`);
      try {
        await writeFile(path, `${process.pid}\n`, { flag: "wx" });
        slot = path;
      } catch {
        if (!(await heldByLiveProcess(path))) await rm(path, { force: true });
      }
    }
    if (!slot) await sleep(1000);
  }
  try {
    return await work();
  } finally {
    await rm(slot, { force: true });
  }
}

// ---------------------------------------------------------------- shims

/**
 * `npx @nightloom/isy …` is what every hook runs; here it runs dist/ instead of
 * the registry's release, and each call is written to the run's shim.log —
 * with the hook payload for `upload`, and the output for `check` and `commit`.
 * A bare `isy` is what the hooks of an isy before 1.0 say, and on a real
 * machine it reaches a package that talks to production: stopped and logged.
 * `xdg-open` is how `isy init` opens the browser on Linux; it only logs.
 */
export async function writeShims() {
  await mkdir(SHIM, { recursive: true });
  const node = process.execPath;
  const realNpx = join(dirname(process.execPath), "npx");
  await writeFile(
    join(SHIM, "npx"),
    `#!/bin/sh
ISY_CLI='${ISY_CLI}'
NODE='${node}'
REAL_NPX='${realNpx}'
LOG="\${ISY_E2E_RUN_DIR:-\$HOME}/shim.log"
now() { date +%s.%N; }
case "$1" in
  @nightloom/isy)
    shift
    case "$1" in
      upload)
        # Two seconds, as the client's own readHookInput waits: Claude Code does not
        # always close a hook's stdin, and a longer wait would delay the upload.
        started=$(now)
        payload=$(timeout 2 cat 2>/dev/null)
        printf '%s pid=%s isy %s stdinFrom=%s stdin=%s\\n' "$(now)" "$$" "$*" "$started" "$payload" >> "$LOG"
        # How long a real npx takes to resolve the package before isy reads anything.
        [ -n "$ISY_E2E_UPLOAD_DELAY" ] && sleep "$ISY_E2E_UPLOAD_DELAY"
        printf '%s' "$payload" | "$NODE" "$ISY_CLI" "$@"
        rc=$?
        printf '%s pid=%s isy %s exit=%s\\n' "$(now)" "$$" "$*" "$rc" >> "$LOG"
        exit $rc ;;
      check|commit)
        printf '%s pid=%s isy %s\\n' "$(now)" "$$" "$*" >> "$LOG"
        out=$("$NODE" "$ISY_CLI" "$@")
        rc=$?
        printf '%s pid=%s isy %s exit=%s out=%s\\n' "$(now)" "$$" "$*" "$rc" "$(printf '%s' "$out" | tr '\\n' '|')" >> "$LOG"
        [ -n "$out" ] && printf '%s\\n' "$out"
        exit $rc ;;
      *)
        printf '%s pid=%s isy %s\\n' "$(now)" "$$" "$*" >> "$LOG"
        exec "$NODE" "$ISY_CLI" "$@" ;;
    esac ;;
  isy|isy@*)
    shift
    printf '%s pid=%s BARE-isy %s\\n' "$(now)" "$$" "$*" >> "$LOG"
    timeout 2 cat >/dev/null 2>&1
    exit 0 ;;
esac
exec "$REAL_NPX" "$@"
`,
  );
  await writeFile(
    join(SHIM, "isy"),
    `#!/bin/sh
printf '%s pid=%s BARE-isy-bin %s\\n' "$(date +%s.%N)" "$$" "$*" >> "\${ISY_E2E_RUN_DIR:-\$HOME}/shim.log"
timeout 2 cat >/dev/null 2>&1
exit 0
`,
  );
  await writeFile(
    join(SHIM, "xdg-open"),
    `#!/bin/sh
printf '%s pid=%s BROWSER %s\\n' "$(date +%s.%N)" "$$" "$*" >> "\${ISY_E2E_RUN_DIR:-\$HOME}/browser.log"
exit 0
`,
  );
  for (const name of ["npx", "isy", "xdg-open"]) await chmod(join(SHIM, name), 0o755);
}

// ---------------------------------------------------------------- runs

export function envFor(run, extra = {}) {
  return {
    PATH: [SHIM, dirname(CLAUDE_BIN), dirname(process.execPath), "/usr/local/bin", "/usr/bin", "/bin"].join(delimiter),
    HOME: run.home,
    USER: process.env.USER ?? "e2e",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "e2e",
    SHELL: "/bin/bash",
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "xterm-256color",
    TMPDIR: join(run.dir, "tmp"),
    CLAUDE_CONFIG_DIR: run.config,
    ISY_HOME: run.isy,
    ISY_E2E_RUN_DIR: run.dir,
    DISABLE_AUTOUPDATER: "1",
    BROWSER: join(SHIM, "xdg-open"),
    GIT_AUTHOR_NAME: "ISY E2E",
    GIT_AUTHOR_EMAIL: "e2e@isy.invalid",
    GIT_COMMITTER_NAME: "ISY E2E",
    GIT_COMMITTER_EMAIL: "e2e@isy.invalid",
    ...run.env,
    ...extra,
  };
}

export function git(run, args, options = {}) {
  return exec("git", args, { cwd: run.repo, env: envFor(run, options.env), ...options });
}

/** This checkout's isy, as the run's hooks would find it, without going through npx. */
export function isy(run, args, { cwd, input } = {}) {
  return exec(process.execPath, [ISY_CLI, ...args], { cwd: cwd ?? run.repo, env: envFor(run), input });
}

/**
 * A fresh run: home, Claude config that has seen its onboarding and trusts the
 * repository, isy pointed at `api`, and a repository with one commit (isy
 * skips a directory with none) and an origin that is never pushed to. With
 * `init`, hooks go in the way a user puts them in.
 */
export async function prepareRun(id, { api, init = true, scaffold } = {}) {
  const dir = join(WORK, "run", id);
  await rm(dir, { recursive: true, force: true });
  const home = join(dir, "home");
  const run = { id, dir, home, repo: join(dir, "repo"), config: join(home, ".claude"), isy: join(home, ".isy"), api, agents: 0 };
  for (const path of [run.config, run.isy, run.repo, join(dir, "tmp")]) await mkdir(path, { recursive: true });

  await symlink(CREDENTIALS, join(run.config, ".credentials.json"));
  await writeFile(
    join(run.config, ".claude.json"),
    JSON.stringify(
      {
        hasCompletedOnboarding: true,
        theme: "dark",
        projects: { [run.repo]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
      },
      null,
      2,
    ),
  );
  await writeFile(join(run.isy, "config.json"), JSON.stringify({ token: "isy_test", apiBaseUrl: api }));

  if (scaffold) await cp(scaffold, run.repo, { recursive: true });
  else await writeFile(join(run.repo, "README.md"), "# e2e\n");
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["remote", "add", "origin", `https://github.com/isy-e2e/${id}.git`],
    ["add", "-A"],
    ["commit", "-qm", "chore: initial commit"],
  ]) {
    const result = await git(run, args);
    if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }

  if (init) {
    const result = await isy(run, ["init"]);
    if (result.code !== 0) throw new Error(`isy init: ${result.stderr || result.stdout}`);
  }
  return run;
}

export async function readSettings(run) {
  return JSON.parse(await readFile(join(run.config, "settings.json"), "utf8"));
}

export async function writeSettings(run, settings) {
  await writeFile(join(run.config, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
}

export async function credentialsIntact(run) {
  try {
    return (await lstat(join(run.config, ".credentials.json"))).isSymbolicLink();
  } catch {
    return false;
  }
}

async function guardCredentials(run) {
  if (!(await credentialsIntact(run))) {
    throw new CredentialsReplaced(
      `${join(run.config, ".credentials.json")} is no longer a symlink: Claude Code wrote the sign-in over it, ` +
        `so ${CREDENTIALS} may now hold a token that was already refreshed away. Stopped; nothing was copied.`,
    );
  }
}

// ---------------------------------------------------------------- agents

/**
 * One `claude -p` run to completion. Not `--dangerously-skip-permissions`:
 * edits in the repository are accepted, and whatever else the run needs is
 * named in `tools` — anything outside it is refused, never prompted for.
 */
export function claudeP(run, prompt, { model = DEFAULT_MODEL, tools, disallowed, extra = [], label, timeoutMs = 15 * 60_000 } = {}) {
  return withAgentSlot(async () => {
    run.agents += 1;
    const name = label ?? `agent-${run.agents}`;
    const args = [
      "-p",
      prompt,
      "--model",
      model,
      "--permission-mode",
      "acceptEdits",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(tools ? ["--allowedTools", tools] : []),
      ...(disallowed ? ["--disallowedTools", disallowed] : []),
      ...extra,
    ];
    const startedAt = Date.now();
    let resultAt;
    let sessionId;
    let result;
    let buffer = "";
    const lines = [];
    const child = spawn(CLAUDE_BIN, args, { cwd: run.repo, env: envFor(run), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let cut;
      while ((cut = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (!line.trim()) continue;
        lines.push(line);
        try {
          const event = JSON.parse(line);
          if (event.type === "system" && event.subtype === "init") sessionId ??= event.session_id;
          if (event.type === "result") {
            resultAt = Date.now();
            result = event;
            sessionId ??= event.session_id;
          }
        } catch {
          // Not an event; kept in the file as it came.
        }
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const code = await new Promise((done) => {
      child.on("error", () => done(-1));
      child.on("close", done);
    });
    clearTimeout(timer);
    const exitedAt = Date.now();
    const out = join(run.dir, `${name}.jsonl`);
    await writeFile(out, `${lines.join("\n")}\n`);
    await writeFile(join(run.dir, `${name}.err`), stderr);
    await guardCredentials(run);
    return { name, sessionId, code, startedAt, resultAt, exitedAt, result, out, stderr };
  });
}

/**
 * An interactive session through e2e/pty-drive.py, `steps` as that file
 * documents them. Resolves with the driver's JSON: marks, snapshots, exit code.
 */
export function claudePty(run, steps, { model = DEFAULT_MODEL, extra = [], label } = {}) {
  return withAgentSlot(async () => {
    run.agents += 1;
    const name = label ?? `pty-${run.agents}`;
    const stepsFile = join(run.dir, `${name}.steps.json`);
    await writeFile(stepsFile, JSON.stringify(steps, null, 1));
    const result = await exec(
      "python3",
      [join(CLI_ROOT, "e2e", "pty-drive.py"), stepsFile, "--", CLAUDE_BIN, "--model", model, "--permission-mode", "acceptEdits", ...extra],
      { cwd: run.repo, env: envFor(run), timeoutMs: 15 * 60_000 },
    );
    await writeFile(join(run.dir, `${name}.json`), result.stdout);
    await guardCredentials(run);
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      parsed = { ok: false, error: result.stderr || "no output from pty-drive.py", marks: {}, snaps: {} };
    }
    return { name, file: join(run.dir, `${name}.json`), ...parsed };
  });
}

// ---------------------------------------------------------------- the mock API

/** `backend/server/src/scripts/mock-api.mjs`, which parses each upload with the installed isy/parser. */
export async function startMock({ port, keep, delayMs = 0, log }) {
  const child = spawn(process.execPath, [join(ISY_REPO, "backend", "server", "src", "scripts", "mock-api.mjs")], {
    cwd: ISY_REPO,
    env: { ...process.env, PORT: String(port), MOCK_API_KEEP: keep, MOCK_API_DELAY_MS: String(delayMs) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk;
    if (log) void writeFile(log, output);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  for (let waited = 0; !output.includes("mock API on"); waited += 100) {
    if (waited > 30_000 || child.exitCode !== null) throw new Error(`mock API did not start on :${port}: ${output}`);
    await sleep(100);
  }
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

export async function uploads(api) {
  const response = await fetch(new URL("/api/v1/sessions", api));
  return (await response.json()).uploads;
}

/** The newest upload of `sessionId` the mock accepted, waiting up to `timeoutMs` for one. */
export async function waitUpload(api, sessionId, { timeoutMs = 90_000, after = 0 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = (await uploads(api)).filter(
      (upload) => upload.sessionId === sessionId && Date.parse(upload.receivedAt) >= after,
    );
    if (found.length > 0) return found.at(-1);
    if (Date.now() > deadline) return undefined;
    await sleep(1000);
  }
}

// ---------------------------------------------------------------- transcripts

export function projectSlug(path) {
  return path.replace(/[^a-zA-Z0-9]/g, "-");
}

export function transcriptPath(run, sessionId) {
  return join(run.config, "projects", projectSlug(run.repo), `${sessionId}.jsonl`);
}

/** Records of a JSONL file, split on LF only — what the file holds, not what a reader makes of it. */
export async function readJsonl(path) {
  const records = [];
  for (const line of (await readFile(path, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      records.push({ unparsed: line });
    }
  }
  return records;
}

export function blocksOf(record) {
  const content = record?.message?.content;
  return Array.isArray(content) ? content : [];
}

/** Every tool call in `records`, in file order. */
export function toolUses(records) {
  return records.flatMap((record, index) =>
    blocksOf(record)
      .filter((block) => block.type === "tool_use")
      .map((block) => ({ ...block, index, record, sidechain: record.isSidechain === true })),
  );
}

/** The run's shim.log, one entry per line: when, which process, what it ran, and what it saw. */
export async function shimLog(run) {
  let text;
  try {
    text = await readFile(join(run.dir, "shim.log"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [at, pid, kind, ...rest] = line.split(" ");
      const tail = rest.join(" ");
      const field = (name) => {
        const match = new RegExp(` ${name}=(.*?)(?= (?:exit|out|stdin|stdinFrom)=|$)`).exec(` ${tail}`);
        return match?.[1];
      };
      return {
        at: Number(at) * 1000,
        pid: pid.replace("pid=", ""),
        kind,
        args: tail.replace(/ (?:stdinFrom|stdin|exit|out)=.*$/, ""),
        stdin: field("stdin"),
        stdinFrom: field("stdinFrom") && Number(field("stdinFrom")) * 1000,
        exit: field("exit"),
        out: field("out"),
      };
    });
}

export async function keepTranscripts(run) {
  const from = join(run.config, "projects");
  if (existsSync(from)) await cp(from, join(run.dir, "transcripts"), { recursive: true });
}

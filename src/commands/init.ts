import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { DEFAULT_API_BASE_URL, verifyToken } from "../api.js";
import { readConfig, writeConfig } from "../config.js";
import { presentAgents } from "../agents/index.js";
import { GIT_HOOKS, gitHooksDir, installGitHook } from "../githook.js";
import { logLine } from "../log.js";
import { awaitPairedKey, openPairing } from "../pairing.js";
import type { Pairing } from "../pairing.js";
import { configPath } from "../paths.js";

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execFile(command, [url], { windowsHide: true }, () => undefined);
  } catch {
    return;
  }
}

/**
 * The paste, still on offer.
 *
 * It is no longer the way in — the browser hands the key over by itself — but
 * it is the way in that works everywhere: a browser signed in on another
 * machine, a server too old to know the pairing route, a page the reader closed
 * and reopened from their own history.
 */
async function promptForToken(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!process.stdin.isTTY) return undefined;

  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = signal
      ? await reader.question(prompt, { signal })
      : await reader.question(prompt);
    const token = answer.trim();
    return token.length > 0 ? token : undefined;
  } catch {
    // Aborted: the browser answered first, and the question is moot.
    return undefined;
  } finally {
    reader.close();
  }
}

/**
 * Whichever arrives first — the key the browser hands over, or one pasted here.
 *
 * Neither is allowed to end the wait by coming back empty: a machine with no
 * TTY has nothing to paste with, and a pairing that expires while the reader is
 * still signing in should leave the paste standing rather than take the prompt
 * away from under them.
 */
function firstOf(
  attempts: readonly Promise<string | undefined>[],
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let left = attempts.length;
    const settle = (token: string | undefined) => {
      if (token) resolve(token);
      else if (--left === 0) resolve(undefined);
    };
    for (const attempt of attempts) void attempt.then(settle, () => settle(undefined));
  });
}

/**
 * Sign in through the keys screen.
 *
 * `isy init` opens `/settings/api_keys` rather than the sign-in page that
 * prints a token: the screen there can make a key, name it, and revoke the one
 * a lost machine still holds, and it hands what it makes straight back to this
 * terminal (`pairing.ts`). Signing in comes free with it — the page is behind
 * the session, so a browser that is not signed in goes through GitHub on its
 * way and lands back on the page it was asked for.
 */
async function keyFromBrowser(baseUrl: string, pairing: Pairing): Promise<string | undefined> {
  console.log(`Opening ${pairing.connectUrl}`);
  console.log("If the browser does not open, visit that URL yourself.");
  // The code is the check, not the connection: that page is reached by a link,
  // and a link can be sent by someone else. A page showing a different code is
  // waiting for a different terminal.
  console.log(`That page should show the code ${pairing.userCode}. Create a key there.`);
  openBrowser(pairing.connectUrl);

  const controller = new AbortController();
  try {
    return await firstOf([
      awaitPairedKey(baseUrl, pairing, controller.signal).then((key) => {
        if (!key) return undefined;
        const who = key.githubLogin ? ` (${key.githubLogin})` : "";
        console.log(`Key received from the browser${who}.`);
        return key.token;
      }),
      promptForToken("Waiting for that page — or paste a key here: ", controller.signal),
    ]);
  } finally {
    // Whichever lost is still running: the poll holds a socket, the prompt
    // holds stdin, and either would keep the process from exiting.
    controller.abort();
  }
}

/** The flow before the keys screen could answer: a page that prints a token, and a paste. */
async function signInAndPaste(authUrl: string): Promise<string | undefined> {
  console.log(`Opening ${authUrl}`);
  console.log("If the browser does not open, visit that URL yourself.");
  openBrowser(authUrl);
  return promptForToken("Paste the token from that page: ");
}

export async function runInit(options: { token?: string }, cwd: string): Promise<void> {
  const config = await readConfig();
  const baseUrl = config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const authUrl = new URL("/auth/github", baseUrl).toString();

  let token = options.token;
  if (!token) {
    // Only when the pairing could not be opened at all — a server that predates
    // it, or one with no dashboard address. A pairing that was opened and then
    // ran out has already had its browser window; a second one would be two
    // tabs and two codes for one sign-in.
    const pairing = await openPairing(baseUrl);
    token = pairing ? await keyFromBrowser(baseUrl, pairing) : await signInAndPaste(authUrl);
  }

  if (!token) {
    throw new Error(`no token provided. Visit ${authUrl}, then run: isy init --token <token>`);
  }

  // The keys screen lists every key by its preview, `isy_abcd…wxyz`, and that is
  // what gets copied off it. Sent as it is, the ellipsis cannot go into an HTTP
  // header, and the failure read as though the server could not be reached.
  if (token.includes("…") || token.includes("...")) {
    throw new Error(
      "that is a key's preview, not the key: the whole key is shown once, when it is created. " +
        `Run isy init again and create a key on the page it opens, or at ${new URL("/settings/api_keys", baseUrl)}`,
    );
  }

  const verified = await verifyToken({ baseUrl, token });
  if (!verified.ok) throw new Error(verified.error);

  await writeConfig({ ...config, token, githubLogin: verified.githubLogin });
  console.log(`Token stored in ${configPath()}`);

  // Hooks go into every CLI actually installed here, and none that is not.
  const agents = await presentAgents();
  if (agents.length === 0) {
    logLine("init: token stored, no supported CLI found");
    console.log("No supported CLI found. Looked for Claude Code, Kimi CLI and Codex CLI.");
  }

  for (const agent of agents) {
    const hook = await agent.installHooks();
    logLine(`init: ${agent.id} hooks ${hook}`);
    console.log(
      hook === "installed"
        ? `Added ${agent.label} hooks (${agent.hooks().map((entry) => entry.event).join(", ")}) in ${agent.configLocation()}`
        : `${agent.label} hooks already present in ${agent.configLocation()}`,
    );
    if (hook === "installed" && agent.afterInstall) console.log(agent.afterInstall);
  }

  // The commit is what starts the loop: it is the first moment the transcript
  // and the SHA it belongs to both exist. The push is when the analysis is
  // waiting for it. Per repository, so this only touches the one the user ran
  // init in.
  const gitHook = await installGitHook(cwd);
  logLine(`init: git hooks ${gitHook}`);
  if (gitHook === "not-a-repository") {
    console.log(`${cwd} is not a git repository, so no git hooks were added.`);
  } else {
    const names = GIT_HOOKS.map((hook) => hook.name).join(" and ");
    const where = await gitHooksDir(cwd);
    console.log(
      gitHook === "installed"
        ? `Added the ${names} hooks in ${where}`
        : `The ${names} hooks are already present in ${where}`,
    );
  }

  if (verified.githubLogin) console.log(`Signed in as ${verified.githubLogin}`);
}

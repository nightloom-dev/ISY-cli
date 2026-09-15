import { presentAgents } from "../agents/index.js";
import { removeGitHook } from "../githook.js";
import { readConfig, writeConfig } from "../config.js";
import { logLine } from "../log.js";
import { configPath } from "../paths.js";

export async function runLogout(cwd: string): Promise<void> {
  const config = await readConfig();
  const hadToken = typeof config.token === "string" && config.token.length > 0;

  const { token: _token, githubLogin: _githubLogin, ...rest } = config;
  await writeConfig(rest);
  console.log(hadToken ? `Token removed from ${configPath()}` : "No token was configured");

  let removed = 0;
  for (const agent of await presentAgents()) {
    const hook = await agent.removeHooks();
    logLine(`logout: ${agent.id} hooks ${hook}`);
    if (hook === "removed") {
      removed += 1;
      console.log(`${agent.label} hooks removed from ${agent.configLocation()}`);
    }
  }

  const gitHook = await removeGitHook(cwd);
  logLine(`logout: git hooks ${gitHook}`);
  if (gitHook === "removed") {
    removed += 1;
    console.log("git hooks removed from this repository");
  }

  if (removed === 0) console.log("No ISY hooks were installed");
}

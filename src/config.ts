import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { configPath, isyHome } from "./paths.js";
import type { IsyConfig } from "./types.js";

export async function readConfig(): Promise<IsyConfig> {
  let contents: string;
  try {
    contents = await readFile(configPath(), "utf8");
  } catch {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as IsyConfig;
  } catch {
    throw new Error(`config at ${configPath()} is not valid JSON`);
  }
}

export async function writeConfig(config: IsyConfig): Promise<void> {
  const target = configPath();
  await mkdir(isyHome(), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(target, 0o600);
}

export async function updateConfig(patch: Partial<IsyConfig>): Promise<IsyConfig> {
  const merged = { ...(await readConfig()), ...patch };
  await writeConfig(merged);
  return merged;
}

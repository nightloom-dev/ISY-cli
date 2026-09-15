import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  HOOK_COMMAND,
  START_HOOK_COMMAND,
  installHook,
  installedHooks,
  isHookInstalled,
  removeHook,
} from "../hook.js";

let configDir: string;
const saved = process.env.CLAUDE_CONFIG_DIR;

before(async () => {
  configDir = await mkdtemp(join(tmpdir(), "isy-settings-"));
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

after(() => {
  if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = saved;
});

async function settings(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")) as Record<string, unknown>;
}

async function writeSettings(value: unknown): Promise<void> {
  await writeFile(join(configDir, "settings.json"), JSON.stringify(value, null, 2));
}

beforeEach(async () => {
  await writeSettings({});
});

test("creates the hook when settings.json has none", async () => {
  assert.equal(await installHook(), "installed");
  assert.equal(await isHookInstalled(), true);

  const hooks = (await settings()).hooks as { SessionEnd: { hooks: { command: string }[] }[] };
  assert.equal(hooks.SessionEnd[0]?.hooks[0]?.command, HOOK_COMMAND);
});

test("does not add a second copy of the hook", async () => {
  await installHook();
  assert.equal(await installHook(), "already-present");

  const hooks = (await settings()).hooks as { SessionEnd: unknown[] };
  assert.equal(hooks.SessionEnd.length, 1);
});

test("keeps hooks belonging to other events and other tools", async () => {
  await writeSettings({
    model: "opus",
    permissions: { allow: ["Bash"] },
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "bash other-tool.sh" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "bash someone-else.sh" }] }],
    },
  });

  await installHook();
  const result = await settings();

  assert.equal(result.model, "opus");
  assert.deepEqual(result.permissions, { allow: ["Bash"] });

  const hooks = result.hooks as Record<string, { hooks: { command: string }[] }[]>;
  assert.equal(hooks.SessionStart?.[0]?.hooks[0]?.command, "bash other-tool.sh");
  assert.equal(hooks.SessionEnd?.length, 2);
  assert.equal(hooks.SessionEnd?.[0]?.hooks[0]?.command, "bash someone-else.sh");
  assert.equal(hooks.SessionEnd?.[1]?.hooks[0]?.command, HOOK_COMMAND);
});

test("removes only the ISY hook and leaves the neighbours alone", async () => {
  await writeSettings({
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "bash other-tool.sh" }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: "bash someone-else.sh" }] }],
    },
  });
  await installHook();

  assert.equal(await removeHook(), "removed");
  const hooks = (await settings()).hooks as Record<string, { hooks: { command: string }[] }[]>;

  assert.equal(hooks.SessionEnd?.length, 1);
  assert.equal(hooks.SessionEnd?.[0]?.hooks[0]?.command, "bash someone-else.sh");
  assert.equal(hooks.SessionStart?.[0]?.hooks[0]?.command, "bash other-tool.sh");
});

test("drops the SessionEnd key entirely when ISY was its only hook", async () => {
  await writeSettings({ model: "opus" });
  await installHook();
  await removeHook();

  const result = await settings();
  assert.equal(result.model, "opus");
  assert.equal(result.hooks, undefined);
});

test("reports absence rather than failing when there is nothing to remove", async () => {
  assert.equal(await removeHook(), "absent");
});

test("works when settings.json does not exist at all", async () => {
  const emptyDir = await mkdtemp(join(tmpdir(), "isy-nosettings-"));
  process.env.CLAUDE_CONFIG_DIR = emptyDir;
  try {
    assert.equal(await isHookInstalled(), false);
    assert.equal(await installHook(), "installed");
    assert.equal(await isHookInstalled(), true);
  } finally {
    process.env.CLAUDE_CONFIG_DIR = configDir;
  }
});

test("refuses to touch a settings.json it cannot parse", async () => {
  await writeFile(join(configDir, "settings.json"), "{ this is not json");
  await assert.rejects(installHook);

  const raw = await readFile(join(configDir, "settings.json"), "utf8");
  assert.equal(raw, "{ this is not json");
});

test("installs both the upload hook and the session start announcement", async () => {
  await installHook();

  const hooks = (await settings()).hooks as Record<string, { hooks: { command: string }[] }[]>;
  assert.equal(hooks.SessionEnd?.[0]?.hooks[0]?.command, HOOK_COMMAND);
  assert.equal(hooks.SessionStart?.[0]?.hooks[0]?.command, START_HOOK_COMMAND);
  assert.deepEqual(await installedHooks(), ["SessionEnd", "SessionStart"]);
});

test("does not call itself installed while one of the two hooks is missing", async () => {
  await writeSettings({
    hooks: { SessionEnd: [{ hooks: [{ type: "command", command: HOOK_COMMAND }] }] },
  });

  assert.equal(await isHookInstalled(), false);
  assert.deepEqual(await installedHooks(), ["SessionEnd"]);
  assert.equal(await installHook(), "installed");
  assert.equal(await isHookInstalled(), true);
});

test("removes both hooks and leaves settings.json clean", async () => {
  await writeSettings({ model: "opus" });
  await installHook();
  assert.equal(await removeHook(), "removed");

  const result = await settings();
  assert.equal(result.model, "opus");
  assert.equal(result.hooks, undefined);
});

test("replaces the hook an older isy wrote instead of stacking a second one", async () => {
  for (const older of ["npx isy upload --silent", "npx isy upload --hook"]) {
    await writeSettings({
      hooks: { SessionEnd: [{ hooks: [{ type: "command", command: older }] }] },
    });

    assert.equal(await installHook(), "installed");
    const hooks = (await settings()).hooks as Record<string, { hooks: { command: string }[] }[]>;

    assert.equal(hooks.SessionEnd?.length, 1);
    assert.equal(hooks.SessionEnd?.[0]?.hooks[0]?.command, HOOK_COMMAND);
  }
});

test("removes a hook left behind by an older isy", async () => {
  await writeSettings({
    hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "npx isy upload --silent" }] }] },
  });

  assert.equal(await removeHook(), "removed");
  assert.equal((await settings()).hooks, undefined);
});

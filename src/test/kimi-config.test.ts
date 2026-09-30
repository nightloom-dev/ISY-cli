import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { promisify } from "node:util";
import { basicString, hookTables } from "../agents/kimi-config.js";
import { kimiAgent, kimiConfigPath } from "../agents/kimi.js";
import { pendingAlertPath } from "../paths.js";

const run = promisify(execFile);

const saved = { kimi: process.env.KIMI_HOME, isy: process.env.ISY_HOME };
let root: string;
/** A Kimi CLI home, and a Kimi Code one: Kimi Code's is told by its name. */
let kimiCli: string;
let kimiCode: string;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "isy-kimi-config-"));
  kimiCli = join(root, "kimi");
  kimiCode = join(root, ".kimi-code");
  // An account name with a quote in it, the way a home directory can have one.
  process.env.ISY_HOME = join(root, "o'brien", ".isy");
});

beforeEach(async () => {
  for (const home of [kimiCli, kimiCode]) await mkdir(home, { recursive: true });
  await writeFile(join(kimiCli, "config.toml"), "");
  await writeFile(join(kimiCode, "config.toml"), "");
});

after(() => {
  if (saved.kimi === undefined) delete process.env.KIMI_HOME;
  else process.env.KIMI_HOME = saved.kimi;
  if (saved.isy === undefined) delete process.env.ISY_HOME;
  else process.env.ISY_HOME = saved.isy;
});

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

test("reads hook tables however their strings are quoted, and nothing inside a string or an array", () => {
  const contents = [
    "[model]",
    'name = "k2"',
    'note = """',
    "[[hooks]]",
    'command = "not a hook"',
    '"""',
    "",
    "[[hooks]]",
    "event = 'SessionStart'",
    'command = "echo \\"hi\\" \\\\ \\u00e9" # a comment',
    "timeout = 30",
    "",
    "# the user's own",
    "[[ hooks ]]",
    'event = "Stop"',
    "matcher = [",
    '  "[[hooks]]",',
    "]",
    "command = '''two",
    "lines'''",
    "",
    "[ui]",
    'theme = "dark"',
  ].join("\n");

  const tables = hookTables(contents);
  assert.deepEqual(
    tables.map(({ event, command, timeout }) => ({ event, command, timeout })),
    [
      { event: "SessionStart", command: 'echo "hi" \\ é', timeout: 30 },
      { event: "Stop", command: "two\nlines", timeout: undefined },
    ],
  );
  // A table is its own lines: not the blank line, the comment or the table after it.
  assert.equal(
    contents.slice(tables[0]!.start, tables[0]!.stop),
    "[[hooks]]\nevent = 'SessionStart'\ncommand = \"echo \\\"hi\\\" \\\\ \\u00e9\" # a comment\ntimeout = 30\n",
  );
  assert.equal(contents.slice(tables[1]!.stop), "\n[ui]\ntheme = \"dark\"");

  // Written on Windows.
  const crlf = hookTables('[[hooks]]\r\nevent = "SessionEnd"\r\ncommand = "x"\r\n');
  assert.deepEqual(crlf.map((table) => table.command), ["x"]);
});

test("a basic string holds any command exactly", () => {
  for (const command of [
    "if [ -s '/home/o'\\''brien/.isy/pending-alert' ]; then cat x; fi",
    'say "hi" \\ there',
    "tab\there, bell\u0007, escape\u001b",
    "日本語 and 🙂",
  ]) {
    assert.equal(hookTables(`[[hooks]]\ncommand = ${basicString(command)}\n`)[0]?.command, command);
  }
});

test("finds its hooks by what they run once Kimi has written the config back without its markers", async () => {
  process.env.KIMI_HOME = kimiCli;
  // An isy 1.0 install as `tomlkit` writes it back after `/model`: no markers,
  // basic strings, the user's own hook and settings around it.
  const rewritten = [
    'default_model = "kimi-k2"',
    "",
    "[[hooks]]",
    'event = "SessionStart"',
    'command = "npx @nightloom/isy check --hook --agent kimi"',
    "timeout = 30",
    "",
    "[[hooks]]",
    'event = "SessionEnd"',
    'command = "npx @nightloom/isy upload --hook --agent kimi"',
    "timeout = 30",
    "",
    "[[hooks]]",
    'event = "PreToolUse"',
    'matcher = "Shell"',
    'command = "./guard.sh"',
    "timeout = 5",
    "",
    "[models.k2]",
    'provider = "moonshot"',
    "",
  ].join("\n");
  await writeFile(kimiConfigPath(), rewritten);

  // Its SessionEnd is the one Kimi CLI kills after five seconds.
  assert.deepEqual(await kimiAgent.hooksInstalled(), ["SessionStart"]);
  assert.equal(await kimiAgent.repairHooks?.(), true);

  let contents = await readFile(kimiConfigPath(), "utf8");
  assert.equal(count(contents, /^\[\[hooks\]\]$/gm), 3);
  assert.equal(count(contents, /npx @nightloom\/isy/g), 2);
  assert.match(contents, /exec 3<&0; nohup npx @nightloom\/isy upload --hook --agent kimi/);
  assert.match(contents, /command = "\.\/guard\.sh"/);
  assert.match(contents, /\[models\.k2\]\nprovider = "moonshot"/);
  assert.deepEqual(await kimiAgent.hooksInstalled(), ["SessionStart", "SessionEnd"]);
  assert.equal(await kimiAgent.installHooks(), "already-present");
  assert.equal(await kimiAgent.repairHooks?.(), false);

  // Written back once more: the markers go, the hooks are still isy's.
  await writeFile(kimiConfigPath(), contents.replace(/^# isy:.*\n/gm, ""));
  assert.deepEqual(await kimiAgent.hooksInstalled(), ["SessionStart", "SessionEnd"]);
  assert.equal(await kimiAgent.installHooks(), "already-present");

  // And taken out, markers or not, with the user's hook left where it was.
  assert.equal(await kimiAgent.removeHooks(), "removed");
  contents = await readFile(kimiConfigPath(), "utf8");
  assert.equal(count(contents, /^\[\[hooks\]\]$/gm), 1);
  assert.doesNotMatch(contents, /isy/);
  assert.match(contents, /command = "\.\/guard\.sh"/);
  assert.equal(await kimiAgent.removeHooks(), "absent");
});

test("the hooks Kimi Code's migration copied from Kimi CLI become Kimi Code's, once", async () => {
  process.env.KIMI_HOME = kimiCode;
  // What the migration writes: Kimi CLI's hooks, copied as they were, no markers.
  await writeFile(
    kimiConfigPath(),
    [
      "[[hooks]]",
      'event = "SessionStart"',
      'command = "npx @nightloom/isy check --hook --agent kimi"',
      "timeout = 30",
      "",
      "[[hooks]]",
      'event = "SessionEnd"',
      'command = "exec 3<&0; nohup npx @nightloom/isy upload --hook --agent kimi <&3 >/dev/null 2>&1 &"',
      "timeout = 30",
      "",
    ].join("\n"),
  );

  assert.deepEqual(await kimiAgent.hooksInstalled(), ["SessionStart"]);
  assert.equal(await kimiAgent.installHooks(), "installed");

  const contents = await readFile(kimiConfigPath(), "utf8");
  // One upload, not two racing each other at every session end.
  assert.equal(count(contents, /upload --hook/g), 1);
  assert.doesNotMatch(contents, /exec 3<&0/);
  assert.equal(count(contents, /^\[\[hooks\]\]$/gm), 3);
  assert.deepEqual(await kimiAgent.hooksInstalled(), ["SessionStart", "SessionEnd", "UserPromptSubmit"]);
  assert.equal(await kimiAgent.installHooks(), "already-present");

  assert.equal(await kimiAgent.removeHooks(), "removed");
  assert.equal(count(await readFile(kimiConfigPath(), "utf8"), /\[\[hooks\]\]/g), 0);
});

test("a block that lost its end marker keeps the hooks the user wrote after it", async () => {
  process.env.KIMI_HOME = kimiCli;
  const guard = '[[hooks]]\nevent = "PreToolUse"\nmatcher = "Shell"\ncommand = "./guard.sh"\ntimeout = 5\n';
  await writeFile(
    kimiConfigPath(),
    [
      "# isy:begin — managed by isy, do not edit inside this block",
      "[[hooks]]",
      'event = "SessionEnd"',
      "command = 'npx isy upload --hook --agent kimi'",
      "timeout = 30",
      "",
      guard,
    ].join("\n"),
  );

  assert.equal(await kimiAgent.installHooks(), "installed");
  let contents = await readFile(kimiConfigPath(), "utf8");
  assert.ok(contents.includes(guard), contents);
  assert.doesNotMatch(contents, /npx isy upload/);
  assert.equal(count(contents, /# isy:begin/g), 1);
  assert.equal(count(contents, /# isy:end/g), 1);

  assert.equal(await kimiAgent.removeHooks(), "removed");
  contents = await readFile(kimiConfigPath(), "utf8");
  assert.equal(contents, guard);
});

test("a home with a quote in its path still gets a config TOML can read, and a drain that runs", async (t) => {
  process.env.KIMI_HOME = kimiCode;
  await writeFile(kimiConfigPath(), '[model]\nname = "k2"\n');
  assert.equal(await kimiAgent.installHooks(), "installed");

  const drain = kimiAgent.hooks().find((hook) => hook.event === "UserPromptSubmit")?.command ?? "";
  assert.ok(drain.includes("o'\\''brien"), drain);
  assert.equal(hookTables(await readFile(kimiConfigPath(), "utf8")).at(-1)?.command, drain);

  // The shell runs it: shows what was parked, once.
  await mkdir(join(root, "o'brien", ".isy"), { recursive: true });
  await writeFile(pendingAlertPath(), "ISY: session uploaded\n");
  assert.equal((await run("sh", ["-c", drain])).stdout, "ISY: session uploaded\n");
  assert.equal((await run("sh", ["-c", drain])).stdout, "");

  // And TOML itself reads it, where a TOML reader is at hand.
  const python = await run("python3", ["-c", "import tomllib"]).then(
    () => true,
    () => false,
  );
  if (!python) {
    t.skip("no python3 with tomllib here");
    return;
  }
  const read = await run("python3", [
    "-c",
    "import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], 'rb'))))",
    kimiConfigPath(),
  ]);
  const parsed = JSON.parse(read.stdout) as { model: unknown; hooks: { event: string; command: string }[] };
  assert.deepEqual(parsed.model, { name: "k2" });
  assert.equal(parsed.hooks.find((hook) => hook.event === "UserPromptSubmit")?.command, drain);
});

test("a config that is there but cannot be read is not written over", async () => {
  process.env.KIMI_HOME = join(root, "unreadable");
  // A directory where the file should be: read fails with something other than "not there".
  await mkdir(join(root, "unreadable", "config.toml"), { recursive: true });

  await assert.rejects(kimiAgent.installHooks(), /EISDIR/);
  await assert.rejects(kimiAgent.removeHooks(), /EISDIR/);
});

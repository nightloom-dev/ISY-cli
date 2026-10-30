import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("the terminal driver still reports once the child has exited", async (t) => {
  const python = await run("python3", ["--version"]).then(
    () => true,
    () => false,
  );
  if (!python) {
    t.skip("no python3 here");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "isy-pty-drive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const steps = join(dir, "steps.json");
  // Each of these reads the terminal again after the read that found the child gone.
  await writeFile(steps, JSON.stringify([{ sleep: 0.3 }, { sleep: 0.1 }, { wait: "never", timeout: 1 }]));

  const driver = join(import.meta.dirname, "..", "..", "e2e", "pty-drive.py");
  const { stdout } = await run("python3", [driver, steps, "--", "sh", "-c", "exit 3"]);
  const report = JSON.parse(stdout) as { ok: boolean; failedStep: number; exitCode: number };
  assert.equal(report.exitCode, 3);
  assert.equal(report.ok, false);
  assert.equal(report.failedStep, 2);
});

// Plain JavaScript outside `rootDir`: named at run time, so tsc leaves it alone.
const lib = await import(new URL("../../e2e/lib.mjs", import.meta.url).href);

test("a tool call copied into an API request record is not listed a second time", () => {
  const edit = { type: "tool_use", id: "toolu_1", name: "Edit", input: {} };
  const records = [
    { type: "api-request-blob", hash: "h1", message: { role: "assistant", content: [edit] } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [edit] } },
  ];
  const uses = lib.toolUses(records);
  assert.equal(uses.length, 1);
  // A blob has no uuid, so a lookup by it would take a real edit for one off the main path.
  assert.equal(uses[0].record.uuid, "a1");
});

test("a note any later commit prints again is a repeat, past an amend that printed none", () => {
  const row = "external_dependency  package.json  added to package.json: left-pad";
  const note = `ISY: 1 possible signal in this session|  ${row}`;
  assert.deepEqual(lib.repeatedNotes([{ out: note }, { out: "" }, { out: note }]), [row]);
  assert.deepEqual(lib.repeatedNotes([{ out: note }, {}, { out: "ISY: 1 possible signal in this session|  known_gap  a.ts  other" }]), []);
});

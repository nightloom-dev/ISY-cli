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

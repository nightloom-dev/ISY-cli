import assert from "node:assert/strict";
import { test } from "node:test";
import { isNewer, updateCommand, updateNotice } from "../update.js";

test("a version is newer only when it really is", () => {
  assert.ok(isNewer("0.2.0", "0.1.0"));
  assert.ok(isNewer("0.1.1", "0.1.0"));
  assert.ok(isNewer("1.0.0", "0.9.9"));
  // Ten is not two, however it sorts as a string.
  assert.ok(isNewer("0.10.0", "0.9.0"));

  assert.ok(!isNewer("0.1.0", "0.1.0"));
  assert.ok(!isNewer("0.1.0", "0.2.0"));
  assert.ok(!isNewer(undefined, "0.1.0"));
  // Anything this comparison cannot read is left alone rather than guessed at.
  assert.ok(!isNewer("0.2.0-rc.1", "0.1.0"));
  assert.ok(!isNewer("nightly", "0.1.0"));
});

test("the command to run depends on how this client was installed", () => {
  assert.match(
    updateCommand("/home/dev/.nvm/versions/node/v22/lib/node_modules/isy/dist"),
    /npm install -g @nightloom\/isy/,
  );
  assert.match(updateCommand("/home/dev/src/isy/backend/client/dist"), /^git pull/);
});

test("a copy npx runs is updated through npx, never by installing one globally", () => {
  // npx runs a global copy ahead of its own, hooks included, and nothing updates
  // that one: told to make one, a user who only ever ran npx would stay behind.
  const command = updateCommand("/home/dev/.npm/_npx/835297a38386f6aa/node_modules/@nightloom/isy/dist");
  assert.equal(command, "npx @nightloom/isy --version");
  assert.doesNotMatch(command, /\s-g\b|install/);
});

test("the notice names both versions and stays silent when there is nothing to say", () => {
  const notice = updateNotice("0.2.0", "0.1.0");
  assert.match(notice ?? "", /^isy 0\.2\.0 is available \(you have 0\.1\.0\) — update: /);

  assert.equal(updateNotice("0.1.0", "0.1.0"), undefined);
});

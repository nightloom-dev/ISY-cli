import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYS, formatSettings, parseValue } from "../commands/settings.js";

test("values are read according to the key they belong to", () => {
  assert.deepEqual(parseValue("categories", "known_gap, unverified_fix"), [
    "known_gap",
    "unverified_fix",
  ]);
  // The word, not an empty argument: a shell would swallow the empty string.
  assert.deepEqual(parseValue("categories", "none"), []);
  assert.equal(parseValue("publish_confidence", "0.8"), 0.8);
  assert.equal(parseValue("disabled", "true"), true);

  assert.throws(() => parseValue("disabled", "yes"), /true or false/);
  assert.throws(() => parseValue("max_signals", "many"), /takes a number/);
});

test("an account with nothing set is told so, and told how to set something", () => {
  const out = formatSettings({});

  assert.match(out, /no personal settings/);
  for (const key of KEYS) assert.ok(out.includes(key), `${key} missing from the hint`);
});

test("settings print one per line, aligned, lists spelled out", () => {
  const out = formatSettings({
    publish_confidence: 0.8,
    categories: ["known_gap"],
    ignore_paths: [],
  });

  assert.match(out, /^categories {10}known_gap$/m);
  assert.match(out, /^ignore_paths {8}\(none\)$/m);
  assert.match(out, /^publish_confidence {2}0\.8$/m);
});

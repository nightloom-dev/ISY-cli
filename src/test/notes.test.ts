import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNotes } from "../commands/notes.js";
import type { NotesResponse } from "../api.js";

function response(overrides: Partial<NotesResponse> = {}): NotesResponse {
  return {
    repo: "acme/api",
    prNumber: 12,
    branch: "feat/retry",
    analysisId: "clxyz123",
    notes: [
      {
        label: "Never run after the change",
        severity: "high",
        confidence: 0.82,
        file: "backend/server/src/queue.ts",
        line: 118,
        prompt: "In backend/server/src/queue.ts around line 118: ISY flagged …",
      },
      {
        label: "Known gap",
        severity: "medium",
        confidence: 0.71,
        file: null,
        line: null,
        prompt: "In this pull request: ISY flagged …",
      },
    ],
    ...overrides,
  };
}

test("notes print as prompts under one header, separated so each is pasteable", () => {
  const out = formatNotes(response(), "https://isy.dev/");

  assert.match(out, /^acme\/api#12 · feat\/retry · 2 notes · https:\/\/isy\.dev\/r\/clxyz123\n/);
  assert.ok(out.includes("\n\n---\n\n"), "prompts run together without a separator");
  assert.ok(out.includes("around line 118") && out.includes("In this pull request"));
});

test("a clean pull request prints one line and no separator", () => {
  const out = formatNotes(response({ notes: [] }), "https://isy.dev");

  assert.equal(out, "acme/api#12 · feat/retry · no notes · https://isy.dev/r/clxyz123");
});

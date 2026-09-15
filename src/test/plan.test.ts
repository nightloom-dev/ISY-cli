import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlan, planNotice } from "../plan.js";

test("the notice appears only when there is nothing left to spend", () => {
  assert.equal(planNotice({ tier: "solo", analysesLeft: 3, credits: 0 }), undefined);
  // Credits are room: the gate spends them once the allowance is gone.
  assert.equal(planNotice({ tier: "solo", analysesLeft: 0, credits: 2 }), undefined);
  assert.equal(planNotice(undefined), undefined);

  const spent = planNotice({ tier: "free", analysesLeft: 0, credits: 0 });
  assert.match(spent ?? "", /plan limit reached on free/);
});

test("the notice names the day the allowance comes back", () => {
  const notice = planNotice({
    tier: "free",
    analysesLeft: 0,
    credits: 0,
    resetsAt: "2026-10-01T00:00:00.000Z",
  });
  assert.match(notice ?? "", /until 1 Oct/);

  // A server that sends a broken date still gets a usable line.
  const undated = planNotice({ tier: "free", analysesLeft: 0, credits: 0, resetsAt: "soon" });
  assert.match(undated ?? "", /not analysed\. Add credits/);
});

test("a plan block in any other shape is no plan block", () => {
  assert.equal(parsePlan(undefined), undefined);
  assert.equal(parsePlan({ tier: "solo" }), undefined);
  assert.equal(parsePlan({ tier: 1, analysesLeft: 1, credits: 1 }), undefined);
  assert.deepEqual(parsePlan({ tier: "solo", analysesLeft: 4, credits: 0, resetsAt: 7 }), {
    tier: "solo",
    analysesLeft: 4,
    credits: 0,
  });
});

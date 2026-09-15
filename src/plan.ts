/**
 * What the server said about the account's plan on the last upload, and the one
 * line it is worth printing.
 *
 * The CLI cannot see an analysis: a run starts when a pull request webhook
 * matches the session, minutes later or never. So the one thing it can
 * usefully say is that the next match will be refused — otherwise a plan that
 * ran out looks exactly like a pull request that has not arrived yet.
 */
export interface PlanStatus {
  tier: string;
  /** Paid analyses left in the cycle. Zero means the gate is closed. */
  analysesLeft: number;
  /** Bought analyses on top of the allowance, one credit each. */
  credits: number;
  /** ISO timestamp the cycle rolls over at. */
  resetsAt?: string;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Never throws: an older or newer server that sends something else has no plan block. */
export function parsePlan(value: unknown): PlanStatus | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.tier !== "string") return undefined;
  if (!isNumber(record.analysesLeft) || !isNumber(record.credits)) return undefined;
  return {
    tier: record.tier,
    analysesLeft: record.analysesLeft,
    credits: record.credits,
    ...(typeof record.resetsAt === "string" ? { resetsAt: record.resetsAt } : {}),
  };
}

/** "1 Oct" — enough to answer "when", short enough to sit in a one-line alert. */
function resetDay(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * The line, or nothing while there is still room. Credits count as room: they
 * are what the gate spends once the allowance is gone (`billing.ts:checkQuota`).
 */
export function planNotice(plan: PlanStatus | undefined): string | undefined {
  if (!plan || plan.analysesLeft > 0 || plan.credits > 0) return undefined;
  const day = resetDay(plan.resetsAt);
  return `plan limit reached on ${plan.tier} — pull requests are not analysed${
    day ? ` until ${day}` : ""
  }. Add credits or upgrade the plan.`;
}

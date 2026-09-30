/**
 * Subagent logs merged into their session's by time — the rule `subagents.ts`
 * applies to Claude Code's files as they stream, here for the Kimi readers,
 * which hold every log in memory already.
 *
 * A subagent's records go in when they happened, never ahead of the event that
 * started it: the detectors read order as time, and a subagent does not always
 * run inside its call. One started in the background works alongside the
 * session, and one resumed later goes on in the same log.
 */

/** An item and the moment it stands for, in epoch milliseconds. */
export interface Timed<T> {
  at: number;
  item: T;
}

/**
 * Each item's moment: its own, or — for one recorded without a time — the last
 * moment before it in the same log, and `from` for those ahead of any.
 */
export function stamped<T>(items: Iterable<T>, timeOf: (item: T) => number | undefined, from: number): Timed<T>[] {
  const out: Timed<T>[] = [];
  let at = from;
  for (const item of items) {
    at = timeOf(item) ?? at;
    out.push({ at, item });
  }
  return out;
}

/**
 * The bound a session's event puts on the subagents it started. A session that
 * has named no moment yet bounds nothing: a log without times puts a subagent
 * right after the event that started it, whole.
 */
export function boundOf(at: number): number {
  return at === -Infinity ? Infinity : at;
}

/** The logs a session has started, each waiting at its next item. */
export class Timelines<T> {
  private readonly heads: { items: Timed<T>[]; next: number }[] = [];

  add(items: Timed<T>[]): void {
    if (items.length > 0) this.heads.push({ items, next: 0 });
  }

  /**
   * Every item due by `at`, earliest first — on a tie, the log that started
   * first. A log added while this runs is read too.
   */
  *until(at: number): Generator<Timed<T>> {
    for (;;) {
      let earliest: { items: Timed<T>[]; next: number } | undefined;
      for (const head of this.heads) {
        const next = head.items[head.next]!;
        if (next.at <= at && (earliest === undefined || next.at < earliest.items[earliest.next]!.at)) earliest = head;
      }
      if (earliest === undefined) return;

      const next = earliest.items[earliest.next]!;
      earliest.next += 1;
      if (earliest.next >= earliest.items.length) this.heads.splice(this.heads.indexOf(earliest), 1);
      yield next;
    }
  }
}

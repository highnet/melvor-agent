/**
 * How blocked opportunities are ranked, and what gets dropped when there are
 * too many to show.
 *
 * The list was rendered with `slice(0, 12)` and no notion of importance, so
 * priority was concatenation order: a food-reserve countdown competed with
 * "Yew unlocks at level 60" on position alone, and the ordering had to be
 * maintained by hand at the one call site that built the array. That hand
 * ordering has already been rewritten twice — once to move Township task needs
 * above locked actions, once to move diagnostics above them as well — because
 * the only lever available was where a `push` happened to sit.
 *
 * Severity makes the intent explicit and local to whoever produces the entry,
 * which is the only place that knows whether a line is a countdown or a fact.
 */

/** Ordered most to least urgent; the array *is* the ranking. */
export const BLOCKED_SEVERITIES = ['critical', 'high', 'normal', 'low'] as const;

export type BlockedSeverity = (typeof BLOCKED_SEVERITIES)[number];

/** Position in {@link BLOCKED_SEVERITIES}; lower sorts first. */
export function severityRank(severity: BlockedSeverity | undefined): number {
  const index = BLOCKED_SEVERITIES.indexOf(severity ?? 'normal');
  return index === -1 ? BLOCKED_SEVERITIES.indexOf('normal') : index;
}

/**
 * Slots each tier is guaranteed before rate ranking may spend the rest.
 *
 * Reserved rather than a plain sort, because a plain sort has the same failure
 * as the concatenation it replaces, one level up: twenty `high` entries would
 * fill every slot and the `low` tier would vanish entirely — which is how
 * "this skill needs one more material" became indistinguishable from "this
 * skill does not exist". Breadth across tiers first, depth within them after.
 *
 * `critical` is deliberately not a quota. A countdown that ends the run is
 * never a candidate for being dropped, however many of them there are.
 */
const RESERVED: Record<Exclude<BlockedSeverity, 'critical'>, number> = {
  high: 4,
  normal: 4,
  low: 2,
};

export interface RankableBlocked {
  label: string;
  xpPerHour: number;
  severity?: BlockedSeverity;
}

/**
 * Chooses which blocked opportunities to show, and reports the rest.
 *
 * @param items - Every blocked opportunity the mod reported.
 * @param limit - How many to show, ignoring criticals, which are always shown.
 * @returns The entries to render and the entries that did not fit.
 */
export function selectBlocked<T extends RankableBlocked>(
  items: readonly T[],
  limit: number,
): { shown: T[]; dropped: T[] } {
  const ordered = [...items].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity) || b.xpPerHour - a.xpPerHour,
  );

  const shown: T[] = [];
  const rest: T[] = [];
  const quota = { ...RESERVED };

  for (const item of ordered) {
    const severity = item.severity ?? 'normal';
    if (severity === 'critical') {
      shown.push(item);
      continue;
    }
    if (quota[severity] > 0 && shown.length < limit) {
      quota[severity] -= 1;
      shown.push(item);
      continue;
    }
    rest.push(item);
  }

  // Whatever the reservations did not use is handed out by severity and rate,
  // so a quiet tier does not cost the list its slots.
  const dropped: T[] = [];
  for (const item of rest) {
    if (shown.length < limit) shown.push(item);
    else dropped.push(item);
  }

  return { shown, dropped };
}

/**
 * Says what was left out, by name.
 *
 * "...and 14 more" is not a diagnostic: it says a cut was made and nothing
 * about whether the cut removed a level-unlock trivia line or the one entry
 * naming the material that would have unblocked the next four hours. Naming
 * the first few and counting the remainder costs one line and makes the
 * omission checkable.
 *
 * @param dropped - Entries {@link selectBlocked} could not fit.
 * @param name - How many to name before falling back to a count.
 */
export function describeDropped(dropped: readonly RankableBlocked[], name = 3): string | null {
  if (dropped.length === 0) return null;

  const named = dropped.slice(0, name).map((item) => item.label);
  const remainder = dropped.length - named.length;

  return `...and ${dropped.length} not shown, most urgent of them first: ${named.join('; ')}${
    remainder > 0 ? `; and ${remainder} more` : ''
  }`;
}

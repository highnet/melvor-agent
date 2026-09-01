/**
 * Melvor's XP curve, in one place.
 *
 * The same arithmetic was written three times — sizing goal rungs, measuring
 * the control rate, and now choosing a stopgap — which is three chances for the
 * curve to drift apart from itself. It belongs in shared because every tier
 * needs it: the planner to plan, the mod to choose.
 */

/** Total XP required to reach a level. */
export function xpForLevel(level: number): number {
  let total = 0;
  for (let i = 1; i < level; i += 1) {
    total += Math.floor(i + 300 * 2 ** (i / 7));
  }
  return Math.floor(total / 4);
}

/** The level a given amount of XP reaches. The inverse of {@link xpForLevel}. */
export function levelForXp(xp: number): number {
  let points = 0;
  for (let level = 1; level < 120; level += 1) {
    points += Math.floor(level + 300 * 2 ** (level / 7));
    if (Math.floor(points / 4) > xp) return level;
  }
  return 120;
}

/**
 * Levels a skill would gain from an hour at a given XP rate.
 *
 * The unit conversion that matters. XP per hour is not comparable across
 * skills — 25,000 XP is most of a level at level 10 and a rounding error at
 * level 60 — so any choice made by comparing raw XP rates silently prefers
 * whatever skill is already highest. Levels per hour is the currency the
 * project's own metric is denominated in.
 *
 * Fractional on purpose: an action yielding a third of a level an hour must
 * still be comparable to one yielding a tenth, and rounding both to zero would
 * make them tie.
 */
export function levelsPerHour(currentXp: number, xpPerHour: number): number {
  if (xpPerHour <= 0) return 0;

  const current = levelForXp(currentXp);
  const projected = levelForXp(currentXp + xpPerHour);
  if (projected > current) return projected - current;

  // Still inside one level: report the fraction of it covered, so slow actions
  // on low skills still outrank slow actions on high ones.
  const span = xpForLevel(current + 1) - xpForLevel(current);
  return span <= 0 ? 0 : xpPerHour / span;
}

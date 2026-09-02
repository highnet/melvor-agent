import { type QualitySample, levelForXp } from '@melvor-agent/shared';

/**
 * The project's one quality metric.
 *
 * The brief asks a single question and refuses the comfortable ones: is this
 * better than leaving one skill running? Melvor already simulates 24 hours of
 * offline progress for a single action, so uptime proves nothing and "the agent
 * did 4,000 things" proves less. The only honest measure is progress per hour of
 * real time, compared against the control condition of doing nothing.
 *
 * Everything here is computed from samples the mod already records, so the
 * metric costs nothing to keep and cannot be gamed by the agent behaving
 * differently while measured.
 *
 * One caveat to read the number with: progress is counted in *total levels*,
 * and early levels in a fresh skill are far cheaper than late ones in a
 * developed skill. An agent that trains a new skill will therefore score well
 * against a control that keeps grinding a high one. That is a genuine advantage
 * of breadth rather than an artifact — it is the same reason Township tasks pay
 * for spreading out — but a ratio driven entirely by starting cheap skills is
 * measuring the curve as much as the agent, and should not be read as though
 * the agent were eight times better at the same work.
 */

/** What the agent achieved, per hour of wall clock, against the control. */
export interface ProgressReport {
  hours: number;
  totalLevelGained: number;
  gpGained: number;
  levelsPerHour: number;
  gpPerHour: number;
  /** What one skill left running would have produced over the same hours. */
  controlLevelsPerHour: number | null;
  /** Ratio against the control. Below 1 means the agent is not worth running. */
  timesBetterThanControl: number | null;
  detail: string;
}

/** Ignore windows shorter than this; the arithmetic is noise below it. */
const MIN_HOURS = 0.05;

/**
 * Below this many hours, report the rate but do not diagnose from it.
 *
 * The ratio is arithmetic and always honest. The *diagnosis* attached to a low
 * one — "something is wrong: check for refused objectives, an idle action slot,
 * or a plan that spends more time transitioning than acting" — is an inference,
 * and over six minutes it is usually wrong.
 *
 * A short window is dominated by whatever happened to be in it: one objective
 * transition, one reload, one fight that had not started yet. It said something
 * is wrong while the agent was fighting Golbins exactly as planned, and it said
 * it in the same words used for a genuinely stuck agent — which is how a real
 * warning gets ignored.
 *
 * Half an hour is roughly the point where a transition stops dominating.
 */
const MIN_DIAGNOSIS_HOURS = 0.5;

/**
 * Measures progress across the sample window.
 *
 * @param samples - Quality samples, oldest first.
 * @param controlLevelsPerHour - What the best single sustained action would
 *   yield if simply left running, in total levels per hour. Null when unknown,
 *   which is honest: an uncomparable number is better than an invented one.
 */
export function measureProgress(
  samples: readonly QualitySample[],
  controlLevelsPerHour: number | null,
): ProgressReport | null {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined || first === last) return null;

  const hours = (last.at - first.at) / 3_600_000;
  if (hours < MIN_HOURS) return null;

  const totalLevelGained = last.totalLevel - first.totalLevel;
  const gpGained = last.gp - first.gp;

  const levelsPerHour = totalLevelGained / hours;
  const gpPerHour = gpGained / hours;

  // GP is deliberately excluded from the comparison. Selling a bank the agent
  // spent yesterday filling shows up as enormous GP per hour and measures
  // nothing about the hour it was earned in.
  const timesBetterThanControl =
    controlLevelsPerHour !== null && controlLevelsPerHour > 0
      ? levelsPerHour / controlLevelsPerHour
      : null;

  return {
    hours,
    totalLevelGained,
    gpGained,
    levelsPerHour,
    gpPerHour,
    controlLevelsPerHour,
    timesBetterThanControl,
    detail: describe(hours, levelsPerHour, gpPerHour, timesBetterThanControl),
  };
}

function describe(
  hours: number,
  levelsPerHour: number,
  gpPerHour: number,
  timesBetterThanControl: number | null,
): string {
  const earned = gpPerHour > 0 ? ` and ${Math.round(gpPerHour).toLocaleString()} GP/hour` : '';
  const window = `${hours.toFixed(1)}h window, ${levelsPerHour.toFixed(2)} total levels/hour${earned}`;

  if (timesBetterThanControl === null) {
    return `${window}. No control rate available to compare against.`;
  }

  // Too short to infer anything from. The number still stands; the story does
  // not. See MIN_DIAGNOSIS_HOURS.
  if (hours < MIN_DIAGNOSIS_HOURS) {
    return `${window} — ${timesBetterThanControl.toFixed(2)}x the control, but this window is too short to read anything into: a single objective transition dominates it.`;
  }

  if (timesBetterThanControl < 1) {
    // Said plainly rather than softened: an agent that loses to a control it
    // can measure should be reported as losing. But losing on *levels* while
    // earning heavily is a trade, not a fault — Thieving at 55,000 GP an hour
    // scores 0.43x here and is still the right call when a 1,000,000 GP
    // purchase is the goal. The number stays honest; the diagnosis no longer
    // assumes a defect.
    const earning = gpPerHour > levelsPerHour * 1000;
    return earning
      ? `${window} — ${timesBetterThanControl.toFixed(2)}x the control on levels, but earning heavily. If the GP is for a specific purchase this is a deliberate trade; if not, something on the list pays better.`
      : `${window} — ${timesBetterThanControl.toFixed(2)}x the control condition, which means leaving one skill running would do better. Something is wrong: check for refused objectives, an idle action slot, or a plan that spends more time transitioning than acting.`;
  }

  return `${window} — ${timesBetterThanControl.toFixed(2)}x what leaving one skill running would achieve.`;
}

/**
 * The control rate: one skill left running, in total levels per hour.
 *
 * Derived from the best sustained candidate rather than a remembered number, so
 * the comparison tracks the character as it grows. It is deliberately generous
 * to the control — the single best action available, never an average — because
 * a metric that flatters the agent is worth nothing.
 *
 * @param candidates - Current candidates with measured XP rates.
 * @param skillXp - Current XP per skill, to convert XP into levels honestly.
 */
export function controlRate(
  candidates: readonly {
    kind: string;
    xpPerHour?: number | undefined;
    params: Readonly<Record<string, unknown>>;
  }[],
  skillXp: ReadonlyMap<string, number>,
): number | null {
  let best: { xpPerHour: number; skillId: string } | null = null;

  for (const candidate of candidates) {
    if (candidate.kind !== 'gather_resource') continue;
    const xpPerHour = candidate.xpPerHour ?? 0;
    const skillId = candidate.params.skillId;
    if (xpPerHour <= 0 || typeof skillId !== 'string') continue;
    if (best === null || xpPerHour > best.xpPerHour) best = { xpPerHour, skillId };
  }

  if (best === null) return null;

  const currentXp = skillXp.get(best.skillId) ?? 0;
  const currentLevel = levelForXp(currentXp);
  const projectedLevel = levelForXp(currentXp + best.xpPerHour);

  return projectedLevel - currentLevel;
}

/**
 * What the current activity is actually delivering, against what it claimed.
 *
 * Every rate error this session was found by hand: an operator noticed a number
 * looked wrong, and hours of work had already been planned around it. Crystal
 * advertised 120,000 GP/h and delivered about 10,800; Agility advertised 21
 * levels/h and delivered 6; Thieving advertised nothing at all and was worth
 * more than most of the board. In each case the service was already measuring
 * the truth and had no way to line it up against the claim.
 *
 * The comparison needs one skill's samples, not the whole window: total level
 * mixes every skill together, so a fast skill hides a slow one. Samples now
 * carry the skill that produced them, which makes the join possible.
 *
 * Returns null rather than a zero when there is too little to say. A confident
 * "0% of advertised" from two samples thirty seconds apart would be exactly the
 * kind of number this exists to catch.
 */
export function measureAgainstClaim(
  samples: readonly QualitySample[],
  skillId: string,
  advertisedXpPerHour: number | null,
  recipeId?: string,
): { realisedXpPerHour: number; ratio: number | null; hours: number } | null {
  // Recipe as well as skill, when one is known.
  //
  // Matching on skill alone compares a realised rate against whichever of that
  // skill's candidates is listed first. Live, that reported Mining Rune Essence
  // as "8% of the 111,429 xp/h advertised" when Rune Essence advertises about
  // 6,000: the measurement was correct and the claim it was held against
  // belonged to a different recipe. A comparison that indicts the wrong thing
  // is worse than none, because it invites a fix to something that is working.
  const matching = samples.filter(
    (sample) =>
      sample.activeSkillId === skillId &&
      sample.activeSkillXp !== undefined &&
      (recipeId === undefined ||
        sample.activeRecipeId === undefined ||
        sample.activeRecipeId === recipeId),
  );

  const first = matching[0];
  const last = matching[matching.length - 1];
  if (first === undefined || last === undefined || first === last) return null;

  const hours = (last.at - first.at) / 3_600_000;
  if (hours < MIN_CLAIM_HOURS) return null;

  const gained = (last.activeSkillXp ?? 0) - (first.activeSkillXp ?? 0);
  if (gained < 0) return null;

  const realisedXpPerHour = gained / hours;
  const ratio =
    advertisedXpPerHour !== null && advertisedXpPerHour > 0
      ? realisedXpPerHour / advertisedXpPerHour
      : null;

  return { realisedXpPerHour, ratio, hours };
}

/**
 * Minimum window before a realised rate is worth reporting.
 *
 * Short enough to catch an order-of-magnitude error within one objective, long
 * enough that a single slow action does not read as a broken model.
 */
const MIN_CLAIM_HOURS = 0.25;

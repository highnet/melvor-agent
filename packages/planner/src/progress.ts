import type { QualitySample } from '@melvor-agent/shared';

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
  const window =
    `${hours.toFixed(1)}h window, ${levelsPerHour.toFixed(2)} total levels/hour` +
    (gpPerHour > 0 ? ` and ${Math.round(gpPerHour).toLocaleString()} GP/hour` : '');

  if (timesBetterThanControl === null) {
    return `${window}. No control rate available to compare against.`;
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

/** Melvor's XP curve, inverted. Matches `xpForLevel` in the goals module. */
function levelForXp(xp: number): number {
  let points = 0;
  for (let level = 1; level < 120; level += 1) {
    points += Math.floor(level + 300 * 2 ** (level / 7));
    if (Math.floor(points / 4) > xp) return level;
  }
  return 120;
}

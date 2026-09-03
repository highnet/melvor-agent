import type { QualitySample } from '@melvor-agent/shared';

/**
 * The rolling window the project's one quality metric is computed over.
 *
 * The metric is progress per *real* hour, measured against the control
 * condition of one good skill left running and collected every 24h. There is
 * no speedup mod, so the window is the only way to see it: an hour of work
 * cannot be watched, it can only be sampled and differenced.
 *
 * Extracted from `agent.ts` because both the cap and the rate were arithmetic
 * over an array that nothing could reach -- the array was a private field, and
 * the getter that reads it sits on a class needing a live `game`. The two
 * off-by-one risks in it, the shift at the cap and the `first === last` guard,
 * were correspondingly untested.
 */

/** Samples retained; see the cap in {@link QualityWindow.add}. */
const WINDOW_SAMPLES = 2880;

/** Samples shipped with a report; the tail, not the archive. */
const REPORTED_SAMPLES = 120;

/**
 * Below this the window is too short for a rate to mean anything.
 *
 * Three minutes. Differencing two samples a few seconds apart divides a
 * rounding error by a very small number, which is how a flat run produces a
 * spectacular rate.
 */
const MIN_RATE_HOURS = 0.05;

export class QualityWindow {
  private samples: QualitySample[] = [];

  add(sample: QualitySample): void {
    this.samples.push(sample);
    // 48h of minute samples is plenty to compare a planner change against the
    // control condition of one skill left running.
    if (this.samples.length > WINDOW_SAMPLES) this.samples.shift();
  }

  /** The tail of the window, as shipped on a report. */
  recent(): QualitySample[] {
    return this.samples.slice(-REPORTED_SAMPLES);
  }

  /** How many samples are held; the window's own length, not the report's. */
  get length(): number {
    return this.samples.length;
  }

  /**
   * Levels and GP per hour across the sample window.
   *
   * The project's one metric, which until now lived only in the planner's
   * replies — visible when a session asked, invisible while the agent actually
   * ran. An operator watching the panel could see everything about the current
   * action and nothing about whether the last four hours were worth it.
   *
   * Deliberately not compared against the control here: the control rate needs
   * the candidate list, which the panel has no business recomputing on every
   * render. The raw rate is the honest half that is cheap.
   *
   * @returns Null while the window is too short to divide by.
   */
  get progressRate(): { hours: number; levelsPerHour: number; gpPerHour: number } | null {
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first === undefined || last === undefined || first === last) return null;

    const hours = (last.at - first.at) / 3_600_000;
    if (hours < MIN_RATE_HOURS) return null;

    return {
      hours,
      levelsPerHour: (last.totalLevel - first.totalLevel) / hours,
      gpPerHour: (last.gp - first.gp) / hours,
    };
  }
}

import { xpForLevel } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { planRung } from '../src/goals.js';

/**
 * Sizing a target level against the rate and the budget.
 *
 * `nextRung` was exported, imported and never called, so every target was a
 * guess sitting between the two failures its own doc comment describes: a rung
 * too far always ends in `abortMinutes` and records an abandonment, a rung too
 * near completes in minutes and spends the hour replanning.
 */

const AT_LEVEL_10 = xpForLevel(10);

describe('planRung', () => {
  it('lowers a target the budget cannot reach', () => {
    // Level 60 from level 10 is hundreds of thousands of XP; an hour at
    // 5,000 xp/h is not going to arrive, and the objective would have spent
    // the whole budget before aborting.
    const rung = planRung(10, AT_LEVEL_10, 60, 5_000, 60);

    expect(rung.fit).toBe('clamped');
    expect(rung.level).toBeLessThan(60);
    expect(rung.level).toBeGreaterThan(10);
  });

  it('always advances at least one level, even on a hopeless rate', () => {
    // A rung that does not move is not a rung: the objective completes on its
    // first tick without acting.
    const rung = planRung(10, AT_LEVEL_10, 60, 1, 60);

    expect(rung.level).toBe(11);
  });

  it('reports a target that finishes long before the budget', () => {
    const rung = planRung(10, AT_LEVEL_10, 11, 100_000, 120);

    expect(rung.fit).toBe('short');
    // Never raised. Grinding further than the caller asked is not a correction
    // to make on their behalf.
    expect(rung.level).toBe(11);
  });

  it('leaves a well-sized target alone', () => {
    // The rate is chosen so the budget lands almost exactly on the target.
    const xpNeeded = xpForLevel(20) - AT_LEVEL_10;
    const rung = planRung(10, AT_LEVEL_10, 20, xpNeeded, 60);

    expect(rung.fit).toBe('fits');
    expect(rung.level).toBe(20);
    expect(rung.estimatedMinutes).toBeCloseTo(60, 0);
  });

  it('projects nothing when the candidate advertises no rate', () => {
    // A one-shot action — buying, equipping — has no xp/h, and inventing a
    // projection for it would be arithmetic on a number nobody measured.
    const rung = planRung(10, AT_LEVEL_10, 20, 0, 60);

    expect(rung.level).toBe(20);
    expect(Number.isNaN(rung.estimatedMinutes)).toBe(true);
  });
});

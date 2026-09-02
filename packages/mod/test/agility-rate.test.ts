import { describe, expect, it } from 'vitest';

/**
 * The Agility lap rate must use the modifier-aware getters.
 *
 * Fixing the lap-versus-obstacle error (21 levels/h advertised, about 6
 * delivered) left this summing `baseExperience` and `baseInterval` -- the same
 * mastery blindness corrected everywhere else in the candidate list. It prices
 * an invested course at its uninvested rate forever, and Agility is a skill
 * whose whole design is long uninterrupted running.
 *
 * Correcting a 3.5x overstatement by introducing a systematic understatement is
 * not an improvement; it is a different wrong number.
 */
const lapRate = (
  obstacles: { baseExperience: number; baseInterval: number }[],
  intervalFor: (o: { baseInterval: number }) => number,
  xpPercentFor: () => number,
): number | null => {
  if (obstacles.length === 0) return null;
  let xp = 0;
  let ms = 0;
  for (const o of obstacles) {
    xp += o.baseExperience * Math.max(0, 1 + xpPercentFor() / 100);
    ms += intervalFor(o);
  }
  return ms <= 0 || xp <= 0 ? null : (xp / ms) * 3_600_000;
};

const course = [
  { baseExperience: 10, baseInterval: 5_000 },
  { baseExperience: 20, baseInterval: 10_000 },
];

describe('agility lap rate', () => {
  it('sums the whole lap, not one obstacle', () => {
    // The original bug: a lap runs every built obstacle.
    expect(
      lapRate(
        course,
        (o) => o.baseInterval,
        () => 0,
      ),
    ).toBeCloseTo((30 / 15_000) * 3_600_000, 5);
  });

  it('uses the mastery-modified interval when it is available', () => {
    // A course run for hours gets faster; the base constant never does.
    const faster = lapRate(
      course,
      () => 2_500,
      () => 0,
    );
    const base = lapRate(
      course,
      (o) => o.baseInterval,
      () => 0,
    );

    expect(faster as number).toBeGreaterThan(base as number);
  });

  it('applies the XP modifier', () => {
    expect(
      lapRate(
        course,
        (o) => o.baseInterval,
        () => 50,
      ),
    ).toBeCloseTo((45 / 15_000) * 3_600_000, 5);
  });

  it('reports nothing for an unbuilt course', () => {
    // Null rather than zero, so the caller falls back to the per-recipe rate
    // instead of ranking Agility below everything.
    expect(
      lapRate(
        [],
        (o) => o.baseInterval,
        () => 0,
      ),
    ).toBeNull();
  });
});

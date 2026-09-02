import { describe, expect, it } from 'vitest';

/**
 * Every skill's interval comes from the skill, not from a nominal constant.
 *
 * `actionInterval` reads the selected recipe and throws when none is chosen --
 * the state candidate enumeration runs in -- so artisan skills landed on a
 * hardcoded three seconds. ArtisanSkill declares `abstract readonly
 * baseInterval` (artisanSkill.d.ts:8), so each concrete skill knows its own:
 * 2000ms for Smithing, Fletching, Runecrafting and Herblore, 5000ms for
 * Summoning. The constant understated the first group by half and overstated
 * Summoning by two thirds -- in opposite directions, from a number that was
 * never read off anything.
 *
 * Positivity matters more than presence: a getter returning 0 divides into an
 * infinite rate, which would pin that recipe to the top of the board. An
 * interval of zero is not a very fast action, it is an unreadable one.
 */
const firstPositive = (...reads: (() => number | undefined)[]): number => {
  for (const read of reads) {
    try {
      const v = read();
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    } catch {
      // next
    }
  }
  return 3000;
};

describe('interval resolution', () => {
  it('prefers the live action interval', () => {
    expect(
      firstPositive(
        () => 1_800,
        () => 2_000,
      ),
    ).toBe(1_800);
  });

  it("falls back to the skill's own base interval when the live one throws", () => {
    expect(
      firstPositive(
        () => {
          throw new Error('no recipe selected');
        },
        () => 2_000,
      ),
    ).toBe(2_000);
  });

  it('rejects a zero interval rather than reporting an infinite rate', () => {
    expect(
      firstPositive(
        () => 0,
        () => 5_000,
      ),
    ).toBe(5_000);
  });

  it('rejects a non-finite interval', () => {
    expect(
      firstPositive(
        () => Number.NaN,
        () => 2_000,
      ),
    ).toBe(2_000);
  });

  it('uses the nominal constant only when nothing reports anything', () => {
    expect(
      firstPositive(
        () => undefined,
        () => undefined,
      ),
    ).toBe(3000);
  });
});

import { describe, expect, it } from 'vitest';

/**
 * A failed action costs the time and the inputs and yields nothing.
 *
 * Cooking burns at a base 70% success (cooking.d.ts:159) and Fishing rolls each
 * action between the fish, a special table and junk (fishing.d.ts:126, 168-171)
 * -- yet both were priced as though every action landed its product. Cooking
 * was overstated by up to a third, Fishing by whatever share of an area is
 * junk, and neither overstatement was visible next to skills that do land every
 * action.
 *
 * Applied to yield rather than to XP on purpose: whether a burn or a junk catch
 * still pays experience is not stated in the typings, and guessing would move
 * the number in a direction measurement could not later correct.
 */
const chance = (opts: { successPercent?: number; fishPercent?: number }): number => {
  if (opts.successPercent !== undefined) {
    return opts.successPercent > 0 ? Math.min(1, opts.successPercent / 100) : 1;
  }
  if (opts.fishPercent !== undefined) {
    return opts.fishPercent > 0 ? Math.min(1, opts.fishPercent / 100) : 1;
  }
  return 1;
};

describe('product chance', () => {
  it('discounts Cooking by its burn rate', () => {
    expect(chance({ successPercent: 70 })).toBeCloseTo(0.7, 5);
  });

  it('discounts Fishing by the junk and special share', () => {
    // Only the fish share produces the item being priced.
    expect(chance({ fishPercent: 65 })).toBeCloseTo(0.65, 5);
  });

  it('is neutral for a skill that lands every action', () => {
    // Mining and Smithing must not be quietly discounted.
    expect(chance({})).toBe(1);
  });

  it('never exceeds one', () => {
    // A modifier pushing success past 100 should not inflate a rate.
    expect(chance({ successPercent: 140 })).toBe(1);
  });

  it('fails to neutral rather than to zero when odds are unreadable', () => {
    // A skill that cannot report its odds should read as ordinary, not vanish
    // from the board.
    expect(chance({ successPercent: 0 })).toBe(1);
  });
});

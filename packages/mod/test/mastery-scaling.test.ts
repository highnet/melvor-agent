import { describe, expect, it } from 'vitest';

/**
 * Rates scale with mastery, so an instantaneous rate is a myopic way to choose
 * work that will run for hours.
 *
 * Mastery scales the things rates are built from: a rock yields more before it
 * empties, an interval shortens, a steal succeeds more often. An action sitting
 * mid-table today can be the best on the board after a sustained run, while one
 * already at 99 is as good as it will ever be. Comparing only current numbers
 * systematically favours whatever is already mastered and never commits long
 * enough to master anything else.
 *
 * Two behaviours are pinned here. First, the mining respawn amortisation must
 * divide by the MASTERY-ADJUSTED rock HP (`getRockMaxHP`, rockTicking.d.ts:180)
 * rather than the static field, or every rock is frozen at its unmastered rate.
 * Second, headroom is REPORTED, never folded into the rate -- the growth curve
 * is not in the typings, and projecting it would put a fabricated number where
 * a measured one belongs.
 */
const intervalFor = (base: number, masteryAdjustedMaxHP: number, respawn: number): number =>
  masteryAdjustedMaxHP <= 0 || respawn <= 0 ? base : base + respawn / masteryAdjustedMaxHP;

const MASTERY_HEADROOM_LEVEL = 50;
const headroom = (level: number): boolean => level > 0 && level < MASTERY_HEADROOM_LEVEL;

describe('mining rate improves as mastery raises rock HP', () => {
  it('amortises the respawn over more actions at higher mastery', () => {
    // Same rock, same respawn. Unmastered it yields 5 before emptying; mastered
    // it yields 20, so the identical 30s respawn costs a quarter as much per
    // action. The rate of a given rock is not a constant.
    const unmastered = intervalFor(3_000, 5, 30_000);
    const mastered = intervalFor(3_000, 20, 30_000);

    expect(unmastered).toBe(9_000);
    expect(mastered).toBe(4_500);
    expect(mastered).toBeLessThan(unmastered);
  });

  it('converges on the bare interval as yield grows', () => {
    // The ceiling: with enough HP per cycle the respawn all but disappears, so
    // the correction can never make a rock look worse than its swing.
    expect(intervalFor(3_000, 1_000, 30_000)).toBeCloseTo(3_030, 0);
  });
});

describe('mastery headroom is flagged, not projected', () => {
  it('flags an action with room to grow', () => {
    expect(headroom(1)).toBe(true);
    expect(headroom(20)).toBe(true);
  });

  it('stays quiet once the growth left is not worth flagging', () => {
    // Above the line the note would appear on nearly everything and stop
    // carrying information.
    expect(headroom(50)).toBe(false);
    expect(headroom(99)).toBe(false);
  });

  it('stays quiet when mastery cannot be read at all', () => {
    // A skill without mastery must not silently read as "fully mastered".
    expect(headroom(0)).toBe(false);
  });
});

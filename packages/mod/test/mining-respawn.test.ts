import { afterEach, describe, expect, it } from 'vitest';
import { miningIntervalFor } from '../src/adapter/candidates.js';
import { installFakeGame } from './fixtures.js';

/**
 * Mining rates must charge for the respawn, not just the swing.
 *
 * `MiningRock` carries `baseRespawnInterval` (rockTicking.d.ts:63-85): a rock
 * yields a number of actions, empties, and then pays nothing until it comes
 * back. Pricing only `baseInterval` per action prices the mining and leaves the
 * waiting free.
 *
 * Crystal advertised 120,000 GP/h on that basis and banked 81 ore in three
 * quarters of an hour -- roughly 10,800 GP/h. An afternoon of planning was
 * built on the inflated number.
 *
 * The real `miningIntervalFor` is imported here rather than mirrored. The
 * mirror this file used to hold divided by the static `rock.maxHP`, and stayed
 * green after the implementation moved to the mastery-adjusted
 * `game.mining.getRockMaxHP` -- a test pinning the behaviour the code had been
 * changed away from, which is the failure it existed to prevent.
 */
let uninstall = (): void => {};

/** A rock, with the two readings of its yield kept deliberately different. */
function rock(fields: {
  /** The static field. Nothing should read this; it is the trap. */
  maxHP?: number;
  /** What `getRockMaxHP` returns — mastery applied. */
  masteryMaxHP?: number;
  baseRespawnInterval?: number;
  hasPassiveRegen?: boolean;
}) {
  const value = {
    maxHP: fields.maxHP,
    baseRespawnInterval: fields.baseRespawnInterval,
    hasPassiveRegen: fields.hasPassiveRegen,
  };

  uninstall = installFakeGame({
    mining: {
      baseInterval: 3_000,
      getRockMaxHP: () => fields.masteryMaxHP ?? 0,
    },
  });

  return value as unknown as MiningRock;
}

afterEach(() => uninstall());

describe('mining interval includes respawn downtime', () => {
  it('amortises the respawn across the actions it interrupts', () => {
    // Ten actions then a 30s wait is 3s of waiting per action, on top of the
    // 3s swing: half the real time was previously invisible.
    expect(miningIntervalFor(rock({ masteryMaxHP: 10, baseRespawnInterval: 30_000 }))).toBe(6_000);
  });

  it('divides by the mastery-adjusted yield, never the static field', () => {
    // The drift this file was mirroring past. Mastery raises how much a rock
    // gives before it empties, so the same respawn is amortised over more
    // actions as mastery grows: the rate of a given rock is not a constant.
    // A reader taking `maxHP` would answer 6,000 here.
    expect(
      miningIntervalFor(rock({ maxHP: 10, masteryMaxHP: 20, baseRespawnInterval: 30_000 })),
    ).toBe(4_500);
  });

  it('still charges the respawn when the rock regenerates passively', () => {
    // This assertion used to expect the bare 3,000 -- "a rock that refills
    // while being mined never stops paying out". The dump settles it against
    // that reading: *every* rock in the game carries `hasPassiveRegen`, so the
    // exemption disabled the respawn correction entirely, and the rocks it
    // mattered most for have the least forgiving numbers. Mithril yields 6 ore
    // and waits 20 seconds; Crystal yields 66 and waits two minutes. Crystal
    // advertised 120,000 GP/h on the old reading and measured 10,800.
    //
    // Regen refills the rock over time, so the truth sits between the bare
    // swing and the full amortisation. The slower bound is used deliberately:
    // how much a regen tick restores is not stated in the typings, and
    // understating a rate is recoverable by measurement where overstating one
    // is not.
    expect(
      miningIntervalFor(
        rock({ masteryMaxHP: 10, baseRespawnInterval: 30_000, hasPassiveRegen: true }),
      ),
    ).toBe(6_000);
  });

  it('falls back to the bare interval when HP or respawn is unrecorded', () => {
    // The only safe guess. Inventing a downtime would understate rates as
    // badly as ignoring one overstates them.
    expect(miningIntervalFor(rock({}))).toBe(3_000);
    expect(miningIntervalFor(rock({ masteryMaxHP: 10 }))).toBe(3_000);
    expect(miningIntervalFor(rock({ baseRespawnInterval: 30_000 }))).toBe(3_000);
  });

  it('barely moves a rock whose respawn is short against its yield', () => {
    // Copper-shaped: plentiful HP, quick respawn. The correction should be
    // small here, which is why the old model looked right for so long.
    expect(miningIntervalFor(rock({ masteryMaxHP: 100, baseRespawnInterval: 5_000 }))).toBe(3_050);
  });
});

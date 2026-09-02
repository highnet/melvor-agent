import { describe, expect, it } from 'vitest';

/**
 * Mining rates must charge for the respawn, not just the swing.
 *
 * `MiningRock` carries `maxHP` and `baseRespawnInterval` (rockTicking.d.ts:63-85):
 * a rock yields `maxHP` actions, empties, and then pays nothing until it comes
 * back. Pricing only `baseInterval` per action prices the mining and leaves the
 * waiting free.
 *
 * Crystal advertised 120,000 GP/h on that basis and banked 81 ore in three
 * quarters of an hour -- roughly 10,800 GP/h. An afternoon of planning was
 * built on the inflated number.
 *
 * The predicate is mirrored here because the real one reads `game.mining`.
 */
const intervalFor = (
  base: number,
  rock: { maxHP?: number; baseRespawnInterval?: number; hasPassiveRegen?: boolean },
): number => {
  if (rock.hasPassiveRegen === true) return base;
  const actionsPerCycle = rock.maxHP ?? 0;
  const respawn = rock.baseRespawnInterval ?? 0;
  if (actionsPerCycle <= 0 || respawn <= 0) return base;
  return base + respawn / actionsPerCycle;
};

describe('mining interval includes respawn downtime', () => {
  it('amortises the respawn across the actions it interrupts', () => {
    // Ten actions then a 30s wait is 3s of waiting per action, on top of the
    // 3s swing: half the real time was previously invisible.
    expect(intervalFor(3_000, { maxHP: 10, baseRespawnInterval: 30_000 })).toBe(6_000);
  });

  it('charges only the swing when the rock regenerates passively', () => {
    // A rock that refills while being mined never stops paying out.
    expect(
      intervalFor(3_000, { maxHP: 10, baseRespawnInterval: 30_000, hasPassiveRegen: true }),
    ).toBe(3_000);
  });

  it('falls back to the bare interval when HP or respawn is unrecorded', () => {
    // The only safe guess. Inventing a downtime would understate rates as
    // badly as ignoring one overstates them.
    expect(intervalFor(3_000, {})).toBe(3_000);
    expect(intervalFor(3_000, { maxHP: 10 })).toBe(3_000);
    expect(intervalFor(3_000, { baseRespawnInterval: 30_000 })).toBe(3_000);
  });

  it('barely moves a rock whose respawn is short against its yield', () => {
    // Copper-shaped: plentiful HP, quick respawn. The correction should be
    // small here, which is why the old model looked right for so long.
    expect(intervalFor(3_000, { maxHP: 100, baseRespawnInterval: 5_000 })).toBe(3_050);
  });
});

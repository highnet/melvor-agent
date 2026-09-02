import { describe, expect, it } from 'vitest';

/**
 * Mining pays in gems as well as ore, and priced neither modifiers nor gems.
 *
 * Two omissions with one cause -- the rate was assembled from constants instead
 * of from the game's own accessors:
 *
 * - The interval was the raw `Mining.baseInterval` (rockTicking.d.ts:106),
 *   making Mining the only skill on the board whose rate ignored every interval
 *   modifier the character had bought. `modifyInterval` (skill.d.ts:426) takes
 *   the rock as an argument and so, unlike `actionInterval`, answers during
 *   enumeration.
 * - The gem roll was absent entirely. `getRockGemChance` (rockTicking.d.ts:154),
 *   `getRockSuperiorGemChance` (:155) and `chanceToDoubleGems` (:153) give the
 *   chances; `DropTable.getAverageDropValue` (utils.d.ts:458) gives the price,
 *   so nothing here is a representative gem picked by hand.
 *
 * The predicates are mirrored here because the real ones read `game.*`.
 */

const modifiedInterval = (
  skill: { modifyInterval?: (interval: number, action?: object) => number },
  base: number,
  action: object,
): number => {
  try {
    const modified = skill.modifyInterval?.(base, action);
    return typeof modified === 'number' && Number.isFinite(modified) && modified > 0
      ? modified
      : base;
  } catch {
    return base;
  }
};

const share = (read: () => number): number => {
  let percent = 0;
  try {
    percent = read();
  } catch {
    return 0;
  }
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(1, percent / 100);
};

interface Rock {
  giveGems?: boolean;
  giveSuperiorGems?: boolean;
}

interface MiningLike {
  chanceToDoubleGems?: number;
  getRockGemChance?: (rock: Rock) => number;
  getRockSuperiorGemChance?: (rock: Rock) => number;
}

const gemGpPerAction = (
  mining: MiningLike,
  rock: Rock,
  gemTableGp: number,
  superiorTableGp: number,
): number => {
  const doubling = 1 + Math.max(0, (mining.chanceToDoubleGems ?? 0) / 100);
  let gp = 0;
  if (rock.giveGems === true) {
    gp += share(() => mining.getRockGemChance?.(rock) ?? 0) * gemTableGp * doubling;
  }
  if (rock.giveSuperiorGems === true) {
    gp += share(() => mining.getRockSuperiorGemChance?.(rock) ?? 0) * superiorTableGp;
  }
  return Number.isFinite(gp) && gp > 0 ? gp : 0;
};

describe('mining interval applies the skill modifiers', () => {
  it('is no longer the raw base constant', () => {
    const faster = { modifyInterval: (interval: number) => interval * 0.85 };
    expect(modifiedInterval(faster, 3_000, {})).toBe(2_550);
  });

  it('falls back to the base rather than dropping the rock', () => {
    // An unmodified interval understates a mastered skill; no interval at all
    // removes Mining from the board, which is strictly worse.
    const throwing = {
      modifyInterval: () => {
        throw new Error('no rock selected');
      },
    };
    expect(modifiedInterval(throwing, 3_000, {})).toBe(3_000);
    expect(modifiedInterval({}, 3_000, {})).toBe(3_000);
  });

  it('refuses a modifier that returns zero', () => {
    expect(modifiedInterval({ modifyInterval: () => 0 }, 3_000, {})).toBe(3_000);
  });
});

describe('mining gem GP', () => {
  it('prices the ordinary gem roll from the table average', () => {
    // 5% of a 400 GP table average, no doubling: 20 GP an action.
    const mining = { chanceToDoubleGems: 0, getRockGemChance: () => 5 };
    expect(gemGpPerAction(mining, { giveGems: true }, 400, 5_000)).toBe(20);
  });

  it('scales the ordinary gem by the doubling chance', () => {
    const mining = { chanceToDoubleGems: 50, getRockGemChance: () => 5 };
    expect(gemGpPerAction(mining, { giveGems: true }, 400, 5_000)).toBe(30);
  });

  it('does not double superior gems, because the typings do not say it applies', () => {
    // Understating an unstated bonus is recoverable by measurement. Claiming it
    // is what made Crystal advertise an order of magnitude above what it paid.
    const mining = {
      chanceToDoubleGems: 100,
      getRockSuperiorGemChance: () => 1,
    };
    expect(gemGpPerAction(mining, { giveSuperiorGems: true }, 400, 5_000)).toBe(50);
  });

  it('pays nothing for a rock the game says gives no gems', () => {
    // Gated on `giveGems` rather than trusting the chance getter to return 0,
    // which is not stated. A gem credited to a rock that drops none is a
    // fabricated rate; a missed one is a measurable shortfall.
    const mining = { getRockGemChance: () => 5, getRockSuperiorGemChance: () => 1 };
    expect(gemGpPerAction(mining, {}, 400, 5_000)).toBe(0);
    expect(gemGpPerAction(mining, { giveGems: false }, 400, 5_000)).toBe(0);
  });

  it('adds both rolls for a rock that gives each', () => {
    const mining = {
      chanceToDoubleGems: 0,
      getRockGemChance: () => 5,
      getRockSuperiorGemChance: () => 1,
    };
    expect(gemGpPerAction(mining, { giveGems: true, giveSuperiorGems: true }, 400, 5_000)).toBe(70);
  });

  it('reads zero when a chance getter throws', () => {
    const mining = {
      getRockGemChance: () => {
        throw new Error('unreadable');
      },
    };
    expect(gemGpPerAction(mining, { giveGems: true }, 400, 5_000)).toBe(0);
  });

  it('clamps a chance above 100% rather than compounding it', () => {
    const mining = { chanceToDoubleGems: 0, getRockGemChance: () => 250 };
    expect(gemGpPerAction(mining, { giveGems: true }, 400, 5_000)).toBe(400);
  });
});

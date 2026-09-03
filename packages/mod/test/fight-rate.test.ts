import { afterEach, describe, expect, it } from 'vitest';
import { killValueFor } from '../src/adapter/pricing.js';
import { type FightRate, readFightRate } from '../src/adapter/rates.js';
import { resetAdapterFailures } from '../src/adapter/safe.js';
import { installFakeGame } from './fixtures.js';

/**
 * Fights were the only candidates on the board carrying no rate at all.
 *
 * Thieving priced itself completely -- "hits up to 3.2 (2% of current HP) --
 * 6,766 xp/h -- 4.00 levels/h -- 72,490 gp/h -- needs lvl 4" -- while a fight
 * offered drops and a combat level, so all sixty sorted identically and the
 * planner could not tell a level-1 Chicken from a level-27 Sweaty Monster. That
 * became the largest gap on the board the moment Auto Eat was bought, because
 * five of the remaining goals are combat-shaped.
 *
 * The real readers are imported rather than restated. A restatement agrees with
 * itself by construction: `mining-respawn.test.ts` mirrored the respawn
 * amortisation and kept passing for weeks after the implementation had
 * deliberately moved away from what it pinned.
 */

/** The live character at the time this was written, so the numbers are real. */
const PLAYER: { minHit: number; maxHit: number; attackInterval: number } = {
  minHit: 6,
  maxHit: 24,
  attackInterval: 3000,
};

/** Three monsters straight out of `data/dump.json`, unedited. */
const CHICKEN = { hitpoints: 3, defence: 1, name: 'Chicken' };
const STEEL_KNIGHT = { hitpoints: 15, defence: 10, name: 'Steel Knight' };
const HILL_GIANT = { hitpoints: 35, defence: 26, name: 'Hill Giant' };

interface MonsterSpec {
  hitpoints: number;
  defence: number;
  name: string;
}

function fakeMonster(spec: MonsterSpec): Monster {
  return {
    id: `melvorD:${spec.name.replace(' ', '')}`,
    name: spec.name,
    levels: { Hitpoints: spec.hitpoints, Defence: spec.defence },
  } as unknown as Monster;
}

/**
 * Installs a character and a spawn gap, and returns the uninstall.
 *
 * `spawnMs` is separate from the player stats because it is the term that makes
 * two monsters differ at all: without it every fight pays the same damage per
 * hour, since damage per hour is just the character's DPS.
 */
function withPlayer(
  overrides: Partial<typeof PLAYER> & { spawnMs?: number; multiplier?: number } = {},
): () => void {
  const stats = { ...PLAYER, ...overrides };
  const globals = globalThis as { numberMultiplier?: number | undefined };
  const previousMultiplier = globals.numberMultiplier;
  globals.numberMultiplier = overrides.multiplier ?? 10;

  const uninstall = installFakeGame({
    combat: {
      player: {
        stats,
        getMonsterSpawnTime: () => overrides.spawnMs ?? 3000,
        baseSpawnInterval: 3000,
      },
    },
  });

  return () => {
    uninstall();
    globals.numberMultiplier = previousMultiplier;
  };
}

function rate(spec: MonsterSpec, overrides: Parameters<typeof withPlayer>[0] = {}): FightRate {
  const uninstall = withPlayer(overrides);
  try {
    const measured = readFightRate(fakeMonster(spec));
    if (measured === null) throw new Error(`${spec.name} did not price`);
    return measured;
  } finally {
    uninstall();
  }
}

afterEach(() => {
  resetAdapterFailures();
});

describe('a fight prices itself', () => {
  it('converts a Hitpoints level into a health bar', () => {
    // Not stated in the typings -- `Monster` has levels and no hitpoints field
    // -- so it is settled by measurement: the live character reads Hitpoints 15
    // against a 150 bar, which is `numberMultiplier` exactly.
    expect(rate(STEEL_KNIGHT).hitpoints).toBe(150);
    expect(rate(CHICKEN).hitpoints).toBe(30);
    expect(rate(HILL_GIANT).hitpoints).toBe(350);
  });

  it('charges the spawn gap between kills', () => {
    // The mining-respawn lesson in a second skill. A Chicken is 30 HP at 15
    // damage every 3s, so six seconds of fighting -- and then three seconds of
    // standing still, which is half again on top.
    expect(rate(CHICKEN).secondsPerKill).toBeCloseTo(9, 5);
    expect(rate(CHICKEN, { spawnMs: 0 }).secondsPerKill).toBeCloseTo(6, 5);
  });
});

describe('two monsters of different difficulty price differently, and in order', () => {
  it('ranks the tougher monster higher on damage per hour', () => {
    // The point of the whole exercise. Combat XP is paid per point of damage
    // dealt (`rewardXPAndPetsForDamage`, player.d.ts:435), and the spawn gap is
    // a fixed cost per kill -- so a monster with more health amortises it
    // better and trains combat faster. Before this, all three were identical.
    const chicken = rate(CHICKEN).damagePerHour;
    const knight = rate(STEEL_KNIGHT).damagePerHour;
    const giant = rate(HILL_GIANT).damagePerHour;

    expect(chicken).toBeLessThan(knight);
    expect(knight).toBeLessThan(giant);
  });

  it('ranks the weaker monster higher on kills per hour', () => {
    // The opposite order, and both are true at once. Kills are what pay bones,
    // which is the only thing Prayer trains on -- so a planner chasing
    // `prayer-20` wants the Chicken and one chasing `hp-40` wants the Giant.
    // A single "which fight is best" number could not have said both.
    expect(rate(CHICKEN).killsPerHour).toBeGreaterThan(rate(HILL_GIANT).killsPerHour);
  });

  it('separates them by a margin no rounding could close', () => {
    // Sorting identically was the bug. Two rates that differ in the eighth
    // decimal would still sort by whatever order the registry happened to
    // return, so the assertion is about a gap, not about an inequality.
    const chicken = rate(CHICKEN).damagePerHour;
    const giant = rate(HILL_GIANT).damagePerHour;

    expect(giant / chicken).toBeGreaterThan(1.4);
  });

  it('orders them identically whatever the health multiplier turns out to be', () => {
    // `numberMultiplier` is one global scaling every monster's health, so being
    // wrong about it makes every kill rate uniformly wrong and reorders
    // nothing. That is the argument for settling it by measurement rather than
    // refusing to price fights at all, and it is worth pinning: a future reader
    // should not have to re-derive why an unstated constant was acceptable.
    const tenfold = rate(HILL_GIANT).damagePerHour / rate(CHICKEN).damagePerHour;
    const fourfold =
      rate(HILL_GIANT, { multiplier: 4 }).damagePerHour /
      rate(CHICKEN, { multiplier: 4 }).damagePerHour;

    expect(fourfold).toBeGreaterThan(1);
    expect(tenfold).toBeGreaterThan(1);
  });
});

describe('what a fight refuses to price', () => {
  it('returns nothing rather than a guess when the character cannot be read', () => {
    // A zero interval divides into an infinite kill rate, which would pin that
    // fight to the top of the board and keep it there. Zero is not a fast
    // character, it is an unread one -- the same reasoning as
    // `firstUsableInterval`.
    const uninstall = withPlayer({ attackInterval: 0 });
    try {
      expect(readFightRate(fakeMonster(STEEL_KNIGHT))).toBeNull();
    } finally {
      uninstall();
    }
  });

  it('returns nothing for a monster with no readable health', () => {
    const uninstall = withPlayer();
    try {
      expect(readFightRate(fakeMonster({ ...CHICKEN, hitpoints: 0 }))).toBeNull();
    } finally {
      uninstall();
    }
  });
});

/**
 * A kill's worth, and the accessor that must never be used to find it.
 *
 * `DropTable` offers `getDrop()` and `getRawDrop()` (utils.d.ts:541, 543), both
 * documented as rolling, alongside `getAverageDropValue()` (utils.d.ts:545),
 * documented as an average. Pricing an hour off either of the first two is the
 * `modifyPrimaryProductQuantity` bug again -- a sample read as an estimate,
 * which had the board advertising rates that flipped by a factor of two between
 * two readings with no game state moving.
 */
describe('what a kill is worth', () => {
  const gp = { id: 'melvorD:GP' };

  function fakeLootMonster(parts: {
    lootChance: number;
    average: number;
    bones?: { name: string; sellsFor: number; quantity: number };
    currency?: { min: number; max: number };
    rolled?: () => never;
  }): Monster {
    return {
      currencyDrops: parts.currency === undefined ? [] : [{ currency: gp, ...parts.currency }],
      lootChance: parts.lootChance,
      lootTable: {
        totalWeight: 1,
        drops: [],
        getAverageDropValue: () => ({ get: () => parts.average }),
        // Calling either of these is the bug this suite exists to prevent, so
        // the fake makes it fail loudly rather than merely produce noise.
        getDrop: () => {
          throw new Error('getDrop rolls; pricing must never call it');
        },
        getRawDrop: () => {
          throw new Error('getRawDrop rolls; pricing must never call it');
        },
      },
      bones:
        parts.bones === undefined
          ? undefined
          : {
              item: {
                name: parts.bones.name,
                sellsFor: { currency: gp, quantity: parts.bones.sellsFor },
              },
              quantity: parts.bones.quantity,
            },
    } as unknown as Monster;
  }

  function value(monster: Monster) {
    const uninstall = installFakeGame({ gp });
    try {
      return killValueFor(monster);
    } finally {
      uninstall();
    }
  }

  it('takes the average of a currency range rather than either end', () => {
    // `CurrencyDrop` is a range the game rolls (monsters.d.ts:12-16). The max
    // is what the wiki quotes and it is not what an hour pays.
    expect(
      value(fakeLootMonster({ lootChance: 0, average: 0, currency: { min: 1, max: 10 } }))
        .gpPerKill,
    ).toBe(5.5);
  });

  it('discounts the loot table by the chance it rolls at all', () => {
    // `lootChance` is the chance the table rolls, and the average is
    // conditional on it rolling. Reading the two as one produced "drops Garum
    // Seeds at 100% loot chance", which welded two true facts into a false one.
    expect(value(fakeLootMonster({ lootChance: 25, average: 400 })).lootGpPerKill).toBeCloseTo(
      100,
      5,
    );
  });

  it('never rolls the table to find out what it is worth', () => {
    // The fake throws from getDrop and getRawDrop, so this passing is the
    // assertion: an hour was not priced off one sample.
    expect(() => value(fakeLootMonster({ lootChance: 100, average: 12 }))).not.toThrow();
  });

  it('names the bones a kill always drops and prices them outside the table', () => {
    // Bones sit outside the loot table (monsters.d.ts:114), so they are not
    // discounted by lootChance -- a monster that has them drops them every
    // kill. Prayer has exactly one input and this is it.
    const priced = value(
      fakeLootMonster({
        lootChance: 0,
        average: 0,
        bones: { name: 'Big Bones', sellsFor: 7, quantity: 1 },
      }),
    );

    expect(priced.bones).toEqual({ name: 'Big Bones', quantity: 1 });
    expect(priced.lootGpPerKill).toBe(7);
  });

  it('says nothing about bones for a monster that drops none', () => {
    expect(value(fakeLootMonster({ lootChance: 0, average: 0 })).bones).toBeNull();
  });
});

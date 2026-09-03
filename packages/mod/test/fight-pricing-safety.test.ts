import type { CombatSkillLevels } from '@melvor-agent/shared';
import { combatLevelScreenInputsSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { readFightPricing } from '../src/adapter/combat.js';
import { screenByCombatSkillLevels } from '../src/policy/combat-gate.js';
import { installFakeGame } from './fixtures.js';

/**
 * A fight the gate refuses must stay refused, however well it prices.
 *
 * Pricing fights is the change that made every combat candidate comparable, and
 * the obvious way for it to go wrong is for a large, attractive number to
 * become a reason to take a fight that would kill the character. It has died
 * fifty-five times; the standing rule is that it may die but may not take
 * irreversible actions, and a rate is not a permit.
 *
 * The invariant is structural rather than a matter of ordering the calls
 * carefully: the two paths share nothing. The screen decides, the pricing
 * describes, and the pricing result has no field a caller could mistake for
 * permission. These tests pin all three halves of that.
 */

/** The live character: Attack 7, Strength 5, Defence 15, Hitpoints 15. */
const WEAK_PLAYER: CombatSkillLevels = {
  attack: 7,
  strength: 5,
  defence: 15,
  hitpoints: 15,
  ranged: 1,
  magic: 1,
};

/** Something well past what a character in the teens can stand up to. */
const OVERWHELMING: CombatSkillLevels = {
  attack: 90,
  strength: 95,
  defence: 90,
  hitpoints: 120,
  ranged: 1,
  magic: 1,
};

const MONSTER = {
  id: 'melvorD:SweatyMonster',
  name: 'Sweaty Monster',
  levels: { Hitpoints: OVERWHELMING.hitpoints, Defence: OVERWHELMING.defence },
  currencyDrops: [],
  lootChance: 0,
  lootTable: { totalWeight: 0, drops: [] },
} as unknown as Monster;

function priceIt() {
  const globals = globalThis as { numberMultiplier?: number | undefined };
  const previous = globals.numberMultiplier;
  globals.numberMultiplier = 10;

  const uninstall = installFakeGame({
    gp: { id: 'melvorD:GP' },
    monsters: { getObjectByID: (id: string) => (id === MONSTER.id ? MONSTER : undefined) },
    combat: {
      player: {
        stats: { minHit: 6, maxHit: 24, attackInterval: 3000 },
        getMonsterSpawnTime: () => 3000,
        baseSpawnInterval: 3000,
        getExperienceGainSkills: () => [{ name: 'Attack' }, { name: 'Hitpoints' }],
      },
    },
  });

  try {
    return readFightPricing(MONSTER.id);
  } finally {
    uninstall();
    globals.numberMultiplier = previous;
  }
}

describe('pricing a fight is not a route to taking it', () => {
  it('still refuses an outmatched monster', () => {
    // The screen is untouched by any of this and must go on saying no. A
    // 120-hitpoint monster is the most attractive thing on the board by damage
    // per hour, which is exactly why this test exists.
    const verdict = screenByCombatSkillLevels(
      combatLevelScreenInputsSchema.parse({
        targetId: MONSTER.id,
        targetName: 'Sweaty Monster',
        isDungeon: false,
        player: WEAK_PLAYER,
        playerDefenceBonus: 0,
        monsters: [{ name: 'Sweaty Monster', levels: OVERWHELMING, strengthBonus: 0 }],
        unreadableMonsters: [],
      }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.reason)).toContain('outmatched');
  });

  it('prices that same refused monster as the best fight on the board', () => {
    // Deliberately asserted, not merely tolerated. Pricing a refused fight is
    // what lets a blocked entry say how big the thing was as well as why it was
    // refused -- "could be one-shot" reads the same for a Chicken and for this,
    // and the scale is what tells a planner whether the answer is better gear
    // or a smaller target.
    const pricing = priceIt();

    expect(pricing).not.toBeNull();
    expect(pricing?.note).toContain('1,200 HP');
    expect(pricing?.note).toContain('damage/h into Attack and Hitpoints');
  });

  it('returns nothing a caller could read as permission', () => {
    // The structural half. A pricing result carries a description and a GP
    // rate, and no `available`, `safe` or `ok` that could be spread into a
    // candidate. If a future change adds one, this fails before the character
    // walks into the fight rather than after.
    const pricing = priceIt();

    expect(Object.keys(pricing ?? {}).sort()).toEqual(['gpPerHour', 'note']);
  });
});

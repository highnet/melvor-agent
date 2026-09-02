import type { CombatLevelScreenInputs, CombatSkillLevels } from '@melvor-agent/shared';
import { combatLevelScreenInputsSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { screenByCombatSkillLevels } from '../src/policy/combat-gate.js';

/**
 * The screen this replaces compared `Monster.combatLevel` with
 * `Game.playerCombatLevel` and required the monster to be at most half the
 * player. Those are different scales, and the arithmetic refused every dungeon
 * in the game to every possible character — while presenting itself as a safety
 * feature.
 *
 * So these tests are written from both ends. Half of them ask "does it refuse
 * what would kill this character"; the other half ask "does it permit what
 * plainly would not", because a gate that refuses everything is exactly as
 * useless as one that refuses nothing, and only the second kind of test catches
 * the first kind of failure.
 */

/** The live character at the time of writing: Attack 7, Strength 5, Defence 15, Hitpoints 15. */
const WEAK_PLAYER: CombatSkillLevels = {
  attack: 7,
  strength: 5,
  defence: 15,
  hitpoints: 15,
  ranged: 1,
  magic: 1,
};

function levels(overrides: Partial<CombatSkillLevels> = {}): CombatSkillLevels {
  return {
    attack: 1,
    strength: 1,
    defence: 1,
    hitpoints: 1,
    ranged: 1,
    magic: 1,
    ...overrides,
  };
}

function inputs(overrides: Partial<CombatLevelScreenInputs> = {}): CombatLevelScreenInputs {
  return combatLevelScreenInputsSchema.parse({
    targetId: 'melvorD:Chicken',
    targetName: 'Chicken',
    isDungeon: false,
    player: WEAK_PLAYER,
    playerDefenceBonus: 0,
    monsters: [{ name: 'Chicken', levels: levels(), strengthBonus: 0 }],
    unreadableMonsters: [],
    ...overrides,
  });
}

describe('screenByCombatSkillLevels — what it must permit', () => {
  it('permits a Chicken to a character with levels in the teens', () => {
    // The concrete regression: under the old screen a level-2 Chicken was
    // refused to a level-20 character. Refusing that is not caution, it is
    // noise, and noise is what makes a gate ignorable.
    const verdict = screenByCombatSkillLevels(inputs());

    expect(verdict.ok).toBe(true);
    expect(verdict.refusals).toEqual([]);
  });

  it('permits a fresh character its first fight', () => {
    // Defence 1, Hitpoints 10 — a new character. The ceiling floor of 1 exists
    // so this case cannot become impossible however the mean is computed.
    const verdict = screenByCombatSkillLevels(
      inputs({ player: levels({ hitpoints: 10, defence: 1 }) }),
    );

    expect(verdict.ok).toBe(true);
  });

  it('permits an uphill fight against a single monster, because the live check backs it up', () => {
    // Defence 15 / Hitpoints 15 gives a mean of 15 and a ceiling of 22.5 for a
    // single monster. A level-20 attacker is above the character and still
    // inside the allowance: `abandonIfOutmatched` reads the enemy's real max
    // hit a tick into the fight, so the screen does not have to be the last
    // word here.
    const verdict = screenByCombatSkillLevels(
      inputs({ monsters: [{ name: 'Bandit', levels: levels({ attack: 20 }), strengthBonus: 12 }] }),
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.workings.ceiling).toBeCloseTo(22.5);
  });
});

describe('screenByCombatSkillLevels — what it must refuse', () => {
  it('refuses a plainly lethal monster', () => {
    const verdict = screenByCombatSkillLevels(
      inputs({
        targetName: 'Red Dragon',
        monsters: [
          { name: 'Red Dragon', levels: levels({ attack: 90, strength: 90 }), strengthBonus: 90 },
        ],
      }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.reason)).toContain('outmatched');
    expect(verdict.detail).toContain('Red Dragon');
  });

  it('judges a dungeon by its worst inhabitant, not its first', () => {
    // Dying on floor nine costs exactly what dying on floor one costs, and the
    // entrance gives no sign of the boss.
    const verdict = screenByCombatSkillLevels(
      inputs({
        targetId: 'melvorD:Into_the_Abyss',
        targetName: 'Into the Abyss',
        isDungeon: true,
        monsters: [
          { name: 'Weak Thing', levels: levels(), strengthBonus: 0 },
          { name: 'Boss', levels: levels({ strength: 80 }), strengthBonus: 60 },
        ],
      }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.workings.hardestMonsterName).toBe('Boss');
    expect(verdict.workings.monsterOffensiveLevel).toBe(80);
  });

  it('refuses a monster whose levels could not be read, rather than assuming it is harmless', () => {
    // Zero sails through every comparison as "nothing to survive". One
    // unmeasurable inhabitant makes the whole target unmeasurable.
    const verdict = screenByCombatSkillLevels(
      inputs({
        isDungeon: true,
        monsters: [{ name: 'Chicken', levels: levels(), strengthBonus: 0 }],
        unreadableMonsters: ['melvorD:MummaChicken (TypeError)'],
      }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.reason)).toContain('unmeasurable');
  });

  it('refuses when the character itself did not read', () => {
    // All-zero player levels are a failed read, not a character. A real one
    // always has Hitpoints.
    const verdict = screenByCombatSkillLevels(
      inputs({ player: { ...levels(), defence: 0, hitpoints: 0 } }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.reason)).toContain('unmeasurable');
  });
});

describe('screenByCombatSkillLevels — a mid-tier dungeon at a plausible level', () => {
  /** A character with 60s across the board — mid-game, not maxed. */
  const midPlayer: CombatSkillLevels = {
    attack: 60,
    strength: 60,
    defence: 60,
    hitpoints: 60,
    ranged: 1,
    magic: 1,
  };

  it('permits a dungeon whose worst monster is at the character', () => {
    const verdict = screenByCombatSkillLevels(
      inputs({
        targetId: 'melvorD:Dragons_Den',
        targetName: "Dragon's Den",
        isDungeon: true,
        player: midPlayer,
        monsters: [
          {
            name: 'Green Dragon',
            levels: levels({ attack: 45, hitpoints: 70 }),
            strengthBonus: 30,
          },
          { name: 'Red Dragon', levels: levels({ attack: 58, hitpoints: 90 }), strengthBonus: 40 },
        ],
      }),
    );

    expect(verdict.ok).toBe(true);
    // Parity for a dungeon, not the 1.5 a single monster gets.
    expect(verdict.workings.allowance).toBe(1);
    expect(verdict.workings.ceiling).toBeCloseTo(60);
  });

  it('refuses the same dungeon one tier up', () => {
    const verdict = screenByCombatSkillLevels(
      inputs({
        targetName: 'Volcanic Cave',
        isDungeon: true,
        player: midPlayer,
        monsters: [{ name: 'Fire Spirit', levels: levels({ magic: 85 }), strengthBonus: 70 }],
      }),
    );

    expect(verdict.ok).toBe(false);
    expect(verdict.refusals.map((refusal) => refusal.reason)).toContain('outmatched');
  });

  it('holds a dungeon to a stricter allowance than the same monster met alone', () => {
    // The asymmetry has one cause: abandoning a dungeon partway restarts it, so
    // the mid-fight backstop that makes an uphill single fight recoverable
    // cannot rescue a dungeon.
    const monsters = [{ name: 'Boss', levels: levels({ attack: 75 }), strengthBonus: 40 }];

    expect(screenByCombatSkillLevels(inputs({ player: midPlayer, monsters })).ok).toBe(true);
    expect(
      screenByCombatSkillLevels(inputs({ player: midPlayer, monsters, isDungeon: true })).ok,
    ).toBe(false);
  });
});

describe('screenByCombatSkillLevels — reporting what it cannot see', () => {
  it('always states that it screened on levels alone', () => {
    // A permit from a heuristic is not a proof of safety. The old screen's
    // worst property was presenting a bare verdict as though it were one.
    const verdict = screenByCombatSkillLevels(inputs());

    expect(verdict.ok).toBe(true);
    expect(verdict.uncertainties.join(' ')).toContain('levels only');
    expect(verdict.detail).toContain('not proven survivable');
  });

  it('reports equipment bonuses without gating on them', () => {
    // Real numbers on comparable keys, with no threshold calibratable from the
    // typings or from data/dump.json — which captures neither monster levels
    // nor monster equipment stats. Reported, therefore, rather than enforced.
    const verdict = screenByCombatSkillLevels(
      inputs({
        playerDefenceBonus: -20,
        monsters: [{ name: 'Chicken', levels: levels(), strengthBonus: 300 }],
      }),
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.uncertainties.join(' ')).toContain('300');
    expect(verdict.uncertainties.join(' ')).toContain('-20');
  });

  it('flags a fight it may not be able to finish, without refusing it', () => {
    // The Golbin failure: Magic 2 against something that will not die. That
    // costs an hour, not a character, so it is a note and a counter to watch —
    // not a refusal invented from a threshold nobody can defend.
    const verdict = screenByCombatSkillLevels(
      inputs({
        monsters: [{ name: 'Golbin', levels: levels({ hitpoints: 200 }), strengthBonus: 0 }],
      }),
    );

    expect(verdict.ok).toBe(true);
    expect(verdict.uncertainties.join(' ')).toContain('possibly unwinnable');
  });

  it('says a dungeon has no mid-fight escape', () => {
    const verdict = screenByCombatSkillLevels(inputs({ isDungeon: true }));

    expect(verdict.ok).toBe(true);
    expect(verdict.uncertainties.join(' ')).toContain('abandoning restarts it');
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  type TriangleLike,
  describeMatchup,
  matchupFrom,
  readTriangleMatchup,
} from '../src/adapter/triangle.js';
import { installFakeGame } from './fixtures.js';

/**
 * The combat triangle, which nothing consulted while the character died 57 times.
 *
 * `CombatManager.combatTriangle` (combatManager.d.ts:100) has existed all run
 * and no code read it. These tests pin the two things that were genuinely at
 * risk of being got wrong: the *orientation* of the tables, which no `.d.ts`
 * states, and the rule that a note on every fight is the same as no note.
 *
 * The orientation was settled from the shipped v1.3.1 source rather than
 * guessed — `Character.applyTriangleToDamage` reads
 * `damageModifier[this.attackType][target.attackType]` — so the fixture below
 * is asymmetric on purpose. A table where `[magic][ranged]` and
 * `[ranged][magic]` differ is the only kind that can fail if the indices are
 * swapped, and a symmetric fixture would pass either way.
 */

const uninstalls: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
});

/**
 * The standard triangle's shape, with the two tables deliberately disagreeing.
 *
 * Melee beats ranged beats magic beats melee, which is the shipped standard
 * set. The reduction table is not the damage table: magic against melee is
 * 1.10 damage but 1.25 reduction, and magic against ranged is 0.85 on both.
 * That asymmetry is what makes `bestPlayerType` a real computation rather than
 * a lookup of the damage row.
 */
const STANDARD: TriangleLike = {
  damageModifier: {
    melee: { melee: 1, ranged: 1.1, magic: 0.85 },
    ranged: { melee: 0.85, ranged: 1, magic: 1.1 },
    magic: { melee: 1.1, ranged: 0.85, magic: 1 },
  },
  reductionModifier: {
    melee: { melee: 1, ranged: 1.25, magic: 0.75 },
    ranged: { melee: 0.95, ranged: 1, magic: 1.25 },
    magic: { melee: 1.25, ranged: 0.85, magic: 1 },
  },
};

describe('the triangle is read in the direction the game reads it', () => {
  it('prices a caster against a melee monster from the [player][target] cell', () => {
    // The live case the whole module exists for: twenty-three of this
    // character's thirty-two fight candidates are melee, and this is the
    // matchup its Magic is rewarded for.
    const matchup = matchupFrom(STANDARD, 'magic', 'melee', true);

    expect(matchup?.damageDealt).toBe(1.1);
    expect(matchup?.reduction).toBe(1.25);
  });

  it('does not read the transposed cell', () => {
    // Swapping the indices would return damageModifier.melee.magic = 0.85 and
    // reductionModifier.melee.magic = 0.75 — advice that is exactly backwards
    // on every fight, and indistinguishable from correct advice on a symmetric
    // table. This is the assertion the shipped source was dug out to write.
    const matchup = matchupFrom(STANDARD, 'magic', 'melee', true);

    expect(matchup?.damageDealt).not.toBe(0.85);
    expect(matchup?.reduction).not.toBe(0.75);
  });

  it('prices the same caster against a ranged monster as a penalty', () => {
    // Six candidates on the live list: four Bandit Trainees, a Ranged Golbin
    // and a Skeleton. Their kill rates read the same as the melee ones.
    const matchup = matchupFrom(STANDARD, 'magic', 'ranged', true);

    expect(matchup?.damageDealt).toBe(0.85);
    expect(matchup?.reduction).toBe(0.85);
  });
});

describe('the favoured style is computed from the table, not assumed', () => {
  it('names melee against a ranged target', () => {
    expect(matchupFrom(STANDARD, 'magic', 'ranged', true)?.bestPlayerType).toBe('melee');
  });

  it('names the style already in use when it is already the best', () => {
    // So the clause can stay silent about it. "Consider magic" to a caster
    // already casting is noise that reads as a criticism of a correct choice.
    expect(matchupFrom(STANDARD, 'magic', 'melee', true)?.bestPlayerType).toBe('magic');
  });

  it('follows an inverted table rather than the usual triangle', () => {
    // `InvertedHardcore` reverses the whole triangle (combatTriangle.d.ts:1),
    // and an area may override the set outright (combatAreas.d.ts:343). A
    // hardcoded "magic beats melee" would be silently wrong in both, which is
    // why nothing in this module is a constant.
    const inverted: TriangleLike = {
      damageModifier: {
        melee: { melee: 1, ranged: 0.85, magic: 1.1 },
        ranged: { melee: 1.1, ranged: 1, magic: 0.85 },
        magic: { melee: 0.85, ranged: 1.1, magic: 1 },
      },
      reductionModifier: {
        melee: { melee: 1, ranged: 0.95, magic: 1.25 },
        ranged: { melee: 1.25, ranged: 1, magic: 0.85 },
        magic: { melee: 0.75, ranged: 1.25, magic: 1 },
      },
    };

    const matchup = matchupFrom(inverted, 'magic', 'melee', true);

    expect(matchup?.damageDealt).toBe(0.85);
    expect(matchup?.bestPlayerType).toBe('ranged');
  });
});

describe('a triangle that cannot answer says nothing', () => {
  it('refuses a random-attacking monster rather than guessing a column', () => {
    // `Monster.attackType` is `AttackType | 'random'` (monsters.d.ts:106) and
    // the tables have three columns, not four. Three of the live candidates —
    // the Lair of the Spider Queen monsters — are random.
    expect(matchupFrom(STANDARD, 'magic', 'random', true)).toBeNull();
  });

  it('refuses a table with a missing row instead of defaulting to neutral', () => {
    // A silent 1 is indistinguishable from a genuinely neutral matchup, and
    // "this fight is neutral" is exactly the wrong thing to tell a caster about
    // an archer.
    const holed = { damageModifier: { magic: { melee: 1.1 } }, reductionModifier: {} };

    expect(matchupFrom(holed, 'magic', 'melee', true)).toBeNull();
  });

  it('refuses when there is no triangle at all', () => {
    expect(matchupFrom(undefined, 'magic', 'melee', true)).toBeNull();
  });
});

describe('the clause only appears when the triangle has something to say', () => {
  it('says nothing about a mirror matchup', () => {
    // Every fight candidate would otherwise gain a sentence, and a note on
    // every line is the same as no note — the failure the drops annotation was
    // written to avoid.
    expect(describeMatchup(matchupFrom(STANDARD, 'magic', 'magic', true))).toBe('');
  });

  it('says nothing when the matchup could not be priced', () => {
    expect(describeMatchup(null)).toBe('');
  });

  it('carries the numbers, not just a verdict', () => {
    // A figure that exists only as an adjective is invisible to anything that
    // has to weigh it against a kill rate. This repo has found that twice.
    const clause = describeMatchup(matchupFrom(STANDARD, 'magic', 'ranged', true));

    expect(clause).toContain('x0.85');
    expect(clause).toContain('UNFAVOURABLE');
  });

  it('names a better style only when it is not the one in use', () => {
    const bad = describeMatchup(matchupFrom(STANDARD, 'magic', 'ranged', true));
    const good = describeMatchup(matchupFrom(STANDARD, 'magic', 'melee', true));

    expect(bad).toContain('melee would be the favoured style');
    expect(good).not.toContain('would be the favoured style');
    expect(good).toContain('favourable');
  });

  it('warns when the area overrides the triangle', () => {
    // The shipped data carries a `Reversed` set, so this is a real area rather
    // than a hypothetical, and a planner reading the usual rules there would be
    // reasoning from a table that does not apply.
    const clause = describeMatchup(matchupFrom(STANDARD, 'magic', 'melee', false));

    expect(clause).toContain('overrides the usual combat triangle');
  });
});

/**
 * Installs enough of a game for the live reader.
 *
 * The area registries are the real three the adapter searches, in order, so a
 * dungeon id resolving through `game.dungeons` is exercised rather than
 * asserted about.
 */
function installGame(parts: {
  playerAttackType: string;
  monsters: Record<string, { attackType: string }>;
  areas?: Record<string, { combatTriangleSet: unknown; usesStandardCombatTriangle: boolean }>;
  combatTriangleType?: string;
  normalSet?: Record<string, TriangleLike>;
}): void {
  const registry = (entries: Record<string, unknown>) => ({
    getObjectByID: (id: string) => entries[id],
  });

  uninstalls.push(
    installFakeGame({
      currentGamemode: { combatTriangleType: parts.combatTriangleType ?? 'Standard' },
      normalCombatTriangleSet: parts.normalSet ?? { Standard: STANDARD },
      combat: { player: { attackType: parts.playerAttackType } },
      monsters: registry(parts.monsters),
      combatAreas: registry(parts.areas ?? {}),
      slayerAreas: registry({}),
      dungeons: registry({}),
    }),
  );
}

describe('reading the triangle out of a live game', () => {
  it('prices a real monster in a real area', () => {
    installGame({
      playerAttackType: 'magic',
      monsters: { 'melvorD:BanditTrainee': { attackType: 'ranged' } },
      areas: {
        'melvorF:Bandit_Hideout': {
          combatTriangleSet: undefined,
          usesStandardCombatTriangle: true,
        },
      },
    });

    const matchup = readTriangleMatchup('melvorD:BanditTrainee', 'melvorF:Bandit_Hideout');

    expect(matchup?.damageDealt).toBe(0.85);
    expect(matchup?.standardTriangle).toBe(true);
  });

  it('uses the area’s own set in preference to the default', () => {
    // This is the reason the module does not simply call
    // `game.combat.combatTriangle`: that getter reads the *selected* area, and
    // candidates are enumerated when nothing is selected. Asking it about a
    // prospective fight in an overriding area returns the wrong table silently.
    const reversed: TriangleLike = {
      damageModifier: { magic: { melee: 0.85, ranged: 1.1, magic: 1 } },
      reductionModifier: { magic: { melee: 0.75, ranged: 1.25, magic: 1 } },
    };

    installGame({
      playerAttackType: 'magic',
      monsters: { 'melvorD:Golbin': { attackType: 'melee' } },
      areas: {
        'melvorD:Golbin_Village': {
          combatTriangleSet: { Standard: reversed },
          usesStandardCombatTriangle: false,
        },
      },
    });

    const matchup = readTriangleMatchup('melvorD:Golbin', 'melvorD:Golbin_Village');

    expect(matchup?.damageDealt).toBe(0.85);
    expect(matchup?.standardTriangle).toBe(false);
  });

  it('follows the gamemode to a different table in the same set', () => {
    const inverted: TriangleLike = {
      damageModifier: { magic: { melee: 0.75, ranged: 1.1, magic: 1 } },
      reductionModifier: { magic: { melee: 0.5, ranged: 1.25, magic: 1 } },
    };

    installGame({
      playerAttackType: 'magic',
      monsters: { 'melvorD:Golbin': { attackType: 'melee' } },
      combatTriangleType: 'InvertedHardcore',
      normalSet: { Standard: STANDARD, InvertedHardcore: inverted },
    });

    expect(readTriangleMatchup('melvorD:Golbin', undefined)?.damageDealt).toBe(0.75);
  });

  it('returns nothing for a monster the registry does not hold', () => {
    installGame({ playerAttackType: 'magic', monsters: {} });

    expect(readTriangleMatchup('melvorD:NoSuchMonster', undefined)).toBeNull();
  });

  it('returns nothing when the player has no readable attack type', () => {
    // An empty weapon slot has no attack type at all, and a fabricated 'melee'
    // there would annotate every fight with advice about a weapon that is not
    // held.
    installGame({
      playerAttackType: '',
      monsters: { 'melvorD:Golbin': { attackType: 'melee' } },
    });

    expect(readTriangleMatchup('melvorD:Golbin', undefined)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

/**
 * Candidates from a locked realm must never be offered.
 *
 * Harvesting: Abyssal Vein was listed as available, advertising 1,855,200 xp/h
 * and "needs Abyssal lvl 1", while the knowledge dump reported
 * `melvorItA:Abyssal` as `unlocked: false` with "Complete Into the Abyss x1"
 * outstanding. Two orders of magnitude above everything else on the board and
 * completely unreachable: precisely the planner trap this codebase already
 * refuses elsewhere.
 *
 * The predicate is tested rather than the whole builder because the builder
 * needs a live `game`. `MasteryAction extends RealmedObject` (mastery2.d.ts:11)
 * carries `realm: Realm` (realms.d.ts:46), and `Realm.isUnlocked` is
 * realms.d.ts:23.
 */
const isRecipeRealmUnlocked = (recipe: {
  realm?: { id: string; isUnlocked: boolean };
}): boolean => {
  try {
    return recipe.realm?.isUnlocked ?? true;
  } catch {
    return true;
  }
};

describe('locked realms are not offered', () => {
  it('rejects a recipe whose realm is locked', () => {
    expect(isRecipeRealmUnlocked({ realm: { id: 'melvorItA:Abyssal', isUnlocked: false } })).toBe(
      false,
    );
  });

  it('accepts a recipe whose realm is open', () => {
    expect(isRecipeRealmUnlocked({ realm: { id: 'melvorD:Melvor', isUnlocked: true } })).toBe(true);
  });

  it('treats a recipe with no realm as open', () => {
    // Every base-game recipe predates realms; defaulting these to locked would
    // empty the board rather than trim it.
    expect(isRecipeRealmUnlocked({})).toBe(true);
  });

  it('treats a realm that throws as open', () => {
    const hostile = {
      get realm(): { id: string; isUnlocked: boolean } {
        throw new Error('no realm');
      },
    };
    expect(isRecipeRealmUnlocked(hostile)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { readActiveRecipeIds } from '../src/adapter/active.js';
import { installFakeGame } from './fixtures.js';

describe('readActiveRecipeIds for Alt Magic', () => {
  it('names the selected spell instead of reporting nothing selected', () => {
    // The regression this exists for: Alt Magic is registered under
    // `melvorD:Magic` and has no `activeRecipe`, so it used to fall to the
    // artisan default and return []. An empty answer means "not the one I
    // want", so the policy stopped and recast the spell every tick for zero XP.
    installFakeGame({
      activeAction: { id: 'melvorD:Magic' },
      altMagic: { selectedSpell: { id: 'melvorF:JustLearning' } },
    });

    expect(readActiveRecipeIds()).toEqual(['melvorF:JustLearning']);
  });

  it('reports nothing when no spell is selected', () => {
    installFakeGame({
      activeAction: { id: 'melvorD:Magic' },
      altMagic: { selectedSpell: undefined },
    });

    expect(readActiveRecipeIds()).toEqual([]);
  });

  it('does not throw when the selection getter refuses', () => {
    installFakeGame({
      activeAction: { id: 'melvorD:Magic' },
      altMagic: {
        get selectedSpell(): { id: string } {
          throw new Error('Tried to access active spell, but none is selected.');
        },
      },
    });

    expect(readActiveRecipeIds()).toEqual([]);
  });
});

/**
 * Combat, whose `activeAction.id` is not a skill id at all.
 *
 * The live failure: `combat.engage ok` and `combat.disengage ok` alternating
 * on the 3s policy clock, indefinitely, while the character took damage and
 * gained nothing. `melvorD:Combat` matched no case, fell to the artisan
 * default, looked up a skill that does not exist, and returned [] -- which the
 * caller reads as "not the one I want" and restarts.
 */
describe('readActiveRecipeIds for combat', () => {
  it('names the selected monster', () => {
    installFakeGame({
      activeAction: { id: 'melvorD:Combat' },
      combat: { selectedMonster: { id: 'melvorD:Leech' } },
    });

    expect(readActiveRecipeIds()).toEqual(['melvorD:Leech']);
  });

  it('reports nothing when no monster is selected', () => {
    installFakeGame({
      activeAction: { id: 'melvorD:Combat' },
      combat: { selectedMonster: undefined },
    });

    expect(readActiveRecipeIds()).toEqual([]);
  });

  it('does not throw when the selection getter refuses', () => {
    installFakeGame({
      activeAction: { id: 'melvorD:Combat' },
      combat: {
        get selectedMonster(): { id: string } {
          throw new Error('no monster is selected');
        },
      },
    });

    expect(readActiveRecipeIds()).toEqual([]);
  });
});

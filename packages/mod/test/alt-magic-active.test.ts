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

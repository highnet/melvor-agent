import { describe, expect, it } from 'vitest';

/**
 * Connecting "I need this item" to "this fight produces it".
 *
 * The pure rule, restated: the real reader consults the live monster registry.
 * What is pinned here is the decision — a fight is annotated only when it drops
 * something the agent is *already* short of, and a note on every monster is the
 * same as no note at all.
 */
function dropsOfInterest(loot: readonly string[], wanted: ReadonlySet<string>): string[] {
  return loot.filter((item) => wanted.has(item));
}

describe('monster drops the agent is short of', () => {
  const wanted = new Set(['melvorD:Potato_Seeds']);

  it('names the wanted drop so a fight reads as a means, not a risk', () => {
    // Without this, every fight candidate is "Fight X (area, combat level N)"
    // and the planner chooses by combat level — which measures danger, not
    // value. Farming was blocked on a seed while fights that drop it looked
    // identical to fights that do not.
    const loot = ['melvorD:Bones', 'melvorD:Potato_Seeds'];

    expect(dropsOfInterest(loot, wanted)).toEqual(['melvorD:Potato_Seeds']);
  });

  it('says nothing about a monster that drops nothing wanted', () => {
    expect(dropsOfInterest(['melvorD:Bones', 'melvorD:Raw_Beef'], wanted)).toEqual([]);
  });

  it('says nothing at all when the agent is short of nothing', () => {
    // A note attached to every fight is the same as no note.
    expect(dropsOfInterest(['melvorD:Potato_Seeds'], new Set())).toEqual([]);
  });
});

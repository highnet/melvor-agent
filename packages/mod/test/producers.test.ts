import { describe, expect, it } from 'vitest';

/**
 * A blocked entry should name what produces the input it is missing.
 *
 * The blocked list's stated purpose is that "the best move is often to produce
 * an input for something better" -- and it said what was missing without ever
 * saying what makes it. Turning "needs Iron Bar 0/5" into an action required a
 * human who happens to know that Smithing makes bars, which is precisely the
 * join a planner should not have to supply from memory.
 *
 * The answer is usually in a different skill: bars from Smithing for a
 * Fletching recipe, logs from Woodcutting for a Firemaking one. That
 * cross-skill hop is the entire content of a production chain.
 */
const describeProducers = (
  missing: { itemId: string; name: string }[],
  producerOf: (itemId: string) => string | null,
): string => {
  const named = missing
    .map((m) => {
      const p = producerOf(m.itemId);
      return p === null ? null : `${m.name} from ${p}`;
    })
    .filter((x): x is string => x !== null);

  return named.length === 0 ? '' : ` — ${named.join(', ')}`;
};

const producers: Record<string, string> = {
  'melvorD:Iron_Bar': 'Smithing: Iron Bar',
  'melvorD:Oak_Logs': 'Woodcutting: Oak Tree',
};
const lookup = (id: string): string | null => producers[id] ?? null;

describe('blocked entries name their producers', () => {
  it('names the recipe that makes a missing input', () => {
    expect(describeProducers([{ itemId: 'melvorD:Iron_Bar', name: 'Iron Bar' }], lookup)).toBe(
      ' — Iron Bar from Smithing: Iron Bar',
    );
  });

  it('names a producer in a different skill', () => {
    // The cross-skill hop is the whole point.
    expect(describeProducers([{ itemId: 'melvorD:Oak_Logs', name: 'Oak Logs' }], lookup)).toBe(
      ' — Oak Logs from Woodcutting: Oak Tree',
    );
  });

  it('names several producers at once', () => {
    expect(
      describeProducers(
        [
          { itemId: 'melvorD:Oak_Logs', name: 'Oak Logs' },
          { itemId: 'melvorD:Iron_Bar', name: 'Iron Bar' },
        ],
        lookup,
      ),
    ).toContain('Iron Bar from Smithing: Iron Bar');
  });

  it('stays silent when nothing produces the item', () => {
    // A monster drop or a shop purchase has no recipe, and inventing a producer
    // would be worse than leaving the entry as it was.
    expect(describeProducers([{ itemId: 'melvorD:Feathers', name: 'Feathers' }], lookup)).toBe('');
  });

  it('mentions only the inputs it can explain', () => {
    expect(
      describeProducers(
        [
          { itemId: 'melvorD:Feathers', name: 'Feathers' },
          { itemId: 'melvorD:Iron_Bar', name: 'Iron Bar' },
        ],
        lookup,
      ),
    ).toBe(' — Iron Bar from Smithing: Iron Bar');
  });
});

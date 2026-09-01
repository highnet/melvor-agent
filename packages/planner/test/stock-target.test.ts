import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * Objectives that finish on stock rather than on a level.
 *
 * `item_qty_at_least` has been in the objective contract, implemented in the
 * mod's criteria and rendered in the panel since early on, and nothing could
 * ever set one — `successFor` only ever emitted `skill_level_at_least`. So a
 * capability that existed everywhere except where it was needed.
 *
 * Township tasks are what makes it matter: they ask for stock — "give 250 Air
 * Rune", "give 100 Iron Arrows", "give 25 Beef" — and a level target is the
 * wrong shape. It either stops short of the count, leaving the task unmet, or
 * runs for hours past it. Township level gates the biome the last untrained
 * skill in scope sits behind, so these tasks are the critical path.
 */

function storeWith(candidate: { kind: string; params: Record<string, unknown>; label: string }) {
  const queued: unknown[] = [];
  return {
    queued,
    report: { snapshot: null, candidates: [candidate] },
    rememberShownCandidates() {},
    resolveChoice: (index: number) => ({ index, moved: false }),
    enqueue(command: unknown) {
      queued.push(command);
    },
  };
}

const CRAFT = {
  kind: 'gather_resource',
  params: {
    kind: 'gather_resource',
    skillId: 'melvorD:Runecrafting',
    recipeId: 'melvorD:Air_Rune',
  },
  label: 'Runecrafting: Air Rune',
};

describe('an objective that ends on a quantity', () => {
  it('completes on the item count when one is given', async () => {
    const store = storeWith(CRAFT);

    await TOOLS.set_objective!(
      {
        candidateIndex: 0,
        targetLevel: 15,
        abortMinutes: 60,
        untilItemId: 'melvorD:Air_Rune',
        untilQuantity: 250,
        rationale: 'the task wants 250',
      },
      { store } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: {
        successWhen: [{ type: 'item_qty_at_least', itemId: 'melvorD:Air_Rune', qty: 250 }],
      },
    });
  });

  it('still uses the level when no quantity is given', async () => {
    const store = storeWith(CRAFT);

    await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 15, abortMinutes: 60, rationale: 'level target' },
      { store } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: {
        successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Runecrafting', level: 15 }],
      },
    });
  });

  it('ignores a quantity target missing its item', async () => {
    // Half a target is not a target; falling back to the level is the honest
    // reading rather than inventing an item id.
    const store = storeWith(CRAFT);

    await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 15, abortMinutes: 60, untilQuantity: 250, rationale: 'x' },
      { store } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: { successWhen: [{ type: 'skill_level_at_least' }] },
    });
  });
});

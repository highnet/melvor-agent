import type { Candidate } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { chooseStopgap } from '../src/policy/stopgap.js';

const NOW = 1_700_000_000_000;

function gather(skillId: string, recipeId: string, xpPerHour: number): Candidate {
  return {
    kind: 'gather_resource',
    params: { kind: 'gather_resource', skillId, recipeId },
    label: `${skillId}: ${recipeId}`,
    xpPerHour,
    available: true,
  };
}

describe('stopgap', () => {
  it('runs the best sustained action rather than standing still', () => {
    const objective = chooseStopgap(
      [
        gather('melvorD:Fishing', 'melvorD:Raw_Shrimp', 3000),
        gather('melvorD:Woodcutting', 'melvorD:Willow', 15_840),
        gather('melvorD:Mining', 'melvorD:Copper', 8400),
      ],
      NOW,
    );

    expect(objective?.params).toMatchObject({ recipeId: 'melvorD:Willow' });
    expect(objective?.rationale).toMatch(/stopgap/i);
  });

  it('never spends anything', () => {
    // A stopgap makes no decisions, only progress. Buying or selling without a
    // planner is the greedy behaviour the whole architecture exists to avoid —
    // an unattended stopgap that bought things would spend the bank on
    // whatever happened to be cheapest.
    const objective = chooseStopgap(
      [
        {
          kind: 'buy_shop_upgrade',
          params: {
            kind: 'buy_shop_upgrade',
            purchaseId: 'melvorD:Black_Axe',
            quantity: 1,
            gpFloor: 0,
          },
          label: 'Buy Black Axe',
          available: true,
        },
        {
          kind: 'sell_items',
          params: { kind: 'sell_items', itemId: 'melvorD:Oak_Logs', keepQuantity: 0 },
          label: 'Sell Oak Logs',
          available: true,
        },
      ],
      NOW,
    );

    expect(objective).toBeNull();
  });

  it('carries a budget, so a real plan replaces it within the half hour', () => {
    const objective = chooseStopgap([gather('melvorD:Mining', 'melvorD:Copper', 8400)], NOW);

    expect(objective?.abortWhen.minutesExceed).toBe(30);
    // No success criterion: a stopgap is not trying to reach anything, and its
    // budget expiring is what triggers the next request for a real plan.
    expect(objective?.successWhen).toEqual([]);
  });

  it('returns null when there is nothing sustained to do', () => {
    expect(chooseStopgap([], NOW)).toBeNull();
  });
});

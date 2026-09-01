import type { Candidate } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { chooseStopgap } from '../src/policy/stopgap.js';

const NOW = 1_700_000_000_000;

/** Every skill untrained, so ranking falls back to raw rate differences. */
const FRESH = new Map<string, number>();

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
  it('ranks in levels per hour, not XP per hour', () => {
    // The live failure this fixes: ranking by XP picked Mahogany on a level-60
    // Woodcutting and scored 0.78x the control condition, losing to the very
    // thing the metric compares against — while Ranged and Magic sat at level
    // 1. Here Woodcutting is deep into the curve and Mining is untouched, so
    // the smaller XP rate is worth more levels.
    const developed = new Map([['melvorD:Woodcutting', 800_000]]);

    const objective = chooseStopgap(
      [
        gather('melvorD:Woodcutting', 'melvorD:Mahogany', 25_412),
        gather('melvorD:Mining', 'melvorD:Copper', 8400),
      ],
      developed,
      NOW,
    );

    expect(objective?.params).toMatchObject({ recipeId: 'melvorD:Copper' });
    expect(objective?.rationale).toMatch(/levels per hour/i);
  });

  it('runs the best sustained action rather than standing still', () => {
    const objective = chooseStopgap(
      [
        gather('melvorD:Fishing', 'melvorD:Raw_Shrimp', 3000),
        gather('melvorD:Woodcutting', 'melvorD:Willow', 15_840),
        gather('melvorD:Mining', 'melvorD:Copper', 8400),
      ],
      FRESH,
      NOW,
    );

    expect(objective?.params).toMatchObject({ recipeId: 'melvorD:Willow' });
    expect(objective?.rationale).toMatch(/stopgap/i);
  });

  it('prefers producing over consuming', () => {
    // Firemaking is almost always the highest-XP action available and it burns
    // logs. Unattended, that converts a bank the agent spent hours filling into
    // XP alone — the exact "cut trees and burn them" loop that is not a
    // strategy. A candidate that earns GP is producing something.
    const burning: Candidate = {
      kind: 'gather_resource',
      params: {
        kind: 'gather_resource',
        skillId: 'melvorD:Firemaking',
        recipeId: 'melvorD:Willow',
      },
      label: 'Firemaking: Willow Logs',
      xpPerHour: 96_000,
      available: true,
    };
    const cutting: Candidate = {
      ...gather('melvorD:Woodcutting', 'melvorD:Teak', 18_000),
      gpPerHour: 12_000,
    };

    const objective = chooseStopgap([burning, cutting], FRESH, NOW);

    expect(objective?.params).toMatchObject({ recipeId: 'melvorD:Teak' });
  });

  it('falls back to raw XP when nothing on offer earns anything', () => {
    const objective = chooseStopgap(
      [gather('melvorD:Firemaking', 'melvorD:Oak', 72_000)],
      FRESH,
      NOW,
    );
    expect(objective?.params).toMatchObject({ recipeId: 'melvorD:Oak' });
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
      FRESH,
      NOW,
    );

    expect(objective).toBeNull();
  });

  it('carries a budget, so a real plan replaces it within the half hour', () => {
    const objective = chooseStopgap([gather('melvorD:Mining', 'melvorD:Copper', 8400)], FRESH, NOW);

    expect(objective?.abortWhen.minutesExceed).toBe(30);
    // No success criterion: a stopgap is not trying to reach anything, and its
    // budget expiring is what triggers the next request for a real plan.
    expect(objective?.successWhen).toEqual([]);
  });

  it('returns null when there is nothing sustained to do', () => {
    expect(chooseStopgap([], FRESH, NOW)).toBeNull();
  });
});

describe('free actions', () => {
  it('claims a finished task before falling back to grinding', () => {
    // The rule "a stopgap makes no decisions" bends only where there is no
    // decision: claiming spends nothing and forfeits nothing.
    const objective = chooseStopgap(
      [
        gather('melvorD:Woodcutting', 'melvorD:Willow', 15_840),
        {
          kind: 'claim_township_task',
          params: { kind: 'claim_township_task', taskId: 'melvorF:Task_1' },
          label: 'Claim the Township task Task',
          available: true,
        },
      ],
      FRESH,
      NOW,
    );

    expect(objective?.kind).toBe('claim_township_task');
  });

  it('opens a container before falling back to grinding', () => {
    // Left alone, an unattended agent sat on sixteen bird nests while the seeds
    // inside were the one thing blocking Farming.
    const objective = chooseStopgap(
      [
        gather('melvorD:Woodcutting', 'melvorD:Willow', 15_840),
        {
          kind: 'open_item',
          params: { kind: 'open_item', itemId: 'melvorD:Bird_Nest', quantity: 16 },
          label: 'Open 16x Bird Nest',
          available: true,
        },
      ],
      FRESH,
      NOW,
    );

    expect(objective?.kind).toBe('open_item');
  });

  it('still refuses anything that spends', () => {
    // Buying, selling and equipping are judgements about what to give up, and a
    // scoring function making them unattended is the greedy behaviour this
    // design exists to refuse.
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
      ],
      FRESH,
      NOW,
    );

    expect(objective).toBeNull();
  });
});

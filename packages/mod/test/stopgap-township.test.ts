import type { Candidate } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { chooseStopgap } from '../src/policy/stopgap.js';

/**
 * The second half of the operator's rule: *otherwise do township tasks*.
 *
 * The stopgap only ever adopted gathering ranked by levels per hour, so nothing
 * built the town unattended — which matters because Township XP is what the
 * skilling outfits sit behind, and those are permanent multipliers on every
 * skill the run will spend the rest of its life training. The demand was
 * already on the candidates the whole time: `suggestedStock` carried the item,
 * the quantity and the derivation, and reached nothing but a label.
 *
 * Its own file rather than more cases in `stopgap.test.ts`, because every claim
 * here is about a candidate carrying a task demand and the fixtures for that
 * are a third of the file.
 */

const NOW = 1_700_000_000_000;

/** Every skill untrained, so ranking falls back to raw rate differences. */
const FRESH = new Map<string, number>();

function gather(
  skillId: string,
  recipeId: string,
  xpPerHour: number,
  gpPerHour: number,
): Candidate {
  return {
    kind: 'gather_resource',
    params: { kind: 'gather_resource', skillId, recipeId },
    label: `${skillId}: ${recipeId}`,
    xpPerHour,
    gpPerHour,
    available: true,
  };
}

/** A candidate annotated the way `annotateStockDemand` annotates it. */
function forTask(
  candidate: Candidate,
  itemId: string,
  name: string,
  quantity: number,
  have: number,
  perHour: number,
): Candidate {
  return {
    ...candidate,
    produces: { itemId, name, perHour },
    suggestedStock: {
      itemId,
      name,
      quantity,
      have,
      why: 'a Township task wants it',
      source: 'township_task',
    },
  };
}

/** The live pairing: fewer levels per hour than the tree, and what the town asked for. */
const FISH = forTask(
  gather('melvorD:Fishing', 'melvorD:Raw_Skeleton_Fish', 20_000, 70_255),
  'melvorD:Raw_Skeleton_Fish',
  'Raw Skeleton Fish',
  5_000,
  1_152,
  700,
);

const TREE = gather('melvorD:Woodcutting', 'melvorD:Yew', 45_000, 22_500);

describe('township tasks, when nobody is planning', () => {
  it('works the task instead of the higher rate', () => {
    expect(chooseStopgap([TREE, FISH], FRESH, NOW)?.params).toMatchObject({
      recipeId: 'melvorD:Raw_Skeleton_Fish',
    });
  });

  it('is unmoved by the order the candidates arrive in', () => {
    // Registry order has made "take the last match" accidentally correct in
    // this repo before, so the claim is made both ways round.
    expect(chooseStopgap([FISH, TREE], FRESH, NOW)?.params).toMatchObject({
      recipeId: 'melvorD:Raw_Skeleton_Fish',
    });
  });

  it("ends on the task's own count rather than on its budget", () => {
    const objective = chooseStopgap([TREE, FISH], FRESH, NOW);

    // The one stopgap that can finish by achieving something. The criterion is
    // also what reserves the fish from the liquidation reflex, via
    // `stockTargetsOf` — an objective may not have its own target sold out from
    // under it.
    expect(objective?.successWhen).toEqual([
      { type: 'item_qty_at_least', itemId: 'melvorD:Raw_Skeleton_Fish', qty: 5_000 },
    ]);
    expect(objective?.abortWhen.minutesExceed).toBe(30);
  });

  it('takes the task nearest to done, in hours of work left', () => {
    // 3,848 fish at 700/h is about five and a half hours; 90 bones at 10/h is
    // nine. Finishing a task pays; being a third of the way through two pays
    // nothing. Units remaining alone would have picked the bones.
    const BONES = forTask(
      gather('melvorD:Mining', 'melvorD:Bones', 30_000, 5_000),
      'melvorD:Bones',
      'Bones',
      100,
      10,
      10,
    );

    expect(chooseStopgap([BONES, FISH], FRESH, NOW)?.params).toMatchObject({
      recipeId: 'melvorD:Raw_Skeleton_Fish',
    });
    expect(chooseStopgap([FISH, BONES], FRESH, NOW)?.params).toMatchObject({
      recipeId: 'melvorD:Raw_Skeleton_Fish',
    });
  });

  it("ignores a recipe input shortfall, which is a planner's chain", () => {
    // "A blocked recipe wants an hour of Earth Runes" is a production chain
    // whose consumer a planner chose. The stopgap did not choose it and cannot
    // know the consumer is still wanted, so it stays on the rate.
    const RUNES: Candidate = {
      ...gather('melvorD:Runecrafting', 'melvorD:Earth_Rune', 12_000, 4_000),
      produces: { itemId: 'melvorD:Earth_Rune', name: 'Earth Rune', perHour: 5_400 },
      suggestedStock: {
        itemId: 'melvorD:Earth_Rune',
        name: 'Earth Rune',
        quantity: 5_400,
        have: 0,
        why: 'Superheat consumes 3 per action',
        source: 'recipe_input',
      },
    };

    expect(chooseStopgap([RUNES, TREE], FRESH, NOW)?.params).toMatchObject({
      recipeId: 'melvorD:Yew',
    });
  });

  it('stays on the rate when the task candidate cannot price its own output', () => {
    // The ranking is in hours, and a candidate with no `produces.perHour`
    // cannot say how long its task would take. Ranking it by units left instead
    // would compare across two different units — the shape that had a mining
    // rate advertising 120,000 GP/h against a realised 10,800.
    const UNPRICED: Candidate = {
      ...gather('melvorD:Fishing', 'melvorD:Raw_Seahorse', 20_000, 30_000),
      suggestedStock: {
        itemId: 'melvorD:Raw_Seahorse',
        name: 'Raw Seahorse',
        quantity: 5_000,
        have: 11,
        why: 'a Township task wants it',
        source: 'township_task',
      },
    };

    expect(chooseStopgap([UNPRICED, TREE], FRESH, NOW)?.params).toMatchObject({
      recipeId: 'melvorD:Yew',
    });
  });

  it('still refuses a task whose inputs cannot fill the half hour', () => {
    // The pool's guards are not widened by this; the task is chosen from within
    // them. A three-second craft is not a stopgap however much the town wants
    // it — that is the Smoke Rune failure, wearing a task's clothes.
    const SHORT: Candidate = {
      ...forTask(
        gather('melvorD:Runecrafting', 'melvorF:Smoke_Rune', 60_000, 9_000),
        'melvorF:Smoke_Rune',
        'Smoke Rune',
        250,
        0,
        1_800,
      ),
      sustainMinutes: 0.05,
    };

    expect(chooseStopgap([SHORT, TREE], FRESH, NOW)?.params).toMatchObject({
      recipeId: 'melvorD:Yew',
    });
  });

  it('still claims a finished task before starting a new one', () => {
    // The free branch runs first and must keep running first: claiming spends
    // nothing, and a claimed task is the one that actually pays.
    const claim: Candidate = {
      kind: 'claim_township_task',
      params: { kind: 'claim_township_task', taskId: 'melvorD:Task_1' },
      label: 'Claim a finished Township task',
      available: true,
    };

    expect(chooseStopgap([FISH, claim], FRESH, NOW)?.kind).toBe('claim_township_task');
  });
});

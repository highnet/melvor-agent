import type { Candidate, StateSnapshot } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * Steps that are already satisfied when they are queued.
 *
 * Observed twice, and reported by the operator as "we are skipping through the
 * steps without doing them". A three-step plan asked for Cooking 44 and Fishing
 * 40 while Cooking was already 44 and Fishing 42 — the levels had risen since
 * the listing those targets were read off. Both steps completed on their first
 * tick, the plan drained in nine seconds, and the agent fell through to a
 * stopgap it could not afford either.
 *
 * `rungFor` had the signal and did not use it: it projected "~0min" and called
 * that "a short rung". A target at or below the current level is not a short
 * rung, it is a no-op.
 */

/** No goals file, so no funding target is read; the tests are about criteria. */
const CTX = { memoryRoot: 'test-fixture-with-no-goals-file' };

const COOK = {
  kind: 'gather_resource',
  params: { kind: 'gather_resource', skillId: 'melvorD:Cooking', recipeId: 'melvorAoD:Halibut' },
  label: 'Cooking: Halibut',
  xpPerHour: 30_000,
  available: true,
} satisfies Candidate;

const FISH = {
  kind: 'gather_resource',
  params: { kind: 'gather_resource', skillId: 'melvorD:Fishing', recipeId: 'melvorD:Raw_Seahorse' },
  label: 'Fishing: Raw Seahorse',
  xpPerHour: 40_000,
  available: true,
} satisfies Candidate;

/** The live reading: Cooking 44 and Fishing 42, both past what was asked for. */
const SNAPSHOT = {
  capturedAt: 0,
  gameVersion: 'v1.3.1',
  characterName: 'Agent',
  gamemodeId: 'melvorD:Standard',
  currentRealmId: 'melvorD:Melvor',
  isOfflineLoop: false,
  totalLevel: 596,
  completionPercent: 4.2,
  currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 149_077 }],
  skills: [
    { id: 'melvorD:Cooking', name: 'Cooking', level: 44, xp: 60_405, isActive: false },
    { id: 'melvorD:Fishing', name: 'Fishing', level: 42, xp: 48_026, isActive: true },
  ],
  bank: {
    slotsUsed: 2,
    slotsMax: 40,
    items: [{ id: 'melvorD:Raw_Seahorse', name: 'Raw Seahorse', qty: 300 }],
  },
  activeAction: null,
  combat: { hitpoints: 150, maxHitpoints: 150, autoEatThreshold: 0 },
} as unknown as StateSnapshot;

function storeWith(candidates: Candidate[]) {
  const queued: unknown[] = [];
  return {
    queued,
    report: { snapshot: SNAPSHOT, candidates },
    rememberShownCandidates() {},
    resolveChoice: (index: number) => ({ index, moved: false }),
    enqueue(command: unknown) {
      queued.push(command);
    },
  };
}

describe('set_plan', () => {
  it('refuses a step whose level target the character has already passed', async () => {
    const store = storeWith([COOK, FISH]);

    const text = await TOOLS.set_plan!(
      {
        steps: [
          { candidateIndex: 0, targetLevel: 44, abortMinutes: 30, rationale: 'cook to 44' },
          { candidateIndex: 1, targetLevel: 40, abortMinutes: 30, rationale: 'fish to 40' },
        ],
      },
      { store, ...CTX } as never,
    );

    expect(text).toContain('Refused');
    // The current level, so the retry is a decision rather than a second guess
    // made from the same stale listing that produced the first one.
    expect(text).toContain('Cooking is already level 44');
    expect(store.queued).toHaveLength(0);
  });

  it('refuses a later step too, not only the one that starts first', async () => {
    // Step one is real work; the drain came from step two and step three.
    const store = storeWith([COOK, FISH]);

    const text = await TOOLS.set_plan!(
      {
        steps: [
          { candidateIndex: 0, targetLevel: 50, abortMinutes: 30, rationale: 'cook to 50' },
          { candidateIndex: 1, targetLevel: 40, abortMinutes: 30, rationale: 'fish to 40' },
        ],
      },
      { store, ...CTX } as never,
    );

    expect(text).toContain('step 2');
    expect(text).toContain('Fishing is already level 42');
    expect(store.queued).toHaveLength(0);
  });

  it('queues a plan whose targets are all still ahead', async () => {
    const store = storeWith([COOK, FISH]);

    const text = await TOOLS.set_plan!(
      {
        steps: [
          // Within the budget at the advertised rate, so `rungFor` leaves it
          // alone and the queued criterion is the one that was asked for.
          { candidateIndex: 0, targetLevel: 45, abortMinutes: 30, rationale: 'cook to 45' },
          { candidateIndex: 1, targetLevel: 46, abortMinutes: 45, rationale: 'fish to 46' },
        ],
      },
      { store, ...CTX } as never,
    );

    expect(text).toContain('Queued a plan of 2 objectives');
    expect(store.queued).toMatchObject([
      {
        type: 'set_plan',
        objectives: [
          {
            successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Cooking', level: 45 }],
          },
          {
            successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Fishing', level: 46 }],
          },
        ],
      },
    ]);
  });

  it('lets a later step keep a stock target the bank already satisfies', async () => {
    // The case the check must not break, and the tool's own headline example:
    // "mine 200 Gold Ore, then smelt". A step behind another step is judged
    // against a character that has since done the work in front of it, and a
    // stock target met today is real work once the step before it has spent the
    // stock. Only levels are decidable that far ahead.
    const store = storeWith([COOK, FISH]);

    const text = await TOOLS.set_plan!(
      {
        steps: [
          { candidateIndex: 0, targetLevel: 50, abortMinutes: 30, rationale: 'cook the fish' },
          {
            candidateIndex: 1,
            targetLevel: 50,
            abortMinutes: 45,
            untilItemId: 'melvorD:Raw_Seahorse',
            untilQuantity: 100,
            rationale: 'restock the raw fish the cook just spent',
          },
        ],
      },
      { store, ...CTX } as never,
    );

    expect(text).toContain('Queued a plan of 2 objectives');
    expect(store.queued).toMatchObject([
      {
        objectives: [
          {},
          {
            successWhen: [{ type: 'item_qty_at_least', itemId: 'melvorD:Raw_Seahorse', qty: 100 }],
          },
        ],
      },
    ]);
  });

  it('refuses a first step whose stock target the bank already holds', async () => {
    // The first step replaces whatever is running the moment the mod reports,
    // so nothing can consume the stock in between: there is no later state for
    // it to be judged against, and "already satisfied" is final.
    const store = storeWith([FISH]);

    const text = await TOOLS.set_plan!(
      {
        steps: [
          {
            candidateIndex: 0,
            targetLevel: 50,
            abortMinutes: 45,
            untilItemId: 'melvorD:Raw_Seahorse',
            untilQuantity: 100,
            rationale: 'fish until 100 seahorse',
          },
          { candidateIndex: 0, targetLevel: 50, abortMinutes: 45, rationale: 'then to 50' },
        ],
      },
      { store, ...CTX } as never,
    );

    expect(text).toContain('Refused: step 1');
    expect(text).toContain('already holds 300x Raw Seahorse');
    expect(store.queued).toHaveLength(0);
  });
});

describe('set_objective', () => {
  it('refuses a level target that is already met', async () => {
    const store = storeWith([COOK]);

    const text = await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 44, abortMinutes: 30, rationale: 'cook to 44' },
      { store, ...CTX } as never,
    );

    expect(text).toContain('Refused');
    expect(text).toContain('Cooking is already level 44');
    expect(store.queued).toHaveLength(0);
  });

  it('refuses a stock target the bank already satisfies', async () => {
    // This one used to slip through: a quantity target skipped the level check
    // entirely, so an objective to fish "until 100 Raw Seahorse" with 300 in the
    // bank was queued and completed on its first tick.
    const store = storeWith([FISH]);

    const text = await TOOLS.set_objective!(
      {
        candidateIndex: 0,
        targetLevel: 50,
        abortMinutes: 45,
        untilItemId: 'melvorD:Raw_Seahorse',
        untilQuantity: 100,
        rationale: 'stock up',
      },
      { store, ...CTX } as never,
    );

    expect(text).toContain('Refused');
    expect(text).toContain('already holds 300x Raw Seahorse');
    expect(store.queued).toHaveLength(0);
  });

  it('queues a target that is genuinely ahead', async () => {
    const store = storeWith([FISH]);

    const text = await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 46, abortMinutes: 45, rationale: 'fish to 46' },
      { store, ...CTX } as never,
    );

    expect(text).toContain('Queued: Fishing: Raw Seahorse');
    expect(store.queued).toMatchObject([
      {
        type: 'set_objective',
        objective: {
          successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Fishing', level: 46 }],
        },
      },
    ]);
  });

  it('still queues a one-shot with no criteria at all', async () => {
    // An empty criteria list is the opposite of a no-op: nothing here can say
    // whether a purchase has work to do, and refusing it would refuse every
    // purchase the agent ever makes.
    const buy = {
      kind: 'buy_shop_upgrade',
      params: {
        kind: 'buy_shop_upgrade',
        purchaseId: 'melvorD:Bank_Slot',
        quantity: 1,
        gpFloor: 0,
      },
      label: 'Buy a bank slot',
      available: true,
    } satisfies Candidate;
    const store = storeWith([buy]);

    await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 0, abortMinutes: 5, rationale: 'more room' },
      { store, ...CTX } as never,
    );

    expect(store.queued).toMatchObject([{ objective: { successWhen: [] } }]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBlockedOpportunities } from '../src/adapter/blocked.js';
import { readGatherCandidates } from '../src/adapter/candidates.js';
import { resetAdapterFailures } from '../src/adapter/safe.js';
import {
  annotateStockDemand,
  mergeDemands,
  readTaskStockDemands,
} from '../src/adapter/stock-demand.js';
import { installFakeGame } from './fixtures.js';

/**
 * A shortfall the blocked list already prints, carried as a number.
 *
 * `readBlockedOpportunities` has been emitting `Magic: Superheat II — Earth
 * Rune from Runecrafting: Earth Rune — needs Earth Rune 1/3` for months: a
 * producer, an item and a quantity, which is a complete stock objective in
 * prose that nothing could consume. Meanwhile every goal and every plan step
 * came out level-shaped, and a plan went out as "craft Mind Runes to
 * Runecrafting 49" — a level target for a stock problem.
 *
 * The real `readBlockedOpportunities` and `readGatherCandidates` are driven
 * here rather than a mirror of the arithmetic, because the claim under test is
 * not "the multiplication is right". It is that a number computed in one walk
 * reaches a candidate produced by a different walk, across a skill boundary,
 * which is exactly the join a mirror cannot fail.
 */
let uninstall = (): void => {};

beforeEach(() => {
  resetAdapterFailures();
});

afterEach(() => {
  uninstall();
  resetAdapterFailures();
});

const GP = { id: 'melvorD:GP' };

/**
 * Every item carries a `sellsFor`, because the gathering path prices its
 * product before it names it.
 *
 * Omitting it is not a harmless fixture gap: `gpValue` reads `sellsFor.currency`
 * and throws, and the candidate wrapper drops the *whole* skill's enumeration
 * on a throw -- so Woodcutting vanished silently and the assertion below read
 * as "produces is missing" rather than "the skill is missing".
 */
const item = (id: string, name: string) => ({ id, name, sellsFor: { currency: GP, quantity: 5 } });

const EARTH_RUNE = item('melvorD:Earth_Rune', 'Earth Rune');
const RUNE_ESSENCE = item('melvorD:Rune_Essence', 'Rune Essence');
const IRON_BAR = item('melvorD:Iron_Bar', 'Iron Bar');
const AIR_RUNE = item('melvorD:Air_Rune', 'Air Rune');
const NORMAL_LOGS = item('melvorD:Normal_Logs', 'Normal Logs');

/** Woodcutting's own recipe shape: a tree, priced by `getTreeInterval`. */
const NORMAL_TREE = {
  id: 'melvorD:Normal_Tree',
  name: 'Normal Tree',
  level: 1,
  baseExperience: 10,
  baseQuantity: 1,
  product: NORMAL_LOGS,
};

/** A second producer, of an item nothing is short of. */
const AIR_RUNE_RECIPE = {
  id: 'melvorD:Air_Rune',
  name: 'Air Rune',
  level: 1,
  baseExperience: 5,
  baseQuantity: 1,
  product: AIR_RUNE,
  itemCosts: [{ item: RUNE_ESSENCE, quantity: 1 }],
};

/** Runecrafting: one essence in, one rune out, two seconds an action. */
const EARTH_RUNE_RECIPE = {
  id: 'melvorD:Earth_Rune',
  name: 'Earth Rune',
  level: 1,
  baseExperience: 6,
  baseQuantity: 1,
  product: EARTH_RUNE,
  itemCosts: [{ item: RUNE_ESSENCE, quantity: 1 }],
};

/** Smithing: three Earth Runes a craft, and the character holds one. */
const RUNE_HUNGRY_RECIPE = {
  id: 'melvorD:Rune_Platebody',
  name: 'Rune Platebody',
  level: 1,
  baseExperience: 50,
  baseQuantity: 1,
  product: IRON_BAR,
  itemCosts: [{ item: EARTH_RUNE, quantity: 3 }],
};

/**
 * Two skills, one producing what the other is short of.
 *
 * Deliberately different skills: the shortfall belongs to the consumer and the
 * candidate belongs to the producer, and no single enumerator sees both. That
 * cross-skill hop is the whole content of a production chain and was the part
 * left to a person to know.
 */
function installChain(held: Record<string, number>, township?: unknown): void {
  const runecrafting = {
    id: 'melvorD:Runecrafting',
    name: 'Runecrafting',
    level: 50,
    baseInterval: 2_000,
    hasMastery: false,
    actions: { allObjects: [EARTH_RUNE_RECIPE, AIR_RUNE_RECIPE] },
    isMasteryActionUnlocked: () => true,
    // The bank pays for it or it does not; nothing here models preservation.
    getRecipeCosts: (recipe: { itemCosts: { item: { id: string }; quantity: number }[] }) => ({
      checkIfOwned: () =>
        recipe.itemCosts.every((cost) => (held[cost.item.id] ?? 0) >= cost.quantity),
    }),
  };

  const smithing = {
    id: 'melvorD:Smithing',
    name: 'Smithing',
    level: 50,
    baseInterval: 2_000,
    hasMastery: false,
    actions: { allObjects: [RUNE_HUNGRY_RECIPE] },
    isMasteryActionUnlocked: () => true,
    getRecipeCosts: (recipe: { itemCosts: { item: { id: string }; quantity: number }[] }) => ({
      checkIfOwned: () =>
        recipe.itemCosts.every((cost) => (held[cost.item.id] ?? 0) >= cost.quantity),
    }),
  };

  const skills: Record<string, unknown> = {
    'melvorD:Runecrafting': runecrafting,
    'melvorD:Smithing': smithing,
  };

  // A gathering producer as well, because `produces` is built at two sites --
  // the shared `candidate()` in gather-candidates.ts and the artisan push in
  // candidates.ts -- and logs and ore are exactly what an artisan recipe is
  // most often blocked on. One site regressing while the other holds would
  // otherwise be invisible.
  const woodcutting = {
    id: 'melvorD:Woodcutting',
    name: 'Woodcutting',
    treeCutLimit: 1,
    actions: { allObjects: [NORMAL_TREE] },
    isTreeUnlocked: () => true,
    getTreeInterval: () => 3_000,
  };

  uninstall = installFakeGame({
    gp: GP,
    woodcutting,
    bank: { getQty: (item: { id: string }) => held[item.id] ?? 0 },
    items: {
      getObjectByID: (id: string) =>
        [EARTH_RUNE, RUNE_ESSENCE, IRON_BAR, AIR_RUNE, NORMAL_LOGS].find((item) => item.id === id),
    },
    skills: {
      getObjectByID: (id: string) => (id === 'melvorD:Woodcutting' ? woodcutting : skills[id]),
    },
    ...(township === undefined ? {} : { township }),
  });
}

const bankQty =
  (held: Record<string, number>) =>
  (itemId: string): number =>
    held[itemId] ?? 0;

describe('a blocked recipe states its shortfall as a stock figure', () => {
  it('scales the per-craft need by the consumer own rate', () => {
    // Three Earth Runes a craft at 2s an action is 1,800 crafts an hour, so an
    // hour of Smithing is 5,400 runes. The per-craft `need` of 3 is the figure
    // the blocked label prints and is useless as a target: "craft until 3" is
    // over in seconds and the plan tool would refuse it as a no-op.
    installChain({ 'melvorD:Rune_Essence': 1_000, 'melvorD:Earth_Rune': 1 });

    const entry = readBlockedOpportunities().find((item) =>
      item.label.startsWith('Smithing: Rune Platebody'),
    );

    expect(entry?.demands).toEqual([
      expect.objectContaining({
        itemId: 'melvorD:Earth_Rune',
        quantity: 5_400,
        have: 1,
      }),
    ]);
  });

  it('says how the figure was derived rather than only stating it', () => {
    // A number with no derivation cannot be argued with, and the caller is the
    // one deciding whether an hour of the consumer is what they want.
    installChain({ 'melvorD:Rune_Essence': 1_000, 'melvorD:Earth_Rune': 1 });

    const entry = readBlockedOpportunities().find((item) =>
      item.label.startsWith('Smithing: Rune Platebody'),
    );

    expect(entry?.demands?.[0]?.why).toContain('consumes 3 per action');
    expect(entry?.demands?.[0]?.why).toContain('1,800 actions/h');
  });
});

describe('a producing candidate names what it produces', () => {
  it('carries the item and the rate it banks it at', () => {
    // One rune an action at 2s: 1,800/h. Built from the same terms the label's
    // XP figure divides by, so the two cannot disagree.
    installChain({ 'melvorD:Rune_Essence': 1_000, 'melvorD:Earth_Rune': 1 });

    const producer = readGatherCandidates().find(
      (candidate) => (candidate.params as { recipeId?: string }).recipeId === 'melvorD:Earth_Rune',
    );

    expect(producer?.produces?.itemId).toBe('melvorD:Earth_Rune');
    expect(producer?.produces?.perHour).toBeCloseTo(1_800, 5);
  });

  it('does the same for a gathering candidate, which is priced elsewhere', () => {
    // A tree at 3s is 1,200 logs an hour. Asserted separately because the
    // gathering enumerations build their candidates in their own function, and
    // logs and ore are what an artisan recipe is most often blocked on.
    installChain({ 'melvorD:Rune_Essence': 1_000, 'melvorD:Earth_Rune': 1 });

    const tree = readGatherCandidates().find(
      (candidate) => (candidate.params as { recipeId?: string }).recipeId === 'melvorD:Normal_Tree',
    );

    expect(tree?.produces?.itemId).toBe('melvorD:Normal_Logs');
    expect(tree?.produces?.perHour).toBeCloseTo(1_200, 5);
  });
});

describe('the shortfall reaches the candidate that would fill it', () => {
  it('annotates the producer with the consumer figure', () => {
    installChain({ 'melvorD:Rune_Essence': 1_000, 'melvorD:Earth_Rune': 1 });

    const demands = mergeDemands(readBlockedOpportunities().flatMap((item) => item.demands ?? []));
    const annotated = annotateStockDemand(readGatherCandidates(), demands);

    const producer = annotated.find(
      (candidate) => (candidate.params as { recipeId?: string }).recipeId === 'melvorD:Earth_Rune',
    );

    expect(producer?.suggestedStock).toMatchObject({
      itemId: 'melvorD:Earth_Rune',
      name: 'Earth Rune',
      quantity: 5_400,
    });
  });

  it('leaves a candidate that produces something else alone', () => {
    // The join is by product, not by proximity. Annotating every candidate
    // would make the suggestion noise, which is how the last three diagnostics
    // shipped here went unread.
    installChain({ 'melvorD:Rune_Essence': 1_000, 'melvorD:Earth_Rune': 1 });

    const demands = mergeDemands(readBlockedOpportunities().flatMap((item) => item.demands ?? []));
    const annotated = annotateStockDemand(readGatherCandidates(), demands);

    for (const candidate of annotated) {
      if ((candidate.params as { recipeId?: string }).recipeId === 'melvorD:Earth_Rune') continue;
      expect(candidate.suggestedStock).toBeUndefined();
    }
  });

  it('does not mutate the candidates it was given', () => {
    // The enumeration is cached for the panel; annotating in place would leave
    // last pass's suggestion on a candidate after the shortfall was filled.
    installChain({ 'melvorD:Rune_Essence': 1_000, 'melvorD:Earth_Rune': 1 });

    const original = readGatherCandidates();
    const demands = mergeDemands(readBlockedOpportunities().flatMap((item) => item.demands ?? []));
    annotateStockDemand(original, demands);

    expect(original.every((candidate) => candidate.suggestedStock === undefined)).toBe(true);
  });
});

describe('a Township task states its own quantity', () => {
  const townshipWanting = (quantity: number) => ({
    townData: { townCreated: true },
    tasks: {
      completedTasks: { has: () => false },
      tasks: {
        allObjects: [{ goals: { itemGoals: [{ item: EARTH_RUNE, quantity }] } }],
      },
    },
    casualTasks: { currentCasualTasks: [] },
  });

  it('passes the ask through untouched', () => {
    // The one demand source that needs no scaling: the goal *is* a bank count,
    // so it is already an `item_qty_at_least` target.
    const held = { 'melvorD:Earth_Rune': 40 };
    installChain(held, townshipWanting(250));

    expect(readTaskStockDemands(bankQty(held))).toEqual([
      expect.objectContaining({ itemId: 'melvorD:Earth_Rune', quantity: 250, have: 40 }),
    ]);
  });

  it('says nothing about an ask the bank already covers', () => {
    // A suggestion to produce what is already held is the no-op the plan tool
    // refuses a step later, for a reason that would read as unrelated.
    const held = { 'melvorD:Earth_Rune': 400 };
    installChain(held, townshipWanting(250));

    expect(readTaskStockDemands(bankQty(held))).toEqual([]);
  });
});

describe('two demands for one item collapse to the one that covers both', () => {
  it('keeps the larger, not the sum', () => {
    // Consumers are not run at the same time, so the larger already covers the
    // smaller — the same argument readTaskWantedQuantities makes for taking the
    // largest single ask rather than every task in the game added together.
    const merged = mergeDemands([
      {
        itemId: 'melvorD:Earth_Rune',
        name: 'Earth Rune',
        quantity: 250,
        have: 0,
        why: 'task',
        source: 'township_task',
      },
      {
        itemId: 'melvorD:Earth_Rune',
        name: 'Earth Rune',
        quantity: 5_400,
        have: 0,
        why: 'craft',
        source: 'recipe_input',
      },
    ]);

    expect(merged.get('melvorD:Earth_Rune')?.quantity).toBe(5_400);
    expect(merged.get('melvorD:Earth_Rune')?.why).toBe('craft');
  });
});

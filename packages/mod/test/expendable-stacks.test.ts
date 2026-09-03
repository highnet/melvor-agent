import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readCheapestExpendableStack,
  readMostValuableExpendableStack,
} from '../src/adapter/disposal.js';

/**
 * What the automatic sell path is allowed to reach, and how much of it.
 *
 * Driven through the real readers rather than a copy of their predicate, for the
 * reason `alt-magic-fuel.test.ts` states next door: a test that mirrors the
 * guard cannot catch a bug in the guard. `liquidate.test.ts` used to assert the
 * Township reserve against a two-line `sellable()` helper written in the test
 * file, which is precisely why nobody noticed that the reflex path did not
 * apply it — the helper was correct and unreachable from the code.
 *
 * The bug that shape hid: `saleExclusionReason` withholds a stack only while it
 * *fails* to cover an open task's ask, so 582 Gold Bars against a task wanting
 * 100 became sellable — and the reflex then asked the bank how many there were
 * and offered all 582. The operator's own measurement of the candidate path
 * ("100 of every 582 kept, and that is correct") was the behaviour the reflex
 * beside it did not have.
 */

const MAGIC = 'melvorD:Magic';

const GP_CURRENCY = { id: 'melvorD:GP', amount: 0 };

interface FakeItem {
  id: string;
  name: string;
  sellsFor: { currency: typeof GP_CURRENCY; quantity: number };
}

const item = (id: string, name: string, quantity: number): FakeItem => ({
  id,
  name,
  sellsFor: { currency: GP_CURRENCY, quantity },
});

// Sale values are the game's own, from `data/dump.json`.
const GOLD_BAR = item('melvorD:Gold_Bar', 'Gold Bar', 142);
const SILVER_BAR = item('melvorD:Silver_Bar', 'Silver Bar', 51);
const RUSTY_KEY = item('melvorF:Rusty_Key', 'Rusty Key', 12);
const POTATO_SEED = item('melvorD:Potato_Seed', 'Potato Seeds', 4);
const MIND_RUNE = item('melvorD:Mind_Rune', 'Mind Rune', 1);
const SHRIMP = item('melvorD:Shrimp', 'Shrimp', 3);
const ARROWS = item('melvorD:Bronze_Arrows', 'Bronze Arrows', 2);

const ITEMS = [GOLD_BAR, SILVER_BAR, RUSTY_KEY, POTATO_SEED, MIND_RUNE, SHRIMP, ARROWS];

/**
 * The game's item classes, as classes, so `instanceof` answers.
 *
 * Undefined globals throw, and a throw inside `saleExclusionReason` excludes
 * every item — which would make an assertion that something is *not* sellable
 * pass for entirely the wrong reason.
 */
class MasteryTokenItemStub {}
class EquipmentItemStub {
  ammoType?: number;
}
class FoodItemStub {}

/** Shrimp is food and Bronze Arrows are ammunition, by class rather than name. */
const FOOD = Object.assign(new FoodItemStub(), SHRIMP) as unknown as FakeItem;
const AMMO = Object.assign(new EquipmentItemStub(), ARROWS, {
  ammoType: 0,
}) as unknown as FakeItem;

let banked: Map<string, { item: FakeItem; quantity: number }>;
let taskWanted: { item: FakeItem; quantity: number }[];

function stockBank(): void {
  banked = new Map(
    (
      [
        [GOLD_BAR, 582],
        [SILVER_BAR, 40],
        [RUSTY_KEY, 10],
        [POTATO_SEED, 30],
        [MIND_RUNE, 81],
        [FOOD, 12],
        [AMMO, 1259],
      ] as [FakeItem, number][]
    ).map(([entry, quantity]) => [entry.id, { item: entry, quantity }]),
  );
}

function installGame(): void {
  (globalThis as Record<string, unknown>).game = {
    gp: GP_CURRENCY,
    items: {
      getObjectByID: (id: string) =>
        [...ITEMS, FOOD, AMMO].find((entry) => (entry as FakeItem).id === id),
    },
    bank: {
      items: banked,
      lockedItems: new Set<FakeItem>(),
      getQty: (wanted: FakeItem) => banked.get(wanted.id)?.quantity ?? 0,
    },
    skills: { getObjectByID: (id: string) => (id === MAGIC ? { id: MAGIC, level: 1 } : undefined) },
    attackSpells: {
      allObjects: [
        // Wind Strike: castable at Magic 1, and the reason Mind Rune is not
        // spare change however cheap it looks.
        { id: 'melvorD:WindStrike', level: 1, runesRequired: [{ item: MIND_RUNE, quantity: 1 }] },
      ],
    },
    combat: { player: { useCombinationRunes: false, food: { currentSlot: { quantity: 0 } } } },
    farming: {
      actions: {
        allObjects: [{ seedCost: { item: POTATO_SEED, quantity: 3 } }],
      },
    },
    herblore: { actions: { allObjects: [] } },
    township: {
      townData: { townCreated: true },
      tasks: {
        tasks: {
          allObjects: [{ goals: { itemGoals: taskWanted } }],
        },
        completedTasks: new Set(),
      },
      casualTasks: { currentCasualTasks: [], isTaskComplete: () => false },
    },
  };
}

const GAME_CLASSES: [string, unknown][] = [
  ['MasteryTokenItem', MasteryTokenItemStub],
  ['EquipmentItem', EquipmentItemStub],
  ['FoodItem', FoodItemStub],
];

beforeEach(() => {
  // The live task measured on the day: 100 Gold Bars wanted of 582 held.
  taskWanted = [{ item: GOLD_BAR, quantity: 100 }];
  stockBank();
  for (const [name, value] of GAME_CLASSES) (globalThis as Record<string, unknown>)[name] = value;
  installGame();
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
  for (const [name] of GAME_CLASSES) (globalThis as Record<string, unknown>)[name] = undefined;
});

describe('readMostValuableExpendableStack', () => {
  it('offers the surplus above a task reserve and not the reserve', () => {
    const best = readMostValuableExpendableStack();

    expect(best?.itemId).toBe(GOLD_BAR.id);
    expect(best?.held).toBe(582);
    expect(best?.quantity).toBe(482);
    expect(best?.value).toBe(482 * 142);
  });

  it('withholds the stack entirely while it barely covers the ask', () => {
    // The incident the guard was written for: 500 Potatoes sold an hour before
    // a task appeared wanting 100. Holding 80 against an ask of 100 is not
    // surplus at all.
    taskWanted = [{ item: GOLD_BAR, quantity: 1000 }];
    installGame();

    expect(readMostValuableExpendableStack()?.itemId).not.toBe(GOLD_BAR.id);
  });

  it('never offers food, ammunition, seeds or a castable spell rune', () => {
    // Each of these guards exists because something valuable was destroyed
    // live. Ranked by value, this reader would otherwise reach 1,259 arrows
    // before it reached 40 Silver Bars.
    const offered: string[] = [];
    for (let pass = 0; pass < ITEMS.length + 2; pass += 1) {
      const best = readMostValuableExpendableStack();
      if (best === null) break;
      offered.push(best.itemId);
      // Sell it, so the next pass sees what is behind it.
      banked.delete(best.itemId);
    }

    expect(offered).toEqual([GOLD_BAR.id, SILVER_BAR.id, RUSTY_KEY.id]);
    expect(offered).not.toContain(FOOD.id);
    expect(offered).not.toContain(AMMO.id);
    expect(offered).not.toContain(POTATO_SEED.id);
    expect(offered).not.toContain(MIND_RUNE.id);
  });

  it('ranks on the sellable portion, not on the bank count', () => {
    // 582 Gold Bars are worth more than 40 Silver Bars either way. Reserve all
    // but two of them and the ranking has to change, or the caller is told the
    // most valuable thing it may sell is a stack worth 284 GP.
    taskWanted = [{ item: GOLD_BAR, quantity: 580 }];
    installGame();

    expect(readMostValuableExpendableStack()?.itemId).toBe(SILVER_BAR.id);
  });
});

describe('readCheapestExpendableStack', () => {
  it('takes the cheapest stack it can empty', () => {
    // The full-bank escape hatch: the point is one freed slot at the smallest
    // cost, so it wants the cheapest, not the most valuable.
    expect(readCheapestExpendableStack()?.itemId).toBe(RUSTY_KEY.id);
  });

  it('skips a stack a task has a claim on, however cheap', () => {
    // A partial sale does not free the slot, so selling down to the reserve
    // buys nothing and costs a task cycle.
    //
    // All three sellable stacks are reserved, because all three have to be:
    // every other item in the fixture is already withheld by an unrelated
    // guard (seed, spell rune, food, ammunition), so leaving any one of the
    // bars unclaimed leaves it genuinely emptyable and correctly returned.
    // An earlier version reserved only the two cheap stacks and asserted null
    // anyway, which asked the reader to skip the unreserved Gold Bar for no
    // stated reason.
    taskWanted = [
      { item: RUSTY_KEY, quantity: 5 },
      { item: SILVER_BAR, quantity: 5 },
      { item: GOLD_BAR, quantity: 5 },
    ];
    installGame();

    expect(readCheapestExpendableStack()).toBeNull();
  });
});

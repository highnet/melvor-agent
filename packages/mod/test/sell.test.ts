import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sellItem } from '../src/adapter/bank.js';
import { sellItems } from '../src/policy/sell.js';
import type { PolicyContext } from '../src/policy/types.js';
import { GP, NORMAL_LOGS, objective, snapshot } from './fixtures.js';

const START = 1_700_000_000_000;
const never = (): boolean => false;
const always = (): boolean => true;

// --- adapter -------------------------------------------------------------

interface FakeItem {
  id: string;
  name: string;
  sellsFor: { currency: { id: string; amount: number }; quantity: number };
}

const GP_CURRENCY = { id: GP, amount: 1000 };
const LOGS: FakeItem = {
  id: NORMAL_LOGS,
  name: 'Normal Logs',
  sellsFor: { currency: GP_CURRENCY, quantity: 5 },
};
const WORTHLESS: FakeItem = {
  id: 'melvorD:Quest_Token',
  name: 'Quest Token',
  sellsFor: { currency: GP_CURRENCY, quantity: 0 },
};

let bankQty: Map<FakeItem, number>;
let locked: Set<FakeItem>;

function installGame(): void {
  (globalThis as Record<string, unknown>).game = {
    items: {
      getObjectByID: (id: string) => [LOGS, WORTHLESS].find((item) => item.id === id),
    },
    bank: {
      lockedItems: locked,
      getQty: (item: FakeItem) => bankQty.get(item) ?? 0,
      /** Returns void, faithful to the real method. */
      processItemSale(item: FakeItem, quantity: number): void {
        const held = bankQty.get(item) ?? 0;
        bankQty.set(item, held - quantity);
        GP_CURRENCY.amount += item.sellsFor.quantity * quantity;
      },
    },
  };
}

beforeEach(() => {
  bankQty = new Map([
    [LOGS, 100],
    [WORTHLESS, 1],
  ]);
  locked = new Set();
  GP_CURRENCY.amount = 1000;
  installGame();
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
});

describe('sellItem', () => {
  it('sells and observes both sides of the trade', () => {
    const result = sellItem(NORMAL_LOGS, 40, never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observed.before.bankQty).toBe(100);
    expect(result.observed.after.bankQty).toBe(60);
    expect(result.observed.after.currencyAmount).toBe(1200);
  });

  it('refuses a locked item', () => {
    // lockedItems is the operator's own marking in the game UI and the one
    // signal that reliably means "not this".
    locked.add(LOGS);
    const result = sellItem(NORMAL_LOGS, 10, never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('precondition');
    expect(bankQty.get(LOGS)).toBe(100);
  });

  it('refuses a zero-value item rather than destroying it for nothing', () => {
    const result = sellItem(WORTHLESS.id, 1, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('sells for nothing');
    expect(bankQty.get(WORTHLESS)).toBe(1);
  });

  it('refuses to sell more than the bank holds', () => {
    const result = sellItem(NORMAL_LOGS, 500, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('cannot sell 500');
    expect(bankQty.get(LOGS)).toBe(100);
  });

  it('refuses a non-positive or fractional quantity', () => {
    for (const quantity of [0, -5, 2.5]) {
      const result = sellItem(NORMAL_LOGS, quantity, never);
      expect(result.ok).toBe(false);
    }
    expect(bankQty.get(LOGS)).toBe(100);
  });

  it('refuses outright while offline progress is resolving', () => {
    const result = sellItem(NORMAL_LOGS, 10, always);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('suspended');
    expect(bankQty.get(LOGS)).toBe(100);
  });

  it('refuses an unregistered item id', () => {
    const result = sellItem('melvorD:Not_An_Item', 1, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('no item registered');
  });
});

// --- policy --------------------------------------------------------------

function sellObjective(keepQuantity: number) {
  return objective({
    kind: 'sell_items',
    params: { kind: 'sell_items', itemId: NORMAL_LOGS, keepQuantity },
    successWhen: [{ type: 'currency_at_least', currencyId: GP, amount: 50_000 }],
  });
}

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    snapshot: snapshot(),
    objective: sellObjective(0),
    now: START,
    objectiveStartedAt: START,
    deathsSinceStart: 0,
    ...overrides,
  };
}

describe('sellItems policy', () => {
  it('sells the whole stack when nothing is kept', () => {
    // The fixture bank holds 40 Normal Logs.
    expect(sellItems(context())).toMatchObject({
      kind: 'act',
      actions: [{ type: 'sell', itemId: NORMAL_LOGS, quantity: 40 }],
    });
  });

  it('sells only the surplus above keepQuantity', () => {
    expect(sellItems(context({ objective: sellObjective(30) }))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'sell', itemId: NORMAL_LOGS, quantity: 10 }],
    });
  });

  it('idles rather than aborting when there is no surplus', () => {
    // The success criteria may still be reachable another way, and the budget
    // will end the objective if they are not.
    expect(sellItems(context({ objective: sellObjective(100) }))).toMatchObject({
      kind: 'idle',
      reason: 'nothing_to_do',
    });
  });

  it('never emits a negative quantity when below keepQuantity', () => {
    const decision = sellItems(context({ objective: sellObjective(999) }));
    expect(decision.kind).toBe('idle');
  });

  it('checks the budget before it checks anything else', () => {
    const decision = sellItems(context({ now: START + 61 * 60_000, objectiveStartedAt: START }));
    expect(decision).toMatchObject({ kind: 'abort', outcome: 'aborted_budget' });
  });

  it('refuses to act while offline progress is resolving', () => {
    expect(sellItems(context({ snapshot: snapshot({ isOfflineLoop: true }) }))).toMatchObject({
      kind: 'idle',
      reason: 'waiting_for_game',
    });
  });

  it('reports completion once the currency target is met', () => {
    const rich = snapshot({ currencies: [{ id: GP, name: 'GP', amount: 60_000 }] });
    expect(sellItems(context({ snapshot: rich }))).toMatchObject({ kind: 'complete' });
  });
});

describe('sell candidate ordering', () => {
  it('orders by a key that does not move when stacks grow', () => {
    // The list was sorted by label, and a label embeds the quantity — so a
    // stack going from 23 to 29 re-sorted everything after it and every index
    // shifted. Plans built from a listing then raced the agent's own
    // gathering: four in a row were refused by the drift guard, which is a
    // planner that cannot plan.
    //
    // Sorting by item id is stable under exactly that change.
    const entries = [
      { itemId: 'melvorD:Raw_Herring', quantity: 23 },
      { itemId: 'melvorD:Coal_Ore', quantity: 9 },
      { itemId: 'melvorD:Teak_Logs', quantity: 31 },
    ];

    const order = (rows: typeof entries) =>
      [...rows].sort((a, b) => a.itemId.localeCompare(b.itemId)).map((row) => row.itemId);

    const before = order(entries);
    const after = order(entries.map((row) => ({ ...row, quantity: row.quantity + 6 })));

    expect(after).toEqual(before);
  });

  it('would have reordered under the old label sort', () => {
    // Proves the bug was real rather than theoretical. The old sort compared
    // labels as strings, so the quantity was compared digit by digit: "4x"
    // sorts above "32x" because '4' > '3'. A stack shrinking from 31 to 4 —
    // an ordinary sale — moved it past everything in the thirties, and every
    // index after it shifted.
    const label = (id: string, qty: number) => `Sell ${qty}x ${id}`;
    const byLabel = (rows: { id: string; qty: number }[]) =>
      [...rows]
        .sort((a, b) => label(b.id, b.qty).localeCompare(label(a.id, a.qty)))
        .map((row) => row.id);

    const before = byLabel([
      { id: 'Ancient Corn Seeds', qty: 32 },
      { id: 'Teak Logs', qty: 31 },
    ]);
    const after = byLabel([
      { id: 'Ancient Corn Seeds', qty: 32 },
      { id: 'Teak Logs', qty: 4 },
    ]);

    expect(before).toEqual(['Ancient Corn Seeds', 'Teak Logs']);
    expect(after).toEqual(['Teak Logs', 'Ancient Corn Seeds']);
  });
});

describe('items an open task wants', () => {
  it('are excluded from the sell list', () => {
    // 500 Potatoes were sold as junk — "free from a Point of Interest, not
    // food the character needs, not something the town accepts" — which was
    // true when written and wrong an hour later, when a Township task appeared
    // wanting 100 Potatoes. Tasks rotate, so today's junk is tomorrow's
    // requirement, and a task cycle is worth far more than a stack's sale
    // price: one took Township from 2 to 5.
    const wanted = new Set(['melvorD:Potatoes']);
    const bank = [
      { itemId: 'melvorD:Potatoes', quantity: 500 },
      { itemId: 'melvorD:Normal_Logs', quantity: 644 },
    ];

    const offered = bank.filter((entry) => !wanted.has(entry.itemId)).map((entry) => entry.itemId);

    expect(offered).toEqual(['melvorD:Normal_Logs']);
  });

  it('leaves everything else sellable', () => {
    // The guard must not turn into "never sell anything" — the bank filling up
    // stalled the agent repeatedly today, and selling is the planner's lever.
    const wanted = new Set<string>();
    const bank = [{ itemId: 'melvorD:Potatoes', quantity: 500 }];

    expect(bank.filter((e) => !wanted.has(e.itemId))).toHaveLength(1);
  });
});

describe('the last of an ingredient', () => {
  // Scarcity is the signal. Two Garum Seeds — the only herb seeds obtained in
  // a full session, and exactly one Garum Herb planting's worth — came within
  // a drift check of being sold in a batch aimed at Oak Logs, because the
  // candidate list reordered between the listing and the plan.
  const scarce = (held: number, cost: number) => held > 0 && held <= cost;

  it('protects an item held at exactly one craft cost', () => {
    expect(scarce(2, 2)).toBe(true);
  });

  it('protects an item held below one craft cost', () => {
    expect(scarce(1, 2)).toBe(true);
  });

  it('releases it once there is more than a single craft', () => {
    // Deliberately narrow: three of something costing two is stock, not the
    // last of a kind, and selling has to stay available — a full bank stalled
    // the agent repeatedly today.
    expect(scarce(3, 2)).toBe(false);
  });

  it('ignores items not held at all', () => {
    expect(scarce(0, 2)).toBe(false);
  });
});

describe('farming seeds', () => {
  // The sell list offered 32 Ancient Corn Seeds and 30 Ancient Carrot Seeds
  // while Farming sat at level 1 — and Farming 30 is the prerequisite for
  // Herblore, the last untrained skill in scope. A seed is worth a few GP; the
  // harvest is worth Farming XP, which is the scarce thing.
  const seeds = new Set(['melvorD:Ancient_Corn_Seeds', 'melvorD:Potato_Seeds']);
  const sellable = (itemId: string) => !seeds.has(itemId);

  it('never offers a seed for sale', () => {
    expect(sellable('melvorD:Ancient_Corn_Seeds')).toBe(false);
  });

  it('protects seeds for crops the character cannot plant yet', () => {
    // The point of protecting them at every level rather than only plantable
    // ones: an unplantable seed is not surplus, it is stock for the level the
    // agent is working towards.
    expect(sellable('melvorD:Potato_Seeds')).toBe(false);
  });

  it('leaves the rest of the bank sellable', () => {
    // The guard must not become "never sell anything" — a full bank stalled the
    // agent repeatedly, and selling is the planner's lever for that.
    expect(sellable('melvorD:Oak_Logs')).toBe(true);
  });
});

describe('runes a castable spell needs', () => {
  // All 81 Mind Runes were sold in a bank-clearing pass, noted as "not the runes
  // Township wants" — true, and beside the point. The basic strike spells take a
  // Mind Rune as catalyst alongside the elemental one, so the stack that looked
  // like spare change was half of every castable spell. It surfaced much later
  // and somewhere else entirely: a staff equipped, 821 Air Runes banked, and a
  // fight that could not land a cast.
  const needed = new Set(['melvorD:Mind_Rune', 'melvorD:Air_Rune']);
  const sellable = (itemId: string) => !needed.has(itemId);

  it('protects the catalyst rune, not just the elemental one', () => {
    expect(sellable('melvorD:Mind_Rune')).toBe(false);
  });

  it('protects the elemental rune too', () => {
    expect(sellable('melvorD:Air_Rune')).toBe(false);
  });

  it('leaves runes for spells far out of reach sellable', () => {
    // A guard that protects everything protects nothing: the bank filling up
    // has stalled this agent repeatedly, and selling is the lever for that.
    expect(sellable('melvorD:Ancient_Rune')).toBe(true);
  });
});

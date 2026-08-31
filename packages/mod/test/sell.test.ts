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

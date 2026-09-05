import { afterEach, describe, expect, it } from 'vitest';
import { readShopObjectiveCandidates } from '../src/adapter/candidates.js';

/**
 * A cost that escalates has no per-unit price.
 *
 * `Buy 5x Extra Bank Slot (63,857 GP each)` was offered at a balance that
 * covered five times 63,857, and then refused as unaffordable — because a bank
 * slot gets dearer with every purchase. Its cost is a `BankSlotCost`
 * (shop.d.ts:38) and `Shop.getCurrencyCost(cost, buyQuantity, boughtQuantity)`
 * (shop.d.ts:266) takes how many are already owned, so `floor(gp / priceOfOne)`
 * overstates the batch by exactly the amount the price climbs. The label was
 * wrong in the same way and in the same breath: there is no "each".
 *
 * The fake charges a triangular price, which is what an escalating cost is: the
 * n-th unit costs `base * n`. A fake that charged `base * quantity` would be
 * green against the arithmetic being replaced.
 */

const GP = { id: 'melvorD:GP', name: 'GP', amount: 0 };

/** Rises by `step` with every one already owned; the first costs `base`. */
interface Escalating {
  id: string;
  name: string;
  base: number;
  step: number;
  owned: number;
  allowQuantityPurchase: boolean;
  contains: { items: never[] };
  purchaseRequirements: never[];
}

function slot(overrides: Partial<Escalating> = {}): Escalating {
  return {
    id: 'melvorD:Extra_Bank_Slot',
    name: 'Extra Bank Slot',
    base: 63_857,
    step: 20_000,
    owned: 0,
    allowQuantityPurchase: true,
    contains: { items: [] },
    purchaseRequirements: [],
    ...overrides,
  };
}

/** What the shop charges for `quantity` more, starting from `owned`. */
function priceOf(purchase: Escalating, quantity: number): number {
  let total = 0;
  for (let index = 0; index < quantity; index += 1) {
    total += purchase.base + purchase.step * (purchase.owned + index);
  }
  return total;
}

let uninstall = (): void => {};

function install(purchases: Escalating[], gp: number): void {
  const previous = (globalThis as Record<string, unknown>).game;
  GP.amount = gp;

  (globalThis as Record<string, unknown>).game = {
    gp: GP,
    bank: { getQty: (): number => 0 },
    checkRequirements: (): boolean => true,
    shop: {
      purchases: {
        allObjects: purchases,
        getObjectByID: (id: string): Escalating | undefined =>
          purchases.find((purchase) => purchase.id === id),
      },
      getPurchaseCount: (purchase: Escalating): number => purchase.owned,
      isPurchaseAtBuyLimit: (): boolean => false,
      capPurchaseQuantity: (_purchase: Escalating, quantity: number): number => quantity,
      getPurchaseCosts: (purchase: Escalating, quantity: number) => ({
        checkIfOwned: (): boolean => priceOf(purchase, quantity) <= GP.amount,
        getCurrencyQuantityArray: () => [{ currency: GP, quantity: priceOf(purchase, quantity) }],
        getItemQuantityArray: () => [],
      }),
    },
  };

  uninstall = (): void => {
    (globalThis as Record<string, unknown>).game = previous;
  };
}

afterEach(() => {
  uninstall();
});

describe('batching a purchase whose price climbs', () => {
  it('offers only a quantity the shop will actually sell', () => {
    // Five slots from zero owned cost 63,857 + 83,857 + 103,857 + 123,857 +
    // 143,857 = 519,285. At 400,000 the old arithmetic offered five (400,000 /
    // 63,857 = 6, capped by the batch) and the purchase refused.
    install([slot()], 400_000);

    const [candidate] = readShopObjectiveCandidates();
    const quantity = (candidate?.params as { quantity: number }).quantity;

    expect(priceOf(slot(), quantity)).toBeLessThanOrEqual(400_000);
    expect(priceOf(slot(), quantity + 1)).toBeGreaterThan(400_000);
  });

  it('prices the label as a total, because there is no "each"', () => {
    install([slot()], 400_000);

    const [candidate] = readShopObjectiveCandidates();
    const quantity = (candidate?.params as { quantity: number }).quantity;

    expect(candidate?.label).toContain(priceOf(slot(), quantity).toLocaleString());
    expect(candidate?.label).not.toContain('each');
  });

  it('charges from what is already owned, not from zero', () => {
    // The escalation is a function of the purchase count, so the same balance
    // buys fewer slots the more the character has. A model that priced from
    // zero would offer the same batch either way.
    install([slot({ owned: 0 })], 400_000);
    const fresh = (readShopObjectiveCandidates()[0]?.params as { quantity: number }).quantity;

    install([slot({ owned: 6 })], 400_000);
    const later = (readShopObjectiveCandidates()[0]?.params as { quantity: number }).quantity;

    expect(later).toBeLessThan(fresh);
  });

  it('still offers one when only one is affordable', () => {
    install([slot()], 70_000);

    expect((readShopObjectiveCandidates()[0]?.params as { quantity: number }).quantity).toBe(1);
  });

  it('never batches a purchase the game will not sell in quantity', () => {
    // An upgrade is bought once and owning two is meaningless. The game states
    // this outright; nothing here infers it from the price.
    install(
      [slot({ id: 'melvorD:Iron_Axe', name: 'Iron Axe', allowQuantityPurchase: false })],
      10_000_000,
    );

    expect((readShopObjectiveCandidates()[0]?.params as { quantity: number }).quantity).toBe(1);
  });
});

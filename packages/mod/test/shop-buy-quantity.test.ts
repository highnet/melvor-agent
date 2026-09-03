import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buyShopPurchase } from '../src/adapter/shop.js';

/**
 * Buying what was asked for, and leaving the shop page as it was found.
 *
 * `Shop.buyItemOnClick(purchase, confirmed)` (shop.d.ts:261) takes no quantity:
 * it buys `shop.buyQuantity` (shop.d.ts:232), the page's own selector, whose
 * update callback is `updateBuyQuantity` (shop.d.ts:263). The adapter has set
 * that field since "buy 25 shards" bought one — and then left it set, so the
 * operator's next click bought twenty-five of something they wanted one of.
 *
 * The fake transcribes that: it buys `buyQuantity` and ignores any argument. A
 * fake that bought what it was passed would be green with the field never set
 * at all, which is exactly how the same bug survived elsewhere in this repo.
 */

const SHARDS = {
  id: 'melvorD:Summoning_Shard',
  contains: { items: [] as { item: string }[] },
  purchaseRequirements: [],
};

class FakeShop {
  /** The game's own default, and what a human leaves behind by clicking 10. */
  buyQuantity = 1;
  bought = 0;

  readonly purchases = {
    getObjectByID: (id: string): typeof SHARDS | undefined =>
      id === SHARDS.id ? SHARDS : undefined,
  };

  getPurchaseCount(): number {
    return this.bought;
  }

  isPurchaseAtBuyLimit(): boolean {
    return false;
  }

  capPurchaseQuantity(_purchase: typeof SHARDS, quantity: number): number {
    return quantity;
  }

  getPurchaseCosts(): { checkIfOwned: () => boolean } {
    return { checkIfOwned: () => true };
  }

  /** Buys the page's quantity, not the caller's — the whole point. */
  buyItemOnClick(_purchase: typeof SHARDS, _confirmed?: boolean): void {
    this.bought += this.buyQuantity;
  }
}

let shop: FakeShop;

beforeEach(() => {
  shop = new FakeShop();
  (globalThis as Record<string, unknown>).game = {
    shop,
    bank: { getQty: () => 0 },
    gp: { amount: 100_000 },
    checkRequirements: () => true,
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
});

const never = (): boolean => false;

describe('buying from the shop', () => {
  it('buys the quantity asked for', () => {
    const result = buyShopPurchase(SHARDS.id, 25, never);

    expect(result.ok).toBe(true);
    expect(shop.bought).toBe(25);
  });

  it('puts the human buy quantity back', () => {
    // The operator's game. Leaving the selector on 25 changes what their next
    // click buys, with nothing on screen to say why.
    buyShopPurchase(SHARDS.id, 25, never);
    expect(shop.buyQuantity).toBe(1);

    shop.buyQuantity = 10;
    buyShopPurchase(SHARDS.id, 25, never);
    expect(shop.buyQuantity).toBe(10);
  });

  it('restores it even when the purchase throws', () => {
    shop.buyQuantity = 10;
    shop.buyItemOnClick = () => {
      throw new Error('boom');
    };

    expect(buyShopPurchase(SHARDS.id, 25, never).ok).toBe(false);
    expect(shop.buyQuantity).toBe(10);
  });

  it('restores it when the purchase silently does nothing', () => {
    // A refused purchase returns void and changes nothing, which is a failure
    // the `finally` still has to survive: the operator's selector must not be
    // the price of an unsuccessful buy.
    shop.buyQuantity = 10;
    shop.buyItemOnClick = () => undefined;

    expect(buyShopPurchase(SHARDS.id, 25, never).ok).toBe(false);
    expect(shop.buyQuantity).toBe(10);
  });
});

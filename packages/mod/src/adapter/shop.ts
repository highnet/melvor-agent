import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/** What buying claims to change: one more owned, some currency gone. */
export interface PurchaseProjection {
  purchaseId: string;
  owned: number;
  /** Items the purchase grants, counted in the bank. */
  granted: number;
  gp: number;
}

/**
 * Purchases that are refused regardless of affordability.
 *
 * Shop upgrades are the main progression lever and buying them is exactly what
 * the agent is for — but a few entries are gambles or permanent choices rather
 * than upgrades, and those fall under the categorical refusals:
 *
 * - **Loot boxes** are a gamble with a one-way payout, not an upgrade.
 * - **Pets** are unique and unrecoverable if the purchase is a one-off.
 * - **Bank tabs** are harmless, but they are bought endlessly at rising cost
 *   and would quietly drain a GP floor, so they are left to the operator.
 *
 * Detected structurally from `purchase.contains`, not by name matching.
 */
function categoricalRefusal(purchase: ShopPurchase): string | null {
  if (purchase.contains.lootBox === true) {
    return 'loot boxes are a gamble, not an upgrade; refused categorically';
  }
  if (purchase.contains.pet !== undefined) {
    return 'pet purchases are unique and unrecoverable; refused categorically';
  }
  if (purchase.contains.bankTab === true) {
    return 'bank tabs are an open-ended cost; left to the operator';
  }
  return null;
}

/**
 * Buys from the shop.
 *
 * Shop purchases are the transition the wiki corpus exists to advise on — which
 * upgrades matter first is the classic thing game data alone does not encode.
 * The agent may spend, so this is permitted, but three guards apply:
 *
 * - Requirements are checked through the game's own `checkRequirements`, with
 *   notifications suppressed so an unattended agent does not spam the UI.
 * - Affordability is checked through `getPurchaseCosts(...).checkIfOwned()`
 *   rather than by reimplementing cost scaling, which changes per purchase.
 * - {@link categoricalRefusal} blocks gambles and unique items outright.
 *
 * `buyItemOnClick` returns `void` and normally raises a confirmation modal; it
 * is called with `confirmed = true` because an unattended agent has nobody to
 * answer it. Success is established by observing the owned count rise.
 *
 * @param purchaseId - Namespaced `ShopPurchase` id.
 * @param quantity - How many to buy. Capped by the game's own buy limit.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the purchase count increased.
 */
export function buyShopPurchase(
  purchaseId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<PurchaseProjection> {
  const purchase = game.shop.purchases.getObjectByID(purchaseId);
  if (purchase === undefined) {
    return fail('shop.buy', 'precondition', `no shop purchase registered as ${purchaseId}`);
  }

  const project = (): PurchaseProjection => ({
    purchaseId,
    owned: game.shop.getPurchaseCount(purchase),
    // A consumable bought from the shop — leather, summoning shards — does not
    // raise the purchase count: it drops items into the bank. Counting only
    // `owned` reported every such purchase as a no-op while the goods were
    // sitting in the bank, which is the same mistake burying bones made by
    // watching Prayer XP instead of the stack.
    granted: purchase.contains.items.reduce(
      (total, entry) => total + game.bank.getQty(entry.item),
      0,
    ),
    gp: game.gp.amount,
  });

  return act(
    {
      name: 'shop.buy',
      observe: project,
      precondition: () => {
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }

        const refusal = categoricalRefusal(purchase);
        if (refusal !== null) return refusal;

        if (game.shop.isPurchaseAtBuyLimit(purchase)) {
          return `${purchaseId} is at its buy limit`;
        }
        // Suppress notifications: an unattended agent probing requirements
        // would otherwise fill the screen with failure toasts.
        if (!game.checkRequirements(purchase.purchaseRequirements, false)) {
          return `requirements not met for ${purchaseId}`;
        }
        const capped = game.shop.capPurchaseQuantity(purchase, quantity);
        if (capped < quantity) {
          return `can only buy ${capped} of ${purchaseId}, not ${quantity}`;
        }
        if (!game.shop.getPurchaseCosts(purchase, quantity).checkIfOwned()) {
          return `cannot afford ${quantity}x ${purchaseId}`;
        }
        return null;
      },
      perform: () => {
        // `buyItemOnClick` buys `shop.buyQuantity`, not a quantity passed in.
        // The parameter was validated and then ignored, so "buy 25 shards"
        // bought one — an objective that reported success having done a
        // twenty-fifth of its job.
        game.shop.buyQuantity = quantity;
        // `confirmed` skips the modal, which nothing would answer.
        game.shop.buyItemOnClick(purchase, true);
      },
      // Either signal counts: an upgrade raises the purchase count, a
      // consumable raises the bank. Both spend the currency, but GP alone is
      // not proof — a failed purchase that refunds would look identical.
      changed: (before, after) => after.owned > before.owned || after.granted > before.granted,
      // Buying fewer than asked is not a failure worth abandoning the objective
      // over — the shop caps some purchases — but it is worth recording, which
      // the before/after evidence does on its own.
    },
    isSuspended,
  );
}

/**
 * Shop purchases the agent could make right now.
 *
 * Mirrors every refusal in {@link buyShopPurchase}, so an offered purchase is
 * one that would actually go through. Cost is reported so the planner can weigh
 * a purchase against a GP floor rather than discovering the floor by hitting it.
 *
 * @returns Affordable, permitted purchases, cheapest first.
 */
export function readShopCandidates(): {
  purchaseId: string;
  name: string;
  gpCost: number;
  owned: number;
}[] {
  return game.shop.purchases.allObjects
    .filter((purchase) => categoricalRefusal(purchase) === null)
    .filter((purchase) => !game.shop.isPurchaseAtBuyLimit(purchase))
    .filter((purchase) => game.checkRequirements(purchase.purchaseRequirements, false))
    .filter((purchase) => game.shop.getPurchaseCosts(purchase, 1).checkIfOwned())
    .map((purchase) => ({
      purchaseId: purchase.id,
      name: purchase.name,
      gpCost: gpCostOf(purchase),
      owned: game.shop.getPurchaseCount(purchase),
    }))
    .sort((a, b) => a.gpCost - b.gpCost);
}

/** GP component of a single purchase, or 0 when it costs another currency. */
function gpCostOf(purchase: ShopPurchase): number {
  const costs = game.shop.getPurchaseCosts(purchase, 1);
  return (
    costs.getCurrencyQuantityArray().find((entry) => entry.currency === game.gp)?.quantity ?? 0
  );
}

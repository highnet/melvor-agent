import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { noteSwallowed } from './safe.js';

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
 * Runs a shop call with the shop page's quantity dropdown pinned, then restores it.
 *
 * `buyItemOnClick` buys `shop.buyQuantity` (shop.d.ts:232) and not a quantity
 * passed in — the parameter was validated and then ignored, so "buy 25 shards"
 * bought one, an objective reporting success having done a twenty-fifth of its
 * job. Setting the field is therefore not optional.
 *
 * Leaving it set is the half this fixes. The field is the shop page's own buy
 * quantity selector — `updateBuyQuantity` is documented as its callback
 * (shop.d.ts:263) — so a human's next click bought whatever the agent last
 * asked for: twenty-five of something they wanted one of. Not a correctness
 * problem for the agent, which sets the field on every purchase; purely a
 * surprise for the operator, whose game this is.
 *
 * The same shape as `withTownBiome` and `withBuildQuantity` in `township.ts`,
 * and deliberately a third small copy rather than a shared helper: this field
 * is a plain `number`, while `currentTownBiome` is optional and has to be
 * restored to *absent* rather than to `undefined`, so the one abstraction that
 * covered all three would have to carry that distinction into every call site
 * to save five lines at each of them.
 *
 * @typeParam T - Whatever the wrapped call returns; passed straight back.
 */
function withBuyQuantity<T>(quantity: number, call: () => T): T {
  const previous = game.shop.buyQuantity;
  game.shop.buyQuantity = quantity;
  try {
    return call();
  } finally {
    game.shop.buyQuantity = previous;
  }
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
      perform: () =>
        withBuyQuantity(quantity, () => {
          // `confirmed` skips the modal, which nothing would answer.
          game.shop.buyItemOnClick(purchase, true);
        }),
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
export function gpCostOf(purchase: ShopPurchase): number {
  const costs = game.shop.getPurchaseCosts(purchase, 1);
  return (
    costs.getCurrencyQuantityArray().find((entry) => entry.currency === game.gp)?.quantity ?? 0
  );
}

/**
 * Permanent upgrades cheap enough that not owning them is simply an oversight.
 *
 * These were sitting unbought for a whole session: an Iron Axe at 50 GP, an
 * Iron Fishing Rod at 100, an Iron Pickaxe at 250, against 43,860 GP held.
 * Each is a permanent -5% interval on a skill the agent actually trains, and
 * every one of them was on the candidate list the entire time — at index 120 of
 * 227, where a planner reading top-down never reached it. Surfacing a thing is
 * not the same as doing it.
 *
 * Restricted to purchases that grant *no items*: a pure modifier upgrade. That
 * is not a stylistic filter but the safety property that makes this reflex-safe
 * on two counts. It cannot consume a bank slot, so it can never make the
 * full-bank problem worse; and it cannot buy consumables — compost, dragonhide,
 * summoning shards — where "how many" is a judgement the planner should keep.
 * A one-off upgrade has no such judgement: the only wrong quantity is zero.
 */
export function readCheapPermanentUpgrades(): {
  purchaseId: string;
  name: string;
  gpCost: number;
}[] {
  return (
    game.shop.purchases.allObjects
      .filter((purchase) => categoricalRefusal(purchase) === null)
      .filter((purchase) => !purchase.allowQuantityPurchase)
      .filter((purchase) => game.shop.getPurchaseCount(purchase) === 0)
      .filter((purchase) => !game.shop.isPurchaseAtBuyLimit(purchase))
      // Grants modifiers only — no items, no pet, no loot box, no bank tab.
      .filter((purchase) => purchase.contains.items.length === 0)
      .filter((purchase) => purchase.contains.pet === undefined)
      .filter((purchase) => purchase.contains.lootBox !== true)
      .filter((purchase) => purchase.contains.bankTab !== true)
      .filter((purchase) => game.checkRequirements(purchase.purchaseRequirements, false))
      .filter((purchase) => game.shop.getPurchaseCosts(purchase, 1).checkIfOwned())
      .map((purchase) => ({
        purchaseId: purchase.id,
        name: purchase.name,
        gpCost: gpCostOf(purchase),
      }))
      .filter((entry) => entry.gpCost > 0)
      .sort((a, b) => a.gpCost - b.gpCost)
  );
}

/**
 * An unowned purchase whose every requirement is met and whose only obstacle
 * is money.
 *
 * The distinction in that sentence is the whole point of the type. `Rune
 * Fishing Rod` costs 300,000 against a balance of 174,154 and its sole
 * requirement, `Fishing 60`, is **met** — so earning 125,846 GP buys it, and
 * that is an objective. `Mahogany Cooking Fire` is also unaffordable and its
 * requirement is `Firemaking 55` against 32 — so no amount of earning buys it,
 * and offering it as something to save for would send the run after money it
 * could not spend. Conflating the two is how a saving list becomes noise.
 */
export interface MoneyBlockedUpgrade {
  purchaseId: string;
  name: string;
  /** The GP price of one, from the game's own cost object. */
  gpCost: number;
  /** GP still to earn: `gpCost` minus what is held, always above zero. */
  shortfall: number;
  /**
   * What owning it does, in the game's own words.
   *
   * `describePlain` (statProvider.d.ts:34) over `contains.stats`
   * (shop.d.ts:149). Empty for a purchase that grants no modifiers, which is
   * every consumable — and that emptiness is itself the signal that there is
   * no permanent benefit here to weigh against the price.
   */
  effect: string;
  /**
   * Skills the granted modifiers are scoped to, from `ModifierValue.skill`
   * (modifiers.d.ts:56, inherited from `ModifierScope` at :55).
   *
   * This is the only honest input to "is this worth saving for *now*": a -5%
   * Fishing interval is worth a great deal with hours of fishing queued and
   * almost nothing otherwise, and the game states which skill it touches. It
   * is deliberately a set of ids and not a score — see
   * `readShopGoalNotice`, which ranks with it and explains why the payback
   * itself is left unpriced.
   */
  skillIds: string[];
}

/**
 * Whether GP is the *only* thing standing between the character and a purchase.
 *
 * `getPurchaseCosts(...).checkIfOwned()` (shop.d.ts:258, skill.d.ts:1123)
 * answers "can this be bought", which is the wrong question here: it is false
 * for a Slayer-coin upgrade, for one that eats banked items, and for one that
 * is merely expensive, and only the last is fixed by earning. Funding a target
 * the money cannot unblock is the same wasted plan as chasing a level-gated
 * one, arriving by a different route.
 *
 * Every non-GP currency cost and every item cost is checked against what is
 * held, so a purchase reaches the saving list only when paying its GP would
 * complete it.
 */
function gpIsTheOnlyObstacle(purchase: ShopPurchase): boolean {
  const costs = game.shop.getPurchaseCosts(purchase, 1);

  for (const entry of costs.getCurrencyQuantityArray()) {
    if (entry.currency === game.gp) continue;
    // `Currency.amount` (currency.d.ts:41).
    if (entry.quantity > entry.currency.amount) return false;
  }

  for (const entry of costs.getItemQuantityArray()) {
    if (game.bank.getQty(entry.item) < entry.quantity) return false;
  }

  return true;
}

/** The skills a purchase's granted modifiers are scoped to, deduplicated. */
function modifiedSkillIds(purchase: ShopPurchase): string[] {
  const ids = new Set<string>();

  for (const modifier of purchase.contains.stats?.modifiers ?? []) {
    const skillId = modifier.skill?.id;
    if (skillId !== undefined) ids.add(skillId);
  }

  return [...ids];
}

/**
 * Purchases the character has qualified for and cannot yet afford, cheapest
 * shortfall first.
 *
 * Every other shop reader filters on affordability, which means the things
 * worth *saving for* do not exist until the saving is already done. Auto Eat at
 * 1,000,000 GP was the case that proved it: the single upgrade that removes the
 * failure mode which has killed this character twice, and it appears on no list
 * anywhere until the million is banked. An operator had to carry the target in
 * their head and check it by hand every pass.
 *
 * Reported as goals rather than candidates, deliberately. A candidate is
 * something the agent has proven it can do right now, and keeping that
 * guarantee absolute is what makes choosing by index safe. These are the
 * opposite: known, priced, and out of reach — which is exactly the information
 * a planner needs to decide what to earn.
 *
 * Three filters make the list actionable rather than merely long, and each
 * excludes a different kind of unreachable:
 *
 * - `checkRequirements` — a level-blocked purchase is not bought by earning.
 * - {@link gpIsTheOnlyObstacle} — nor is one blocked on Slayer Coins or stock.
 * - `getPurchaseCount === 0` — an owned upgrade is not an opportunity, and the
 *   operator's rule is about upgrades the character has *qualified for* and
 *   does not have.
 *
 * This does **not** withhold spending anywhere. It is a list of things to
 * earn toward; nothing downstream refuses a purchase because a target exists,
 * which is what keeps it clear of the failure the bank-slot cap had — a guard
 * whose only replenishment was the thing it blocked.
 */
export function readMoneyBlockedUpgrades(): MoneyBlockedUpgrade[] {
  try {
    const held = game.gp.amount;

    return game.shop.purchases.allObjects
      .filter((purchase) => categoricalRefusal(purchase) === null)
      .filter((purchase) => !game.shop.isPurchaseAtBuyLimit(purchase))
      .filter((purchase) => game.shop.getPurchaseCount(purchase) === 0)
      .filter((purchase) => game.checkRequirements(purchase.purchaseRequirements, false))
      .filter((purchase) => gpCostOf(purchase) > held)
      .filter((purchase) => gpIsTheOnlyObstacle(purchase))
      .map((purchase) => ({
        purchaseId: purchase.id,
        name: purchase.name,
        gpCost: gpCostOf(purchase),
        shortfall: gpCostOf(purchase) - held,
        effect: safeEffect(purchase),
        skillIds: modifiedSkillIds(purchase),
      }))
      .sort((a, b) => a.shortfall - b.shortfall);
  } catch (error) {
    noteSwallowed('shop.readMoneyBlockedUpgrades', error);
    return [];
  }
}

/**
 * The purchase's effect text, or an empty string.
 *
 * Guarded on its own site rather than under the reader's catch: a purchase
 * whose modifier descriptions will not render is still a perfectly good saving
 * target at a known price, and losing the entire list to one unrenderable
 * entry would be the diagnostic swallowing the answer.
 */
function safeEffect(purchase: ShopPurchase): string {
  try {
    return purchase.contains.stats?.describePlain() ?? '';
  } catch (error) {
    noteSwallowed('shop.purchaseEffect', error);
    return '';
  }
}

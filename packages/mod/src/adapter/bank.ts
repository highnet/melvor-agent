import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/** What selling claims to change: less of the item, more of the currency. */
export interface SaleProjection {
  itemId: string;
  bankQty: number;
  currencyId: string;
  currencyAmount: number;
}

/**
 * Quantity of an item held in the bank.
 *
 * @param itemId - Namespaced item id.
 * @returns The stack size, or 0 when the bank holds none.
 */
export function readBankQuantity(itemId: string): number {
  const item = game.items.getObjectByID(itemId);
  if (item === undefined) return 0;
  return game.bank.getQty(item);
}

/**
 * Sells items from the bank.
 *
 * Selling is permitted — the agent may spend and consume — but it is the first
 * capability that destroys something, so the guards are structural rather than
 * advisory:
 *
 * - **Locked items are never sold.** `bank.lockedItems` is the operator's own
 *   marking, made in the game's UI, and it is the one signal that reliably means
 *   "not this". Honouring it costs nothing and is the cheapest protection
 *   against losing something irreplaceable.
 * - **Zero-value items are never sold.** An item that yields nothing is being
 *   destroyed for no gain, and a zero sell value is a common marker for quest
 *   and unique items.
 * - **The item must be named explicitly.** There is deliberately no "sell
 *   everything" or "sell by filter" action, so a bad plan can lose one stack,
 *   never a bank.
 *
 * `Bank.processItemSale` returns `void`, so success is established by observing
 * both sides of the trade: the stack shrank *and* the currency grew.
 *
 * @param itemId - Namespaced item id to sell.
 * @param quantity - How many to sell. Must be positive and available.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence of the completed sale.
 */
export function sellItem(
  itemId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<SaleProjection> {
  const item = game.items.getObjectByID(itemId);
  if (item === undefined) {
    return fail('bank.sellItem', 'precondition', `no item registered with id ${itemId}`);
  }

  const currency = item.sellsFor.currency;
  const unitValue = item.sellsFor.quantity;

  const project = (): SaleProjection => ({
    itemId,
    bankQty: game.bank.getQty(item),
    currencyId: currency.id,
    currencyAmount: currency.amount,
  });

  return act(
    {
      name: 'bank.sellItem',
      observe: project,
      precondition: () => {
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        if (game.bank.lockedItems.has(item)) {
          return `item ${itemId} is locked in the bank; refusing to sell`;
        }
        if (unitValue <= 0) {
          return `item ${itemId} sells for nothing; selling would destroy it for no gain`;
        }
        const held = game.bank.getQty(item);
        if (held < quantity) {
          return `bank holds ${held} of ${itemId}, cannot sell ${quantity}`;
        }
        return null;
      },
      perform: () => game.bank.processItemSale(item, quantity),
      // Both sides must move. A currency gain with no stack change would mean
      // something else paid out during the same tick, not that the sale worked.
      changed: (before, after) =>
        after.bankQty === before.bankQty - quantity && after.currencyAmount > before.currencyAmount,
    },
    isSuspended,
  );
}

/** Below this many free slots, the bank is worth acting on before it stops play. */
const BANK_PRESSURE_SLOTS = 2;

/**
 * Warns when the bank is about to stop the character working.
 *
 * A full bank does not announce itself. Gathering an item type the bank has no
 * room for simply produces nothing, while the skill keeps running and the XP
 * keeps ticking — so an agent watching only "is the skill active" sees a
 * perfectly healthy run that is quietly throwing away every drop.
 *
 * Reported rather than fixed. The remedies are selling something or buying a
 * slot, both of which are decisions with costs, and both of which the agent
 * already has capabilities for.
 *
 * @returns One blocked-opportunity entry, or none when there is room.
 */
export function readBankPressure(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const used = game.bank.occupiedSlots;
  const max = game.bank.maximumSlots;
  const free = max - used;

  if (free > BANK_PRESSURE_SLOTS) return [];

  return [
    {
      label:
        free <= 0
          ? `Bank is FULL (${used}/${max}) — any new item type is being discarded silently while the skill keeps running. Sell a stack or buy a slot.`
          : `Bank has ${free} slot(s) left (${used}/${max}) — new item types will start being discarded. Sell a stack or buy a slot.`,
      xpPerHour: 0,
      missing: [],
    },
  ];
}

import type { ActionResult, Candidate } from '@melvor-agent/shared';
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

/**
 * Buries bones for Prayer XP and Prayer points.
 *
 * The only source of both. Prayer cannot be trained any other way, and prayers
 * cannot be used without points, so bones left in the bank are the whole skill
 * left unplayed — and combat produces them steadily whether or not anything
 * uses them.
 *
 * **Burying grants prayer points, not Prayer XP.** Verified live: 52 bones went
 * from the bank and Prayer XP stayed at 0. The XP comes later, from *spending*
 * those points during combat. Requiring XP to rise made every successful bury
 * report as a no-op and retry.
 *
 * `buryItemOnClick` returns void and silently does nothing for a non-bone, so
 * the evidence taken is the stack falling while points do not fall. Points are
 * not required to rise, because they cap: burying into a full bar is wasteful
 * but not a failure to observe.
 *
 * @param itemId - Namespaced `BoneItem` id, already in the bank.
 * @param quantity - How many to bury. Capped at what the bank holds.
 */
export function buryBones(
  itemId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<{ held: number; prayerPoints: number }> {
  const item = game.items.getObjectByID(itemId);
  if (item === undefined || !(item instanceof BoneItem)) {
    return fail('bank.buryBones', 'precondition', `${itemId} is not a bone`);
  }

  const project = (): { held: number; prayerPoints: number } => ({
    held: game.bank.getQty(item),
    prayerPoints: game.combat.player.prayerPoints,
  });

  return act(
    {
      name: 'bank.buryBones',
      observe: project,
      precondition: () => {
        const held = game.bank.getQty(item);
        if (held <= 0) return `bank holds no ${itemId}`;
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        return null;
      },
      perform: () => game.bank.buryItemOnClick(item, Math.min(quantity, game.bank.getQty(item))),
      changed: (before, after) =>
        after.held < before.held && after.prayerPoints >= before.prayerPoints,
    },
    isSuspended,
  );
}

/**
 * Bones worth burying.
 *
 * Offered whenever any are held: there is no reason to hoard them, no recipe
 * consumes them, and Prayer is otherwise untrainable.
 */
export function readBoneCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const entry of game.bank.items.values()) {
    if (!(entry.item instanceof BoneItem)) continue;

    try {
      const points = game.bank.getPrayerPointsPerBone(entry.item);
      candidates.push({
        kind: 'bury_bones',
        params: { kind: 'bury_bones', itemId: entry.item.id, quantity: entry.quantity },
        label: `Bury ${entry.quantity}x ${entry.item.name} for ${points} prayer points each — points are what prayers spend, and spending them in combat is what trains Prayer`,
        available: true,
      });
    } catch {
      // A bone that cannot price itself is not a candidate.
    }
  }

  return candidates;
}

/**
 * Opens a container item — bird nests, chests, loot bags.
 *
 * These sit in the bank looking like ordinary items and are the game's way of
 * handing out things that have no other source. Bird nests hold Farming seeds,
 * which is the only reachable seed supply for a character whose Thieving tier
 * is too low to drop them — so an agent that cannot open a nest cannot start
 * Farming, and therefore cannot start Herblore either.
 *
 * The open call returns void and the contents are random, so the evidence is
 * the container leaving the bank rather than any particular reward arriving.
 *
 * @param itemId - Namespaced `OpenableItem` id, already in the bank.
 * @param quantity - How many to open. Capped at what the bank holds.
 */
export function openItem(
  itemId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<{ held: number; bankSlots: number }> {
  const item = game.items.getObjectByID(itemId);
  if (item === undefined || !(item instanceof OpenableItem)) {
    return fail('bank.openItem', 'precondition', `${itemId} is not an openable item`);
  }

  const project = (): { held: number; bankSlots: number } => ({
    held: game.bank.getQty(item),
    bankSlots: game.bank.occupiedSlots,
  });

  return act(
    {
      name: 'bank.openItem',
      observe: project,
      precondition: () => {
        const held = game.bank.getQty(item);
        if (held <= 0) return `bank holds no ${itemId}`;
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        // Contents need somewhere to go; a full bank discards them silently,
        // the same way it discards anything a skill produces.
        if (game.bank.occupiedSlots >= game.bank.maximumSlots) {
          return `bank is full (${game.bank.occupiedSlots}/${game.bank.maximumSlots}); the contents would be discarded`;
        }
        return null;
      },
      // `openItemOnClick` is the click *callback* and can raise a confirmation
      // nothing here will answer — observed live as a nest that stayed in the
      // bank while the reflex reported no state change. `processItemOpen` is
      // documented as performing the actual opening, the same distinction as
      // the shop's `confirmed` flag and confirmTownCreation.
      perform: () => game.bank.processItemOpen(item, Math.min(quantity, game.bank.getQty(item))),
      // The container leaving is the evidence: what comes out is random, and a
      // reward that happened to stack with something already held would show no
      // new slot at all.
      changed: (before, after) => after.held < before.held,
    },
    isSuspended,
  );
}

/** Containers worth opening. */
export function readOpenableCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const entry of game.bank.items.values()) {
    if (!(entry.item instanceof OpenableItem)) continue;

    candidates.push({
      kind: 'open_item',
      params: { kind: 'open_item', itemId: entry.item.id, quantity: entry.quantity },
      label: `Open ${entry.quantity}x ${entry.item.name} — containers hold things with no other source, and a nest is the only seed supply below Thieving's higher tiers`,
      available: true,
    });
  }

  return candidates;
}

/** The first container in the bank worth opening, if any. */
export function readNextContainer(): { itemId: string; quantity: number } | null {
  if (game.bank.occupiedSlots >= game.bank.maximumSlots) return null;

  for (const entry of game.bank.items.values()) {
    if (entry.item instanceof OpenableItem) {
      return { itemId: entry.item.id, quantity: entry.quantity };
    }
  }

  return null;
}

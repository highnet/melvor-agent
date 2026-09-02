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
 * What the bank actually threw away, by the game's own count.
 *
 * `Bank.lostItems` (bank2.d.ts:78) is the game recording every item it tried to
 * add and could not fit. Nothing in this mod had ever read it, so the only thing
 * said about a full bank was the speculative warning below — "new item types
 * *will* start being discarded" — which is a prediction where a measurement was
 * sitting one accessor away.
 *
 * Two honest limits, both stated because they change how the number should be
 * read and neither of them makes it a false positive:
 *
 * - The typings describe the map as being for offline progress, and do not say
 *   when the game clears it. So this is a floor on what has been lost since it
 *   was last cleared, never a ceiling and never a total for the run.
 * - A non-empty map is nonetheless proof. The game only writes to it when an
 *   add has already failed, so anything in here is a drop that is gone.
 *
 * @returns Item names and quantities that did not fit, largest loss first.
 */
export function readLostItems(): { name: string; quantity: number }[] {
  const lost: { name: string; quantity: number }[] = [];

  for (const [item, quantity] of game.bank.lostItems) {
    if (quantity <= 0) continue;
    try {
      lost.push({ name: item.name, quantity });
    } catch {
      // An item that cannot name itself is still a loss, but not one that can
      // be reported usefully.
    }
  }

  return lost.sort((a, b) => b.quantity - a.quantity);
}

/** How many discarded item types to name before summarising the rest. */
const LOST_ITEMS_NAMED = 4;

/**
 * Warns when the bank is about to stop the character working, and reports what
 * it has already destroyed.
 *
 * A full bank does not announce itself. Gathering an item type the bank has no
 * room for simply produces nothing, while the skill keeps running and the XP
 * keeps ticking — so an agent watching only "is the skill active" sees a
 * perfectly healthy run that is quietly throwing away every drop.
 *
 * The loss line is separate from the pressure line and deliberately not gated on
 * free slots. A discard that has already happened is a fact whatever the bank
 * looks like now — a slot bought since, or a stack sold, does not bring the
 * items back — and the two lines answer different questions: one is a countdown,
 * the other is a receipt. See {@link readLostItems} for what the receipt covers.
 *
 * Reported rather than fixed. The remedies are selling something or buying a
 * slot, both of which are decisions with costs, and both of which the agent
 * already has capabilities for — and both of which now have a measured number to
 * argue with instead of a warning about the future.
 *
 * @returns Blocked-opportunity entries, or none when there is room and nothing
 *          has been lost.
 */
export function readBankPressure(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const used = game.bank.occupiedSlots;
  const max = game.bank.maximumSlots;
  const free = max - used;

  const entries: ReturnType<typeof readBankPressure> = [];

  const lost = readLostItems();
  if (lost.length > 0) {
    const total = lost.reduce((sum, entry) => sum + entry.quantity, 0);
    const named = lost
      .slice(0, LOST_ITEMS_NAMED)
      .map((entry) => `${entry.quantity}x ${entry.name}`)
      .join(', ');
    const rest =
      lost.length > LOST_ITEMS_NAMED ? ` and ${lost.length - LOST_ITEMS_NAMED} more` : '';

    entries.push({
      label: `Bank has already DISCARDED ${total} item(s) it could not fit: ${named}${rest}. This is the game's own record of what was lost, not a prediction — buy a slot or sell a stack before gathering more of these.`,
      xpPerHour: 0,
      missing: [],
    });
  }

  if (free <= BANK_PRESSURE_SLOTS) {
    entries.push({
      label:
        free <= 0
          ? `Bank is FULL (${used}/${max}) — any new item type is being discarded silently while the skill keeps running. Sell a stack or buy a slot.`
          : `Bank has ${free} slot(s) left (${used}/${max}) — new item types will start being discarded. Sell a stack or buy a slot.`,
      xpPerHour: 0,
      missing: [],
    });
  }

  return entries;
}

/** The shop's bank-slot purchase, or null when it is unavailable or unaffordable. */
export function readBankExpansion(): { purchaseId: string; gpCost: number; held: number } | null {
  const purchase = game.shop.purchases.getObjectByID('melvorD:Extra_Bank_Slot');
  if (purchase === undefined) return null;
  if (game.shop.isPurchaseAtBuyLimit(purchase)) return null;
  if (!game.checkRequirements(purchase.purchaseRequirements, false)) return null;

  const costs = game.shop.getPurchaseCosts(purchase, 1);
  if (!costs.checkIfOwned()) return null;

  const gpCost =
    costs.getCurrencyQuantityArray().find((entry) => entry.currency === game.gp)?.quantity ?? 0;

  return { purchaseId: purchase.id, gpCost, held: game.gp.amount };
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

/** A bone stack in the bank, with what burying it is worth. */
export interface BuriableBones {
  itemId: string;
  name: string;
  quantity: number;
  /** Prayer points each bone converts into, from the game's own accessor. */
  pointsEach: number;
}

/**
 * Bones held, richest first.
 *
 * Shared by the candidate list and the burying reflex so the two cannot disagree
 * about what is in the bank. Richest first because the reflex takes one stack
 * per pass and points are what everything downstream is short of.
 */
export function readBuriableBones(): BuriableBones[] {
  const bones: BuriableBones[] = [];

  for (const entry of game.bank.items.values()) {
    if (!(entry.item instanceof BoneItem)) continue;
    if (entry.quantity <= 0) continue;

    try {
      bones.push({
        itemId: entry.item.id,
        name: entry.item.name,
        quantity: entry.quantity,
        pointsEach: game.bank.getPrayerPointsPerBone(entry.item),
      });
    } catch {
      // A bone that cannot price itself is not offered.
    }
  }

  return bones.sort((a, b) => b.quantity * b.pointsEach - a.quantity * a.pointsEach);
}

/**
 * Bones worth burying.
 *
 * Offered whenever any are held: there is no reason to hoard them, no recipe
 * consumes them, and Prayer is otherwise untrainable.
 */
export function readBoneCandidates(): Candidate[] {
  return readBuriableBones().map((bone) => ({
    kind: 'bury_bones',
    params: { kind: 'bury_bones', itemId: bone.itemId, quantity: bone.quantity },
    label: `Bury ${bone.quantity}x ${bone.name} for ${bone.pointsEach} prayer points each — points are what prayers spend, and spending them in combat is what trains Prayer`,
    available: true,
  }));
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

/**
 * Claims a Mastery Token, pouring its percentage into the skill's mastery pool.
 *
 * Tokens were invisible to this agent in the worst possible way: not merely
 * unclaimable, but offered *for sale*. `readOpenableCandidates` filters on
 * `instanceof OpenableItem` and a `MasteryTokenItem` is a sibling class, not a
 * subclass — so the container reflex could never see one, while the sell reader,
 * which filters on nothing of the sort, happily listed six Woodcutting tokens
 * as a stack to liquidate.
 *
 * One caveat carried deliberately into the code. Unlike opening — where
 * `openItemOnClick` raises a confirmation nothing here will answer and
 * `processItemOpen` does the real work — the typings expose *only*
 * `claimMasteryTokenOnClick`. There is no process-level counterpart to call, so
 * this uses the click callback knowing it may raise a modal, which would show
 * up as a no-state-change failure rather than a silent success.
 *
 * That is why the evidence is the pool, not the bank. A token leaving the bank
 * proves a click landed; mastery pool XP rising proves the claim actually paid
 * out, and it distinguishes the case where the pool is already full.
 *
 * @param itemId - Namespaced `MasteryTokenItem` id, already in the bank.
 * @param quantity - How many to claim. Capped at what the bank holds.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function claimMasteryToken(
  itemId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<{ held: number; poolXp: number }> {
  const item = game.items.getObjectByID(itemId);
  if (item === undefined || !(item instanceof MasteryTokenItem)) {
    return fail('bank.claimMasteryToken', 'precondition', `${itemId} is not a mastery token`);
  }

  const project = (): { held: number; poolXp: number } => ({
    held: game.bank.getQty(item),
    poolXp: item.skill.getMasteryPoolXP(item.realm),
  });

  return act(
    {
      name: 'bank.claimMasteryToken',
      observe: project,
      precondition: () => {
        const held = game.bank.getQty(item);
        if (held <= 0) return `bank holds no ${itemId}`;
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        return null;
      },
      perform: () =>
        game.bank.claimMasteryTokenOnClick(item, Math.min(quantity, game.bank.getQty(item))),
      // Pool XP, not the bank count: a token leaving proves a click landed,
      // while the pool rising proves it paid out.
      changed: (before, after) => after.poolXp > before.poolXp || after.held < before.held,
    },
    isSuspended,
  );
}

/**
 * Mastery Tokens sitting in the bank.
 *
 * Their own reader, because they are not `OpenableItem`s and the container
 * reader's `instanceof` check excludes them by construction.
 */
export function readMasteryTokenCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const entry of game.bank.items.values()) {
    if (!(entry.item instanceof MasteryTokenItem)) continue;

    candidates.push({
      kind: 'claim_mastery_token',
      params: {
        kind: 'claim_mastery_token',
        itemId: entry.item.id,
        quantity: entry.quantity,
      },
      label: `Claim ${entry.quantity}x ${entry.item.name} — each pours ${entry.item.percent}% into the ${entry.item.skill.name} mastery pool, and holding one does nothing`,
      available: true,
    });
  }

  return candidates;
}

/** Ids of every Mastery Token held, so the sell reader can refuse them. */
export function readMasteryTokenIds(): Set<string> {
  const ids = new Set<string>();
  try {
    for (const entry of game.bank.items.values()) {
      if (entry.item instanceof MasteryTokenItem) ids.add(entry.item.id);
    }
  } catch {
    // Failing to protect a token beats failing to build the sell list.
  }
  return ids;
}

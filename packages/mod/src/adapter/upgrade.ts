import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/**
 * Turning items into better items.
 *
 * Bank upgrades are how ordinary gear becomes usable gear — a set of armour
 * into its (G) version, a pile of bars into a component. The materials sit in
 * the bank doing nothing until someone combines them, and "sitting in the bank
 * doing nothing" is invisible to an agent that measures only XP per hour.
 *
 * Upgrading consumes the inputs and cannot be undone, which is why it is a
 * planner decision with the full cost in the label rather than a reflex.
 */

/** What upgrading claims to change: how many of the upgraded item exist. */
export interface UpgradeProjection {
  itemId: string;
  quantity: number;
}

/**
 * Upgrades an item in the bank.
 *
 * Identified by the *result*, not by a recipe id, because `ItemUpgrade` has no
 * id of its own — the upgraded item is the only stable name the pair has.
 *
 * @param upgradedItemId - The item to end up with.
 * @param quantity - How many upgrades to perform.
 * @param allowDowngrade - Whether a downgrade is acceptable. Never true from a
 *                         candidate; only from an objective that asked for one.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function upgradeBankItem(
  upgradedItemId: string,
  quantity: number,
  allowDowngrade: boolean,
  isSuspended: () => boolean,
): ActionResult<UpgradeProjection> {
  const item = game.items.getObjectByID(upgradedItemId);
  if (item === undefined) {
    return fail('bank.upgrade', 'precondition', `no item ${upgradedItemId}`);
  }

  const upgrade = findUpgradeTo(upgradedItemId);
  if (upgrade === null) {
    return fail(
      'bank.upgrade',
      'precondition',
      `nothing in the bank upgrades into ${upgradedItemId}`,
    );
  }

  const project = (): UpgradeProjection => ({
    itemId: upgradedItemId,
    quantity: game.bank.getQty(item),
  });

  return act(
    {
      name: 'bank.upgrade',
      observe: project,
      precondition: () => {
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        // Downgrades destroy the better item for a refund. They are a real
        // feature and the agent may perform one — but only when the objective
        // says so outright, because nothing that enumerates candidates will
        // ever propose it, and a default of "sure" turns a typo into a loss.
        if (upgrade.isDowngrade && !allowDowngrade) {
          return `${upgradedItemId} is a downgrade; the objective did not allow one`;
        }
        const missing = missingCosts(upgrade, quantity);
        if (missing !== null) return missing;
        return null;
      },
      perform: () => game.bank.upgradeItemOnClick(upgrade, quantity),
      changed: (before, after) => after.quantity > before.quantity,
    },
    isSuspended,
  );
}

/** The upgrade whose result is the given item, if the bank holds its roots. */
function findUpgradeTo(upgradedItemId: string): ItemUpgrade | null {
  for (const upgrades of game.bank.itemUpgrades.values()) {
    for (const upgrade of upgrades) {
      if (upgrade.upgradedItem.id === upgradedItemId) return upgrade;
    }
  }
  return null;
}

/** Describes the first unaffordable cost, or null when everything is in hand. */
function missingCosts(upgrade: ItemUpgrade, quantity: number): string | null {
  for (const cost of upgrade.itemCosts) {
    const held = game.bank.getQty(cost.item);
    if (held < cost.quantity * quantity) {
      return `needs ${cost.quantity * quantity}x ${cost.item.name}, bank has ${held}`;
    }
  }

  for (const cost of upgrade.currencyCosts) {
    if (cost.currency.amount < cost.quantity * quantity) {
      return `needs ${cost.quantity * quantity} ${cost.currency.name}, have ${cost.currency.amount}`;
    }
  }

  return null;
}

/**
 * Upgrades the bank can currently afford.
 *
 * Downgrades are excluded outright — they exist for players who want a
 * cosmetic or a refund, and doing one unattended destroys the better item for
 * nothing.
 *
 * The full cost goes in the label because the trade-off is the whole decision:
 * an upgrade is usually worth it, but not while the materials are earmarked
 * for something else.
 */
export function readUpgradeCandidates(): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const upgrades of game.bank.itemUpgrades.values()) {
    for (const upgrade of upgrades) {
      try {
        if (upgrade.isDowngrade) continue;
        if (seen.has(upgrade.upgradedItem.id)) continue;
        if (missingCosts(upgrade, 1) !== null) continue;

        seen.add(upgrade.upgradedItem.id);

        const cost = [
          ...upgrade.itemCosts.map((entry) => `${entry.quantity}x ${entry.item.name}`),
          ...upgrade.currencyCosts.map((entry) => `${entry.quantity} ${entry.currency.name}`),
        ].join(', ');

        candidates.push({
          kind: 'upgrade_item',
          params: {
            kind: 'upgrade_item',
            upgradedItemId: upgrade.upgradedItem.id,
            quantity: 1,
            allowDowngrade: false,
          },
          label: `Upgrade into ${upgrade.upgradedItem.name} for ${cost}`,
          available: true,
        });
      } catch {
        // An upgrade that cannot price itself is not a candidate.
      }
    }
  }

  return candidates;
}

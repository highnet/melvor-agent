import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/**
 * Wearing things.
 *
 * Without this the shop is half a feature: the agent could buy an Iron Axe and
 * never wear it, so every gear purchase was pure loss. Food matters even more —
 * equipped food is what gates Thieving (a failed pickpocket deals damage) and
 * the whole combat survivability gate, so an agent that cannot equip food can
 * never unlock either.
 */

/** What equipping claims to change: which item occupies the slot. */
export interface EquipProjection {
  slot: string;
  itemId: string | null;
  quantity: number;
}

function projectSlot(slotId: string): EquipProjection {
  const equipped = game.combat.player.equipment.equippedItems[slotId];
  if (equipped === undefined) return { slot: slotId, itemId: null, quantity: 0 };

  return {
    slot: slotId,
    itemId: equipped.item === equipped.emptyItem ? null : equipped.item.id,
    quantity: equipped.quantity,
  };
}

/**
 * Equips an item from the bank.
 *
 * `Player.equipItem` returns a boolean, but a `true` return does not prove the
 * slot changed — so the slot's occupant is observed either side, which is the
 * only evidence that holds.
 *
 * The slot is taken from the item's own `validSlots` rather than guessed. An
 * item can be valid in several (a shield in Shield, a torch in Passive), and
 * picking the wrong one silently no-ops.
 *
 * @param itemId - Namespaced `EquipmentItem` id, already in the bank.
 * @param slotId - Optional explicit slot; defaults to the item's first valid one.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function equipItem(
  itemId: string,
  slotId: string | undefined,
  isSuspended: () => boolean,
): ActionResult<EquipProjection> {
  const item = game.items.equipment.getObjectByID(itemId);
  if (item === undefined) {
    return fail('equipment.equip', 'precondition', `no equipment item registered as ${itemId}`);
  }

  const slot = slotId ?? item.validSlots[0]?.id;
  if (slot === undefined) {
    return fail('equipment.equip', 'precondition', `${itemId} has no valid equipment slot`);
  }

  const player = game.combat.player;

  return act(
    {
      name: 'equipment.equip',
      observe: () => projectSlot(slot),
      precondition: () => {
        if (game.bank.getQty(item) <= 0) return `bank holds no ${itemId}`;
        if (!item.validSlots.some((valid) => valid.id === slot)) {
          return `${itemId} cannot go in slot ${slot}`;
        }
        if (projectSlot(slot).itemId === itemId) return `${itemId} is already equipped`;
        // Mid-fight swaps are allowed: a human switches gear when the enemy
        // changes damage type, and refusing meant the agent could not play
        // dungeons properly. The survivability gate proved the fight winnable
        // with the *old* gear, so the policy tier's HP and food floors are what
        // catch a swap that made things worse.
        return null;
      },
      perform: () => player.equipItem(item, player.selectedEquipmentSet, item.validSlots[0], 1),
      changed: (_before, after) => after.itemId === itemId,
    },
    isSuspended,
  );
}

/**
 * Equips food.
 *
 * Separate from {@link equipItem} because food has its own slots and its own
 * game method. `Player.equipFood` returns `boolean | undefined`, which is the
 * clearest example in the codebase of why a return value is not evidence: a
 * truthiness check is simply wrong for it.
 *
 * @param itemId - Namespaced `FoodItem` id, already in the bank.
 * @param quantity - How many to equip. Capped at what the bank holds.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function equipFood(
  itemId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<{ itemId: string | null; quantity: number }> {
  const item = game.items.food.getObjectByID(itemId);
  if (item === undefined) {
    return fail('equipment.equipFood', 'precondition', `no food item registered as ${itemId}`);
  }

  const player = game.combat.player;

  const project = (): { itemId: string | null; quantity: number } => {
    const slot = player.food.currentSlot;
    return {
      itemId: slot.item === game.emptyFoodItem ? null : slot.item.id,
      quantity: slot.quantity,
    };
  };

  return act(
    {
      name: 'equipment.equipFood',
      observe: project,
      precondition: () => {
        const held = game.bank.getQty(item);
        if (held <= 0) return `bank holds no ${itemId}`;
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        return null;
      },
      perform: () => player.equipFood(item, Math.min(quantity, game.bank.getQty(item))),
      // Either the food changed, or more of the same food is now equipped.
      changed: (before, after) =>
        after.itemId === itemId && (before.itemId !== itemId || after.quantity > before.quantity),
    },
    isSuspended,
  );
}

/**
 * Gear in the bank that is worth wearing.
 *
 * Only *upgrades* are offered: an item whose slot is empty, or whose combined
 * offensive and defensive stats beat what is currently there. Offering every
 * equippable item would bury the planner in noise and invite pointless swaps.
 *
 * Food is offered separately and unconditionally when none is equipped, because
 * "no food at all" is not a marginal upgrade — it is the thing blocking Thieving
 * and combat outright.
 */
export function readEquipCandidates(): Candidate[] {
  const player = game.combat.player;
  const candidates: Candidate[] = [];

  for (const entry of game.bank.items.values()) {
    const item = entry.item;
    if (!(item instanceof EquipmentItem)) continue;

    const slot = item.validSlots[0];
    if (slot === undefined) continue;

    const current = projectSlot(slot.id);
    if (current.itemId === item.id) continue;

    const currentItem =
      current.itemId === null ? undefined : game.items.equipment.getObjectByID(current.itemId);

    if (currentItem !== undefined && statScore(item) <= statScore(currentItem)) continue;

    candidates.push({
      kind: 'equip_item',
      params: { kind: 'equip_item', itemId: item.id, slotId: slot.id },
      label:
        current.itemId === null
          ? `Equip ${item.name} (${slot.emptyName ?? slot.id} is empty)`
          : `Equip ${item.name} (replaces ${currentItem?.name ?? current.itemId})`,
      available: true,
    });
  }

  const foodSlot = player.food.currentSlot;
  if (foodSlot.item === game.emptyFoodItem || foodSlot.quantity === 0) {
    for (const entry of game.bank.items.values()) {
      if (!(entry.item instanceof FoodItem)) continue;
      candidates.push({
        kind: 'equip_food',
        params: { kind: 'equip_food', itemId: entry.item.id, quantity: entry.quantity },
        label: `Equip ${entry.quantity}x ${entry.item.name} as food (nothing equipped; blocks Thieving and combat)`,
        available: true,
      });
    }
  }

  return candidates;
}

/**
 * A single comparable number for a piece of gear.
 *
 * Crude on purpose. A real comparison depends on combat style, damage type and
 * what the rest of the set is doing — judgement the planner is better placed to
 * make than a scoring function here. This only has to be good enough to filter
 * out obvious downgrades.
 */
function statScore(item: EquipmentItem): number {
  const stats = item.equipmentStats;
  return stats.reduce((sum, stat) => sum + (typeof stat.value === 'number' ? stat.value : 0), 0);
}

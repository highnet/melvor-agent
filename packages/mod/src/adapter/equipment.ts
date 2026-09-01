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
 * How many of an item to put in a slot.
 *
 * Ammunition is the reason this exists. The call passed a hardcoded `1`, which
 * is right for a platebody and catastrophic for arrows: the agent equipped a
 * single Bronze Arrow out of a bank holding 1,259, fired it, and stood in a
 * fight with an empty quiver and no way to notice. The bank count dropping by
 * exactly one is what gave it away — a quantity bug is invisible in a slot
 * projection that only records which item is worn.
 *
 * Takes the slot's `allowQuantity` flag rather than the slot, so the rule is
 * testable without a live game: the flag is the game's own answer to "does this
 * slot hold a stack", and everything else here is arithmetic.
 */
export function equipQuantity(allowQuantity: boolean, heldQuantity: number): number {
  if (!allowQuantity) return 1;
  return Math.max(1, heldQuantity);
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

  const targetSlot =
    slotId === undefined
      ? item.validSlots[0]
      : (item.validSlots.find((valid) => valid.id === slotId) ??
        game.equipmentSlots.getObjectByID(slotId));
  if (targetSlot === undefined) {
    return fail('equipment.equip', 'precondition', `${itemId} has no valid equipment slot`);
  }
  const slot = targetSlot.id;

  const player = game.combat.player;

  return act(
    {
      name: 'equipment.equip',
      observe: () => projectSlot(slot),
      precondition: () => {
        if (game.bank.getQty(item) <= 0) return `bank holds no ${itemId}`;
        // The game refuses to equip gear whose requirements are unmet, and
        // `equipItem` signals that by returning false — which surfaced as five
        // identical "no state change" failures for an Oak Shortbow needing
        // Ranged 5. Asking first turns that into an answer.
        if (!game.checkRequirements(item.equipRequirements, false)) {
          return `${itemId} has unmet equip requirements`;
        }
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
      perform: () =>
        player.equipItem(
          item,
          player.selectedEquipmentSet,
          targetSlot,
          equipQuantity(targetSlot.allowQuantity, game.bank.getQty(item)),
        ),
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

    // Offering gear the character cannot wear is worse than not offering it:
    // the planner spends an objective discovering a level requirement the game
    // already knows.
    if (!game.checkRequirements(item.equipRequirements, false)) continue;

    // Nor gear that makes the character worse at the style it is fighting with.
    // See penalisesAttackStyle: a Steel Platebody read as an upgrade for an
    // archer and cost twenty minutes of unwinnable fighting.
    if (penalisesAttackStyle(item.equipmentStats, player.attackType)) continue;

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

/**
 * Attack bonus an item gives for one attack style.
 *
 * Melee is three keys rather than one — the game splits it by stab, slash and
 * block — so they are summed. Ranged and magic each have a single key.
 */
export function attackBonusFor(
  stats: readonly { key: string; value: number }[],
  attackType: string,
): number {
  const keys =
    attackType === 'ranged'
      ? ['rangedAttackBonus']
      : attackType === 'magic'
        ? ['magicAttackBonus']
        : ['stabAttackBonus', 'slashAttackBonus', 'blockAttackBonus'];

  return stats
    .filter((stat) => keys.includes(stat.key))
    .reduce((sum, stat) => sum + (typeof stat.value === 'number' ? stat.value : 0), 0);
}

/**
 * Whether wearing this would make the character worse at what it is doing.
 *
 * Melee armour carries a negative ranged attack bonus, and `statScore` sums
 * every stat blindly — so a Steel Platebody's large melee-defence numbers
 * drowned out its ranged penalty and it scored as an upgrade for an archer.
 * The agent equipped one as "free survivability" with an empty torso slot, and
 * then could not land a shot: full health, no kills, across two monsters in two
 * areas, for twenty minutes.
 *
 * A human does not wear plate to use a bow. Neither is this a close call worth
 * weighing against defence — an attack bonus that is negative for the style
 * actually in use makes the fight unwinnable, and no amount of armour
 * compensates for never hitting anything.
 */
export function penalisesAttackStyle(
  stats: readonly { key: string; value: number }[],
  attackType: string,
): boolean {
  return attackBonusFor(stats, attackType) < 0;
}

/**
 * Familiar pairs that would combine into a synergy.
 *
 * Summoning's real payoff is not the familiars individually — it is the
 * synergy between a specific *pair*, which applies a bonus neither gives
 * alone. A human checks the synergy table before equipping; an agent that
 * equips familiars one at a time by stat score will essentially never land on
 * a pair by accident, so this is the difference between Summoning being a
 * source of buffs and being a source of two mediocre trinkets.
 *
 * Only pairs whose tablets are both in the bank and whose synergy is unlocked
 * are offered, and only the half that is missing from the slots.
 */
export function readSynergyCandidates(): Candidate[] {
  const summoning = game.summoning;
  if (summoning === undefined) return [];

  const player = game.combat.player;
  const equipped = new Set<string>();
  for (const slotId of ['melvorD:Summon1', 'melvorD:Summon2']) {
    const item = projectSlot(slotId).itemId;
    if (item !== null) equipped.add(item);
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  for (const synergy of summoning.synergies) {
    try {
      if (!summoning.isSynergyUnlocked(synergy)) continue;

      const [first, second] = synergy.summons;
      const products = [first.product, second.product];

      // Both tablets must be in hand: suggesting half of a pair the character
      // cannot complete is a dead end dressed up as a plan.
      if (products.some((product) => game.bank.getQty(product) <= 0)) continue;

      const missing = products.filter((product) => !equipped.has(product.id));
      // Nothing to do when both are equipped, and a pair needing *both* slots
      // changed is offered one half at a time — equipping the first is a real
      // step toward the synergy either way.
      if (missing.length === 0) continue;

      const target = missing[0];
      if (target === undefined || seen.has(target.id)) continue;
      seen.add(target.id);

      candidates.push({
        kind: 'equip_item',
        params: { kind: 'equip_item', itemId: target.id, slotId: 'melvorD:Summon1' },
        label: `Equip ${target.name} for the ${synergy.name} synergy: ${synergy.description}`,
        available: true,
      });
    } catch {
      // A synergy that cannot be read is not a candidate.
    }
  }

  // Referenced so the player lookup above cannot be quietly dropped by a later
  // edit: the equipped set is read through it.
  void player;

  return candidates;
}

/**
 * Switches to another equipment set.
 *
 * Sets are how a human keeps a skilling loadout and a combat loadout without
 * re-equipping eight items each time. Without this the agent has one set and
 * pays the full swap cost for every context change — which in practice means
 * it never changes context at all.
 *
 * @param setIndex - Zero-based index into the character's equipment sets.
 */
export function changeEquipmentSet(
  setIndex: number,
  isSuspended: () => boolean,
): ActionResult<{ setIndex: number }> {
  const player = game.combat.player;

  return act(
    {
      name: 'equipment.changeSet',
      observe: () => ({ setIndex: player.selectedEquipmentSet }),
      precondition: () => {
        if (
          !Number.isInteger(setIndex) ||
          setIndex < 0 ||
          setIndex >= player.equipmentSets.length
        ) {
          return `there are ${player.equipmentSets.length} equipment sets; ${setIndex} is out of range`;
        }
        if (player.selectedEquipmentSet === setIndex) return `set ${setIndex} is already active`;
        // Swapping the whole loadout mid-fight invalidates everything the
        // survivability gate measured, all at once.
        if (game.combat.isActive) return 'in combat; refusing to swap the whole loadout';
        return null;
      },
      perform: () => player.changeEquipmentSet(setIndex),
      changed: (_before, after) => after.setIndex === setIndex,
    },
    isSuspended,
  );
}

/**
 * Eats one item from the equipped food slot.
 *
 * `Player.eatFood` returns void and silently does nothing with an empty slot,
 * so healing is proved by hitpoints rising and the slot falling — either alone
 * is ambiguous. A heal at full HP raises nothing, which is why the caller is
 * responsible for only asking when it is low.
 *
 * `interrupt: false` — eating must not stop the fight it is keeping alive.
 */
export function eatFood(
  isSuspended: () => boolean,
): ActionResult<{ hp: number; quantity: number }> {
  const player = game.combat.player;

  // Point the game at a slot that actually holds food before eating.
  // `currentSlot` returns the *selection*, not the food, and equipping food
  // does not select it — so a character can hold 33 chickens in slot 1 with
  // slot 0 selected and every attempt to eat reports "no food equipped".
  // That is how this character died with a full larder.
  if (player.food.currentSlot.quantity <= 0) {
    const stocked = player.food.slots.findIndex((slot) => slot.quantity > 0);
    if (stocked >= 0) player.food.selectedSlot = stocked;
  }

  const project = (): { hp: number; quantity: number } => ({
    hp: player.hitpoints,
    quantity: player.food.currentSlot.quantity,
  });

  return act(
    {
      name: 'equipment.eatFood',
      observe: project,
      precondition: () => {
        if (player.food.currentSlot.quantity <= 0) return 'no food equipped';
        if (player.hitpoints >= player.stats.maxHitpoints) {
          return 'already at full hitpoints; eating would waste the item';
        }
        return null;
      },
      perform: () => player.eatFood(1, false),
      changed: (before, after) => after.quantity < before.quantity && after.hp > before.hp,
    },
    isSuspended,
  );
}

/**
 * Equipment sets worth switching to.
 *
 * Only offered when another set actually holds something: an empty set is a
 * worse version of the current one, and switching to it would strip the
 * character mid-run. Most characters have one populated set, so this is
 * usually silent — which is correct, not a gap.
 */
export function readEquipmentSetCandidates(): Candidate[] {
  const player = game.combat.player;
  const candidates: Candidate[] = [];

  player.equipmentSets.forEach((set, index) => {
    try {
      if (index === player.selectedEquipmentSet) return;

      const equipped = set.equipment.equippedArray.filter(
        (slot) => slot.item !== slot.emptyItem,
      ).length;
      if (equipped === 0) return;

      candidates.push({
        kind: 'change_equipment_set',
        params: { kind: 'change_equipment_set', setIndex: index },
        label: `Switch to equipment set ${index + 1} (${equipped} item(s) equipped)`,
        available: true,
      });
    } catch {
      // A set that cannot be inspected is not a candidate.
    }
  });

  return candidates;
}

/**
 * Food held in the bank, most healing first.
 *
 * Exists so a reflex can refill an *empty* food slot, not merely top up what is
 * already there. An empty slot is precisely when the eat reflex cannot act, and
 * it is reached by ordinary play: Thieving and combat both consume food until
 * there is none left.
 */
export function readBankedFood(): { itemId: string; quantity: number }[] {
  const food: { itemId: string; quantity: number; heals: number }[] = [];

  for (const entry of game.bank.items.values()) {
    if (!(entry.item instanceof FoodItem)) continue;

    try {
      food.push({
        itemId: entry.item.id,
        quantity: entry.quantity,
        heals: game.combat.player.getFoodHealing(entry.item),
      });
    } catch {
      // Food whose healing cannot be read is still food; rank it last.
      food.push({ itemId: entry.item.id, quantity: entry.quantity, heals: 0 });
    }
  }

  return food
    .sort((a, b) => b.heals - a.heals)
    .map((entry) => ({ itemId: entry.itemId, quantity: entry.quantity }));
}

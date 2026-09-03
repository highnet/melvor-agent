import type { ActionResult, BlockedSeverity, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { describeUnmetRequirements } from './requirements.js';
import { noteSwallowed, safeValue } from './safe.js';

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
 * Takes something off.
 *
 * The counterpart that did not exist. The agent could put gear on and never
 * remove it, which is not a small omission: a human unequips constantly — to
 * swap damage types, to clear a slot, to undo a mistake — and without it every
 * equip was one-way and permanent.
 *
 * It became urgent rather than theoretical when a Steel Platebody was equipped
 * for its defence and turned out to carry a negative ranged attack bonus. The
 * candidate reader now refuses to offer such gear, but refusing to offer it
 * does nothing about the piece already worn, and there was no way to take it
 * off short of a human doing it by hand.
 *
 * The bank check is a real precondition, not defensiveness: unequipping moves
 * the item back to the bank, and a full bank is the one state where that can
 * fail.
 *
 * @param slotId - The equipment slot to clear.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function unequipItem(
  slotId: string,
  isSuspended: () => boolean,
): ActionResult<EquipProjection> {
  const slot = game.equipmentSlots.getObjectByID(slotId);
  if (slot === undefined) {
    return fail('equipment.unequip', 'precondition', `no equipment slot registered as ${slotId}`);
  }

  const player = game.combat.player;

  return act(
    {
      name: 'equipment.unequip',
      observe: () => projectSlot(slotId),
      precondition: () => {
        const worn = projectSlot(slotId);
        if (worn.itemId === null) return `${slotId} is already empty`;

        // Unequipping moves the item back to the bank, and a full bank is the
        // one state where that can lose it. But "full" is not the whole
        // question: an item the bank already holds stacks into the slot it
        // occupies and needs no new one, and refusing those would strand gear
        // on a character precisely when the bank is under pressure — which is
        // when swapping gear matters most.
        const item = game.items.equipment.getObjectByID(worn.itemId);
        const stacksWithExisting = item !== undefined && game.bank.getQty(item) > 0;
        if (!stacksWithExisting && game.bank.occupiedSlots >= game.bank.maximumSlots) {
          return 'the bank is full and holds none of this item, so it has nowhere to go';
        }
        return null;
      },
      perform: () => player.unequipItem(player.selectedEquipmentSet, slot),
      changed: (before, after) => before.itemId !== null && after.itemId === null,
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
 *
 * "Beats what is worn" was a stat sum, and a skilling outfit has no stats, so
 * an outfit could never be offered against anything already in its slot. That
 * is Township's whole payoff, earned and never worn. The one extra case now
 * offered is the one that needs no pricing —
 * {@link unambiguousModifierUpgrade} — and everything past it still belongs to
 * the planner.
 */
export function readEquipCandidates(): Candidate[] {
  const player = game.combat.player;
  const candidates: Candidate[] = [];
  const trainingSkillId = activeSkillId();
  const trainingSkill =
    trainingSkillId === null ? undefined : game.skills.getObjectByID(trainingSkillId);

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
    // A weapon of a different attack type is a *style switch*, not an upgrade,
    // and both filters below reject it for reasons that are individually
    // correct and jointly wrong.
    //
    // A Staff of Air "penalises" the ranged style — of course it does, it is a
    // magic weapon — and it scores lower than a shortbow on a flat stat sum,
    // because the two are not comparable. So with a bow equipped, no staff is
    // ever offered, and Magic cannot be started at all: five Staves of Air sat
    // in the bank while Magic stayed at level 2 and its goal read 10%.
    //
    // Offered as its own thing, labelled for what it is. The planner decides
    // whether a switch is wanted; the reader's job is only to make it possible.
    const switchesStyle = item instanceof WeaponItem && item.attackType !== player.attackType;

    if (!switchesStyle && penalisesAttackStyle(item.equipmentStats, player.attackType)) continue;

    const currentItem =
      current.itemId === null ? undefined : game.items.equipment.getObjectByID(current.itemId);

    // A skilling outfit has no equipment stats at all, so a stat sum ranks it
    // level with an empty slot and *below* anything already worn — which is why
    // Township's whole payoff was earned and never put on. It is offered here
    // only when wearing it needs no judgement: see unambiguousModifierUpgrade.
    const modifierUpgrade = unambiguousModifierUpgrade(item, currentItem, trainingSkillId);

    if (
      !switchesStyle &&
      !modifierUpgrade &&
      currentItem !== undefined &&
      statScore(item) <= statScore(currentItem)
    ) {
      continue;
    }

    candidates.push({
      kind: 'equip_item',
      params: { kind: 'equip_item', itemId: item.id, slotId: slot.id },
      label: switchesStyle
        ? `Equip ${item.name} — switches combat to ${(item as WeaponItem).attackType}, which is a strategy choice rather than an upgrade (replaces ${currentItem?.name ?? 'nothing'})`
        : current.itemId === null
          ? `Equip ${item.name} (${slot.emptyName ?? slot.id} is empty)`
          : modifierUpgrade
            ? `Equip ${item.name} — its modifiers are scoped to ${trainingSkill?.name ?? trainingSkillId}, the skill being trained, and it gives up no equipment stat against ${currentItem?.name ?? current.itemId}. Any swap that would displace modifier-bearing gear is left to the planner, because nothing here can price a modifier.`
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
 * The one equipment stat where a larger number is worse.
 *
 * `attackSpeed` is an `EquipStatKey` (character.d.ts:445-446) and sits in every
 * weapon's `equipmentStats` (item.d.ts:253) alongside the bonuses, but it is
 * milliseconds *between* swings: 2,400 beats 3,000. It is also two to three
 * orders of magnitude larger than anything else an item carries — attack and
 * defence bonuses are single- and double-digit — so a blind sum does not merely
 * lean on it, it *is* it. For two weapons `statScore` was the ratio of their
 * attack intervals and essentially nothing else, ranked backwards, which makes
 * the slowest weapon in the bank the best one in the bank, permanently.
 *
 * That is not a hypothetical. It is half of the equip loop of 2026-09-03: an
 * `equip_item` objective put a Steel Scimitar (2,400ms) into the weapon slot
 * every policy tick and the gear reflex put a Staff of Air (3,000ms, and the
 * live snapshot's `attackInterval` confirms it) back on the next reflex tick,
 * 3,000/2,400 = 1.25 clearing the reflex's 1.2 margin in one direction and
 * failing it in the other. Both calls were verified `ok`; forty action slots a
 * minute went into the swap for forty minutes.
 *
 * Excluded rather than negated. Negating it would let it dominate in the other
 * direction and rank gear by speed alone, which is the same defect mirrored;
 * `statScore` is documented as crude, and the honest minimum is that it stops
 * counting a cost as a benefit. Where a key-by-key comparison is made instead,
 * the key is compared in its own direction — see {@link dominatesEquipmentStats}.
 */
const LOWER_IS_BETTER_STAT = 'attackSpeed';

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
  return stats
    .filter((stat) => stat.key !== LOWER_IS_BETTER_STAT)
    .reduce((sum, stat) => sum + (typeof stat.value === 'number' ? stat.value : 0), 0);
}

/** The minimum a modifier-bearing item must show to be worth naming here. */
export interface ModifierScopeLike {
  /** Set when the game scoped this modifier to one skill. */
  skill?: { id: string };
}

/**
 * Modifiers on an item that apply to exactly one named skill.
 *
 * `ModifierValue` extends `ModifierScope` (modifiers.d.ts:129, :56), whose
 * optional `skill` (:19) is the game's own record of what a modifier is scoped
 * to. That is the only part of a modifier this file is willing to interpret: a
 * modifier the game has already tagged with a skill either applies to the skill
 * being trained or it does not, and no weighting is involved in asking.
 *
 * Deliberately ignores `conditionalModifiers` (item.d.ts:259). A conditional
 * carries an `isNegative` flag and a condition this code cannot evaluate
 * (conditionalModifiers.d.ts:375-379), so counting one as a benefit would be
 * the guess this whole area exists to avoid.
 */
export function skillScopedModifiers(
  modifiers: readonly ModifierScopeLike[] | undefined,
  skillId: string | null,
): number {
  if (modifiers === undefined || skillId === null) return 0;
  return modifiers.filter((modifier) => modifier.skill?.id === skillId).length;
}

/**
 * Whether an item carries any modifier at all, conditional ones included.
 *
 * Used to decide what may be *displaced*, which is the direction where being
 * wrong costs something: taking off an item whose worth this file cannot price
 * is exactly the trade it refuses to make.
 */
export function bearsModifiers(item: {
  modifiers?: readonly unknown[];
  conditionalModifiers?: readonly unknown[];
}): boolean {
  return (item.modifiers?.length ?? 0) > 0 || (item.conditionalModifiers?.length ?? 0) > 0;
}

/**
 * Whether a candidate's equipment stats are at least as good, key by key.
 *
 * Not a sum. `statScore` sums, and summing is how a Steel Platebody's melee
 * defence drowned out its ranged penalty and scored as an upgrade for an archer
 * who then could not land a shot for twenty minutes. A key-by-key comparison
 * cannot do that: if a single stat is lower the answer is no, whatever the
 * total says. Missing keys count as zero, so a stat only the candidate has must
 * still be non-negative.
 *
 * `attackSpeed` is compared the other way round, because it is the one key
 * where a larger number is worse: see {@link LOWER_IS_BETTER_STAT}. Comparing
 * it like the rest would say a slower weapon dominates a faster one, which is
 * how the sum next door came to rank every weapon by how long it takes to
 * swing. A missing key is zero on both sides, so an item with no attack speed
 * at all — an amulet, a skilling outfit — is unaffected either way.
 */
export function dominatesEquipmentStats(
  candidate: readonly { key: string; value: number }[],
  worn: readonly { key: string; value: number }[],
): boolean {
  const statValue = (stats: readonly { key: string; value: number }[], key: string): number => {
    const stat = stats.find((entry) => entry.key === key);
    return typeof stat?.value === 'number' ? stat.value : 0;
  };

  const keys = new Set([...candidate, ...worn].map((stat) => stat.key));
  for (const key of keys) {
    const mine = statValue(candidate, key);
    const theirs = statValue(worn, key);
    if (key === LOWER_IS_BETTER_STAT ? mine > theirs : mine < theirs) return false;
  }
  return true;
}

/**
 * The skill the character is training right now, or null.
 *
 * `game.activeAction` (game.d.ts:42) is the skill that is running; combat is a
 * `PassiveAction` and leaves it undefined, which is the right answer here —
 * with no non-combat skill running there is no scope in which a skilling
 * modifier is unambiguously the better choice, so everything below falls back
 * to the stat comparison it already made.
 */
function activeSkillId(): string | null {
  return safeValue('equipment.activeSkillId', () => game.activeAction?.id) ?? null;
}

/**
 * Whether wearing `item` over `worn` is an improvement no judgement is needed for.
 *
 * The one case where a modifier can be scored without pricing it. Everything
 * has to hold at once:
 *
 * - the item carries modifiers the game itself scoped to the skill being
 *   trained, so their relevance is the game's claim and not this file's;
 * - the item it would displace carries no modifiers of any kind, so nothing
 *   unpriceable is being given up;
 * - and no single equipment stat gets worse, so the comparison the stat sum
 *   exists for is won outright rather than on balance.
 *
 * Anything short of that — a modifier scoped to some other skill, a worn item
 * with modifiers of its own, one stat traded for another — is a judgement about
 * what the run is doing, and stays with the planner. That is not caution for
 * its own sake: the last time this file put a number on a comparison it could
 * not make, the agent spent twenty minutes in a fight it could not win.
 */
export function unambiguousModifierUpgrade(
  item: {
    modifiers?: readonly ModifierScopeLike[];
    equipmentStats: readonly { key: string; value: number }[];
  },
  worn:
    | {
        modifiers?: readonly unknown[];
        conditionalModifiers?: readonly unknown[];
        equipmentStats: readonly { key: string; value: number }[];
      }
    | undefined,
  trainingSkillId: string | null,
): boolean {
  if (skillScopedModifiers(item.modifiers, trainingSkillId) === 0) return false;
  // An empty slot is the safe case named in the brief: there is nothing to lose.
  if (worn === undefined) return true;
  if (bearsModifiers(worn)) return false;
  return dominatesEquipmentStats(item.equipmentStats, worn.equipmentStats);
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
    } catch (error) {
      noteSwallowed('equipment.readSynergyCandidates', error);
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
    } catch (error) {
      noteSwallowed('equipment.readEquipmentSetCandidates', error);
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
/**
 * The equipped food slot and what the bank holds of that food, read live.
 *
 * The food reflexes were fed a mix: banked food read live, but the equipped
 * slot and bank quantities taken from the snapshot, which refreshes only when
 * the agent reports. So the reflex acted on a picture of the bank that could be
 * a minute old, and produced a steady drip of failures — "bank holds no
 * melvorD:Chicken" for a stack that had since been eaten, and "state unchanged"
 * for a slot it thought was empty and was not.
 *
 * Individually harmless, since every one was caught by the adapter's own
 * preconditions. Collectively not: 570 of them buried the single warning that
 * actually mattered, which was Thieving refusing to release the action slot.
 * Noise is not free when the log is the diagnostic.
 *
 * The same fix as `readPlayerHitpoints`, applied to the reflex next door — the
 * hitpoints half was corrected this session and the food half was missed.
 */
export function readEquippedFood(): {
  itemId: string | null;
  quantity: number;
  bankQuantityOf: (itemId: string) => number;
} {
  const player = game.combat.player;
  const slot = player.food.currentSlot;

  return {
    itemId: slot.item === game.emptyFoodItem ? null : slot.item.id,
    quantity: slot.quantity,
    bankQuantityOf: (itemId) => {
      const item = game.items.getObjectByID(itemId);
      return item === undefined ? 0 : game.bank.getQty(item);
    },
  };
}

export function readBankedFood(): { itemId: string; quantity: number; heals: number }[] {
  const food: { itemId: string; quantity: number; heals: number }[] = [];

  for (const entry of game.bank.items.values()) {
    if (!(entry.item instanceof FoodItem)) continue;

    try {
      food.push({
        itemId: entry.item.id,
        quantity: entry.quantity,
        heals: game.combat.player.getFoodHealing(entry.item),
      });
    } catch (error) {
      noteSwallowed('equipment.readBankedFood', error);
      // Food whose healing cannot be read is still food; rank it last.
      food.push({ itemId: entry.item.id, quantity: entry.quantity, heals: 0 });
    }
  }

  // Healing is carried out, not dropped. The refill reflex could only ever
  // top up whatever was already in the slot, so a character that equipped
  // Shrimp early kept eating Shrimp while better food sat in the bank — and
  // Thieving's damage is paid for out of exactly that difference.
  return food.sort((a, b) => b.heals - a.heals);
}

/** What the equipped food heals for, so a better one can be recognised. */
export function readEquippedFoodHealing(): number {
  try {
    const slot = game.combat.player.food.currentSlot;
    if (slot.item === game.emptyFoodItem) return 0;
    return game.combat.player.getFoodHealing(slot.item);
  } catch (error) {
    noteSwallowed('equipment.readEquippedFoodHealing', error);
    return 0;
  }
}

/**
 * Worn gear that is working against the current attack style.
 *
 * Reads only; the decision to remove it is {@link removePenalisingGear} in the
 * reflex tier. The weapon slot is excluded deliberately — a weapon *defines*
 * the style rather than fighting it, and stripping it would leave the character
 * unarmed, which is a worse position than a bad bonus.
 */
export function readPenalisingGear(): { slotId: string; itemName: string }[] {
  const player = game.combat.player;
  const worn: { slotId: string; itemName: string }[] = [];

  for (const [slotId, equipped] of Object.entries(player.equipment.equippedItems)) {
    if (slotId === 'melvorD:Weapon' || slotId === 'melvorD:Quiver') continue;
    if (equipped.item === equipped.emptyItem) continue;
    if (!penalisesAttackStyle(equipped.item.equipmentStats, player.attackType)) continue;

    worn.push({ slotId, itemName: equipped.item.name });
  }

  return worn;
}

/**
 * Whether the food reserve is running out, and by how much.
 *
 * The thing that actually limits unattended play, and nothing was watching it.
 * Without Auto Eat the eat reflex is the only thing between the character and
 * death, and it consumes an item every time it fires — Thieving damages on
 * every failed pickpocket, so a long run burns food steadily. When the last
 * meal goes, the reflex has nothing to work with, the Thieving gate starts
 * refusing NPCs as health falls, and the run quietly stops progressing.
 *
 * Reported rather than acted on. Restocking is a genuine plan — fish, then
 * cook, then come back — and inventing that as a reflex would have the agent
 * abandoning objectives to go fishing. Naming the shortfall lets a planning
 * session decide, which is the split this codebase already draws between
 * oversights and trade-offs.
 *
 * @param minimumMeals - Below this many items across all food, say so.
 */
export function readFoodReserve(minimumMeals = 40): {
  label: string;
  xpPerHour: number;
  severity: BlockedSeverity;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    // Auto Eat removes the whole concern: it is fed from the bank directly and
    // the manual reflex stands down.
    if (game.combat.player.autoEatThreshold > 0) return [];

    const banked = readBankedFood();
    const total = banked.reduce((sum, entry) => sum + entry.quantity, 0);
    const equipped = game.combat.player.food.currentSlot.quantity;
    const meals = total + equipped;
    if (meals >= minimumMeals) return [];

    const best = banked[0];
    return [
      {
        // Critical, so it can never be cut. This is a countdown to the
        // failure that has already killed this character once: it starved
        // surrounded by raw food, with a warning nobody read because the
        // blocked list showed twelve lines and this was not one of them.
        severity: 'critical',
        label: `Food is down to ${meals} meals and there is no Auto Eat — the eat reflex spends one per fire, and Thieving fires it often. Cook or fish before the reserve runs out.`,
        xpPerHour: 0,
        missing: [
          {
            itemId: best?.itemId ?? 'melvorD:Shrimp',
            name: best === undefined ? 'any food' : 'more of the best food held',
            need: minimumMeals,
            have: meals,
          },
        ],
      },
    ];
  } catch (error) {
    noteSwallowed('equipment.readFoodReserve', error);
    return [];
  }
}

/**
 * Gear worth putting on, with the comparison already made.
 *
 * The candidate reader evaluates every item in the bank against what is worn
 * and offers only improvements — that part has always worked. What was missing
 * is anything acting on the answer: a Jeweled Necklace sat in the bank with an
 * empty neck slot and the list saying "Neck is empty" for as long as nobody
 * read that line.
 *
 * Empty slots and replacements are returned separately because they are
 * different kinds of decision. Filling nothing has no downside and belongs to a
 * reflex; displacing worn gear is a comparison that has already been wrong once
 * — a Steel Platebody scored *higher* than what it replaced and left an archer
 * unable to land a shot — so it carries the margin by which it claims to win
 * and lets the caller decide how much to trust a stat sum.
 *
 * Says nothing about gear deliberately *set aside*. Valuables stripped for a
 * fight (`valuables.stashValuablesForCombat`) leave an empty slot and sit in
 * the bank, which is exactly the shape this reader offers — so the caller has
 * to stand its fill reflex down while a restore is outstanding rather than ask
 * this function to know why an item is not being worn. See `runReflexes`.
 */
export function readGearUpgrades(): {
  emptySlot: { itemId: string; slotId: string; name: string; scopedModifiers: number }[];
  replacement: { itemId: string; slotId: string; name: string; gain: number }[];
} {
  const player = game.combat.player;
  const trainingSkillId = activeSkillId();
  const emptySlot: {
    itemId: string;
    slotId: string;
    name: string;
    scopedModifiers: number;
  }[] = [];
  const replacement: { itemId: string; slotId: string; name: string; gain: number }[] = [];

  for (const entry of game.bank.items.values()) {
    const item = entry.item;
    if (!(item instanceof EquipmentItem)) continue;

    const slot = item.validSlots[0];
    if (slot === undefined) continue;

    const current = projectSlot(slot.id);
    if (current.itemId === item.id) continue;
    if (!game.checkRequirements(item.equipRequirements, false)) continue;
    if (penalisesAttackStyle(item.equipmentStats, player.attackType)) continue;

    if (current.itemId === null) {
      // An empty slot is left alone by the rule below on purpose. Arming an
      // unarmed character is not a change of strategy, and the doc above says
      // why: there is nothing on the other side of the trade.
      emptySlot.push({
        itemId: item.id,
        slotId: slot.id,
        name: item.name,
        scopedModifiers: skillScopedModifiers(item.modifiers, trainingSkillId),
      });
      continue;
    }

    // A weapon of a different attack type is a *style switch*, not an upgrade,
    // and the reflex tier must not make that call. `readEquipCandidates` says
    // so already and offers such a weapon to the planner labelled "a strategy
    // choice rather than an upgrade" -- this reader, which feeds a reflex that
    // acts without asking, had no notion of one at all, and that is the other
    // half of the equip loop of 2026-09-03. An `equip_item` objective put a
    // Steel Scimitar into the weapon slot every policy tick (3,000ms,
    // agent.ts:220) and this list handed the reflex the displaced Staff of Air
    // back as an upgrade on the next reflex tick (1,000ms, :231). Both tiers
    // were doing exactly what they were told; nothing in the game reverted
    // anything, and the adapter's `ok` was truthful on every one of the forty
    // calls a minute. The bank counts never moved because each weapon was
    // removed and returned inside the same second.
    //
    // Excluding it settles the loop in both directions: with the staff worn the
    // scimitar is not offered either, so the planner's choice -- whichever way
    // it went -- is the one that stands.
    if (item instanceof WeaponItem && item.attackType !== player.attackType) continue;

    const worn = game.items.equipment.getObjectByID(current.itemId);
    if (worn === undefined) continue;

    const wornScore = statScore(worn);
    const gain = wornScore === 0 ? Number.POSITIVE_INFINITY : statScore(item) / wornScore;
    if (gain <= 1) continue;

    replacement.push({ itemId: item.id, slotId: slot.id, name: item.name, gain });
  }

  // Empty slots had no order at all, so the reflex — which takes the head —
  // filled a slot in bank order. That matters because there is usually more
  // than one candidate per slot and only the first one gets worn: once the slot
  // is full, a skilling outfit with no equipment stats can never displace it,
  // since a stat sum scores it at zero forever. Gear whose modifiers the game
  // scoped to the skill actually being trained goes first. Nothing else is
  // reordered — `sort` is stable, so bank order still decides the rest, and no
  // modifier is being weighed against a stat here, only against another
  // candidate for a slot that is empty either way.
  emptySlot.sort((a, b) => b.scopedModifiers - a.scopedModifiers);
  // Best first, so a reflex taking only the head of the list takes the best.
  replacement.sort((a, b) => b.gain - a.gain);
  return { emptySlot, replacement };
}

/** Meals across the bank and the equipped slot; see readFoodReserve. */
export function readMealCount(): number {
  try {
    const banked = readBankedFood().reduce((sum, entry) => sum + entry.quantity, 0);
    return banked + game.combat.player.food.currentSlot.quantity;
  } catch (error) {
    noteSwallowed('equipment.readMealCount', error);
    return 0;
  }
}

/** Whether Auto Eat is owned, which feeds from the bank and needs no reflex. */
export function hasAutoEat(): boolean {
  try {
    return game.combat.player.autoEatThreshold > 0;
  } catch (error) {
    noteSwallowed('equipment.hasAutoEat', error);
    return false;
  }
}

/**
 * Ammunition in the bank that the equipped weapon can actually fire.
 *
 * The quiver is checked once, as a precondition of engaging, and never again --
 * but arrows are consumed per shot. When it empties mid-fight the game reports
 * combat as active, health stays full, and nothing lands: the same silent
 * zero-damage stall the engage-time check was written to prevent, arriving
 * twenty minutes later instead.
 *
 * Matched on `ammoTypeRequired` against `ammoType` (item.d.ts:239, :211) rather
 * than on names, so bolts and javelins are handled by the same rule as arrows.
 * Returns null when the weapon needs no ammunition, which is most of them.
 */
export function readRefillableAmmo(): { itemId: string; quantity: number } | null {
  try {
    const weapon = game.combat.player.equipment.getItemInSlot('melvorD:Weapon' as never);
    if (!(weapon instanceof WeaponItem)) return null;

    const required = weapon.ammoTypeRequired;
    if (required === undefined) return null;

    let best: { itemId: string; quantity: number } | null = null;
    for (const entry of game.bank.items.values()) {
      const item = entry.item;
      if (!(item instanceof EquipmentItem)) continue;
      if (item.ammoType !== required) continue;
      // Ammunition carries `equipRequirements` like any other equipment
      // (item.d.ts:251), and a stack the character cannot equip refills
      // nothing: `equipItem` refuses it on the same check, so offering it here
      // would spend the reflex's retries on a stack that can never load. The
      // right answer in that case is null — no refill exists — which is what
      // makes `refillQuiver` leave a fight it cannot win.
      if (!game.checkRequirements(item.equipRequirements, false)) continue;
      if (best === null || entry.quantity > best.quantity) {
        best = { itemId: item.id, quantity: entry.quantity };
      }
    }

    return best;
  } catch (error) {
    noteSwallowed('equipment.readRefillableAmmo', error);
    return null;
  }
}

/**
 * Names for `AmmoTypeID`, which both the dump and every label here need as text.
 *
 * `EquipmentItem.ammoType` and `WeaponItem.ammoTypeRequired` are the numeric
 * enum (item.d.ts:269, :308), and "fires 1" answers nothing about whether a
 * crossbow can shoot what is in the bank. Spelled out here rather than read off
 * a runtime `AmmoTypeID` global: the typings declare the enum
 * (enums.d.ts:2983-2991) but nothing promises it is emitted as a value, and a
 * missing global would silently blank the field this exists for.
 *
 * Keyed by the enum type so a content update that adds a member fails the build
 * instead of producing an empty string for it.
 */
const AMMO_TYPE_NAMES: Record<AmmoTypeID, string> = {
  0: 'Arrows',
  1: 'Bolts',
  2: 'Javelins',
  3: 'ThrowingKnives',
  4: 'None',
  5: 'AbyssalArrows',
  6: 'AbyssalBolts',
};

/**
 * The name of an ammunition class, or empty where there is none.
 *
 * Empty and `'None'` are different answers and both occur: a platebody has no
 * `ammoType` at all, while an item may be explicitly typed `None`. Collapsing
 * the first into the second would claim the game said something it did not.
 */
export function ammoTypeName(value: number | undefined): string {
  if (value === undefined) return '';
  return AMMO_TYPE_NAMES[value as AmmoTypeID] ?? '';
}

/** The three styles a character can fight in. character.d.ts:621. */
const ATTACK_TYPES = ['melee', 'ranged', 'magic'] as const;

/** How many blocked weapons or ammunition stacks a line names before counting. */
const NAMED_IN_LABEL = 3;

/** A weapon or ammunition stack the character owns but cannot put on. */
interface RefusedGear {
  name: string;
  quantity: number;
  /** Unmet `equipRequirements`, already rendered. Empty when none are unmet. */
  unmet: string[];
}

function describeRefused(refused: readonly RefusedGear[]): string {
  const named = refused
    .slice(0, NAMED_IN_LABEL)
    .map(
      (entry) =>
        `${entry.quantity}x ${entry.name}${
          entry.unmet.length === 0 ? '' : ` needs ${entry.unmet.join(' and ')}`
        }`,
    );
  const remainder = refused.length - named.length;
  return `${named.join('; ')}${remainder > 0 ? `; and ${remainder} more` : ''}`;
}

/**
 * Combat styles the character owns nothing usable for, and the reason.
 *
 * `readEquipCandidates` gates every item on `game.checkRequirements` and, when
 * it fails, does a bare `continue`. That is the right call for a candidate list
 * — offering gear that cannot be worn spends an objective discovering a level
 * the game already knew — but the reason was computed and thrown away, so from
 * outside, gear held behind a requirement and gear that does not exist read
 * identically. A `ranged-20` goal sat at 15% for a run with a bank full of
 * arrows and crossbows and no line anywhere saying why nothing could be
 * equipped; the only way to learn the level was to reach it.
 *
 * Reported, never acted on, and deliberately not a route. This says what the
 * game refuses and what it refuses it for. Whether the answer is to level up,
 * to fletch a bow or to leave the style alone is a plan, and inventing one here
 * would be guessing with a bank list — the mistake that put a fabricated
 * `requires:` on the Abyssal goal and kept it blocked for a reason that did not
 * exist.
 *
 * Bounded at one entry per style, so it cannot crowd out the countdowns that
 * share the blocked list.
 */
export function readUnusableCombatStyles(): {
  label: string;
  xpPerHour: number;
  severity: BlockedSeverity;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    const player = game.combat.player;
    const banked = [...game.bank.items.values()];
    const lines: ReturnType<typeof readUnusableCombatStyles> = [];

    for (const attackType of ATTACK_TYPES) {
      // The style currently being fought in is by definition usable: the game
      // derives `attackType` (character.d.ts:106) from the equipped weapon.
      if (player.attackType === attackType) continue;

      const owned = banked.filter(
        (entry) => entry.item instanceof WeaponItem && entry.item.attackType === attackType,
      );

      // Nothing to explain: the character simply has no such weapon. Saying so
      // is still the point — "no ranged weapon is owned" and "a ranged weapon
      // is owned and refused" want completely different responses, and neither
      // was distinguishable from silence.
      if (owned.length === 0) {
        lines.push({
          severity: 'normal',
          label: `${attackType}: no ${attackType} weapon is owned, so the style cannot be started at all.`,
          xpPerHour: 0,
          missing: [],
        });
        continue;
      }

      const usable = owned.filter((entry) =>
        game.checkRequirements((entry.item as WeaponItem).equipRequirements, false),
      );

      if (usable.length === 0) {
        const refused = owned.map((entry) => ({
          name: entry.item.name,
          quantity: entry.quantity,
          unmet: describeUnmetRequirements(() => (entry.item as WeaponItem).equipRequirements),
        }));

        lines.push({
          severity: 'normal',
          label: `${attackType}: none of the ${owned.length} ${attackType} weapon(s) owned can be equipped — ${describeRefused(refused)}.${ammoClause(attackType, owned, banked)}`,
          xpPerHour: 0,
          missing: [],
        });
        continue;
      }

      // Equippable, and still unusable if it fires something the character
      // cannot load. A weapon with no ammunition is the zero-damage stall the
      // quiver reflex exists for, arriving before the fight rather than during.
      const clause = ammoClause(attackType, usable, banked);
      if (clause !== '') {
        lines.push({
          severity: 'normal',
          label: `${attackType}: ${usable[0]?.item.name} can be equipped, but${clause}`,
          xpPerHour: 0,
          missing: [],
        });
      }
    }

    return lines;
  } catch (error) {
    noteSwallowed('equipment.readUnusableCombatStyles', error);
    return [];
  }
}

/**
 * What the given weapons fire, and whether any of it can be loaded.
 *
 * Returns empty when there is nothing to say — every weapon either needs no
 * ammunition or has some it can equip. Ammunition held but refused is named
 * explicitly: 1,620 arrows in the bank and an empty quiver is the exact shape
 * that reads as "the bank is stocked" to everything that counts stacks.
 */
function ammoClause(
  attackType: string,
  weapons: readonly { item: AnyItem }[],
  banked: readonly { item: AnyItem; quantity: number }[],
): string {
  const required = new Set<AmmoTypeID>();
  for (const entry of weapons) {
    const needs = entry.item instanceof WeaponItem ? entry.item.ammoTypeRequired : undefined;
    if (needs !== undefined) required.add(needs);
  }
  if (required.size === 0) return '';

  const clauses: string[] = [];
  for (const ammoType of required) {
    const held = banked.filter(
      (entry) => entry.item instanceof EquipmentItem && entry.item.ammoType === ammoType,
    );
    const loadable = held.filter((entry) =>
      game.checkRequirements((entry.item as EquipmentItem).equipRequirements, false),
    );
    if (loadable.length > 0) continue;

    const className = ammoTypeName(ammoType);

    if (held.length === 0) {
      clauses.push(`no ${className} are held at all`);
      continue;
    }

    clauses.push(
      `the ${className} held cannot be equipped — ${describeRefused(
        held.map((entry) => ({
          name: entry.item.name,
          quantity: entry.quantity,
          unmet: describeUnmetRequirements(() => (entry.item as EquipmentItem).equipRequirements),
        })),
      )}`,
    );
  }

  if (clauses.length === 0) return '';
  return ` Every ${attackType} weapon here needs ammunition, and ${clauses.join('; ')}.`;
}

/** Owned gear whose value is in modifiers rather than in equipment stats. */
export interface ModifierGear {
  itemId: string;
  name: string;
  slotId: string;
  /** The game's own descriptions of what the item does. */
  effects: string[];
  /**
   * True when wearing it needs no judgement — see {@link unambiguousModifierUpgrade}.
   *
   * These are already offered as equip candidates and, for an empty slot, taken
   * by the fill reflex. Reporting them as "nothing will pick this up" would be
   * false, which is why the notice below filters on this rather than on nothing.
   */
  decidable: boolean;
}

/**
 * Gear held in the bank whose worth {@link statScore} cannot see.
 *
 * `statScore` sums `equipmentStats` — attack bonuses, defence bonuses, the
 * numbers a weapon has. A skilling outfit has none of those. Its entire value
 * lives in `modifiers` (item.d.ts:197): the Mining Skillcape's interval
 * reduction, a Township outfit's flat XP multiplier. Summed as equipment stats
 * they score exactly zero, so every gear reader in this file ranks them level
 * with an empty slot and the equip reflex, which only fills empty slots and
 * clears a margin, has no reason to ever wear one.
 *
 * **This is still a reader and not a score, for almost every item.** Turning a
 * modifier list into one comparable number is not arithmetic, it is a judgement
 * about relevance: +5% Mining mastery XP is worth a great deal to a character
 * mining and nothing at all to one fishing, and the same item's worth changes
 * with the objective it is worn for. Every weighting this file could invent
 * would be a guess dressed as a measurement — and a wrong stat sum has already
 * cost this project twenty minutes of unwinnable fighting, with a Steel
 * Platebody that scored *higher* than what it replaced. So the modifiers are
 * surfaced verbatim, in the game's own words via `ModifierValue.getDescription`
 * (modifiers.d.ts:117), and the choice stays with the planner.
 *
 * The single exception is marked with `decidable`, and it is not a weighting:
 * {@link unambiguousModifierUpgrade} asks only whether the *game* scoped the
 * modifiers to the skill being trained and whether anything is given up by
 * wearing it. When the answer is yes and no, there is no trade to price.
 *
 * Restricted to gear not currently worn, because the point is what is being
 * missed.
 *
 * @returns Unworn modifier-bearing gear, most effects first.
 */
export function readModifierGear(): ModifierGear[] {
  const gear: ModifierGear[] = [];

  try {
    const trainingSkillId = activeSkillId();
    const equipped = new Set(
      Object.values(game.combat.player.equipment.equippedItems)
        .filter((slot) => slot.item !== slot.emptyItem)
        .map((slot) => slot.item.id),
    );

    for (const entry of game.bank.items.values()) {
      const item = entry.item;
      if (!(item instanceof EquipmentItem)) continue;
      if (equipped.has(item.id)) continue;

      try {
        const modifiers = item.modifiers;
        if (modifiers === undefined || modifiers.length === 0) continue;

        const slot = item.validSlots[0];
        if (slot === undefined) continue;

        const current = projectSlot(slot.id);
        const worn =
          current.itemId === null ? undefined : game.items.equipment.getObjectByID(current.itemId);

        gear.push({
          itemId: item.id,
          name: item.name,
          slotId: slot.id,
          effects: modifiers.map((modifier) => modifier.getDescription().description),
          decidable: unambiguousModifierUpgrade(item, worn, trainingSkillId),
        });
      } catch (error) {
        // An item whose modifiers cannot describe themselves is left out rather
        // than reported with a blank effect.
        noteSwallowed('equipment.readModifierGear.item', error);
      }
    }
  } catch (error) {
    noteSwallowed('equipment.readModifierGear', error);
    return [];
  }

  return gear.sort((a, b) => b.effects.length - a.effects.length);
}

/** How many modifier-bearing items to name, and how many effects for each. */
const MODIFIER_GEAR_REPORTED = 3;
const MODIFIER_EFFECTS_REPORTED = 3;

/**
 * Reports owned gear that every scorer in this mod values at zero.
 *
 * Named as a blocked opportunity because that is exactly what it is: the item is
 * already owned, the slot is filled with something whose own modifiers cannot be
 * priced either, and the only thing between the two is that nothing here can
 * weigh one against the other. Saying so plainly is more honest than a scoring
 * function that would have to invent the price.
 *
 * Items marked `decidable` are excluded. They are offered as equip candidates
 * and, when the slot is empty, taken by the fill reflex — so reporting them as
 * something nobody will act on would be a stale claim, and a notice that is
 * wrong about its own system is worse than no notice.
 *
 * @returns Blocked-opportunity entries, or none when nothing is being missed.
 */
export function readModifierGearNotice(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  return readModifierGear()
    .filter((item) => !item.decidable)
    .slice(0, MODIFIER_GEAR_REPORTED)
    .map((item) => {
      const effects = item.effects.slice(0, MODIFIER_EFFECTS_REPORTED).join('; ');
      const rest =
        item.effects.length > MODIFIER_EFFECTS_REPORTED
          ? ` (+${item.effects.length - MODIFIER_EFFECTS_REPORTED} more)`
          : '';

      return {
        label: `${item.name} is in the bank unworn and scores ZERO on equipment stats — its value is in modifiers, which nothing here can price: ${effects}${rest}. Slot ${item.slotId}. Decide whether it is worth wearing for what this run is doing; no reflex will pick it up.`,
        xpPerHour: 0,
        missing: [],
      };
    });
}

/** A worn item that spends charges, and how many it has left. */
export interface ChargedEquipment {
  itemId: string;
  name: string;
  slotId: string;
  charges: number;
}

/**
 * Worn gear that runs on charges, with the charges it has left.
 *
 * `game.itemCharges` (game.d.ts:75) appeared nowhere in this mod, which made a
 * whole class of equipment silently temporary. A charged item keeps its stats
 * listed and its slot filled after the last charge is gone — the gloves are
 * still worn, the equipment screen still reads the same — so the gear reflexes
 * see a full slot, the planner sees a full loadout, and the bonus everything was
 * bought for has simply stopped. It is the same shape as the empty quiver: full
 * health, every call succeeding, and nothing happening.
 *
 * Which items are chargeable is not guessed. `consumesChargesOn`
 * (item.d.ts:215) is the game's own marker for an item that spends charges, so
 * an item without it is not reported as having zero — it is not reported at all.
 * The count itself is `ItemCharges.getCharges` (itemCharges.d.ts:20).
 *
 * A reader, not a reflex. Replacing a spent Thieving glove means buying another
 * from the shop for real GP, and whether that is worth it depends on what the
 * run is saving for — a planner decision, unlike topping up a food slot.
 *
 * @returns Charged items currently worn, emptiest first.
 */
export function readEquipmentCharges(): ChargedEquipment[] {
  const charged: ChargedEquipment[] = [];

  try {
    for (const equipped of Object.values(game.combat.player.equipment.equippedItems)) {
      try {
        const item = equipped.item;
        if (item === equipped.emptyItem) continue;
        if (item.consumesChargesOn === undefined) continue;

        charged.push({
          itemId: item.id,
          name: item.name,
          slotId: equipped.slot.id,
          charges: game.itemCharges.getCharges(item),
        });
      } catch {
        // One unreadable slot must not cost the report of the others.
      }
    }
  } catch {
    // An equipment set that cannot be walked reports nothing rather than
    // claiming nothing is charged.
    return [];
  }

  return charged.sort((a, b) => a.charges - b.charges);
}

/** Charges at or below which a worn item is worth reporting as running out. */
const LOW_CHARGE_WARNING = 25;

/**
 * Reports worn gear whose charges are spent or nearly spent.
 *
 * Surfacing this matters because nothing else can. A spent item produces no
 * error, no notification and no observable change: XP and GP simply come in
 * slightly slower forever, which is indistinguishable from the advertised rates
 * having been optimistic. This is the line that makes the difference visible
 * while it can still be acted on.
 *
 * @returns Blocked-opportunity entries, or none when nothing worn is running out.
 */
export function readSpentChargesNotice(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  return readEquipmentCharges()
    .filter((entry) => entry.charges <= LOW_CHARGE_WARNING)
    .map((entry) => ({
      label:
        entry.charges <= 0
          ? `${entry.name} (${entry.slotId}) has NO charges left — it is still worn and still reads as equipped, but its bonus is gone. Replace it or take it off.`
          : `${entry.name} (${entry.slotId}) has ${entry.charges} charge(s) left — when they run out the item keeps its slot and stops working silently.`,
      xpPerHour: 0,
      missing: [],
    }));
}

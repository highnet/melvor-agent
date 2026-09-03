import type { ActionResult } from '@melvor-agent/shared';
import { act } from './act.js';
import { equipItem, unequipItem } from './equipment.js';
import { noteSwallowed, safeValue } from './safe.js';

/**
 * Taking the valuables off before a fight, and putting them back after.
 *
 * Every gear reader in this mod answers "what is worth *wearing*". Nothing ever
 * asked whether a slot is worth **emptying**, and the game charges for that
 * omission on every death.
 *
 * `Player.applyDeathPenalty()` (player.d.ts:410-411) is documented verbatim as
 * *"Removes an item from the player's equipment on death"*, and the shipped
 * v1.3.1 build says exactly how it chooses (nw.js HTTP cache, `Player`,
 * f_00019a.js:2628-2643; see `learnings/mod-api.md` for the brotli recipe):
 *
 *     const priorityOrderSlots = [...this.equipment.equippedArray]
 *         .sort((a, b) => a.item.deathPenaltyPriority - b.item.deathPenaltyPriority);
 *     const lowestPriority = priorityOrderSlots[0].item.deathPenaltyPriority;
 *     let minPriorityLength = priorityOrderSlots.findIndex(
 *         (equipped) => equipped.item.deathPenaltyPriority > lowestPriority);
 *     if (minPriorityLength === -1) minPriorityLength = priorityOrderSlots.length;
 *     const priorityIndex = rollInteger(0, minPriorityLength - 1);
 *     const equipped = priorityOrderSlots[priorityIndex];
 *     ...
 *     if (!equipped.isEmpty && this.game.tutorial.complete) { ... unequipItem ... }
 *
 * Three facts follow, and all three matter here.
 *
 * - `deathPenaltyPriority` defaults to 0 (item.d.ts:197-198) and exactly one
 *   item in the whole base game sets it: the Decoy Idol, at -1
 *   ("This is always chosen as the item lost on death"). So for a character
 *   without one, every slot shares the lowest priority and the roll is
 *   **uniform across the whole equipment array**.
 * - The empty-slot placeholder is an ordinary `EquipmentItem` built with no
 *   `deathPenaltyPriority` at all (f_00019d.js:346-362), so it defaults to 0
 *   too and **empty slots are in the roll**. A roll that lands on one loses
 *   nothing.
 * - Therefore taking an item off does not merely remove it from the draw. It
 *   converts its ticket into a blank.
 *
 * This character has died **55 times** (`data/settings.json`, `lastDeathCount`)
 * and its live equipment array holds 19 entries, 9 of them occupied. It was
 * wearing a **Thiever's Cape** (3,900 GP, a Thieving reward and not a shop
 * item, so losing it is not a purchase away) and a **Jeweled Necklace**
 * (5,000 GP), neither of which changes how a fight goes. Each was one of
 * nineteen tickets on every one of those deaths.
 *
 * The standing rule is that the agent may die but may not take irreversible
 * actions. Losing an unbuyable item to a random roll is exactly that, so this
 * is not tuning — and the equip reflex was making it worse rather than better:
 * `fillEmptySlots` puts whatever scores best into an empty slot, which is how
 * the necklace got onto a character that never chose it.
 *
 * ## Why this is not `withTownBiome`
 *
 * `withTownBiome` / `withBuildQuantity` / `withBuyQuantity` set a field, call,
 * and restore in `finally`. That shape works because the call is synchronous. A
 * fight is not: it starts on one tick and ends minutes later, on a tick nobody
 * here is standing on — and it can end in death, in an abort, in a reload or in
 * the offline-progress loop. A `finally` around `combat.engage` would return
 * before the first punch and put the necklace straight back on.
 *
 * So the restore is a *state machine* rather than a scope: what came off is
 * recorded here, and three separate things put it back — a reflex that fires
 * whenever the stash is non-empty and combat is over (which covers death,
 * abort, victory and disengage alike), the reload path in `save.ts`, and any
 * later strip, which restores before it strips again.
 *
 * The one failure this cannot cover is the process going away mid-fight without
 * a reload — a crash, or the window being closed. That is deliberately safe by
 * construction rather than by handling: the stashed items are sitting *in the
 * bank*, where the death penalty cannot reach them, and the next session's
 * `fillEmptySlots` puts them back on unprompted. Losing the record loses
 * nothing but the tidiness.
 */

/**
 * Slots this never touches, and why each one.
 *
 * Deny-listed by slot as well as by the stat and modifier tests below, because
 * two of these are the specific traps where a stat comparison returning "no
 * combat stats" is *not* the same claim as "inert in a fight".
 *
 * - **Weapon** — a weapon defines the attack style. Stripping it leaves the
 *   character unarmed, which is a worse position than any bonus is worth. The
 *   same exclusion `readPenalisingGear` already makes.
 * - **Summon1 / Summon2** — a familiar is *consumed by* a fight rather than
 *   merely worn, and the combat ones carry their contribution somewhere a
 *   platebody does not. Checked against the shipped item data rather than
 *   assumed: a combat familiar has an equipment stat (`summoningMaxhit`, 5.9 on
 *   the tier-1 combat tablet) and `consumesOn: [{ type: 'PlayerSummonAttack' }]`,
 *   while the Ent this character wears has `equipmentStats: []`,
 *   `additionalPrimaryProductChance` scoped to Woodcutting and
 *   `consumesOn: [{ type: 'WoodcuttingAction' }]` (f_00000c.js). The stat test
 *   below would therefore keep a combat familiar and strip a skilling one — but
 *   `readSynergyCandidates` deliberately puts *pairs* in these slots for a
 *   synergy bonus neither half gives alone, and emptying one silently breaks
 *   the pair. A slot the planner arranges is not a slot a reflex should clear.
 * - **Gem** — a Barrier Gem relates to barrier, not to melee stats, and the
 *   modifier it carries proves the general test is not enough on its own: the
 *   Basic Barrier Gem has `equipmentStats: []` and one modifier,
 *   `flatBarrierDamage`, whose own definition does **not** set `isCombat`
 *   (f_00000b.js) even though it plainly acts in a fight. `Modifier.isCombat`
 *   is documented as "if this modifier causes a change in combat stats when
 *   changed" (modifiers.d.ts:295-296) — a claim about the recomputed stats
 *   block, not about whether the modifier matters when swords come out. That
 *   distinction is why {@link NON_COMBAT_MODIFIERS} is an explicit allow-list
 *   and not a filter on `isCombat`.
 * - **Consumable** — its whole purpose is being spent by the activity.
 *
 * `Passive` is not excluded: it holds no stats by the game's own slot data
 * (`providesEquipStats: false`) and needs Attack 1000 to use at all, so it is
 * empty here and the tests below decide it honestly if it ever is not.
 */
const NEVER_STRIPPED_SLOTS: ReadonlySet<string> = new Set([
  'melvorD:Weapon',
  'melvorD:Summon1',
  'melvorD:Summon2',
  'melvorD:Gem',
  'melvorD:Consumable',
]);

/** The quiver, which {@link whyQuiverIsDeadWeight} judges on its own terms. */
const QUIVER_SLOT_ID = 'melvorD:Quiver';

/** `AmmoTypeID.None`, enums.d.ts:2987 — a weapon that reads no quiver at all. */
const AMMO_TYPE_NONE = 4;

/**
 * Skills whose modifiers can act inside a fight.
 *
 * Used to read `ModifierValue.skill` (modifiers.d.ts:56, :19) — the game's own
 * record of what a modifier was scoped to, and the only part of a modifier the
 * rest of this adapter is willing to interpret (see `skillScopedModifiers`). A
 * modifier the game itself tagged `melvorD:Thieving` cannot change a fight; one
 * tagged `melvorD:Defence` obviously can.
 *
 * Spelled out rather than tested with `instanceof CombatSkill`: the typings
 * declare that abstract class (combatSkills.d.ts:1) but nothing promises it is
 * emitted as a runtime value, and a missing global would silently classify
 * every skill as non-combat — which is the direction that strips armour.
 */
const COMBAT_SKILL_IDS: ReadonlySet<string> = new Set([
  'melvorD:Attack',
  'melvorD:Strength',
  'melvorD:Defence',
  'melvorD:Hitpoints',
  'melvorD:Ranged',
  'melvorD:Magic',
  'melvorD:Prayer',
  'melvorD:Slayer',
  'melvorItA:Corruption',
]);

/**
 * Unscoped modifiers this file is willing to call inert in a fight.
 *
 * Deny by default: a modifier that is neither scoped to a non-combat skill nor
 * named here keeps its item on the character. That is the safe direction — the
 * cost of a wrong "inert" is a fight fought without something that mattered,
 * which is the "guard that starves its own precondition" failure this project
 * keeps paying for, while the cost of a wrong "keeps" is only that an item goes
 * on being exposed exactly as it is today.
 *
 * Two entries, both from the shipped item data, both needed by the two items
 * this exists for:
 *
 * - `thievingStealth` — "Stealth while Thieving" by its own description
 *   (f_00000b.js). Carried by the Thiever's Cape, which is otherwise entirely
 *   Thieving-scoped. The game gives it no skill scope, so nothing but naming it
 *   can place it.
 * - `currencyGain` — the Jeweled Necklace's only modifier, +5% GP with a
 *   currency scope and no skill scope. Named here with its cost stated rather
 *   than hidden: this one is not *quite* free. An unscoped +5% GP applies to
 *   coins a kill drops, so stripping the necklace costs 5% of a fight's coin
 *   income. It changes what the fight *pays*, never whether it is won or
 *   survived — and 5% of a fight's coins is not a trade anyone would take
 *   against a 1-in-19 chance per death of destroying a 5,000 GP item, 55 deaths
 *   in.
 *
 * Deliberately absent, and worth naming because they are the near misses:
 * `flatBarrierDamage` and `lifesteal` are both unscoped and neither sets
 * `isCombat`, and both act in a fight. Their slots are excluded above as well,
 * so it takes two mistakes rather than one to strip either.
 */
const NON_COMBAT_MODIFIERS: ReadonlySet<string> = new Set([
  'melvorD:thievingStealth',
  'melvorD:currencyGain',
]);

/** One modifier on a worn item, reduced to what the inertness test reads. */
export interface ModifierFacts {
  /** `ModifierValue.modifier.id` — the registered modifier, not the value. */
  id: string;
  /** `ModifierValue.skill?.id`; null when the game scoped it to no skill. */
  skillId: string | null;
}

/** A worn item, reduced to what the inertness test reads. */
export interface WornItemFacts {
  slotId: string;
  equipmentStats: readonly { key: string; value: number }[];
  modifiers: readonly ModifierFacts[];
  /** `EquipmentItem.conditionalModifiers` (item.d.ts:259), counted only. */
  conditionalModifiers: number;
}

/**
 * Why this item demonstrably does nothing in a fight, or null.
 *
 * Pure, so the judgement can be exercised without a live game — and the
 * judgement is the whole risk here. Every clause must hold; the first that does
 * not is the reason the item stays on.
 *
 * "No equipment stats" is the load-bearing clause and it is a genuine
 * discriminator rather than an absence of evidence. Leather Gloves carry
 * `meleeDefenceBonus: 1`, Bronze Arrows `rangedStrengthBonus: 7`, a combat
 * familiar `summoningMaxhit: 5.9`; the Thiever's Cape and the Jeweled Necklace
 * carry `equipmentStats: []`. A stat worth zero is treated as absent, because
 * the game adds it to the same total either way.
 *
 * `conditionalModifiers` is a refusal rather than a filter, for the reason
 * `skillScopedModifiers` already gives: a conditional carries a condition this
 * code cannot evaluate (conditionalModifiers.d.ts:375-379), so an item with one
 * is an item whose worth is unknown, and unknown is not inert.
 *
 * @returns A reason the item is inert, or null when it contributes or cannot be
 *          shown not to.
 */
export function whyInertInFight(item: WornItemFacts): string | null {
  if (NEVER_STRIPPED_SLOTS.has(item.slotId)) return null;

  const stats = item.equipmentStats.filter(
    (stat) => typeof stat.value === 'number' && stat.value !== 0,
  );
  if (stats.length > 0) return null;

  if (item.conditionalModifiers > 0) return null;

  for (const modifier of item.modifiers) {
    if (modifier.skillId !== null && !COMBAT_SKILL_IDS.has(modifier.skillId)) continue;
    if (modifier.skillId === null && NON_COMBAT_MODIFIERS.has(modifier.id)) continue;
    return null;
  }

  return item.modifiers.length === 0
    ? 'it has no equipment stats and no modifiers at all'
    : `it has no equipment stats, and every modifier it carries acts outside combat (${item.modifiers
        .map((modifier) => modifier.id)
        .join(', ')})`;
}

/**
 * Why the loaded ammunition cannot be fired, or null when it can.
 *
 * The quiver gets its own rule because it fails the test above for the wrong
 * reason: Bronze Arrows carry `rangedStrengthBonus: 7`, a real equipment stat,
 * and the stat still lands in the character's totals — it simply cannot do
 * anything for a caster. 981 of them are worn here behind a Staff of Air.
 *
 * Not a second describer. This is the same comparison `readCannotAttackReason`
 * makes, from the same lines of the shipped `Player.attack`
 * (f_00019a.js:759-766):
 *
 *     if (weapon.ammoTypeRequired === 4) break;
 *     if (weapon.ammoTypeRequired !== quiver.ammoType) { ...canAttack = false; }
 *
 * A weapon requiring `None` never reads the quiver at all, and one requiring a
 * type the quiver does not hold answers with `TOASTS_WRONG_AMMO`
 * (f_00019a.js:720-725). Either way the stack in the slot is dead weight for
 * this fight, and the fight is one where the ranged branch of
 * `readCannotAttackReason` is not the thing refusing — that branch withholds
 * the fight outright, so nothing reaches here with a mismatch it would have
 * blocked.
 *
 * @param required - `WeaponItem.ammoTypeRequired` (item.d.ts:308), or undefined
 *                   for a weapon that is not a `WeaponItem` at all.
 * @param loaded - `EquipmentItem.ammoType` (item.d.ts:269) of what is in the
 *                 quiver, or undefined when it holds a non-ammunition item.
 */
export function whyQuiverIsDeadWeight(
  required: number | undefined,
  loaded: number | undefined,
): string | null {
  if (required === undefined || required === AMMO_TYPE_NONE) {
    return 'the equipped weapon reads no quiver, so the loaded ammunition cannot be fired';
  }
  if (loaded !== required) {
    return 'the equipped weapon fires a different ammunition type from the one loaded';
  }
  return null;
}

/** A worn item worth taking off before a fight. */
export interface StrippableValuable {
  slotId: string;
  itemId: string;
  name: string;
  quantity: number;
  /** Why it demonstrably contributes nothing, for the action's detail. */
  reason: string;
}

/**
 * What is currently in the stash, keyed by the slot it came out of.
 *
 * Module-level, and the slot is the key rather than the item because that is
 * what the restore has to put it back into. `EquipmentItem.validSlots` can hold
 * several — the Jeweled Necklace is valid in both Amulet and Passive — so
 * re-equipping by item alone could quietly move it.
 */
const stash = new Map<string, { itemId: string; quantity: number }>();

/** Whether anything is waiting to be put back on. */
export function hasStashedValuables(): boolean {
  return stash.size > 0;
}

/** Test seam, and the reset a fresh character select needs. */
export function forgetStashedValuables(): void {
  stash.clear();
}

/** What stripping and restoring claim to change. */
export interface StashProjection {
  /** Slots whose contents are set aside, sorted so the diff is stable. */
  stashed: string[];
  /** Slots still worn that ought to come off. */
  exposed: string[];
}

function projectStash(): StashProjection {
  return {
    stashed: [...stash.keys()].sort(),
    exposed: readStrippableValuables()
      .map((entry) => entry.slotId)
      .sort(),
  };
}

/**
 * Worn gear that earns nothing in a fight and can be lost by dying in one.
 *
 * Reads only. Every slot is judged independently and one unreadable slot costs
 * only itself: a slot that cannot describe its own contents is left alone,
 * which is the direction that keeps gear on the character.
 */
export function readStrippableValuables(): StrippableValuable[] {
  const strippable: StrippableValuable[] = [];

  const equipped = safeValue('valuables.equippedItems', () =>
    Object.entries(game.combat.player.equipment.equippedItems),
  );
  if (equipped === undefined) return [];

  const weapon = safeValue('valuables.equippedWeapon', () =>
    game.combat.player.equipment.getItemInSlot('melvorD:Weapon' as never),
  );

  for (const [slotId, slot] of equipped) {
    try {
      const item = slot.item;
      if (item === slot.emptyItem) continue;

      const reason =
        slotId === QUIVER_SLOT_ID
          ? whyQuiverIsDeadWeight(
              // `ammoTypeRequired` lives on WeaponItem (item.d.ts:308), not on
              // the EquipmentItem `getItemInSlot` (equipment.d.ts:110) returns.
              weapon instanceof WeaponItem ? weapon.ammoTypeRequired : undefined,
              item.ammoType,
            )
          : whyInertInFight({
              slotId,
              equipmentStats: item.equipmentStats,
              modifiers: (item.modifiers ?? []).map((modifier) => ({
                id: modifier.modifier.id,
                skillId: modifier.skill?.id ?? null,
              })),
              conditionalModifiers: item.conditionalModifiers?.length ?? 0,
            });
      if (reason === null) continue;

      strippable.push({
        slotId,
        itemId: item.id,
        name: item.name,
        quantity: slot.quantity,
        reason,
      });
    } catch (error) {
      noteSwallowed('valuables.readStrippableValuables.slot', error);
      // A slot that will not describe itself keeps whatever is in it.
    }
  }

  return strippable;
}

/**
 * Takes the valuables off, recording where each came from.
 *
 * Driven by `stripValuablesForFight` in the reflex tier, which is what decides
 * *when* — once a fight is actually running, and never outside one, because the
 * Thiever's Cape earns its place every second the character is Thieving.
 *
 * Anything already stashed is restored first — see
 * {@link restoreStashedValuables} — because a stash keyed by slot cannot hold
 * two generations of the same slot, and a strip that quietly dropped the older
 * record would strand an item in the bank forever.
 *
 * Every removal goes through {@link unequipItem}, which owns the one
 * precondition that can genuinely lose the item: unequipping moves it to the
 * bank, and a full bank holding none of it has nowhere to put it. That is not
 * theoretical here — the bank runs 53 of 64 slots most of the day — and the
 * refusal is the right answer: that piece stays worn, exactly as exposed as it
 * is today, and nothing about the fight changes either way.
 *
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function stashValuablesForCombat(isSuspended: () => boolean): ActionResult<StashProjection> {
  if (stash.size > 0) {
    const restored = restoreStashedValuables(isSuspended);
    if (!restored.ok && restored.reason !== 'precondition') return restored;
  }

  return act(
    {
      name: 'valuables.stash',
      observe: projectStash,
      precondition: () => {
        const exposed = readStrippableValuables();
        if (exposed.length === 0) return 'nothing worn contributes nothing to a fight';
        return null;
      },
      perform: () => {
        const done: string[] = [];
        for (const entry of readStrippableValuables()) {
          const result = unequipItem(entry.slotId, isSuspended);
          if (!result.ok) {
            done.push(`${entry.name} stays on: ${result.detail}`);
            continue;
          }
          stash.set(entry.slotId, { itemId: entry.itemId, quantity: entry.quantity });
          done.push(`${entry.name} off ${entry.slotId} — ${entry.reason}`);
        }
        return done;
      },
      changed: (before, after) => after.stashed.length > before.stashed.length,
    },
    isSuspended,
  );
}

/**
 * Puts back everything the last strip took off.
 *
 * The half that makes stripping acceptable at all. The operator's own
 * selections are their state — today's `withBuyQuantity` work made that
 * explicit and it is written down in `learnings/` — so a strip without a
 * restore is not a guard, it is a different kind of taking.
 *
 * Two things it deliberately declines to force, both for the same reason:
 *
 * - A slot that is no longer empty is left alone and said so. Something else
 *   chose what is in it — the operator, or a planner objective — and putting
 *   the old item back would make this the third tier fighting over a slot,
 *   which is the shape that produced forty equips a minute for forty minutes
 *   (`StuckEquipWatch`, and the note on `readGearUpgrades`).
 * - An item the bank no longer holds is dropped from the stash with a named
 *   reason rather than retried forever.
 *
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function restoreStashedValuables(isSuspended: () => boolean): ActionResult<StashProjection> {
  return act(
    {
      name: 'valuables.restore',
      observe: projectStash,
      // Refused while a fight is running, and this is the load-bearing line of
      // the whole pair.
      //
      // The condition lived only in the reflex, which reads `inCombat` from a
      // snapshot the policy tier refreshes every 3s while the reflex tier runs
      // every 1s. So a restore evaluated against a snapshot captured *before*
      // the engage saw no fight and put everything back on one second into it.
      // That is not a theoretical window: it killed the Jeweled Necklace. Death
      // 56 landed with the necklace worn, because the restore had re-equipped
      // it mid-fight, and `applyDeathPenalty` (player.d.ts:410) rolled onto the
      // slot the strip had already emptied.
      //
      // Here rather than only in the caller because a caller's condition is an
      // opinion and a precondition is a property: the reflex, the reload path
      // in `save.ts` and anything added later all pass through this function,
      // and none of them can now put a valuable back on a character who is in a
      // fight. `game.combat.isActive` spans `selectMonster` to `stop`, so a
      // restore cannot land between an engage and its disengage.
      precondition: () => {
        if (stash.size === 0) return 'nothing is stashed';
        if (game.combat.isActive)
          return 'in combat; the stash stays in the bank until the fight ends';
        return null;
      },
      perform: () => {
        const done: string[] = [];
        for (const [slotId, entry] of [...stash.entries()]) {
          const occupant = safeValue('valuables.restore.slot', () => {
            const slot = game.combat.player.equipment.equippedItems[slotId];
            return slot === undefined || slot.item === slot.emptyItem ? null : slot.item.id;
          });

          if (occupant === undefined) {
            done.push(`${slotId} could not be read; leaving ${entry.itemId} stashed`);
            continue;
          }
          if (occupant !== null) {
            stash.delete(slotId);
            done.push(`${slotId} now holds ${occupant}; leaving ${entry.itemId} in the bank`);
            continue;
          }

          // Dropped from the stash whether or not it went back on. A record
          // that survives its own failed restore is a record that will be
          // retried on every tick forever, which is the shape this repo has
          // twice had bury a real diagnostic under its own noise.
          const result = equipItem(entry.itemId, slotId, isSuspended);
          stash.delete(slotId);
          done.push(
            result.ok
              ? `${entry.itemId} back on ${slotId}`
              : `${entry.itemId} could not go back on ${slotId}: ${result.detail}`,
          );
        }
        return done;
      },
      changed: (before, after) => after.stashed.length < before.stashed.length,
    },
    isSuspended,
  );
}

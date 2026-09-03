import type { RecipeLike } from './recipes.js';
import { noteSwallowed, safeBoolean } from './safe.js';

/**
 * Whether the bank can pay for one action of a recipe, and what it is short of
 * when it cannot.
 *
 * Split out of `candidates.ts` because both halves of that file asked the same
 * question from opposite directions: the candidate list drops a recipe it
 * cannot afford, and the blocked list exists to name what that recipe was
 * missing. Keeping `canAfford` and `missingInputs` in one module is what stops
 * a recipe being refused by the first and then discarded by the second for
 * finding nothing to report -- the shape that left Summoning, and later Alt
 * Magic, absent from both lists at once.
 */

/**
 * Whether the player holds the inputs a recipe consumes.
 *
 * There is no single API for this, and assuming one silently offers recipes the
 * agent cannot perform — which is exactly what happened live: Firemaking was
 * offered "Oak Logs" with zero Oak Logs in the bank, because the check below
 * used to be `getRecipeCosts?.(recipe)` and that method does not exist on
 * Firemaking. An optional call on a missing method yields `undefined`, which
 * compared unequal to `false`, so nothing was filtered and the failure looked
 * like nothing at all.
 *
 * Three shapes, in order of reliability:
 *
 * 1. `ArtisanSkill.getRecipeCosts(recipe)` — Smithing, Crafting, Fletching,
 *    Herblore, Runecrafting, Summoning, Cooking. Authoritative: the game's own
 *    cost calculation, including modifiers.
 * 2. `FiremakingLog.log` — Firemaking consumes exactly one item, named directly
 *    on the recipe. `CraftingSkill` only exposes `getCurrentRecipeCosts()` for
 *    the *selected* recipe, which is useless while enumerating.
 * 3. `ArtisanSkillRecipe.itemCosts` — the raw cost list, as a fallback.
 *
 * A recipe whose inputs cannot be determined by any of these is allowed
 * through: a skill that consumes nothing (Woodcutting, Thieving) is the common
 * case, and refusing everything unknown would silently remove whole skills.
 */
/**
 * The first alternative input set the bank can pay for.
 *
 * Several artisan recipes accept different materials for the same product —
 * arrow shafts from any log, for instance. The game tracks which alternative is
 * *selected*, and prices only that one, so a recipe the character can plainly
 * make looks unaffordable whenever the selection points at a material they do
 * not hold.
 *
 * @returns The index of an affordable alternative, or null if none.
 */
export function affordableAlternative(recipe: object): number | null {
  const alternatives = (
    recipe as { alternativeCosts?: { itemCosts: { item: AnyItem; quantity: number }[] }[] }
  ).alternativeCosts;

  if (!Array.isArray(alternatives)) return null;

  for (const [index, alternative] of alternatives.entries()) {
    const affordable = alternative.itemCosts.every(
      (cost) => game.bank.getQty(cost.item) >= cost.quantity,
    );
    if (affordable) return index;
  }

  return null;
}

/**
 * A Summoning secondary material the bank can pay for.
 *
 * Summoning tablets take shards plus *one of several* secondary items — a
 * familiar might accept logs or ore or fish. The game prices whichever is
 * selected, and with nothing selected the recipe reads as unaffordable, so
 * Summoning appeared in neither the candidate list nor the blocked list: the
 * skill was simply absent.
 *
 * The same shape as {@link affordableAlternative} under a different field name,
 * which is why it is checked alongside it rather than folded in: one is a set
 * of cost *lists*, the other a set of interchangeable *items*.
 *
 * @returns An affordable secondary item, or null if none is held.
 */
export function affordableNonShardItem(
  recipe: object,
  skill?: { getAltRecipeCosts?: (recipe: object, item: AnyItem) => { checkIfOwned(): boolean } },
): AnyItem | null {
  const options = (recipe as { nonShardItemCosts?: AnyItem[] }).nonShardItemCosts;
  if (!Array.isArray(options)) return null;

  // Ask the game what each choice actually costs, rather than checking that one
  // is held at all.
  //
  // "Held at all" was the original test and it is wrong in a way that only
  // shows up with a mixed bank: Summoning prices a secondary by its value, so a
  // cheap log is needed in far greater quantity than an expensive one. With one
  // Normal Log and fifteen Mahogany, the first option matched on `> 0`, the
  // recipe was pointed at a log there was nowhere near enough of, and the craft
  // refused with "missing materials for melvorF:Ent" while holding 57 shards
  // and plenty of usable wood.
  if (typeof skill?.getAltRecipeCosts === 'function') {
    for (const item of options) {
      try {
        if (skill.getAltRecipeCosts(recipe, item).checkIfOwned()) return item;
      } catch (error) {
        noteSwallowed('candidates.affordableNonShardItem', error);
        // An unpriceable option is skipped, not treated as affordable.
      }
    }
    return null;
  }

  // Without the skill there is nothing better to ask, so fall back to the old
  // test rather than refusing outright.
  return options.find((item) => game.bank.getQty(item) > 0) ?? null;
}

/** Shared with the artisan adapter; see `selectAffordableInputs` there. */
function selectAffordableRecipeInputs(
  skill: {
    setAltRecipes?: Map<object, number>;
    selectedNonShardCosts?: Map<object, AnyItem>;
    getAltRecipeCosts?: (recipe: object, item: AnyItem) => { checkIfOwned(): boolean };
  },
  recipe: object,
): void {
  const alternative = affordableAlternative(recipe);
  if (alternative !== null && typeof skill.setAltRecipes?.set === 'function') {
    skill.setAltRecipes.set(recipe, alternative);
  }

  const nonShard = affordableNonShardItem(recipe, skill);
  if (nonShard !== null && typeof skill.selectedNonShardCosts?.set === 'function') {
    skill.selectedNonShardCosts.set(recipe, nonShard);
  }
}

export function canAfford(
  skill: {
    getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean };
    setAltRecipes?: Map<object, number>;
    selectedNonShardCosts?: Map<object, AnyItem>;
  },
  recipe: object,
): boolean {
  if (typeof skill.getRecipeCosts === 'function') {
    if (skill.getRecipeCosts(recipe).checkIfOwned()) return true;

    // `getRecipeCosts` prices the *selected* alternative only. Fletching arrow
    // shafts default to Normal Logs, so a character holding 300 Oak and 258
    // Mahogany read as unable to fletch anything at all. Point the recipe at
    // inputs the bank holds and ask again — the second answer is the real one.
    //
    // Asking whether *some* component is held instead was too lenient: it
    // offered Summoning tablets whose shard colour the character did not have,
    // and the skill silently refused to start.
    selectAffordableRecipeInputs(skill, recipe);
    return skill.getRecipeCosts(recipe).checkIfOwned();
  }

  const consumes = recipe as {
    log?: AnyItem;
    itemCosts?: { item: AnyItem; quantity: number }[];
  };

  if (consumes.log !== undefined) {
    return game.bank.getQty(consumes.log) > 0;
  }

  if (Array.isArray(consumes.itemCosts)) {
    return consumes.itemCosts.every((cost) => game.bank.getQty(cost.item) >= cost.quantity);
  }

  // Alt Magic pays in runes, and nothing above reads them: AltMagic declares no
  // `getRecipeCosts`, and a spell has neither `log` nor `itemCosts`. So every
  // spell fell through to the `return true` below and read as free, which is
  // the planner trap this whole function exists to prevent -- worse here than
  // elsewhere, because the executor then casts once, runs out and stops.
  const spell = spellCosts(recipe);
  if (spell !== null) {
    return spell.every((cost) => game.bank.getQty(cost.item) >= cost.quantity);
  }

  // Consumes nothing identifiable — a gathering skill, most likely.
  return true;
}

/**
 * What one cast of an Alt Magic spell consumes, or null for anything else.
 *
 * Runes plus `fixedItemCosts` (altMagic.d.ts:72), which is the spell's
 * equivalent of `itemCosts`. `runesRequiredAlt` (spells.d.ts:28) is the
 * combination-rune list and is used when the player has them enabled --
 * `Player.useCombinationRunes` (player.d.ts:122), documented as "If the player
 * should use combination runes for spellcasting". Holding the standard runes
 * does not help in that mode, so the two lists are alternatives, not a union.
 *
 * Three things this deliberately does not price:
 *
 * - **The staff discount.** Equipping the matching staff lowers a spell's rune
 *   cost. `EquipmentItem.providedRunes` (item.d.ts:267),
 *   `Player.runesProvided` (player.d.ts:81) and `Player.computeRuneProvision`
 *   (player.d.ts:156) are the machinery, but *how* they apply to an Alt Magic
 *   cast is stated nowhere in the typings: `Player.getRuneCosts`
 *   (player.d.ts:163) carries no documentation at all, and
 *   `AltMagic.getCurrentRecipeRuneCosts` (altMagic.d.ts:151) prices only the
 *   selected spell, which is never set during enumeration. So the unreduced
 *   cost is used. That can withhold a spell a staff would have paid for -- a
 *   missing candidate, which is the recoverable direction -- rather than invent
 *   a discount, which is how Crystal came to advertise ten times what it paid.
 * - **Rune preservation.** `runePreservationChance` (altMagic.d.ts:127) is a
 *   chance not to consume, so it lowers the *average* cost over many casts.
 *   The question here is whether one cast can be paid for, and a chance cannot
 *   pay for it.
 * - **The item a spell converts.** `specialCost` (altMagic.d.ts:74) is a
 *   selection rather than a fixed cost, and the executor's precondition
 *   already refuses when nothing eligible is banked (`skills-misc.ts`,
 *   `startAltMagic`). That refusal is visible; this silence was not.
 *
 * Attack spells share `runesRequired` and would match this shape, but they live
 * in `game.attackSpells` and never reach a skill's `actions` registry.
 */
export function spellCosts(recipe: object): { item: AnyItem; quantity: number }[] | null {
  const spell = recipe as RecipeLike;
  if (!Array.isArray(spell.runesRequired)) return null;

  const useAlt =
    Array.isArray(spell.runesRequiredAlt) &&
    safeBoolean(
      'candidates.useCombinationRunes',
      () => game.combat.player.useCombinationRunes,
      false,
    );

  const costs = [...(useAlt ? (spell.runesRequiredAlt ?? []) : spell.runesRequired)];
  if (Array.isArray(spell.fixedItemCosts)) costs.push(...spell.fixedItemCosts);
  return costs;
}

/** The items a recipe consumes that the bank does not currently hold enough of. */
export function missingInputs(
  recipe: object,
): { itemId: string; name: string; need: number; have: number }[] {
  const consumes = recipe as {
    log?: AnyItem;
    itemCosts?: { item: AnyItem; quantity: number }[];
  };

  if (consumes.log !== undefined) {
    const have = game.bank.getQty(consumes.log);
    return have > 0 ? [] : [{ itemId: consumes.log.id, name: consumes.log.name, need: 1, have }];
  }

  // A recipe can be unaffordable because of a material it *chooses* rather than
  // one it lists. Summoning tablets take shards plus one of several secondary
  // items; with the shards in hand and no secondary, the listed costs all read
  // as satisfied, the recipe reported nothing missing, and it was dropped from
  // the blocked list too — the skill was absent from both, which is how it
  // stayed invisible with 37 shards banked.
  const choices = (recipe as { nonShardItemCosts?: AnyItem[] }).nonShardItemCosts;
  if (Array.isArray(choices) && choices.length > 0) {
    const held = choices.find((item) => game.bank.getQty(item) > 0);
    if (held === undefined) {
      const first = choices[0];
      if (first !== undefined) {
        return [
          {
            itemId: first.id,
            // Named as a choice, because any one of them unblocks the recipe.
            name: `${first.name} (or any of ${choices.length} secondary materials)`,
            need: 1,
            have: 0,
          },
        ];
      }
    }
  }

  // Runes are the Alt Magic equivalent, and this list is what turns a dropped
  // candidate into a stated reason. Without it a spell short of Nature Runes
  // would be refused by `canAfford` and then produce no blocked entry either,
  // because `missing.length === 0` discards it -- the skill absent from both
  // lists again, one filter further along.
  const costs = consumes.itemCosts ?? spellCosts(recipe);
  if (Array.isArray(costs)) {
    return costs
      .map((cost) => ({
        itemId: cost.item.id,
        name: cost.item.name,
        need: cost.quantity,
        have: game.bank.getQty(cost.item),
      }))
      .filter((entry) => entry.have < entry.need);
  }

  return [];
}

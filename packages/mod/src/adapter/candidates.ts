import type { Candidate } from '@melvor-agent/shared';
import { readActiveRecipeIds } from './active.js';
import { readMasteryTokenIds } from './bank.js';
import { readSpellRuneIds } from './combat.js';
import { readFoodReserve } from './equipment.js';
import {
  readAllSeedIds,
  readBarelyEnoughIngredientIds,
  readSeedShortfalls,
  readShortSeedIds,
} from './farming.js';
import {
  FISHING_ID,
  MINING_ID,
  STARTABLE_SKILL_IDS,
  THIEVING_ID,
  WOODCUTTING_ID,
} from './gathering.js';
import { readSlayerBlockedReason } from './management.js';
import { readShopCandidates } from './shop.js';
import { readTaskWantedItemIds } from './township.js';

const MS_PER_HOUR = 3_600_000;

/**
 * Enumerates the gathering objectives the mod can execute right now.
 *
 * Every number comes from the game's own registries and modifier-aware getters,
 * so the planner chooses among measured options rather than guessing. Locked
 * recipes are not emitted at all, which is what makes `available` a literal
 * `true`: an unavailable candidate is simply absent.
 *
 * @returns Candidates with XP/hr and GP/hr attached, best XP first.
 */
export function readGatherCandidates(): Candidate[] {
  return [
    ...safely('woodcutting', woodcuttingCandidates),
    ...safely('mining', miningCandidates),
    ...safely('fishing', fishingCandidates),
    ...safely('thieving', thievingCandidates),
    ...safely('other skills', genericSkillCandidates),
  ].sort((a, b) => (b.xpPerHour ?? 0) - (a.xpPerHour ?? 0));
}

/** Recipe list for a skill, or null when the skill does not expose one. */
function safeRecipes(skill: { actions?: { allObjects: RecipeLike[] } }): RecipeLike[] | null {
  try {
    return skill.actions?.allObjects ?? null;
  } catch {
    return null;
  }
}

interface RecipeLike {
  id: string;
  name: string;
  level: number;
  baseExperience: number;
}

/**
 * Candidates for every other startable skill.
 *
 * These share one shape because `SkillWithMastery` gives them all an `actions`
 * registry of `BasicSkillRecipe`, which carries `level` and `baseExperience`.
 * The *rate* is the honest approximation here: `actionInterval` is the skill's
 * current modified interval rather than a per-recipe one, so XP/hr is exact for
 * whatever is selected and indicative for the rest. Inventing a per-recipe
 * interval the game does not expose would be worse than an approximation the
 * planner can compare consistently.
 *
 * Recipes the player cannot currently do are filtered out, so an unaffordable
 * or locked option is absent rather than offered and then refused.
 */
function genericSkillCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const skillId of STARTABLE_SKILL_IDS) {
    // Skills with their own, more accurate enumerations.
    if (
      skillId === WOODCUTTING_ID ||
      skillId === MINING_ID ||
      skillId === FISHING_ID ||
      skillId === THIEVING_ID
    ) {
      continue;
    }

    const skill = game.skills.getObjectByID(skillId);
    if (skill === undefined) continue;

    const withActions = skill as AnySkill & {
      actions?: { allObjects: RecipeLike[] };
      actionInterval?: number;
      isMasteryActionUnlocked?: (recipe: object) => boolean;
      getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean };
    };

    const recipes = safeRecipes(withActions);
    if (recipes === null) continue;

    // Throws on the artisan skills when no recipe is selected. A nominal 3s
    // keeps every recipe comparable to the others rather than dropping the
    // whole skill; it is an approximation either way, since this is the skill's
    // current interval and not a per-recipe one.
    const interval = safeNumber(() => withActions.actionInterval, 3000);
    const actionsPerHour = interval > 0 ? MS_PER_HOUR / interval : 0;

    for (const recipe of recipes) {
      try {
        if (withActions.isMasteryActionUnlocked?.(recipe) === false) continue;
        if (!canAfford(withActions, recipe)) continue;
      } catch {
        // A recipe whose availability cannot be determined is not offered:
        // a candidate the adapter would then refuse is a planner trap.
        continue;
      }

      candidates.push({
        kind: 'gather_resource',
        params: { kind: 'gather_resource', skillId, recipeId: recipe.id },
        label: `${skill.name}: ${recipe.name}`,
        xpPerHour: actionsPerHour * recipe.baseExperience,
        requiresLevel: recipe.level,
        available: true,
      });
    }
  }

  return candidates;
}

/**
 * GP value of one unit of a recipe's product.
 *
 * `sellsFor` is a `CurrencyQuantity`, and not every item sells for GP —
 * reporting a non-GP value as `gpPerHour` would quietly mislead the planner.
 */
function gpValue(product: AnyItem): number {
  const sale = product.sellsFor;
  return sale.currency === game.gp ? sale.quantity : 0;
}

function candidate(
  skillId: string,
  skillName: string,
  recipe: { id: string; name: string; level: number; baseExperience: number },
  intervalMs: number,
  productGp: number,
): Candidate {
  const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;
  return {
    kind: 'gather_resource',
    params: { kind: 'gather_resource', skillId, recipeId: recipe.id },
    label: `${skillName}: ${recipe.name}`,
    xpPerHour: actionsPerHour * recipe.baseExperience,
    gpPerHour: actionsPerHour * productGp,
    requiresLevel: recipe.level,
    available: true,
  };
}

function woodcuttingCandidates(): Candidate[] {
  const skill = game.woodcutting;
  return skill.actions.allObjects
    .filter((tree) => skill.isTreeUnlocked(tree))
    .map((tree) =>
      candidate(
        WOODCUTTING_ID,
        skill.name,
        tree,
        // Already accounts for gear, mastery and modifiers.
        skill.getTreeInterval(tree),
        gpValue(tree.product),
      ),
    );
}

/**
 * Runs one skill's enumeration, returning nothing if it throws.
 *
 * Game getters are not uniformly safe to read in an arbitrary state, and this
 * is not a rare edge: candidate enumeration runs precisely when *nothing* is
 * selected, which is the state several getters refuse to answer in. Observed in
 * a real session:
 *
 * - `Mining.actionInterval` — "Tried to get active rock data, but none is selected"
 * - artisan `actionInterval` — "Tried to access active recipe, but none is selected"
 *
 * Without per-skill isolation one such getter empties the entire candidate list
 * and the agent has nothing at all to do — a far worse outcome than losing one
 * skill's options.
 */
function safely(name: string, enumerate: () => Candidate[]): Candidate[] {
  try {
    return enumerate();
  } catch (error) {
    console.warn(`[play-agent] ${name} candidates unavailable:`, error);
    return [];
  }
}

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
      } catch {
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

function canAfford(
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

  // Consumes nothing identifiable — a gathering skill, most likely.
  return true;
}

/**
 * Reads a getter that may throw when the game has nothing selected.
 *
 * Returns the fallback rather than propagating, because "this number is
 * currently unknowable" is a normal state here, not an error.
 */
function safeNumber(read: () => number | undefined, fallback: number): number {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

function miningCandidates(): Candidate[] {
  const skill = game.mining;
  return skill.actions.allObjects
    .filter((rock) => skill.canMineOre(rock))
    .map((rock) =>
      // `baseInterval` is a readonly constant on the skill. The obvious choice,
      // `actionInterval`, reads `activeRock` and **throws** when no rock is
      // selected — which is exactly the state candidate enumeration runs in.
      // So this understates the real rate (it ignores modifiers) but it is
      // always readable, and a candidate list that throws is worth nothing.
      candidate(MINING_ID, skill.name, rock, skill.baseInterval, gpValue(rock.product)),
    );
}

/**
 * Thieving, with its GP actually visible.
 *
 * This existed in the generic path and was therefore scored at zero GP/hr,
 * because a thieving payout is a `currencyDrops` entry on the NPC rather than a
 * product item that gets sold. The effect was not cosmetic: Thieving is one of
 * the few things that turns time directly into money with no input, and a
 * planner comparing candidates on GP/hr could not see it at all. Every
 * money-making decision was made from a list where the money option read as
 * worthless.
 *
 * The rate is expected value, not best case: the payout is multiplied by the
 * game's own success rate, because a failed pickpocket earns nothing and
 * quoting the max would make Thieving look better than it is at low levels.
 *
 * **Gated on food.** A failed pickpocket deals damage, so Thieving without food
 * equipped is a slow death rather than an income — the same class of hazard as
 * combat, and it does not announce itself, because the first hour looks like it
 * is working. Offering it foodless would hand the planner an option that ends
 * with a dead character, so no candidates are emitted at all.
 *
 * The stricter check — whether healing outpaces damage for a *specific* NPC —
 * belongs with the combat gate's survivability math and is not duplicated here.
 * This is the floor: no food, no thieving.
 */
function thievingCandidates(): Candidate[] {
  const skill = game.thieving;
  const player = game.combat.player;

  const foodQuantity = player.food.slots.reduce(
    (sum, slot) => sum + (slot.item === game.emptyFoodItem ? 0 : slot.quantity),
    0,
  );
  if (foodQuantity <= 0) return [];

  // Same "what is this for" annotation the fight candidates carry. Monsters got
  // it and Thieving did not, which is backwards: the reason this character is
  // grinding Thieving at all is Bob the Farmer, the only NPC in the game's data
  // that drops Potato Seeds, and his entry said nothing about that.
  const wantedByNeed = new Set<string>([...readTaskWantedItemIds(), ...readShortSeedIds()]);

  return (
    skill.actions.allObjects
      .filter((npc) => npc.level <= skill.level)
      // Dropped while the NPC hits too hard for the health on hand; see
      // THIEVING_MAX_HIT_FRACTION. Filtered on the NPC rather than on a marker
      // smuggled through the label — that trick put a literal NUL byte in this
      // file and shipped it, which is what a clever encoding buys you.
      .filter((npc) => !hitsTooHardForNow(npc.maxHit))
      .map((npc) => {
        const intervalMs = safeNumber(() => skill.actionInterval, 3000);
        const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;
        // Reads 0 unless Thieving is the skill currently running, the same
        // active-selection dependency documented for Mining.actionInterval
        // above. The consequence is quiet and one-directional: every Thieving
        // candidate shows no rate at all while the agent is doing anything
        // else, so a planner comparing options sees Thieving as worthless
        // exactly when it is deciding whether to start it.
        //
        // Left as zero rather than filled with a guess — an invented success
        // rate would make the comparison confidently wrong instead of visibly
        // absent — and the absence is now stated in the blocked list so it
        // reads as "not measurable from here" rather than "not worth doing".
        const successRate = Math.max(
          0,
          Math.min(1, safeNumber(() => skill.getNPCSuccessRate(npc), 0) / 100),
        );

        const gpPerAction = npc.currencyDrops
          .filter((drop) => drop.currency === game.gp)
          // `quantity` is the maximum roll, so the mean is about half of it.
          .reduce((sum, drop) => sum + drop.quantity / 2, 0);

        return {
          kind: 'gather_resource' as const,
          params: {
            kind: 'gather_resource' as const,
            skillId: THIEVING_ID,
            recipeId: npc.id,
          },
          // Damage is named, because Thieving hurts and the number is not
          // proportional to level. Golbin Chief hits 10.1 at level 16 while
          // Marauder hits 6.8 at 21 and Assistant Cook 8.6 at 26 — so choosing by
          // XP alone picks the hardest-hitting NPC of its tier without ever
          // seeing the figure. It was chosen exactly that way, and the operator
          // had to point out that it hits hard for the character's health.
          //
          // Shown as a share of *current* health rather than maximum: a hit worth
          // a fifteenth of a full bar is a different proposition at half health,
          // and Thieving damage accrues over many failures rather than resolving
          // in one fight.
          label: `Thieving: ${npc.name} — hits up to ${npc.maxHit} (${hpShare(npc.maxHit)} of current HP)${describeNpcDrops(npc, wantedByNeed)}`,
          xpPerHour: actionsPerHour * npc.baseExperience * successRate,
          gpPerHour: actionsPerHour * gpPerAction * successRate,
          requiresLevel: npc.level,
          available: true as const,
        };
      })
  );
}

/**
 * The share of current health a Thieving hit may take before the NPC is refused.
 *
 * Thieving is the only thing in the game that damages the character without
 * being combat, and it had no survivability gate at all — combat screens every
 * monster by combat level and then re-checks the real max hit once the fight
 * starts, while Thieving checked only that food was equipped.
 *
 * A quarter of *current* health, not maximum, so the gate tightens as the
 * character gets hurt rather than staying nominally satisfied while the bar
 * empties. At full health almost everything passes, which is correct: a 10.1
 * hit against 150 is survivable and the eat reflex covers it. At 40 health the
 * same NPC is refused, which is the case that actually matters and the one a
 * max-health check would have waved through.
 *
 * Deliberately not stricter. Refusing safe pickpockets costs the income that
 * funds Auto Eat, and Auto Eat is what would remove this whole problem.
 */
const THIEVING_MAX_HIT_FRACTION = 0.25;

/**
 * Whether an NPC hits too hard for the health currently available.
 *
 * Fails open on an unreadable state: refusing every NPC because the player
 * object could not be read would silently delete Thieving, and this is a gate
 * on one skill rather than a guard against irreversible harm.
 */
function hitsTooHardForNow(maxHit: number): boolean {
  try {
    const current = game.combat.player.hitpoints;
    if (current <= 0) return false;
    return maxHit > current * THIEVING_MAX_HIT_FRACTION;
  } catch {
    return false;
  }
}

/**
 * A hit expressed against the health actually available.
 *
 * The planner reads these labels as text; a bare number invites comparing max
 * hits to each other rather than to the character, which is the comparison that
 * decides whether a run is survivable.
 */
function hpShare(maxHit: number): string {
  try {
    const current = game.combat.player.hitpoints;
    if (current <= 0) return 'unknown share';
    return `${Math.round((maxHit / current) * 100)}%`;
  } catch {
    return 'unknown share';
  }
}

function fishingCandidates(): Candidate[] {
  const skill = game.fishing;
  return skill.actions.allObjects
    .filter((fish) => fish.area !== undefined && skill.isMasteryActionUnlocked(fish))
    .map((fish) =>
      candidate(
        FISHING_ID,
        skill.name,
        fish,
        // Fishing rolls an interval per action, so the midpoint is the honest
        // expected value rather than either bound.
        (skill.getMinFishInterval(fish) + skill.getMaxFishInterval(fish)) / 2,
        gpValue(fish.product),
      ),
    );
}

/**
 * Enumerates sellable surplus in the bank.
 *
 * Mirrors the refusals in {@link sellItem} exactly — locked items and
 * zero-value items are absent rather than offered and then rejected. A
 * candidate the adapter would refuse is a planner trap, not a choice.
 *
 * @returns One candidate per sellable stack, most valuable first.
 */
export function readSellCandidates(): Candidate[] {
  // Never offer to sell what an open Township task is asking for. Selling one
  // of those throws away a whole task cycle, and task cycles are the fastest
  // Township XP available — 500 Potatoes went for a few hundred GP an hour
  // before a task appeared wanting 100 of them.
  const wantedByTasks = readTaskWantedItemIds();
  // And never the last of an ingredient. Two Garum Seeds — the only herb seeds
  // of the session and exactly one planting's worth — came within a drift
  // check of being sold in a batch aimed at Oak Logs.
  const scarceIngredients = readBarelyEnoughIngredientIds();
  // And never a farming seed, at any level. Farming is the prerequisite for the
  // last untrained skill in scope, seeds are worth a few GP against a harvest's
  // XP, and the list was offering 32 Ancient Corn Seeds while Farming sat at 1.
  const seeds = readAllSeedIds();
  // And never a rune an attack spell in reach actually needs. All 81 Mind Runes
  // were sold as spare change; they were half of every castable spell, and
  // Magic was unreachable for the rest of the session.
  const spellRunes = readSpellRuneIds();
  // And never a Mastery Token. They are not containers, so the open reader's
  // instanceof check never saw them, while this reader — filtering on nothing
  // of the sort — listed six Woodcutting tokens as a stack to liquidate. A
  // token held does nothing; a token sold is mastery XP set on fire.
  const masteryTokens = readMasteryTokenIds();

  return (
    [...game.bank.items.values()]
      .filter((entry) => !wantedByTasks.has(entry.item.id))
      .filter((entry) => !scarceIngredients.has(entry.item.id))
      .filter((entry) => !seeds.has(entry.item.id))
      .filter((entry) => !spellRunes.has(entry.item.id))
      .filter((entry) => !masteryTokens.has(entry.item.id))
      .filter((entry) => !game.bank.lockedItems.has(entry.item))
      .filter((entry) => gpValue(entry.item) > 0)
      .map((entry) => ({
        kind: 'sell_items' as const,
        params: { kind: 'sell_items' as const, itemId: entry.item.id, keepQuantity: 0 },
        label: `Sell ${entry.quantity}x ${entry.item.name}`,
        // Not a rate: this is the one-off value of clearing the stack. Left off
        // gpPerHour deliberately, since a sale has no duration to divide by.
        gpPerHour: 0,
        available: true as const,
      }))
      // Sorted by item id, which does not change, rather than by the label —
      // the label embeds the quantity, so "23x Raw Herring" becoming "29x"
      // re-sorted the entire list and every index after it moved.
      //
      // That made multi-step plans race the agent's own gathering: build a plan
      // from a listing, and by the time it is submitted the stacks have grown and
      // the indices point at different items. The drift guard caught each one, so
      // nothing wrong was ever done — but four plans in a row were refused, which
      // is a planner unable to plan.
      .sort((a, b) => a.params.itemId.localeCompare(b.params.itemId))
  );
}

/** How many of a repeatable consumable to buy at once. */
const CONSUMABLE_BATCH = 25;

/**
 * How many to buy in one objective.
 *
 * An upgrade is bought once and owning two is meaningless, so those stay at
 * one. Consumables are different: a summoning tablet needs dozens of shards,
 * and buying them one objective at a time turns a single decision into dozens
 * of planning cycles — the exact opposite of "optimise for good transitions".
 *
 * Capped by what the character can actually afford, so the objective is never
 * offered in a quantity that will refuse on price.
 */
function batchSizeFor(purchase: { purchaseId: string; gpCost: number; owned: number }): number {
  const shopPurchase = game.shop.purchases.getObjectByID(purchase.purchaseId);
  if (shopPurchase === undefined) return 1;

  // The game states outright whether a purchase may be bought in quantity.
  // Bank slots are the case that matters: an upgrade, bought repeatedly, and
  // the constraint that has blocked production all session while the character
  // held 178,000 GP and slots cost under a hundred.
  if (!shopPurchase.allowQuantityPurchase) return 1;

  const affordable = purchase.gpCost > 0 ? Math.floor(game.gp.amount / purchase.gpCost) : 1;
  return Math.max(1, Math.min(CONSUMABLE_BATCH, affordable));
}

/**
 * Shop purchases the planner may choose, as objective candidates.
 *
 * Wraps {@link readShopCandidates} into the `Candidate` shape. The GP cost rides
 * along in the label because the planner has to weigh a purchase against a floor
 * and there is no rate to express it as.
 *
 * @returns Affordable, permitted purchases, cheapest first.
 */
export function readShopObjectiveCandidates(): Candidate[] {
  return readShopCandidates().map((purchase) => ({
    kind: 'buy_shop_upgrade' as const,
    params: {
      kind: 'buy_shop_upgrade' as const,
      purchaseId: purchase.purchaseId,
      quantity: batchSizeFor(purchase),
      // A floor of zero here means "the objective sets no reserve"; the planner
      // is expected to raise it. Defaulting higher would silently make cheap
      // early upgrades unbuyable.
      gpFloor: 0,
    },
    label: `Buy ${batchSizeFor(purchase)}x ${purchase.name} (${purchase.gpCost.toLocaleString()} GP each, owned ${purchase.owned})`,
    available: true as const,
  }));
}

/**
 * High-value recipes the agent is level-unlocked for but cannot currently do,
 * with the input it is missing.
 *
 * This is the prerequisite half of planning. A candidate list alone answers
 * "what can I do now", which is not enough to play well: the best move is often
 * to produce the input for something better. Firemaking Oak Logs is worth six
 * times Woodcutting Oak Trees, but only once you have oak logs — and the agent
 * discovered that chain by accident, because cutting oak happened to be the
 * highest-XP thing it *could* do.
 *
 * These are deliberately NOT candidates. A candidate is something the agent has
 * proven it can execute, and keeping that guarantee absolute is what makes
 * choosing by index safe. These are context for the planner: read them, then
 * pick a real candidate that produces the missing input.
 *
 * @returns Blocked options with their missing inputs, best XP first.
 */
export function readBlockedOpportunities(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const blocked: ReturnType<typeof readBlockedOpportunities> = [];

  // Slayer explains itself, because its candidate list is empty for three
  // unrelated reasons and they want three different responses.
  const slayerReason = readSlayerBlockedReason();
  if (slayerReason !== null) {
    blocked.push({ label: `Slayer: ${slayerReason}`, xpPerHour: 0, missing: [] });
  }

  // A seed shortfall is a blocked opportunity in the exact sense this list
  // exists for, and it was the thing holding up the last skill in scope.
  blocked.push(...readSeedShortfalls());

  // Food is what sustains everything that damages the character, and running
  // out is how an unattended run stops without failing.
  blocked.push(...readFoodReserve());

  // And a better recipe in the skill already running. An objective pins a
  // recipe, not a skill, so the agent levels past better options without ever
  // reconsidering — it ground Woman while Marauder unlocked and paid more.
  blocked.push(...readBetterRecipeNotice());
  blocked.push(...readThievingRateNotice());

  for (const skillId of STARTABLE_SKILL_IDS) {
    const skill = game.skills.getObjectByID(skillId);
    if (skill === undefined) continue;

    const withActions = skill as AnySkill & {
      actions?: { allObjects: RecipeLike[] };
      actionInterval?: number;
      isMasteryActionUnlocked?: (recipe: object) => boolean;
      getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean };
    };

    const recipes = safeRecipes(withActions);
    if (recipes === null) continue;

    const interval = safeNumber(() => withActions.actionInterval, 3000);
    const actionsPerHour = interval > 0 ? MS_PER_HOUR / interval : 0;

    for (const recipe of recipes) {
      try {
        if (skill.level < recipe.level) continue;
        if (withActions.isMasteryActionUnlocked?.(recipe) === false) continue;
        // Only the ones we cannot do: the rest are already real candidates.
        if (canAfford(withActions, recipe)) continue;

        const missing = missingInputs(recipe);
        if (missing.length === 0) continue;

        blocked.push({
          label: `${skill.name}: ${recipe.name}`,
          xpPerHour: actionsPerHour * recipe.baseExperience,
          missing,
        });
      } catch {
        // Same reasoning as enumeration: an unreadable recipe is skipped, not
        // reported as an opportunity we cannot describe.
      }
    }
  }

  return rankBlocked(blocked);
}

/** How many blocked opportunities to report. */
const BLOCKED_LIMIT = 12;

/**
 * Ranks blocked opportunities so no skill is silenced by another's variants.
 *
 * Sorting purely by rate filled all twelve slots with Smithing and Fletching
 * variants — five ways to make a bronze weapon — and pushed Summoning out
 * entirely. The skill then appeared in neither list, which reads as "this skill
 * does not exist" rather than "this skill needs one more material".
 *
 * So each skill contributes its best entry first, and only then are the
 * remaining slots filled by rate. Breadth before depth, because the purpose of
 * this list is to tell the planner what the *game* is offering, not to rank
 * within one skill.
 */
function rankBlocked<T extends { label: string; xpPerHour: number }>(blocked: T[]): T[] {
  const byRate = [...blocked].sort((a, b) => b.xpPerHour - a.xpPerHour);

  const bestPerSkill: T[] = [];
  const seenSkills = new Set<string>();
  for (const entry of byRate) {
    const skill = entry.label.split(':')[0] ?? entry.label;
    if (seenSkills.has(skill)) continue;
    seenSkills.add(skill);
    bestPerSkill.push(entry);
  }

  const remainder = byRate.filter((entry) => !bestPerSkill.includes(entry));
  return [...bestPerSkill, ...remainder].slice(0, BLOCKED_LIMIT);
}

/**
 * Skill actions the character has not yet unlocked, nearest first.
 *
 * A locked action is invisible in every other list: candidates hold only what
 * can be done now, and the blocked list holds only what is missing *materials*.
 * So "Farmer unlocks at Thieving 15" — the thing that decides whether Herblore
 * is reachable this hour or next — could not be seen at all, and the only way
 * to find out was to grind and watch.
 *
 * Reported as opportunities because a level requirement is not an action; it is
 * a reason to keep going with one.
 */
export function readLockedActions(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const locked: ReturnType<typeof readLockedActions> = [];

  for (const skillId of STARTABLE_SKILL_IDS) {
    const skill = game.skills.getObjectByID(skillId);
    if (skill === undefined) continue;

    const withActions = skill as AnySkill & { actions?: { allObjects: RecipeLike[] } };
    const recipes = safeRecipes(withActions);
    if (recipes === null) continue;

    // The next one up only: a list of everything still locked would bury the
    // one that is actually close.
    let nearest: RecipeLike | null = null;
    for (const recipe of recipes) {
      if (recipe.level <= skill.level) continue;
      if (nearest === null || recipe.level < nearest.level) nearest = recipe;
    }

    if (nearest === null) continue;

    locked.push({
      label: `${skill.name}: ${nearest.name} unlocks at level ${nearest.level} (currently ${skill.level})`,
      xpPerHour: 0,
      missing: [],
    });
  }

  return locked;
}

/** The items a recipe consumes that the bank does not currently hold enough of. */
function missingInputs(
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

  if (Array.isArray(consumes.itemCosts)) {
    return consumes.itemCosts
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

/**
 * A better recipe in the skill that is already running.
 *
 * An objective pins a *recipe*, not a skill: "pickpocket Woman until Thieving
 * 39" keeps pickpocketing Woman for the whole eighteen levels, even as Marauder
 * unlocks at 21 and pays more. The agent levels past better options without
 * ever reconsidering, because nothing re-examines the choice once it is made.
 *
 * Reported, never applied. Automatically switching to the highest-XP recipe
 * would have quietly destroyed the plan running right now — Normal Trees were
 * chosen *over* Yew on purpose, trading XP for four times the rare-drop rolls,
 * because the seed is what Farming is blocked on. An auto-upgrade cannot tell
 * that apart from an oversight, so it stays a planning decision with the
 * arithmetic put in front of it.
 *
 * @param candidates - Current candidates, already level-filtered.
 * @param activeSkillId - The skill currently occupying the action slot.
 * @param activeRecipeIds - The recipes it is running.
 */
function readBetterRecipeNotice(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const active = game.activeAction;
  if (active === undefined) return [];

  // `readActiveRecipeIds` rather than `active.selectedRecipe`, which was the
  // first attempt and silently did nothing. `selectedRecipe` exists on
  // ArtisanSkill and Farming only — not on Woodcutting, Fishing, Mining or
  // Thieving, which are exactly the skills where grinding a superseded recipe
  // for hours is possible. The notice was written for "pickpocketing Woman
  // while Marauder is unlocked" and could never have fired for it.
  //
  // The snapshot has solved this since it was written: one function that knows
  // where each skill keeps its selection. Reaching for a cast instead of the
  // adapter's own reader is how a feature ends up shaped like a capability and
  // behaving like an absence.
  const runningRecipeIds = readActiveRecipeIds();
  if (runningRecipeIds.length === 0) return [];

  const inSkill = readGatherCandidates().filter(
    (candidate) => (candidate.params as { skillId?: string }).skillId === active.id,
  );

  const running = inSkill.find((candidate) =>
    runningRecipeIds.includes(String((candidate.params as { recipeId?: unknown }).recipeId ?? '')),
  );
  const best = inSkill.reduce<Candidate | null>(
    (leader, candidate) =>
      leader === null || (candidate.xpPerHour ?? 0) > (leader.xpPerHour ?? 0) ? candidate : leader,
    null,
  );
  if (running === undefined || best === null || best === running) return [];

  const runningRate = running.xpPerHour ?? 0;
  const bestRate = best.xpPerHour ?? 0;
  // A tenth better, so noise and rounding do not produce a permanent notice.
  if (bestRate <= runningRate * 1.1) return [];

  return [
    {
      label: `Running ${running.label} at ${Math.round(runningRate).toLocaleString()} xp/h while ${best.label} is unlocked at ${Math.round(bestRate).toLocaleString()} xp/h. Switching is a choice, not an oversight — the slower one may be producing something the faster one does not.`,
      xpPerHour: 0,
      missing: [],
    },
  ];
}

/**
 * Says when Thieving's rates cannot be measured, rather than showing zero.
 *
 * `getNPCSuccessRate` reads 0 unless Thieving is the skill currently running —
 * the same active-selection dependency the Mining interval has. So every
 * Thieving candidate loses its xp/h and gp/h the moment the agent does
 * anything else, and a planner comparing options sees a skill worth nothing
 * precisely when it is choosing whether to start it.
 *
 * The bias is one-directional and therefore worse than noise: Thieving is
 * under-rated only while it is not running, which is exactly when the decision
 * is made. Naming it costs one line and turns a silent zero into a known gap —
 * the same reason Slayer explains its empty list and monsters carry their
 * loot chance.
 */
function readThievingRateNotice(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    const skill = game.thieving;
    if (game.activeAction === skill) return [];
    if (skill.level < 1) return [];

    return [
      {
        label:
          'Thieving candidates show no xp/h or gp/h because the game only reports a success rate while Thieving is the running skill. The rates are unknown here, not zero — Marauder was measured at 8,078 xp/h and 47,829 gp/h while it ran.',
        xpPerHour: 0,
        missing: [],
      },
    ];
  } catch {
    return [];
  }
}

/**
 * Names what a Thieving NPC drops that the agent is short of.
 *
 * The mirror of {@link readMonsterDropsOfInterest} for the other half of the
 * game that has loot tables. Without it, every NPC entry reads as a rate and a
 * damage figure, and the reason to prefer one over another — that it carries
 * the seed a blocked skill is waiting on — is invisible.
 *
 * `uniqueDrop` is included because it is guaranteed rather than rolled, and it
 * is not part of the loot table: an NPC whose unique drop is the wanted item
 * gives it every single time, which is the strongest possible reason to pick it
 * and was previously nowhere on screen.
 */
function describeNpcDrops(
  npc: {
    lootTable: { drops: { item: { id: string; name: string } }[] };
    uniqueDrop?: { item: { id: string; name: string } };
  },
  wanted: ReadonlySet<string>,
): string {
  if (wanted.size === 0) return '';

  try {
    const names = new Set<string>();
    for (const drop of npc.lootTable.drops) {
      if (wanted.has(drop.item.id)) names.add(drop.item.name);
    }
    const unique = npc.uniqueDrop?.item;
    if (unique !== undefined && wanted.has(unique.id)) names.add(`${unique.name} (guaranteed)`);

    return names.size === 0 ? '' : ` — drops ${[...names].join(', ')}, which you are short of`;
  } catch {
    return '';
  }
}

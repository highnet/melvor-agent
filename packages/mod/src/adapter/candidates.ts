import type { Candidate } from '@melvor-agent/shared';
import {
  FISHING_ID,
  MINING_ID,
  STARTABLE_SKILL_IDS,
  THIEVING_ID,
  WOODCUTTING_ID,
} from './gathering.js';
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
export function affordableNonShardItem(recipe: object): AnyItem | null {
  const options = (recipe as { nonShardItemCosts?: AnyItem[] }).nonShardItemCosts;
  if (!Array.isArray(options)) return null;

  return options.find((item) => game.bank.getQty(item) > 0) ?? null;
}

/** Shared with the artisan adapter; see `selectAffordableInputs` there. */
function selectAffordableRecipeInputs(
  skill: {
    setAltRecipes?: Map<object, number>;
    selectedNonShardCosts?: Map<object, AnyItem>;
  },
  recipe: object,
): void {
  const alternative = affordableAlternative(recipe);
  if (alternative !== null && typeof skill.setAltRecipes?.set === 'function') {
    skill.setAltRecipes.set(recipe, alternative);
  }

  const nonShard = affordableNonShardItem(recipe);
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

  return skill.actions.allObjects
    .filter((npc) => npc.level <= skill.level)
    .map((npc) => {
      const intervalMs = safeNumber(() => skill.actionInterval, 3000);
      const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;
      const successRate = Math.max(0, Math.min(1, skill.getNPCSuccessRate(npc) / 100));

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
        label: `Thieving: ${npc.name}`,
        xpPerHour: actionsPerHour * npc.baseExperience * successRate,
        gpPerHour: actionsPerHour * gpPerAction * successRate,
        requiresLevel: npc.level,
        available: true as const,
      };
    });
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

  return (
    [...game.bank.items.values()]
      .filter((entry) => !wantedByTasks.has(entry.item.id))
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

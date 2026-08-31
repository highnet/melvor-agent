import type { Candidate } from '@melvor-agent/shared';
import { FISHING_ID, MINING_ID, STARTABLE_SKILL_IDS, WOODCUTTING_ID } from './gathering.js';
import { readShopCandidates } from './shop.js';

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
    // The three gathering skills have their own, more accurate enumerations.
    if (skillId === WOODCUTTING_ID || skillId === MINING_ID || skillId === FISHING_ID) continue;

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
function canAfford(
  skill: { getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean } },
  recipe: object,
): boolean {
  if (typeof skill.getRecipeCosts === 'function') {
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
  return [...game.bank.items.values()]
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
    .sort((a, b) => b.label.localeCompare(a.label));
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
      quantity: 1,
      // A floor of zero here means "the objective sets no reserve"; the planner
      // is expected to raise it. Defaulting higher would silently make cheap
      // early upgrades unbuyable.
      gpFloor: 0,
    },
    label: `Buy ${purchase.name} (${purchase.gpCost.toLocaleString()} GP, owned ${purchase.owned})`,
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

  return blocked.sort((a, b) => b.xpPerHour - a.xpPerHour).slice(0, 12);
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

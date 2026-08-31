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
    ...woodcuttingCandidates(),
    ...miningCandidates(),
    ...fishingCandidates(),
    ...genericSkillCandidates(),
  ].sort((a, b) => (b.xpPerHour ?? 0) - (a.xpPerHour ?? 0));
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
      actions?: {
        allObjects: { id: string; name: string; level: number; baseExperience: number }[];
      };
      actionInterval?: number;
      isMasteryActionUnlocked?: (recipe: object) => boolean;
      getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean };
    };

    const recipes = withActions.actions?.allObjects;
    if (recipes === undefined) continue;

    const interval = withActions.actionInterval ?? 0;
    const actionsPerHour = interval > 0 ? MS_PER_HOUR / interval : 0;

    for (const recipe of recipes) {
      if (withActions.isMasteryActionUnlocked?.(recipe) === false) continue;
      // Costs exist only on the crafting-style skills; where present, an
      // unaffordable recipe is not a real option.
      if (withActions.getRecipeCosts?.(recipe).checkIfOwned() === false) continue;

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

function miningCandidates(): Candidate[] {
  const skill = game.mining;
  return skill.actions.allObjects
    .filter((rock) => skill.canMineOre(rock))
    .map((rock) =>
      // Mining has no per-rock interval getter; `actionInterval` is the skill's
      // current modified interval. Using it means the rate is a good estimate
      // for the *selected* rock and an approximation for the others — better
      // than inventing a per-rock formula the game does not expose.
      candidate(MINING_ID, skill.name, rock, skill.actionInterval, gpValue(rock.product)),
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

import { readAgilityLapRate } from './agility.js';

/** Agility's skill id; see readAgilityLapRate for why it is special-cased. */
const AGILITY_ID = 'melvorD:Agility';
import type { BlockedSeverity, Candidate } from '@melvor-agent/shared';
import { readActiveRecipeIds } from './active.js';
import { canAfford, missingInputs, spellCosts } from './affordability.js';
import { readMasteryTokenIds } from './bank.js';
import { readSpellRuneIds } from './combat.js';
import { readFoodReserve, readMealCount } from './equipment.js';
import { readAllSeedIds, readBarelyEnoughIngredientIds, readSeedShortfalls } from './farming.js';
import {
  fishingCandidates,
  miningCandidates,
  thievingCandidates,
  woodcuttingCandidates,
} from './gather-candidates.js';
import {
  FISHING_ID,
  MINING_ID,
  STARTABLE_SKILL_IDS,
  THIEVING_ID,
  WOODCUTTING_ID,
} from './gathering.js';
import { readSlayerBlockedReason } from './management.js';
import { describeSustain, gpValue, netProductGpFor } from './pricing.js';
import {
  MS_PER_HOUR,
  firstUsableInterval,
  masteryNote,
  productYieldFor,
  resolveInterval,
  xpMultiplierFor,
} from './rates.js';
import {
  ALT_MAGIC_ID,
  type RecipeLike,
  currentLevelFor,
  isRecipeRealmUnlocked,
  readMasteryGate,
  recipeRequirement,
  safeRecipes,
} from './recipes.js';
import { noteSwallowed, recordFallback, safeBoolean, safeList, safeNumber } from './safe.js';
import { readShopCandidates, readShopGoals } from './shop.js';
import { readTaskWantedQuantities } from './township.js';

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
    ...safeCandidates('woodcutting', woodcuttingCandidates),
    ...safeCandidates('mining', miningCandidates),
    ...safeCandidates('fishing', fishingCandidates),
    ...safeCandidates('thieving', thievingCandidates),
    ...safeCandidates('other-skills', genericSkillCandidates),
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
      baseInterval?: number;
      isMasteryActionUnlocked?: (recipe: object) => boolean;
      getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean };
    };

    const recipes = safeRecipes(withActions);
    if (recipes === null) continue;

    // Throws on the artisan skills when no recipe is selected. A nominal 3s
    // keeps every recipe comparable to the others rather than dropping the
    // whole skill; it is an approximation either way, since this is the skill's
    // current interval and not a per-recipe one.
    // The skill's own base interval before any invented constant.
    //
    // `actionInterval` reads the selected recipe and throws when none is
    // chosen, which is the state enumeration runs in -- so this landed on a
    // nominal three seconds for every artisan skill. ArtisanSkill declares
    // `abstract readonly baseInterval` (artisanSkill.d.ts:8), so each concrete
    // skill knows its own: 2000 for Smithing, Fletching, Runecrafting and
    // Herblore, 5000 for Summoning. The fallback understated the first group by
    // half and overstated Summoning by two thirds, in opposite directions, from
    // a number that was never read off anything.
    //
    // Undefined rather than a number when neither answers, because for a skill
    // with a per-recipe getter that is not a failure — it is a backstop that
    // will never be reached. See `resolveInterval`, which owns the one report.
    const skillInterval = firstUsableInterval(
      () => withActions.actionInterval,
      () => withActions.baseInterval,
    );

    // A course skill earns a whole lap at a time; see readAgilityLapRate. Every
    // obstacle reports the same lap rate, because that is what running the
    // course actually pays. Rope Jump advertised 21 levels/h this way and
    // delivered about 6.
    const lapXpPerHour = skillId === AGILITY_ID ? readAgilityLapRate() : null;

    // Asked once for the whole skill, because whether the mastery answer is a
    // lock at all is a property of the skill, not of one recipe. Null means it
    // is not; the level requirement is then the gate. See readMasteryGate.
    const masteryUnlocked = readMasteryGate(skill, withActions, recipes);

    // Why recipes were dropped, so a skill that vanishes entirely still says
    // something. See reportSilentSkill: total silence is what made Alt Magic
    // cost a day.
    const dropped = { mastery: 0, level: 0, realm: 0, cost: 0 };
    let emitted = 0;

    for (const recipe of recipes) {
      const requirement = recipeRequirement(recipe);

      // The mastery check is separated from the affordability check because a
      // single try around both conflates two different failures.
      //
      // "This action is locked" and "the lock could not be consulted" are not
      // the same claim, and treating them alike hides whole skills. A mastery
      // check that cannot answer is therefore read as "unlocked": if that is
      // wrong the action is offered and the game refuses it, which is visible
      // and recoverable. Silence is neither.
      //
      // There is a third case, and it is the one that hid Alt Magic for a day.
      // `isMasteryActionUnlocked` can answer perfectly well and still not be
      // answering this question -- see readMasteryGate. When that is so the
      // level requirement takes over, because for every skill in this loop the
      // mastery answer *is* the level check, and dropping it without a
      // replacement would offer level-70 spells at Magic 10.
      if (masteryUnlocked !== null) {
        if (!masteryUnlocked.has(recipe)) {
          dropped.mastery += 1;
          continue;
        }
      } else if (requirement.level > currentLevelFor(skill, requirement.abyssal)) {
        dropped.level += 1;
        continue;
      }

      try {
        if (!isRecipeRealmUnlocked(recipe)) {
          dropped.realm += 1;
          continue;
        }
        // Affordability is different: a candidate the adapter would then refuse
        // is a planner trap, so an unanswerable cost check does skip.
        if (!canAfford(withActions, recipe)) {
          dropped.cost += 1;
          continue;
        }
      } catch (error) {
        noteSwallowed('candidates.genericSkillCandidates', error);
        dropped.cost += 1;
        continue;
      }

      // Per recipe, not per skill: mastery is earned on the individual action,
      // so two recipes in one skill do not share an interval.
      const interval = resolveInterval(
        `candidates.skillInterval:${skillId}`,
        skill,
        recipe,
        skillInterval,
      );
      const actionsPerHour = interval > 0 ? MS_PER_HOUR / interval : 0;

      // Interval was only one axis. Mastery also raises what an action yields
      // and the XP it pays, so a rate built from interval alone still
      // understates mastered work -- just by less than before.
      const xpMultiplier = xpMultiplierFor(skill, recipe);
      const yielded = productYieldFor(skill, recipe, recipe.baseQuantity ?? 1);
      const netPerHour = actionsPerHour * netProductGpFor(skill, recipe, yielded);

      candidates.push({
        kind: 'gather_resource',
        params: { kind: 'gather_resource', skillId, recipeId: recipe.id },
        label: requirement.abyssal
          ? `${skill.name}: ${recipe.name} — Abyssal realm, needs Abyssal lvl ${requirement.level}`
          : `${skill.name}: ${recipe.name}${
              netPerHour > 0
                ? ` — output worth ${Math.round(netPerHour).toLocaleString()} GP/h net of inputs, if sold`
                : ''
            }${describeSustain(recipe, interval)}${masteryNote(skill, recipe)}${veinDecayNote(skillId)}`,
        xpPerHour: lapXpPerHour ?? actionsPerHour * requirement.xp * xpMultiplier,
        gpPerHour: netPerHour > 0 ? netPerHour : undefined,
        // Alt Magic's alchemy pays currency; every other recipe here produces
        // an item whose value needs a sale to become GP.
        gpIsEarned: skillId === ALT_MAGIC_ID,
        requiresLevel: requirement.level,
        available: true,
      });
      emitted += 1;
    }

    reportSilentSkill(skillId, recipes.length, emitted, dropped);
  }

  return candidates;
}

/**
 * Records a skill that produced nothing for a reason nothing else reports.
 *
 * A recipe dropped here leaves no trace anywhere by itself, and a whole skill
 * dropped here is invisible in the strongest sense: the planner reads absence
 * as "this skill does not exist" and never asks again.
 *
 * Deliberately not one entry per dropped recipe, and not one per empty skill.
 * Two of the four reasons already reach the planner in the list built for them:
 * `readLockedActions` names the nearest level-gated recipe, and
 * `readUnstockedSkills` says "no candidates because nothing it can make is in
 * stock". Filing those here as well would put a permanent line per idle skill
 * in the one report whose job is to show what actually broke, and that noise
 * has already evicted real diagnostics twice; see `safe.ts`.
 *
 * The mastery gate and the realm gate have no such channel, and between them
 * they can empty a whole skill. That is the shape Alt Magic had: 26 spells in,
 * nothing out, nowhere.
 */
function reportSilentSkill(
  skillId: string,
  total: number,
  emitted: number,
  dropped: { mastery: number; level: number; realm: number; cost: number },
): void {
  if (total === 0 || emitted > 0) return;
  if (dropped.mastery === 0 && dropped.realm === 0) return;

  recordFallback(
    `candidates.noCandidates:${skillId}`,
    `all ${total} recipe(s) dropped: ${dropped.mastery} mastery-locked, ${dropped.level} level-locked, ${dropped.realm} realm-locked, ${dropped.cost} unaffordable`,
  );
}

/** Harvesting's skill id; see veinDecayNote for why it is called out. */
const HARVESTING_ID = 'melvorItA:Harvesting';

/**
 * Names the decay a Harvesting vein suffers while it is worked.
 *
 * Structurally the mining respawn trap: a `HarvestingVein` carries
 * `currentIntensity` and `maxIntensity` (harvesting.d.ts:37-38), the skill runs
 * a `veinDecayTimer` and a `reduceVeinIntensity()` (harvesting.d.ts:77, 109),
 * and each product declares a `minIntensityPercent` (harvesting.d.ts:16) below
 * which it stops dropping. So a vein pays less the longer it is harvested, and
 * the rate on the board charges none of that.
 *
 * Unlike mining's respawn there is no honest correction to apply. How much
 * intensity one action or one decay tick removes is not stated in the typings,
 * `passiveRegenInterval` (harvesting.d.ts:66) restores an unstated amount
 * against it, and nothing exposes a sustained yield. Modelling it would mean
 * inventing exactly the constant that made Crystal advertise an order of
 * magnitude above what it paid -- and the same invention was already tried for
 * mining's passive regen and measured 3.3x high.
 *
 * So the rate stands as the upper bound it is, and the label says which
 * direction it is wrong in. A planner that reads "unverified" can measure; one
 * that reads a confident number cannot.
 */
function veinDecayNote(skillId: string): string {
  return skillId === HARVESTING_ID
    ? ' — rate unverified: a vein loses intensity as it is harvested and the decay per action is not stated in the typings, so this is an upper bound'
    : '';
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
 *
 * Renamed from `safely`, which was also the name of an unrelated helper in
 * `active.ts` with a different signature: two functions of the same name doing
 * different things is how a reader concludes the codebase already reports these
 * failures everywhere. It did not; this was the only one that reported at all.
 */
function safeCandidates(name: string, enumerate: () => Candidate[]): Candidate[] {
  return safeList(`candidates.${name}`, enumerate);
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
/**
 * Meals below which food stops being surplus and becomes the reserve.
 *
 * Matches COOK_WHEN_MEALS_BELOW in the reflex tier on purpose: one number
 * decides both when to cook more and when to stop selling it, so the two
 * cannot disagree about what "enough food" means.
 */
const FOOD_SELL_FLOOR = 40;

/** Whether an item is ammunition, and so must not be liquidated. */
function isAmmunition(item: AnyItem): boolean {
  try {
    return item instanceof EquipmentItem && item.ammoType !== undefined;
  } catch (error) {
    noteSwallowed('candidates.isAmmunition', error);
    return false;
  }
}

export function readSellCandidates(): Candidate[] {
  // Never offer to sell what an open Township task is asking for. Selling one
  // of those throws away a whole task cycle, and task cycles are the fastest
  // Township XP available — 500 Potatoes went for a few hundred GP an hour
  // before a task appeared wanting 100 of them.
  // And never the last of an ingredient. Two Garum Seeds — the only herb seeds
  // of the session and exactly one planting's worth — came within a drift
  // check of being sold in a batch aimed at Oak Logs.
  // And never a farming seed, at any level. Farming is the prerequisite for the
  // last untrained skill in scope, seeds are worth a few GP against a harvest's
  // XP, and the list was offering 32 Ancient Corn Seeds while Farming sat at 1.
  // And never a rune an attack spell in reach actually needs. All 81 Mind Runes
  // were sold as spare change; they were half of every castable spell, and
  // Magic was unreachable for the rest of the session.
  // And never a rune a reachable *Alt Magic* spell needs. The attack-spell
  // guard reads `game.attackSpells`, no attack spell wants a Nature Rune, and
  // Nature Rune is the input every castable Alt Magic spell has -- so the
  // cheapest-item rule fed 49 casts of Just Learning a Nature Rune apiece on
  // top of the one the spell already charged. See readAltMagicFuelIds.
  // And never a Mastery Token. They are not containers, so the open reader's
  // instanceof check never saw them, while this reader — filtering on nothing
  // of the sort — listed six Woodcutting tokens as a stack to liquidate. A
  // token held does nothing; a token sold is mastery XP set on fire.

  // And never food while the larder is thin.
  //
  // Every other scarce thing in this run got a guard -- seeds, spell runes,
  // mastery tokens, task items -- and the one resource whose absence has
  // actually killed this character, twice, had none. Worse, it is the resource
  // the automatic path selects: `sellToEscapeFullBank` liquidates the *cheapest*
  // stack it can find without asking a planner, and a pile of Raw Shrimp is
  // exactly what cheapest looks like. That is a single call from "the bank is
  // full" to "there is nothing to eat".
  //
  // Not an outright ban: surplus food is real value and a full larder should be
  // sellable. The line is the same reserve the cooking reflex defends, so the
  // two agree instead of one quietly undoing the other.

  return (
    [...game.bank.items.values()]
      .filter((entry) => saleExclusionReason(entry.item, entry.quantity) === null)
      // And never ammunition.
      //
      // The same omission as food, with the same automatic path selecting it:
      // an empty quiver makes every ranged fight refuse outright, and Ranged 20
      // is a stated goal fed by 1,259 self-made arrows. Identified by
      // `ammoType`, which item.d.ts:210 documents as "property exclusive to
      // ammo" -- a structural test rather than a match on the word "arrow",
      // which would miss bolts and javelins entirely.
      .filter((entry) => !isAmmunition(entry.item))
      .filter((entry) => gpValue(entry.item) > 0)
      .map((entry) => ({
        kind: 'sell_items' as const,
        params: {
          kind: 'sell_items' as const,
          itemId: entry.item.id,
          // Keep back what a task still wants and sell the rest, rather than
          // choosing between the whole stack and none of it.
          keepQuantity: readTaskWantedQuantities().get(entry.item.id) ?? 0,
        },
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
  /**
   * How urgent this is. Absent means ordinary.
   *
   * Carried from the producer because only the producer knows whether a line
   * is a countdown or a fact, and the renderer has twelve slots for a list
   * that regularly runs to forty.
   */
  severity?: BlockedSeverity;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const blocked: ReturnType<typeof readBlockedOpportunities> = [];

  // Slayer explains itself, because its candidate list is empty for three
  // unrelated reasons and they want three different responses.
  const slayerReason = readSlayerBlockedReason();
  if (slayerReason !== null) {
    // A reason a menu is empty, not a shortfall to act on.
    blocked.push({ label: `Slayer: ${slayerReason}`, xpPerHour: 0, severity: 'low', missing: [] });
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
  blocked.push(...readUnstockedSkills());

  for (const skillId of STARTABLE_SKILL_IDS) {
    const skill = game.skills.getObjectByID(skillId);
    if (skill === undefined) continue;

    const withActions = skill as AnySkill & {
      actions?: { allObjects: RecipeLike[] };
      actionInterval?: number;
      baseInterval?: number;
      isMasteryActionUnlocked?: (recipe: object) => boolean;
      getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean };
    };

    const recipes = safeRecipes(withActions);
    if (recipes === null) continue;

    // Same chain as the candidate path, and for the same reason: a skill whose
    // `actionInterval` throws during enumeration has not failed, it simply has
    // nothing selected. This site was the second source of the "x456 Tried to
    // get active vein data" noise, after the first was fixed.
    const skillInterval = firstUsableInterval(
      () => withActions.actionInterval,
      () => withActions.baseInterval,
    );

    const masteryUnlocked = readMasteryGate(skill, withActions, recipes);

    for (const recipe of recipes) {
      try {
        // Per recipe, exactly as on the candidate path -- and it was not, which
        // is why Woodcutting and Fishing reported a failure here while pricing
        // themselves correctly two hundred lines up.
        //
        // This loop covers every startable skill, including the four the
        // candidate path hands to dedicated enumerators, and it asked only for
        // a skill-wide interval. Woodcutting and Fishing have none to give:
        // `Woodcutting.actionInterval` (woodcutting.d.ts:86) and
        // `Fishing.actionInterval` (fishing.d.ts:100) read the active action and
        // throw, neither class declares a skill-wide `baseInterval` (it sits on
        // `WoodcuttingTree` at woodcutting.d.ts:46 and, as a min/max pair, on
        // `Fish` at fishing.d.ts:13-14), and their real intervals only ever come
        // from `getTreeInterval` (woodcutting.d.ts:76) and
        // `getMinFishInterval`/`getMaxFishInterval` (fishing.d.ts:128, :130).
        //
        // So every blocked entry for those two was priced at a nominal three
        // seconds. That is not only a false report, it is a false *ranking*: the
        // blocked list is sorted by XP/hr and a flat interval sorts it by base
        // XP alone, which is the same inversion that had Firemaking preferring
        // its slowest logs. Firemaking is fixed here too, for free, because its
        // per-log interval also lives on the recipe.
        //
        // Read before the level and affordability checks rather than after, so
        // that an accessor this skill has genuinely lost is still reported on a
        // pass where nothing turns out to be blocked. A diagnostic that only
        // fires when there is also something to report is not a diagnostic.
        const interval = resolveInterval(
          `candidates.blockedInterval:${skillId}`,
          skill,
          recipe,
          skillInterval,
        );
        const actionsPerHour = interval > 0 ? MS_PER_HOUR / interval : 0;

        if (skill.level < recipe.level) continue;
        // Same gate as the candidate path, for the same reason: a skill whose
        // mastery answer is not a lock would otherwise be absent from both
        // lists, which is how Alt Magic managed to be neither available nor
        // blocked. See readMasteryGate.
        if (masteryUnlocked !== null && !masteryUnlocked.has(recipe)) continue;
        // Only the ones we cannot do: the rest are already real candidates.
        if (canAfford(withActions, recipe)) continue;

        const missing = missingInputs(recipe);
        if (missing.length === 0) continue;

        blocked.push({
          // Names what produces each missing input, where anything does.
          //
          // A blocked entry said what was missing and never what makes it, so
          // turning "needs Iron Bar 0/5" into an action meant a human knowing
          // that Smithing makes bars. That is exactly the join a planner should
          // not have to supply from memory, and the reason the blocked list --
          // whose stated purpose is "the best move is often to produce an input
          // for something better" -- could not actually be used that way.
          label: `${skill.name}: ${recipe.name}${describeProducers(missing)}`,
          xpPerHour: actionsPerHour * recipe.baseExperience,
          missing,
        });
      } catch (error) {
        noteSwallowed('candidates.readBlockedOpportunities', error);
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
function rankBlocked<T extends { label: string; xpPerHour: number; severity?: BlockedSeverity }>(
  blocked: T[],
): T[] {
  // Criticals are never subject to the cap. Food running out with no Auto Eat
  // is the shape of failure that ends a run, and it competed for one of twelve
  // slots against five ways to make a bronze dagger.
  const critical = blocked.filter((entry) => entry.severity === 'critical');
  const byRate = blocked
    .filter((entry) => entry.severity !== 'critical')
    .sort((a, b) => b.xpPerHour - a.xpPerHour);

  const bestPerSkill: T[] = [];
  const seenSkills = new Set<string>();
  for (const entry of byRate) {
    const skill = entry.label.split(':')[0] ?? entry.label;
    if (seenSkills.has(skill)) continue;
    seenSkills.add(skill);
    bestPerSkill.push(entry);
  }

  const remainder = byRate.filter((entry) => !bestPerSkill.includes(entry));
  return [...critical, ...[...bestPerSkill, ...remainder].slice(0, BLOCKED_LIMIT)];
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
  severity: BlockedSeverity;
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
      // About the objective running right now, and it stops being true the
      // moment the objective changes. A level requirement will still be there
      // in an hour; this will not.
      severity: 'high',
      missing: [],
    },
  ];
}

/**
 * The least valuable stack that is safe to sell, for breaking a full-bank
 * deadlock and nothing else.
 *
 * This codebase has said "buying, never selling" since the bank reflex was
 * written, on the grounds that which stack is worth destroying is a judgement
 * with no undo. That held right up until the case it did not cover: a bank at
 * 59/59 with a slot priced above what the character could pay. Every gathering
 * action was refused because its output had nowhere to go, income was zero, the
 * price never moved, and the agent re-planned into the same wall for two hours.
 *
 * Buying stays the first answer and runs first. This exists only for the case
 * where buying is impossible, where the choice is not "sell or keep" but "sell
 * or stop playing".
 *
 * Every guard the sell list already applies is inherited by construction, since
 * this picks from `readSellCandidates`: task items, seeds, runes a castable
 * attack spell or a reachable Alt Magic spell needs, mastery tokens, the last of
 * a recipe ingredient and locked items are all excluded. The *cheapest* surviving stack is chosen, because the point
 * is to free one slot at the smallest cost rather than to raise money.
 */
export function readCheapestExpendableStack(): {
  itemId: string;
  name: string;
  value: number;
} | null {
  try {
    let cheapest: { itemId: string; name: string; value: number } | null = null;

    for (const option of readSellCandidates()) {
      const itemId = String((option.params as { itemId?: unknown }).itemId ?? '');
      const item = game.items.getObjectByID(itemId);
      if (item === undefined) continue;

      const value = gpValue(item) * game.bank.getQty(item);
      if (cheapest === null || value < cheapest.value) {
        cheapest = { itemId, name: item.name, value };
      }
    }

    return cheapest;
  } catch (error) {
    noteSwallowed('candidates.readCheapestExpendableStack', error);
    return null;
  }
}

/**
 * Skills the character is level-qualified for but holds no materials to run.
 *
 * A skill with no affordable recipe emits no candidates at all, and an absent
 * skill is indistinguishable from an impossible one. That has now cost two
 * separate mistakes in a day.
 *
 * Summoning sat at level 1 and never appeared, and it took reading the adapter
 * to establish that the capability was complete and the bank simply held 19
 * shards against recipes that need dozens. Then Crafting, mid-plan, silently
 * left the list the moment its 75 leather became 86 gloves — the same skill
 * that had just been measured as the best rate on the board at 29 levels/h.
 * Both times the planner concluded "unavailable" from silence and moved on.
 *
 * The distinction is worth a line each, and it is a cheap one: for every
 * startable skill with no candidates, name the nearest recipe the character
 * *could* run and the ingredient it lacks. "Crafting is unstocked, buy leather"
 * is an action. Nothing at all is a dead end.
 *
 * Deliberately only skills with no candidates whatsoever. A skill running fine
 * on one recipe does not need to explain the ones it cannot afford, and the
 * blocked list has a twelve-line budget that this session already learned to
 * respect the hard way.
 */
export function readUnstockedSkills(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const out: ReturnType<typeof readUnstockedSkills> = [];

  try {
    const available = new Set(
      readGatherCandidates().map((candidate) =>
        String((candidate.params as { skillId?: unknown }).skillId ?? ''),
      ),
    );

    for (const skillId of STARTABLE_SKILL_IDS) {
      if (available.has(skillId)) continue;

      const skill = game.skills.getObjectByID(skillId);
      if (skill === undefined) continue;

      const withActions = skill as AnySkill & { actions?: { allObjects: RecipeLike[] } };
      const recipes = safeRecipes(withActions);
      if (recipes === null) continue;

      // The best recipe the level allows. If one exists, the block is
      // materials rather than progression, and that is the whole point.
      const affordable = recipes.filter((recipe) => (recipe.level ?? 0) <= skill.level);
      const best = affordable[0];
      if (best === undefined) continue;

      out.push({
        label: `${skill.name} has no candidates because nothing it can make is in stock, not because it is unavailable — ${best.name} is unlocked at level ${best.level ?? 0} and needs materials bought or gathered.`,
        xpPerHour: 0,
        missing: [],
      });
    }
  } catch (error) {
    noteSwallowed('candidates.readUnstockedSkills', error);
    // A skill that cannot be inspected is left unmentioned rather than guessed
    // at; a wrong reason is worse than none.
  }

  return out;
}

/**
 * The most valuable stack the agent may safely sell.
 *
 * The counterpart to {@link readCheapestExpendableStack}, and the difference in
 * direction is the difference in purpose. That one exists to escape a full
 * bank, where the goal is to free a slot while destroying as little value as
 * possible. This one exists to *earn*, so it takes the stack worth the most.
 *
 * Both draw from the same `readSellCandidates` filter, which is what makes an
 * automatic sale defensible at all: task items, scarce ingredients, every
 * farming seed, attack-spell runes, the runes and fixed inputs a reachable Alt
 * Magic spell needs, mastery tokens, bank-locked items, food while the larder
 * is thin, and ammunition are all already excluded by construction. The
 * reflex inherits every one of those guards rather than restating them, so a
 * guard added for the planner's benefit protects the reflex too.
 */
export function readMostValuableExpendableStack(): {
  itemId: string;
  name: string;
  value: number;
} | null {
  try {
    let best: { itemId: string; name: string; value: number } | null = null;

    for (const option of readSellCandidates()) {
      const itemId = String((option.params as { itemId?: unknown }).itemId ?? '');
      const item = game.items.getObjectByID(itemId);
      if (item === undefined) continue;

      const value = gpValue(item) * game.bank.getQty(item);
      if (value <= 0) continue;
      if (best === null || value > best.value) {
        best = { itemId, name: item.name, value };
      }
    }

    return best;
  } catch (error) {
    noteSwallowed('candidates.readMostValuableExpendableStack', error);
    return null;
  }
}

/**
 * Which question the guards are being asked.
 *
 * `'sell'` is "should this stack be offered to the shop"; `'consume'` is "may
 * this stack be destroyed by an Alt Magic cast". Every scarcity guard answers
 * both identically -- a seed, a token, a task item or a spell's own rune is no
 * safer fed to a spell than sold -- so they stay one ordered list in one
 * function rather than two that can drift. Exactly one clause differs, and it
 * is marked where it appears.
 */
type DisposalPurpose = 'sell' | 'consume';

/**
 * Bank items an Alt Magic cast is allowed to destroy.
 *
 * The consumption-side twin of {@link readSellCandidates}, sharing its guard
 * chain rather than restating it: both filter on `saleExclusionReason`, so a
 * guard added for the shop protects the spell in the same commit.
 *
 * It exists because the two paths differ in exactly one respect. Selling an
 * item worth 0 GP is pointless, so the sell list drops it; *burning* one is the
 * whole idea, and that difference is what made this bug expensive. With every
 * worthless stack filtered out, the cheapest thing Just Learning could see was a
 * 1 GP Nature Rune -- the rune it spends -- while 4,770 unusable Arrow Shafts
 * sat next to it costing nothing to lose.
 *
 * Returns items rather than `Candidate`s because the caller ranks and selects;
 * a `Sell 4770x Arrow Shafts` label on a list nothing will sell was noise the
 * previous shape carried only because it was borrowing the sell reader.
 */
export function readConsumableItems(): AnyItem[] {
  try {
    return [...game.bank.items.values()]
      .filter((entry) => saleExclusionReason(entry.item, entry.quantity, 'consume') === null)
      .map((entry) => entry.item);
  } catch (error) {
    noteSwallowed('candidates.readConsumableItems', error);
    // An unreadable bank offers nothing, which refuses the cast. Refusing is
    // the recoverable direction; destroying the wrong stack is not.
    return [];
  }
}

/**
 * Why a stack may not be sold, or null when it may.
 *
 * One function so the sell list and the diagnostic that explains it cannot
 * disagree. That mattered: Gold and Silver Bars worth about 216,000 GP sat
 * unsellable and unexplained, and three separate investigations eliminated
 * guards one at a time from outside because nothing would say which one had
 * fired. A filter chain that only ever returns a boolean can refuse for a good
 * reason and a bad one identically, and the third time that costs an afternoon
 * it is cheaper to make it speak.
 */
function saleExclusionReason(
  item: AnyItem,
  held = 0,
  purpose: DisposalPurpose = 'sell',
): string | null {
  try {
    // Quantity, not identity. A future task wanting one Gold Bar should keep
    // one, not all 1,056 -- see readTaskWantedQuantities.
    const wanted = readTaskWantedQuantities().get(item.id) ?? 0;
    if (wanted > 0 && held <= wanted) {
      return `a Township task wants ${wanted} and only ${held} are held`;
    }
    if (readBarelyEnoughIngredientIds().has(item.id)) return 'it is the last of a recipe input';
    if (readAllSeedIds().has(item.id)) return 'it is a farming seed';
    if (readSpellRuneIds().has(item.id)) return 'a castable spell needs it';
    if (readAltMagicFuelIds().has(item.id)) return 'an Alt Magic spell in reach needs it';
    if (readMasteryTokenIds().has(item.id)) return 'it is a mastery token';
    if (game.bank.lockedItems.has(item)) return 'it is locked in the bank';
    if (isAmmunition(item)) return 'it is ammunition';
    if (item instanceof FoodItem && readMealCount() < FOOD_SELL_FLOOR) {
      return `it is food and the larder is below ${FOOD_SELL_FLOOR} meals`;
    }
    // The only guard that is about the *sale* rather than about the item, and
    // so the only one that does not carry over to consumption. A stack the shop
    // will not pay for is pointless to list and perfect to burn: 4,770 Arrow
    // Shafts sell for 0 GP each (dump: `melvorF:Arrow_Shafts`, sellsFor 0) and
    // GOALS.md has them down as dead weight with no recipe that can use them.
    // Applying it to both paths is what left Just Learning nothing worthless to
    // eat and sent it to the cheapest thing that *did* have a price -- a Nature
    // Rune at 1 GP, which is its own fuel.
    if (purpose === 'sell' && gpValue(item) <= 0) return 'it does not sell for GP';
    return null;
  } catch (error) {
    noteSwallowed('candidates.saleExclusionReason', error);
    // Unreadable means unsellable: refusing to sell is the recoverable error.
    return 'its sell guards could not be evaluated';
  }
}

/**
 * How far above the current Magic level a spell still counts as reachable.
 *
 * "Castable right now" is the rule `readSpellRuneIds` uses for attack spells,
 * and it is too narrow here: the point of casting Just Learning at all is to
 * stockpile toward Superheat II, which unlocks at Magic 25 (dump: `melvorF`
 * `SuperheatII`, level 25) and needs a Nature Rune per cast like almost every
 * spell below it. A rune sold at Magic 10 because the spell that wants it is at
 * 25 has to be re-crafted before the milestone it was being saved for.
 *
 * A band rather than "every spell in the game", because a guard that reserves
 * everything refuses everything: Superheat III (64), Item Alchemy III (76) and
 * Superheat V (110) between them name every rune in the base game, and honouring
 * those from Magic 1 would lock Air, Earth, Fire, Water, Spirit and Soul Runes
 * for the rest of the run in exchange for nothing the character can do.
 *
 * 25 is the smallest band that reaches Superheat II from a fresh Magic 1, which
 * is the case this exists for, and it is roughly a session's worth of levels
 * rather than a lifetime's -- Just Learning took Magic 2 to 10 in six minutes.
 * From Magic 1 it stops at Bone Offering (18) and Superheat II (25) and leaves
 * the 40-and-up spells unreserved, which is the "60 levels away must not lock a
 * rune forever" line drawn where it can be justified.
 */
const ALT_MAGIC_REACH_LEVELS = 25;

/**
 * Everything a reachable Alt Magic spell destroys on every cast.
 *
 * The hole this closes, measured live over 100 seconds of `Just Learning`:
 *
 * ```
 * Air Rune -49   Nature Rune -98   Rune Essence +49
 * ```
 *
 * 49 casts. One Nature and one Air went to the spell's rune cost, which is
 * correct; the *second* Nature Rune per cast was the item the spell consumed,
 * because `chooseSelection` picks the cheapest thing `readSellCandidates` will
 * part with and a Nature Rune sells for 1. A Nature Rune costs a Rune Essence
 * to craft, so the trade was 2 Nature + 1 Air in for 1 essence out -- a strict
 * loss, paid in the one rune that every castable Alt Magic spell requires.
 *
 * `readSpellRuneIds` did not catch it: it walks `game.attackSpells`, and Nature
 * Rune appears in no attack spell. The guard was never wrong about attack
 * spells, it simply did not know Alt Magic prices itself in runes too. Note the
 * hole is independent of which end of the ranking `chooseSelection` takes --
 * before today it took the *dearest* item and would have burned Topaz or an
 * Adamantite Bar instead.
 *
 * Reserved for the sell list *and* for consumption, because those are the same
 * act: the reason this reader hangs off `saleExclusionReason` rather than
 * standing beside it is that a spell must not be able to eat its own fuel while
 * the shop is forbidden to sell it.
 *
 * Costs come from {@link spellCosts}, which is where the `runesRequired` /
 * `runesRequiredAlt` pair (spells.d.ts:27-28, chosen by
 * `Player.useCombinationRunes`, player.d.ts:122) is already resolved. That also
 * folds in `fixedItemCosts` (altMagic.d.ts:72), deliberately: Rags to Riches II
 * burns a Coal Ore per cast, and feeding a spell the last of what it needs to
 * fire is the identical failure to feeding it its own runes. Separating the two
 * would need an `instanceof RuneItem` (item.d.ts:489), and this file has been
 * bitten three times by naming a game global that vitest does not define.
 *
 * `specialCost` (altMagic.d.ts:74) is *not* reserved, and must not be: it is the
 * selection itself, so reserving it would refuse every cast.
 */
function readAltMagicFuelIds(): Set<string> {
  const fuel = new Set<string>();

  const magicLevel = safeNumber(
    'candidates.altMagicFuelLevel',
    () => game.skills.getObjectByID(ALT_MAGIC_ID)?.level,
    0,
  );
  // A level that could not be read leaves the band at 0 + reach, which still
  // covers Just Learning and Superheat II. Silently reserving nothing is the
  // failure this whole function exists to stop.
  const reach = magicLevel + ALT_MAGIC_REACH_LEVELS;

  // `Game.altMagic` (game.d.ts:115) is an `AltMagic`, whose `actions` registry
  // holds its `AltMagicSpell`s -- the same list `genericSkillCandidates` walks.
  // Reached through `game.skills` rather than `game.altMagic` so that a save
  // without the skill is a missing entry rather than a TypeError.
  const spells = safeList('candidates.altMagicSpells', () => {
    const magic = game.skills.getObjectByID(ALT_MAGIC_ID) as
      | (AnySkill & { actions?: { allObjects: RecipeLike[] } })
      | undefined;
    return magic?.actions?.allObjects ?? [];
  });

  for (const spell of spells) {
    try {
      if (spell.level > reach) continue;
      for (const cost of spellCosts(spell) ?? []) fuel.add(cost.item.id);
    } catch (error) {
      noteSwallowed('candidates.altMagicFuelCosts', error);
      // One unreadable spell does not get to empty the guard; the rest of the
      // book still reserves what it needs.
    }
  }

  return fuel;
}

/**
 * Valuable stacks the agent is holding but refuses to sell, and why.
 *
 * The counterpart to the sell list rather than a duplicate of it. A stack worth
 * six figures that never appears as a candidate is indistinguishable, from
 * outside, from a stack the agent simply has not got to yet -- and that
 * ambiguity is what let 216,000 GP of bars sit through several planning passes
 * while the run was short of GP for Auto Eat.
 *
 * Only above a floor, and only the worst offenders, so this stays a diagnostic
 * rather than a second inventory listing.
 */
export function readUnsellableNotice(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    const held: { name: string; value: number; reason: string }[] = [];

    for (const entry of game.bank.items.values()) {
      const reason = saleExclusionReason(entry.item, entry.quantity);
      if (reason === null) continue;

      const value = gpValue(entry.item) * entry.quantity;
      if (value < UNSELLABLE_NOTICE_FLOOR) continue;

      held.push({ name: entry.item.name, value, reason });
    }

    return held
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map((stack) => ({
        label: `Holding ${stack.value.toLocaleString()} GP of ${stack.name} that will not be sold: ${stack.reason}.`,
        xpPerHour: 0,
        missing: [],
      }));
  } catch (error) {
    noteSwallowed('candidates.readUnsellableNotice', error);
    return [];
  }
}

/** GP value below which an unsellable stack is not worth mentioning. */
const UNSELLABLE_NOTICE_FLOOR = 20_000;

/**
 * The nearest shop purchases the character is saving toward.
 *
 * Surfaced beside the blocked list because "you are 107,054 GP from the upgrade
 * that stops you starving" is a planning fact of exactly the same kind as "this
 * recipe needs five bars you do not have" -- a known, priced thing standing
 * between the run and something it wants.
 *
 * Only the nearest few, so this stays a horizon rather than a catalogue.
 */
export function readShopGoalNotice(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    return readShopGoals()
      .slice(0, SHOP_GOAL_NOTICES)
      .map((goal) => ({
        label: `${goal.name} costs ${goal.gpCost.toLocaleString()} GP — ${goal.shortfall.toLocaleString()} GP short.`,
        xpPerHour: 0,
        missing: [],
      }));
  } catch (error) {
    noteSwallowed('candidates.readShopGoalNotice', error);
    return [];
  }
}

/** How many saving targets to surface; a horizon, not a catalogue. */
const SHOP_GOAL_NOTICES = 3;

/**
 * Names a recipe that produces each missing input, where one exists.
 *
 * Searched across every startable skill rather than the blocked recipe's own,
 * because the answer is usually in a different skill: bars come from Smithing
 * for a Fletching recipe, logs from Woodcutting for a Firemaking one. That
 * cross-skill hop is the whole content of a production chain and was the part
 * left to a person to know.
 *
 * Silent when nothing produces the item -- a monster drop or a shop purchase
 * has no recipe, and inventing a producer would be worse than leaving the entry
 * as it was.
 */
function describeProducers(missing: readonly { itemId: string; name: string }[]): string {
  try {
    const named: string[] = [];

    for (const want of missing) {
      const producer = findProducer(want.itemId);
      if (producer !== null) named.push(`${want.name} from ${producer}`);
    }

    return named.length === 0 ? '' : ` — ${named.join(', ')}`;
  } catch (error) {
    noteSwallowed('candidates.describeProducers', error);
    return '';
  }
}

/** The first startable recipe whose product is this item, or null. */
function findProducer(itemId: string): string | null {
  try {
    for (const skillId of STARTABLE_SKILL_IDS) {
      const skill = game.skills.getObjectByID(skillId);
      if (skill === undefined) continue;

      const recipes = safeRecipes(skill as AnySkill & { actions?: { allObjects: RecipeLike[] } });
      if (recipes === null) continue;

      for (const recipe of recipes) {
        const product = recipe.product as { id?: string } | undefined;
        if (product?.id !== itemId) continue;
        return `${skill.name}: ${recipe.name}`;
      }
    }

    return null;
  } catch (error) {
    noteSwallowed('candidates.findProducer', error);
    return null;
  }
}

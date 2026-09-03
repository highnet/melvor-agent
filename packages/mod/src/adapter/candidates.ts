import { readAgilityLapRate } from './agility.js';

/** Agility's skill id; see readAgilityLapRate for why it is special-cased. */
const AGILITY_ID = 'melvorD:Agility';
import type { BlockedSeverity, Candidate } from '@melvor-agent/shared';
import { readActiveRecipeIds } from './active.js';
import { canAfford, missingInputs } from './affordability.js';
import { readFoodReserve } from './equipment.js';
import { readSeedShortfalls } from './farming.js';
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
import { describeSustain, netProductGpFor, sustainableMinutes } from './pricing.js';
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
import { noteSwallowed, recordFallback, safeList } from './safe.js';
import { readShopCandidates, readShopGoals } from './shop.js';

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
      const realmOpen = isRecipeRealmUnlocked(recipe);
      const levelMet = requirement.level <= currentLevelFor(skill, requirement.abyssal);

      if (masteryUnlocked !== null) {
        if (!masteryUnlocked.has(recipe)) {
          // The gate decides; these three counters only explain its decision.
          //
          // `isMasteryActionUnlocked` was the *only* thing consulted here, so
          // every refusal it made was filed as "mastery-locked" and
          // `level-locked` could never be anything but zero. Live, after the
          // mastery-gate fix landed: Firemaking 32 with 33 logs reported "29
          // mastery-locked, 0 level-locked" while 17 of those logs are Teak and
          // above and 12 are Abyssal-realm. Herblore 1 reported 71
          // mastery-locked against 70 recipes above level 1. The recipes were
          // right and the heading was wrong -- and a heading that says "mastery"
          // sends the planner hunting for mastery XP when the answer is a level
          // or a realm it cannot enter, which is the same misdirection that cost
          // a day on Alt Magic.
          //
          // Realm and level are checked *here* rather than made gates of their
          // own because the typings state the shape of
          // `isMasteryActionUnlocked` (skill.d.ts:806) and not what it returns.
          // Making our reading the gate would risk dropping a recipe the game
          // would have allowed -- a modifier that lowers a level requirement is
          // invisible to `recipe.level` -- so the game's answer still decides
          // and ours only names the checkable fact behind it. Mastery is the
          // residual: what the gate refused that neither realm nor level
          // explains.
          if (!realmOpen) dropped.realm += 1;
          else if (!levelMet) dropped.level += 1;
          else dropped.mastery += 1;
          continue;
        }
      } else if (!levelMet) {
        dropped.level += 1;
        continue;
      }

      try {
        if (!realmOpen) {
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

      // How long the banked inputs actually last, carried as a number and not
      // only as a sentence. See `sustainMinutes` on the candidate schema: the
      // stopgap has to make this choice with nobody reading the label.
      const sustainMinutes = sustainableMinutes(recipe, interval);

      candidates.push({
        kind: 'gather_resource',
        params: { kind: 'gather_resource', skillId, recipeId: recipe.id },
        label: requirement.abyssal
          ? `${skill.name}: ${recipe.name} — Abyssal realm, needs Abyssal lvl ${requirement.level}`
          : `${skill.name}: ${recipe.name}${
              netPerHour > 0
                ? ` — output worth ${Math.round(netPerHour).toLocaleString()} GP/h net of inputs, if sold`
                : ''
            }${describeSustain(sustainMinutes)}${masteryNote(skill, recipe)}${veinDecayNote(skillId)}`,
        xpPerHour: lapXpPerHour ?? actionsPerHour * requirement.xp * xpMultiplier,
        gpPerHour: netPerHour > 0 ? netPerHour : undefined,
        ...(sustainMinutes === null ? {} : { sustainMinutes }),
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
 *
 * Which makes the *attribution* load-bearing rather than cosmetic. This line
 * fires precisely when `mastery` or `realm` is non-zero, so a level block
 * misfiled as mastery both names the wrong cause and keeps the line alive on a
 * skill whose story `readLockedActions` was already telling correctly. See the
 * classification in the loop above: `mastery` here is the residual, the
 * refusals neither the realm nor the level requirement accounts for.
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

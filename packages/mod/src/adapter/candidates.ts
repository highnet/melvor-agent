import { readAgilityLapRate } from './agility.js';

/** Agility's skill id; see readAgilityLapRate for why it is special-cased. */
const AGILITY_ID = 'melvorD:Agility';
import type { BlockedSeverity, Candidate } from '@melvor-agent/shared';
import { readActiveRecipeIds } from './active.js';
import { readMasteryTokenIds } from './bank.js';
import { readSpellRuneIds } from './combat.js';
import { readFoodReserve, readMealCount } from './equipment.js';
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
import { noteSwallowed, recordFallback, safeList, safeNumber } from './safe.js';
import { readShopCandidates, readShopGoals } from './shop.js';
import { readTaskWantedQuantities } from './township.js';

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
    ...safeCandidates('woodcutting', woodcuttingCandidates),
    ...safeCandidates('mining', miningCandidates),
    ...safeCandidates('fishing', fishingCandidates),
    ...safeCandidates('thieving', thievingCandidates),
    ...safeCandidates('other-skills', genericSkillCandidates),
  ].sort((a, b) => (b.xpPerHour ?? 0) - (a.xpPerHour ?? 0));
}

/** Recipe list for a skill, or null when the skill does not expose one. */
function safeRecipes(skill: { actions?: { allObjects: RecipeLike[] } }): RecipeLike[] | null {
  try {
    return skill.actions?.allObjects ?? null;
  } catch (error) {
    noteSwallowed('candidates.safeRecipes', error);
    return null;
  }
}

export interface RecipeLike {
  id: string;
  name: string;
  level: number;
  baseExperience: number;
  /** Into the Abyss content gates on this instead; see recipeRequirement. */
  abyssalLevel?: number;
  baseAbyssalExperience?: number;
  /** MasteryAction extends RealmedObject (mastery2.d.ts:11, realms.d.ts:46). */
  realm?: { id: string; isUnlocked: boolean };
  /** Present on SingleProductArtisanSkillRecipe and the gathering recipes. */
  product?: object;
  baseQuantity?: number;
  /** ArtisanSkillRecipe.itemCosts (artisanSkill.d.ts:82); absent on gathering. */
  itemCosts?: { item: AnyItem; quantity: number }[];
}

/**
 * Whether a recipe's realm is open.
 *
 * Harvesting: Abyssal Vein was offered as an *available* candidate advertising
 * 1,855,200 xp/h while `melvorItA:Abyssal` reported `unlocked: false` and
 * "Complete Into the Abyss x1" as its requirement. Nothing was checking the
 * realm, so the whole of Into the Abyss looked like the best move on the board
 * by two orders of magnitude -- the exact trap this file already refuses
 * elsewhere: a candidate the adapter would then refuse.
 *
 * Absent realm data is treated as open, because every Melvor-realm recipe
 * predates realms entirely and defaulting those to "locked" would empty the
 * board.
 */
function isRecipeRealmUnlocked(recipe: RecipeLike): boolean {
  try {
    return recipe.realm?.isUnlocked ?? true;
  } catch (error) {
    noteSwallowed('candidates.isRecipeRealmUnlocked', error);
    return true;
  }
}

/**
 * The level and XP a recipe actually uses.
 *
 * `BasicSkillRecipe` carries two parallel tracks (`skill.d.ts:950-955`):
 * `level`/`baseExperience` for Melvor-realm content and
 * `abyssalLevel`/`baseAbyssalExperience` for Into the Abyss content. A recipe
 * uses one or the other, and the unused pair reads 0.
 *
 * Reading only the standard pair made every Abyssal recipe advertise itself as
 * `needs lvl 0` worth `0 xp/h` — which reads as "free and worthless" when the
 * truth is "gated behind a track we have not started". The `abyssal` flag is
 * returned so callers can compare against `skill.abyssalLevel` (`skill.d.ts:177`)
 * rather than `skill.level`; the two are separate progressions and comparing
 * across them is how a 0 became an invitation.
 */
function recipeRequirement(recipe: RecipeLike): {
  level: number;
  xp: number;
  abyssal: boolean;
} {
  const abyssalLevel = recipe.abyssalLevel ?? 0;
  if (abyssalLevel > 0) {
    return { level: abyssalLevel, xp: recipe.baseAbyssalExperience ?? 0, abyssal: true };
  }
  return { level: recipe.level, xp: recipe.baseExperience, abyssal: false };
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
    // The nominal three seconds is no longer a third source in this chain, it
    // is what `firstPositive` returns when the chain runs out — which is what
    // makes reaching it countable. Same number, same behaviour, now visible.
    const skillInterval = firstPositive(
      `candidates.skillInterval:${skillId}`,
      () => withActions.actionInterval,
      () => withActions.baseInterval,
    );

    // A course skill earns a whole lap at a time; see readAgilityLapRate. Every
    // obstacle reports the same lap rate, because that is what running the
    // course actually pays. Rope Jump advertised 21 levels/h this way and
    // delivered about 6.
    const lapXpPerHour = skillId === AGILITY_ID ? readAgilityLapRate() : null;

    for (const recipe of recipes) {
      // The mastery check is separated from the affordability check because a
      // single try around both conflates two different failures.
      //
      // "This action is locked" and "the lock could not be consulted" are not
      // the same claim, and treating them alike hides whole skills. Alt Magic's
      // spells are not mastery actions in the way `isMasteryActionUnlocked`
      // expects, so the call is a candidate for throwing on every spell -- and
      // a throw here discarded the recipe entirely, producing no candidate and
      // no blocked entry either. The skill simply was not there, which is the
      // hardest kind of absence to notice.
      //
      // So a mastery check that cannot answer is read as "unlocked". If that is
      // wrong the action is offered and the game refuses it, which is visible
      // and recoverable. Silence is neither.
      let masteryLocked = false;
      try {
        masteryLocked = withActions.isMasteryActionUnlocked?.(recipe) === false;
      } catch (error) {
        noteSwallowed('candidates.genericSkillCandidates', error);
        masteryLocked = false;
      }
      if (masteryLocked) continue;

      try {
        if (!isRecipeRealmUnlocked(recipe)) continue;
        // Affordability is different: a candidate the adapter would then refuse
        // is a planner trap, so an unanswerable cost check does skip.
        if (!canAfford(withActions, recipe)) continue;
      } catch (error) {
        noteSwallowed('candidates.genericSkillCandidates', error);
        continue;
      }

      const requirement = recipeRequirement(recipe);

      // Per recipe, not per skill: mastery is earned on the individual action,
      // so two recipes in one skill do not share an interval.
      const interval = masteryIntervalFor(skill, recipe, skillInterval);
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
    }
  }

  return candidates;
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
 * GP a single Alt Magic cast yields, net of the item it destroys.
 *
 * `getAlchemyGP` (altMagic.d.ts:142) is documented as "the modified GP to add
 * when casting alchemy spells", and `productionRatio` is the multiplier it
 * takes. The item consumed is subtracted because alchemy destroys it, and its
 * sale value is the alternative -- an alchemy that pays less than selling the
 * same item is not income, it is a slower way to sell.
 *
 * Returns null for any spell that is not an alchemy, so the caller falls
 * through to the ordinary product arithmetic.
 */
function alchemyGpPerCast(skill: AnySkill, recipe: RecipeLike): number | null {
  try {
    if (skill.id !== ALT_MAGIC_ID) return null;

    const spell = recipe as unknown as {
      produces?: unknown;
      productionRatio?: number;
      specialCost?: { quantity: number };
    };
    // The two ids are spelled out because AltMagicProductionID is a plain
    // `declare enum` (altMagic.d.ts:12-21), so the runtime bundle may carry no
    // value for it: -1 is GP, -2 is Bar.
    if ((spell.specialCost?.quantity ?? 0) <= 0) return null;

    // Superheat produces a bar, not currency, so the ordinary product path
    // finds nothing to price -- an AltMagicSpell has no `product` field -- and
    // the whole family read as worth zero. Its value is the bar it smelts, less
    // the ore that bar consumes, exactly as the furnace version is priced.
    if (spell.produces === -2) return superheatGpPerCast();
    if (spell.produces !== -1) return null;

    const magic = game.altMagic;
    let best = 0;
    for (const item of magic.getSpellItemSelection(recipe as never)) {
      const gp = magic.getAlchemyGP(item, spell.productionRatio ?? 1);
      const net = gp - gpValue(item);
      if (Number.isFinite(net) && net > best) best = net;
    }

    return best;
  } catch (error) {
    noteSwallowed('candidates.alchemyGpPerCast', error);
    return null;
  }
}

/**
 * The share of actions that actually produce the recipe's product.
 *
 * One for skills whose every action lands. Cooking reports a success chance per
 * recipe; Fishing splits each action between the fish, a special table and
 * junk, and only the fish share is the product being priced.
 *
 * Fails to 1 rather than to 0, because a skill that cannot report its odds
 * should read as ordinary rather than vanish from the board.
 */
export function productChanceFor(skill: AnySkill, recipe: RecipeLike): number {
  try {
    const cooking = skill as AnySkill & {
      getRecipeSuccessChance?: (r: object) => number;
    };
    if (typeof cooking.getRecipeSuccessChance === 'function') {
      const percent = cooking.getRecipeSuccessChance(recipe);
      return Number.isFinite(percent) && percent > 0 ? Math.min(1, percent / 100) : 1;
    }

    const fishing = skill as AnySkill & {
      getAreaChances?: (area: object) => { fish: number };
    };
    const area = (recipe as { area?: object }).area;
    if (typeof fishing.getAreaChances === 'function' && area !== undefined) {
      const share = fishing.getAreaChances(area).fish;
      return Number.isFinite(share) && share > 0 ? Math.min(1, share / 100) : 1;
    }

    return 1;
  } catch (error) {
    noteSwallowed('candidates.productChanceFor', error);
    return 1;
  }
}

/**
 * Net GP of the best bar Superheat can currently smelt.
 *
 * Superheat consumes a Smithing recipe's ingredients and produces its bar
 * without occupying the furnace. Its worth is therefore the same margin the
 * furnace earns -- bar value less ore value -- and pricing it any other way
 * would make the two paths incomparable when the whole question is which to
 * use.
 *
 * The best *affordable* recipe, because an unaffordable one is not an option
 * this hour, and level-gated ones are not options at all.
 */
function superheatGpPerCast(): number {
  try {
    let best = 0;
    for (const recipe of game.smithing.actions.allObjects) {
      try {
        if (recipe.level > game.smithing.level) continue;
        if (!game.smithing.isMasteryActionUnlocked(recipe)) continue;

        const revenue = gpValue(recipe.product) * (recipe.baseQuantity ?? 1);
        if (revenue <= 0) continue;

        let spent = 0;
        for (const cost of recipe.itemCosts) spent += gpValue(cost.item) * cost.quantity;

        const net = revenue - spent;
        if (net > best) best = net;
      } catch (error) {
        noteSwallowed('candidates.superheatGpPerCast', error);
        // A recipe that will not price itself is not the best one.
      }
    }

    return best;
  } catch (error) {
    noteSwallowed('candidates.superheatGpPerCast', error);
    return 0;
  }
}

/**
 * What one action of a production recipe is worth, net of what it consumes.
 *
 * Artisan recipes reported no GP at all -- not zero, absent -- so Smithing,
 * Crafting, Fletching, Herblore, Runecrafting, Summoning, Cooking, Firemaking
 * and Alt Magic were invisible to any planner asked to raise money, and the
 * board showed only gathering and Thieving. The consequence was live and
 * expensive: Gold Topaz Ring sat available with its inputs banked while the
 * agent mined ore, and nothing on screen could say which was worth more.
 *
 * Net, not gross, because a production recipe *spends* to earn and the
 * difference is frequently the whole story. Leather armour looks like 90,000
 * GP/h gross and is negative once the leather it burns is priced; an Air
 * Battlestaff tops any list at over a million gross and loses six hundred
 * thousand an hour. A gross figure here would not be an approximation, it would
 * point the wrong way.
 *
 * Preservation reduces what is actually consumed (`getPreservationChance`,
 * skill.d.ts:458), so it is applied to the cost side. Where an input has no
 * sale value the cost term is zero, which understates -- an unpriced input is
 * not a free one, and that direction at least stays recoverable by measurement.
 */
function netProductGpFor(skill: AnySkill, recipe: RecipeLike, yielded: number): number {
  try {
    // Alt Magic pays a currency rather than producing an item, so the generic
    // product arithmetic below scores it at zero -- which made the game's
    // dedicated turn-items-into-GP action invisible on a board being read to
    // answer "how do we earn money". Exactly the shape of the Thieving bug.
    const alchemy = alchemyGpPerCast(skill, recipe);
    if (alchemy !== null) return alchemy;

    const product = recipe.product as AnyItem | undefined;
    if (product === undefined) return 0;

    const revenue = gpValue(product) * yielded;
    if (revenue <= 0) return 0;

    const withPreservation = skill as AnySkill & {
      getPreservationChance?: (action: object) => number;
    };
    const preserved = Math.max(
      0,
      Math.min(1, (withPreservation.getPreservationChance?.(recipe) ?? 0) / 100),
    );

    let spent = 0;
    for (const cost of recipe.itemCosts ?? []) {
      spent += gpValue(cost.item) * cost.quantity * (1 - preserved);
    }

    return revenue - spent;
  } catch (error) {
    noteSwallowed('candidates.netProductGpFor', error);
    return 0;
  }
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
  recipe: RecipeLike,
  intervalMs: number,
  productGp: number,
  skill?: AnySkill,
  /** Per-action GP that is not the priced product, e.g. a mining gem roll. */
  extraGpPerAction = 0,
  /** Appended to the label; used to name an uncertainty rather than price it. */
  note = '',
): Candidate {
  const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;
  const requirement = recipeRequirement(recipe);

  // Yield and XP both scale with mastery, and both come from the game's own
  // accessors rather than a multiplier assembled here.
  const yielded =
    skill === undefined ? 1 : productYieldFor(skill, recipe, recipe.baseQuantity ?? 1);
  const xpMultiplier = skill === undefined ? 1 : xpMultiplierFor(skill, recipe);
  const salePerHour = actionsPerHour * (productGp * yielded + extraGpPerAction);
  return {
    kind: 'gather_resource',
    params: { kind: 'gather_resource', skillId, recipeId: recipe.id },
    // "gp/h" means two different things across this list and the label never
    // said which. Thieving pays coins directly, so its figure is money in
    // pocket. Gathering produces *items*, so its figure is what those items
    // would fetch if sold — and nothing sells them automatically.
    //
    // The difference is not cosmetic. Crystal was picked as "120,000 GP/h, two
    // and a half times Thieving" to fund a 1,000,000 GP purchase, and an hour
    // of it moves GP by exactly zero: the ore piles up in a bank that is
    // already near full, which is how the last deadlock started. A plan aimed
    // at a GP goal has to sell, and that step is invisible if the list calls
    // both things the same name.
    label:
      (salePerHour > 0
        ? `${skillName}: ${recipe.name} — output worth ${Math.round(salePerHour).toLocaleString()} GP/h if sold, not GP earned`
        : `${skillName}: ${recipe.name}`) +
      (skill === undefined ? '' : masteryNote(skill, recipe)) +
      note,
    xpPerHour: actionsPerHour * requirement.xp * xpMultiplier,
    gpPerHour: salePerHour,
    requiresLevel: requirement.level,
    available: true,
  };
}

function woodcuttingCandidates(): Candidate[] {
  const skill = game.woodcutting;
  return skill.actions.allObjects
    .filter((tree) => skill.isTreeUnlocked(tree) && isRecipeRealmUnlocked(tree))
    .map((tree) =>
      candidate(
        WOODCUTTING_ID,
        skill.name,
        tree,
        // Already accounts for gear, mastery and modifiers.
        //
        // Divided by the cut limit because the executor now fills every slot:
        // two trees cut at once produce two trees' worth of logs in the same
        // wall-clock time, so the effective interval per unit of output is that
        // much shorter. Pricing one tree while cutting several understated
        // Woodcutting by exactly the multiple the character had bought.
        skill.getTreeInterval(tree) /
          Math.max(
            1,
            safeNumber('candidates.treeCutLimit', () => skill.treeCutLimit, 1),
          ),
        gpValue(tree.product),
        skill,
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
 * The first reading that is a usable interval.
 *
 * Positivity matters more than presence here: a getter returning 0 would
 * otherwise pass straight through, and a zero interval divides into an infinite
 * rate, which would put that recipe at the top of the board and keep it there.
 * An interval of zero is not a very fast action, it is an unreadable one.
 *
 * Only the *last* source is counted as a failure, deliberately. Falling through
 * from `actionInterval` to `baseInterval` is the designed path and happens on
 * every enumeration; counting it would bury the reads that genuinely broke
 * under noise. Reaching the end of the chain is the event worth seeing.
 */
function firstPositive(site: string, ...reads: (() => number | undefined)[]): number {
  for (const read of reads) {
    try {
      const value = read();
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    } catch (error) {
      noteSwallowed('candidates.firstPositive', error);
      // Try the next source.
    }
  }

  recordFallback(site, 'no source reported a usable interval');
  return NOMINAL_INTERVAL_MS;
}

/** Last-resort interval when a skill will not report one at all. */
const NOMINAL_INTERVAL_MS = 3000;

function miningCandidates(): Candidate[] {
  const skill = game.mining;
  return skill.actions.allObjects
    .filter((rock) => skill.canMineOre(rock) && isRecipeRealmUnlocked(rock))
    .map((rock) =>
      candidate(
        MINING_ID,
        skill.name,
        rock,
        miningIntervalFor(rock),
        gpValue(rock.product),
        skill,
        gemGpPerAction(rock),
        passiveRegenNote(rock),
      ),
    );
}

/**
 * Expected GP from the gem roll a mining action carries, per action.
 *
 * Gems are a material share of what Mining pays and they appeared nowhere: the
 * board priced the ore and nothing else, so a rock whose whole point is its gem
 * chance read as worth only its ore. That is the same omission as Thieving's
 * `currencyDrops` -- a reward that does not arrive as the recipe's `product` is
 * invisible to product arithmetic.
 *
 * Every term is read, not modelled. `getRockGemChance` (rockTicking.d.ts:154)
 * and `getRockSuperiorGemChance` (:155) are the game's own per-rock chances, and
 * `DropTable.getAverageDropValue` (utils.d.ts:458) is documented as "the average
 * currency value of a drop in this table" for `game.randomGemTable` /
 * `game.randomSuperiorGemTable` (game.d.ts:198-199) -- so the gem's price comes
 * from the table rather than from picking a representative gem, which would have
 * been a guess dressed as data.
 *
 * Three deliberate understatements, all in the recoverable direction:
 *
 * - The rolls are gated on `giveGems` / `giveSuperiorGems`
 *   (rockTicking.d.ts:70-71) rather than trusting the chance getters to return 0
 *   for a rock that yields no gems, which is not stated.
 * - The chances are read as percentages, matching every other chance getter this
 *   file consumes. If they are fractions instead this is a hundredfold
 *   *under*statement, which measurement corrects; the other way round would put
 *   a fabricated number at the top of the board.
 * - `chanceToDoubleGems` (rockTicking.d.ts:153) is applied only to the ordinary
 *   gem. Whether it also covers superior gems is not stated in the typings.
 *
 * Abyssal gems are left out entirely: their rocks are realm-gated and absent
 * from the board anyway.
 */
function gemGpPerAction(rock: MiningRock): number {
  try {
    const mining = game.mining;
    const doubling =
      1 +
      Math.max(
        0,
        safeNumber('candidates.chanceToDoubleGems', () => mining.chanceToDoubleGems, 0) / 100,
      );

    let gp = 0;

    if (rock.giveGems === true) {
      const chance = share('candidates.share1', () => mining.getRockGemChance(rock));
      gp += chance * averageDropGp(game.randomGemTable) * doubling;
    }

    if (rock.giveSuperiorGems === true) {
      const chance = share('candidates.share2', () => mining.getRockSuperiorGemChance(rock));
      gp += chance * averageDropGp(game.randomSuperiorGemTable);
    }

    return Number.isFinite(gp) && gp > 0 ? gp : 0;
  } catch {
    return 0;
  }
}

/** A percentage getter read as a 0..1 share; 0 when it will not answer. */
function share(site: string, read: () => number): number {
  const percent = safeNumber(site, read, 0);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(1, percent / 100);
}

/** The GP a drop table pays on average, ignoring any non-GP currency it holds. */
function averageDropGp(table: DropTable): number {
  try {
    const value = table.getAverageDropValue().get(game.gp);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Names the uncertainty a passively regenerating rock carries.
 *
 * {@link miningIntervalFor} charges these rocks the bare interval, because they
 * refill while being mined and so never spend a respawn. That is an upper bound,
 * not a rate: `Mining.regenRockHP` (rockTicking.d.ts:176) restores an unstated
 * amount every `passiveRegenInterval` (:108), so whether regeneration actually
 * keeps pace with mining cannot be answered from the typings at all.
 *
 * The obvious model -- one HP per regen interval -- was tried and measured, and
 * it overestimated the realised rate by 3.3x. So the number is left as the bound
 * it is and the label says so, because the whole lesson of Crystal's 120,000
 * GP/h is that a plausible model in the overstating direction costs an
 * afternoon, while an acknowledged gap costs a sentence.
 */
function passiveRegenNote(rock: MiningRock): string {
  try {
    if (rock.hasPassiveRegen !== true) return '';
    return ' — rate unverified: this rock regenerates while mined and the HP restored per regen tick is not stated in the typings, so this is an upper bound';
  } catch {
    return '';
  }
}

/**
 * Time per mined action, including the respawn the rock spends giving nothing.
 *
 * A rock is not a tap. `MiningRock` carries `maxHP` and `baseRespawnInterval`
 * (rockTicking.d.ts:63-85): it yields `maxHP` actions, empties, and then pays
 * out nothing at all until it respawns. Charging only `baseInterval` per action
 * prices the mining and leaves the waiting free.
 *
 * The error was not academic. Crystal advertised 120,000 GP/h on that basis and
 * banked 81 ore in three quarters of an hour — about 10,800 GP/h, an order of
 * magnitude out — and a whole afternoon of planning was built on the inflated
 * figure. It is the same mistake as the Agility course this morning, where the
 * rate came from one obstacle while a lap runs the whole thing: in both cases
 * the model priced the part that produces and ignored the part that costs.
 *
 * Amortising the respawn across the actions it interrupts is the honest form.
 * A rock with passive regen or no recorded HP is charged the bare interval,
 * which is correct for the first and the only safe guess for the second.
 */
/**
 * How much product one action actually yields, and how much XP it actually pays.
 *
 * Interval was only one of the axes mastery moves. It also raises the quantity
 * an action produces and the XP it grants, and pricing a rate on interval alone
 * leaves those out -- so the list still understated mastered work, just less
 * than before.
 *
 * Both figures come from the game's own accessors rather than from a multiplier
 * assembled here. `modifyPrimaryProductQuantity` (skill.d.ts:455) is documented
 * as returning the modified product quantity, and `getXPModifier`
 * (skill.d.ts:375) as a percentage XP modifier. Reimplementing either would
 * mean guessing how mastery, gear, agility bonuses and pet effects combine,
 * which is exactly the kind of confident arithmetic that had Crystal
 * advertising an order of magnitude above what it paid.
 *
 * Item doubling is deliberately NOT applied on top. `getDoublingChance`
 * (skill.d.ts:386) exists, but whether the yield above already accounts for it
 * is not stated anywhere in the typings, and multiplying by both would
 * overstate every gathering rate. An unclaimed bonus understates; a
 * double-counted one is a fabrication.
 */
export function productYieldFor(skill: AnySkill, recipe: RecipeLike, baseQuantity: number): number {
  try {
    // A failed action still costs the time and the inputs, and yields nothing.
    //
    // Cooking burns at a base 70% success (cooking.d.ts:159), and Fishing rolls
    // between the fish, junk and a special table (fishing.d.ts:126, 168-171) --
    // so both were priced as though every action landed its product. Cooking
    // was overstated by up to a third and Fishing by whatever share of an area
    // is junk.
    //
    // Applied to yield rather than to XP: whether a burn or a junk catch still
    // pays experience is not stated in the typings, and guessing it would move
    // the number in a direction measurement could not later correct.
    const landed = productChanceFor(skill, recipe);
    const withYield = skill as AnySkill & {
      modifyPrimaryProductQuantity?: (item: object, quantity: number, action: object) => number;
    };
    const product = recipe.product;
    if (withYield.modifyPrimaryProductQuantity === undefined || product === undefined) {
      return baseQuantity * landed;
    }

    const yielded = withYield.modifyPrimaryProductQuantity(product, baseQuantity, recipe);
    const modified = Number.isFinite(yielded) && yielded > 0 ? yielded : baseQuantity;
    return modified * landed;
  } catch (error) {
    noteSwallowed('candidates.productYieldFor', error);
    return baseQuantity;
  }
}

/** XP multiplier from the skill's own percentage modifier; 1 when unreadable. */
export function xpMultiplierFor(skill: AnySkill, recipe: RecipeLike): number {
  try {
    const withXp = skill as AnySkill & { getXPModifier?: (action?: object) => number };
    const percent = withXp.getXPModifier?.(recipe);
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return 1;

    // A modifier of -100% would zero the rate and sort the recipe off the
    // board; clamp rather than let a hostile value rewrite the ranking.
    return Math.max(0, 1 + percent / 100);
  } catch (error) {
    noteSwallowed('candidates.xpMultiplierFor', error);
    return 1;
  }
}

/**
 * Per-action interval, mastery included, for whichever skill this is.
 *
 * Nearly every skill exposes a getter that takes the specific action and
 * returns its real interval with mastery and modifiers applied. Woodcutting was
 * the only one wired up, and it was correspondingly the only rate in the whole
 * list that tracked reality -- Yew rose from 22,500 to 30,000 GP/h across an
 * afternoon of cutting purely because `getTreeInterval` reflected the mastery
 * being earned, while every other skill stayed frozen at a flat `actionInterval`
 * or, worse, a nominal three seconds.
 *
 * That is not a rounding error, it is a bias: it prices unmastered work at its
 * unmastered rate forever and mastered work at its unmastered rate too, so the
 * whole list understates exactly the actions the character has invested in.
 *
 * Fishing reports a range rather than a figure, so the midpoint is used and
 * named as such. Artisan skills have no per-recipe getter -- one interval
 * covers the skill -- so `actionInterval` is already the mastery-modified
 * value for them.
 */
/**
 * Firemaking's skill id; see masteryIntervalFor for why it is special-cased.
 */
const FIREMAKING_ID = 'melvorD:Firemaking';

/**
 * A base interval with the skill's own modifiers applied to it.
 *
 * `Skill.modifyInterval(interval, action)` (skill.d.ts:426) is the accessor the
 * per-skill getters -- `getTreeInterval`, `getNPCInterval` and the rest -- are
 * built on. It takes the action as an argument and reads nothing about what is
 * currently selected, so unlike `actionInterval` it answers during enumeration,
 * which is the state this file always runs in.
 *
 * Falls back to the unmodified base rather than to nothing: an interval without
 * modifiers understates a mastered skill, while no interval at all removes the
 * candidate from the board entirely.
 */
function modifiedInterval(skill: AnySkill, base: number, action: object): number {
  try {
    const withModifier = skill as AnySkill & {
      modifyInterval?: (interval: number, action?: object) => number;
    };
    const modified = withModifier.modifyInterval?.(base, action);
    return typeof modified === 'number' && Number.isFinite(modified) && modified > 0
      ? modified
      : base;
  } catch {
    return base;
  }
}

export function masteryIntervalFor(skill: AnySkill, recipe: object, fallback: number): number {
  const getters: Record<string, string> = {
    'melvorD:Woodcutting': 'getTreeInterval',
    'melvorD:Cooking': 'getRecipeCookingInterval',
    'melvorD:Thieving': 'getNPCInterval',
    'melvorD:Agility': 'getObstacleInterval',
    'melvorD:Astrology': 'getConstellationInterval',
    'melvorD:Archaeology': 'getDigSiteInterval',
    'melvorD:Farming': 'getRecipeInterval',
    'melvorAoD:Cartography': 'getPaperMakingInterval',
  };

  try {
    // Fishing is a range: getMinFishInterval / getMaxFishInterval. The midpoint
    // is the honest single number, and pretending either end is *the* interval
    // would bias every fishing rate in one direction.
    if (skill.id === FISHING_ID) {
      const fishing = skill as AnySkill & {
        getMinFishInterval?: (fish: object) => number;
        getMaxFishInterval?: (fish: object) => number;
      };
      const min = fishing.getMinFishInterval?.(recipe);
      const max = fishing.getMaxFishInterval?.(recipe);
      if (typeof min === 'number' && typeof max === 'number' && min > 0 && max > 0) {
        return (min + max) / 2;
      }
      return fallback;
    }

    // Firemaking is per-log, and the table above had no entry for it.
    //
    // `FiremakingLog.baseInterval` (firemakingTicks.d.ts:35) is a field on the
    // *log*, not on the skill, and it ranges from a couple of seconds to tens of
    // seconds across the tiers. With no getter registered every log fell through
    // to the skill-wide fallback -- a nominal 3s, because `actionInterval`
    // (firemakingTicks.d.ts:89) reads `activeRecipe` and throws while nothing is
    // selected. Every log therefore advertised the same actions per hour, so
    // ranking collapsed to base XP alone and picked whichever log paid most per
    // burn: precisely the slowest ones, whose long interval was the reason they
    // paid more. The rate was not merely approximate, it was ordered backwards.
    //
    // Firemaking exposes no `getLogInterval`, so the modifiers are applied by
    // the general accessor. `modifyInterval(interval, action)` (skill.d.ts:426)
    // is action-scoped and reads nothing about what is currently selected, which
    // is what makes it usable during enumeration.
    if (skill.id === FIREMAKING_ID) {
      const base = (recipe as { baseInterval?: number }).baseInterval;
      if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return fallback;
      return modifiedInterval(skill, base, recipe);
    }

    // Alt Magic has no per-spell interval getter: one interval covers the
    // skill. But `actionInterval` reads the selected spell and throws when
    // none is chosen -- which is the state candidate enumeration runs in -- so
    // it was landing on the generic 3s fallback instead of its real 2s, and
    // every spell was priced a third slow. `baseInterval` is a readonly
    // constant (altMagic.d.ts:99) and is always readable.
    if (skill.id === ALT_MAGIC_ID) {
      const magic = skill as AnySkill & { baseInterval?: number };
      return typeof magic.baseInterval === 'number' && magic.baseInterval > 0
        ? magic.baseInterval
        : fallback;
    }

    const name = getters[skill.id];
    if (name === undefined) return fallback;

    const withGetter = skill as unknown as Record<string, ((action: object) => number) | undefined>;
    const getter = withGetter[name];
    if (typeof getter !== 'function') return fallback;

    const interval = getter.call(skill, recipe);
    return Number.isFinite(interval) && interval > 0 ? interval : fallback;
  } catch (error) {
    noteSwallowed('candidates.masteryIntervalFor', error);
    return fallback;
  }
}

/**
 * Mastery headroom, when a rate still has room to grow.
 *
 * Every rate in this list is an instantaneous one, and that is a myopic way to
 * choose work that will run for hours. Mastery scales the things the rates are
 * built from -- a rock yields more before it empties, an interval shortens, a
 * steal succeeds more often -- so an action sitting mid-table today can be the
 * best on the board after a sustained run, while one already at 99 is as good
 * as it will ever be. Comparing only the current numbers systematically favours
 * whatever is already mastered and never commits long enough to master anything
 * else.
 *
 * Reported rather than folded into `xpPerHour`, deliberately. The growth curve
 * is not in the typings and inventing a projection would put a fabricated
 * number where a measured one belongs -- the exact failure that made Crystal
 * look like 120,000 GP/h. Naming the headroom lets a planner weigh it; guessing
 * its size would just be a new way to be confidently wrong.
 */
export function masteryNote(skill: AnySkill, recipe: { id: string }): string {
  try {
    const withMastery = skill as AnySkill & {
      getMasteryLevel?: (action: object) => number;
    };
    if (withMastery.getMasteryLevel === undefined) return '';

    const level = withMastery.getMasteryLevel(recipe);
    if (!Number.isFinite(level) || level <= 0) return '';
    if (level >= MASTERY_HEADROOM_LEVEL) return '';

    return ` — mastery ${level}/99, so this rate improves with sustained use`;
  } catch (error) {
    noteSwallowed('candidates.masteryNote', error);
    return '';
  }
}

/**
 * Mastery at or above which the remaining growth is not worth flagging.
 *
 * Below this there is real headroom; above it the note would appear on almost
 * everything and stop carrying information.
 */
export const MASTERY_HEADROOM_LEVEL = 50;

export function miningIntervalFor(rock: MiningRock): number {
  // Mining was the last skill in this file reading a raw constant.
  //
  // `Mining.baseInterval` (rockTicking.d.ts:106) is a flat readonly 3000, and
  // the comment at the call site explained only why `actionInterval` could not
  // be used -- it reads `activeRock` and throws while nothing is selected. That
  // was true and it was not the whole answer: `modifyInterval` (skill.d.ts:426)
  // takes the rock as an argument, so it never touches the active selection, and
  // it is what every per-skill interval getter in the table above is built on.
  // Until this, Mining was the one skill on the board whose rate ignored gear,
  // mastery and every interval modifier the character had bought -- so every
  // investment in mining speed made the advertised rate more wrong, in the
  // direction of understating exactly the skill being invested in.
  const base = modifiedInterval(game.mining, game.mining.baseInterval, rock);

  try {
    if (rock.hasPassiveRegen === true) return base;

    // `getRockMaxHP` (rockTicking.d.ts:180), not the static `maxHP` field.
    //
    // Mastery raises how much a rock yields before it empties, so the same rock
    // amortises the same respawn over more actions as mastery grows -- the rate
    // of a given rock is not a constant, it improves with use. Reading the
    // static field would freeze every rock at its unmastered value and make the
    // respawn correction itself wrong in a second way.
    const actionsPerCycle = game.mining.getRockMaxHP(rock);
    const respawn = rock.baseRespawnInterval ?? 0;
    if (actionsPerCycle <= 0 || respawn <= 0) return base;

    return base + respawn / actionsPerCycle;
  } catch (error) {
    noteSwallowed('candidates.miningIntervalFor', error);
    return base;
  }
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
  const wantedByNeed = new Set<string>([
    ...readTaskWantedQuantities().keys(),
    ...readShortSeedIds(),
  ]);

  return (
    skill.actions.allObjects
      .filter((npc) => npc.level <= skill.level)
      // Dropped while the NPC hits too hard for the health on hand; see
      // THIEVING_MAX_HIT_FRACTION. Filtered on the NPC rather than on a marker
      // smuggled through the label — that trick put a literal NUL byte in this
      // file and shipped it, which is what a clever encoding buys you.
      .filter((npc) => !hitsTooHardForNow(npc.maxHit))
      .map((npc) => {
        const successRate = Math.max(
          0,
          Math.min(
            1,
            safeNumber('candidates.thievingSuccessRate', () => skill.getNPCSuccessRate(npc), 0) /
              100,
          ),
        );

        // `getNPCInterval(npc)` (thieving2.d.ts:193), not `skill.actionInterval`.
        //
        // The old reading had the active-selection dependency documented for
        // Mining: it returns 0 unless Thieving is the skill currently running,
        // so every Thieving candidate showed no rate at all while the agent was
        // doing anything else — worthless exactly when a planner is deciding
        // whether to start it. That was accepted here as "absent rather than
        // guessed", but the choice was never between a zero and a guess: this
        // accessor takes the NPC as an argument and so does not care what is
        // running. The honest number was available the whole time.
        //
        // A failed steal is charged too. `getStunInterval` (thieving2.d.ts:182)
        // is time in which nothing is earned, so the expected cost of an action
        // is its interval plus the stun that failure carries — the same shape
        // as a mining respawn, and ignoring it overstates exactly the low-level
        // NPCs whose success rate is worst.
        const baseIntervalMs = safeNumber(
          'candidates.thievingNPCInterval',
          () => skill.getNPCInterval(npc),
          safeNumber('candidates.thievingInterval', () => skill.actionInterval, 3000),
        );
        const stunMs = safeNumber(
          'candidates.thievingStunInterval',
          () => skill.getStunInterval(npc),
          0,
        );
        const intervalMs = baseIntervalMs + (1 - successRate) * stunMs;
        const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;

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
          // Coins into the balance, not items that would fetch coins.
          gpIsEarned: true,
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
  } catch (error) {
    noteSwallowed('candidates.hitsTooHardForNow', error);
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
  } catch (error) {
    noteSwallowed('candidates.hpShare', error);
    return 'unknown share';
  }
}

function fishingCandidates(): Candidate[] {
  const skill = game.fishing;
  return skill.actions.allObjects
    .filter(
      (fish) =>
        fish.area !== undefined &&
        skill.isMasteryActionUnlocked(fish) &&
        isRecipeRealmUnlocked(fish),
    )
    .map((fish) =>
      candidate(
        FISHING_ID,
        skill.name,
        fish,
        // Fishing rolls an interval per action, so the midpoint is the honest
        // expected value rather than either bound.
        (skill.getMinFishInterval(fish) + skill.getMaxFishInterval(fish)) / 2,
        gpValue(fish.product),
        skill,
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
/**
 * Meals below which food stops being surplus and becomes the reserve.
 *
 * Matches COOK_WHEN_MEALS_BELOW in the reflex tier on purpose: one number
 * decides both when to cook more and when to stop selling it, so the two
 * cannot disagree about what "enough food" means.
 */
/**
 * Alt Magic's skill id.
 *
 * `melvorD:Magic`, not `melvorD:AltMagic`. Alt Magic is a mode of the Magic
 * skill rather than a skill of its own, so the registry holds it under
 * `melvorD:Magic` -- and every lookup keyed on the plausible-looking
 * `melvorD:AltMagic` silently returned undefined. Alt Magic therefore produced
 * no candidates at all, for any spell, at any level, for the entire life of
 * this repo. Not a refusal and not a zero rate: simply absent, and absent in a
 * way nothing reported, because a skill that cannot be found is skipped in the
 * same breath as a skill with nothing to offer.
 */
const ALT_MAGIC_ID = 'melvorD:Magic';

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
      isMasteryActionUnlocked?: (recipe: object) => boolean;
      getRecipeCosts?: (recipe: object) => { checkIfOwned(): boolean };
    };

    const recipes = safeRecipes(withActions);
    if (recipes === null) continue;

    const interval = safeNumber(
      'candidates.blockedActionInterval',
      () => withActions.actionInterval,
      3000,
    );
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
  } catch (error) {
    noteSwallowed('candidates.describeNpcDrops', error);
    return '';
  }
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
 * spell needs, mastery tokens, the last of a recipe ingredient and locked items
 * are all excluded. The *cheapest* surviving stack is chosen, because the point
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
 * farming seed, spell runes, mastery tokens, bank-locked items, food while the
 * larder is thin, and ammunition are all already excluded by construction. The
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
function saleExclusionReason(item: AnyItem, held = 0): string | null {
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
    if (readMasteryTokenIds().has(item.id)) return 'it is a mastery token';
    if (game.bank.lockedItems.has(item)) return 'it is locked in the bank';
    if (isAmmunition(item)) return 'it is ammunition';
    if (item instanceof FoodItem && readMealCount() < FOOD_SELL_FLOOR) {
      return `it is food and the larder is below ${FOOD_SELL_FLOOR} meals`;
    }
    if (gpValue(item) <= 0) return 'it does not sell for GP';
    return null;
  } catch (error) {
    noteSwallowed('candidates.saleExclusionReason', error);
    // Unreadable means unsellable: refusing to sell is the recoverable error.
    return 'its sell guards could not be evaluated';
  }
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

/** Names the input horizon when it is short enough to matter. */
function describeSustain(recipe: RecipeLike, intervalMs: number): string {
  const minutes = sustainableMinutes(recipe, intervalMs);
  if (minutes === null) return '';
  if (minutes >= SUSTAIN_NOTICE_MINUTES) return '';

  return minutes < 1
    ? ' — inputs run out almost immediately'
    : ` — inputs last about ${Math.round(minutes)} min`;
}

/** Above this the stock is not the binding constraint and saying so is noise. */
const SUSTAIN_NOTICE_MINUTES = 60;

/**
 * How long a recipe's banked inputs will actually sustain it.
 *
 * `canAfford` asks only whether one action is possible, which is a different
 * question from whether an objective is. A recipe with five bars in the bank
 * advertises a full rate, runs for twenty seconds and then fails until the
 * failure limit abandons it -- and the planner that chose it had nothing on
 * screen suggesting it would.
 *
 * It cost two objectives today. Runecrafting's Acolyte Wizard Robes was the
 * highest-XP recipe on the board and aborted instantly, because it consumes
 * runes rather than the essence that was banked; and the Gold Bar chain
 * silently ran the smelter dry while the plan still read as healthy.
 *
 * Null when a recipe consumes nothing identifiable -- a gathering action is
 * limited by time, not by stock, and reporting a horizon there would be
 * inventing one.
 */
export function sustainableMinutes(recipe: RecipeLike, intervalMs: number): number | null {
  try {
    const costs = recipe.itemCosts ?? [];
    if (costs.length === 0) return null;
    if (intervalMs <= 0) return null;

    let actions = Number.POSITIVE_INFINITY;
    for (const cost of costs) {
      if (cost.quantity <= 0) continue;
      const held = game.bank.getQty(cost.item);
      actions = Math.min(actions, Math.floor(held / cost.quantity));
    }

    if (!Number.isFinite(actions)) return null;
    return (actions * intervalMs) / 60_000;
  } catch (error) {
    noteSwallowed('candidates.sustainableMinutes', error);
    return null;
  }
}

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

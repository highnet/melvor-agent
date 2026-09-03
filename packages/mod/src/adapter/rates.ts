import { FISHING_ID } from './gathering.js';
import { ALT_MAGIC_ID, type RecipeLike } from './recipes.js';
import { noteSwallowed, recordFallback } from './safe.js';

/**
 * How long an action takes, how much it yields, and how much XP it pays.
 *
 * The arithmetic every candidate list is built from, split out of
 * `candidates.ts` so the enumerations above it read as enumerations. Nothing
 * here decides what to offer; it only answers, for one skill and one recipe,
 * what a single action costs and produces.
 *
 * Every figure comes from the game's own modifier-aware accessors rather than
 * from a formula assembled here. Reimplementing them would mean guessing how
 * mastery, gear, agility bonuses and pet effects combine -- which is the
 * confident arithmetic that had Crystal advertising an order of magnitude
 * above what it paid.
 */

export const MS_PER_HOUR = 3_600_000;

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
 * The first reading that is a usable interval, or nothing.
 *
 * Positivity matters more than presence here: a getter returning 0 would
 * otherwise pass straight through, and a zero interval divides into an infinite
 * rate, which would put that recipe at the top of the board and keep it there.
 * An interval of zero is not a very fast action, it is an unreadable one.
 *
 * Reports nothing at all, deliberately. It used to record `no source reported a
 * usable interval` when the chain ran out, and that was wrong for the same
 * reason its own comment gave for not recording every throw: for a skill with a
 * per-recipe getter this chain is not the answer, it is a *backstop the answer
 * never needs*. Cooking has no skill-wide interval to report — `actionInterval`
 * (cooking.d.ts:71) reads the selected recipe and throws, and `baseInterval`
 * lives on `CookingRecipe` (cooking.d.ts:15), not on the skill — yet
 * `getRecipeCookingInterval` (cooking.d.ts:100) answers for every recipe. Same
 * for Agility: no skill-wide `baseInterval`, `baseInterval` on
 * `AgilityObstacle` (agility.d.ts:77), and `getObstacleInterval`
 * (agility.d.ts:223) answering fine. Both skills reported a failure on every
 * pass while every rate they produced was correct — 276 entries of a skill
 * being shaped the way it is shaped.
 *
 * The single report now lives at the end of {@link resolveInterval}, where
 * "nothing at all could price this action" is actually true.
 */
export function firstUsableInterval(...reads: (() => number | undefined)[]): number | undefined {
  for (const read of reads) {
    try {
      const value = read();
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    } catch {
      // `actionInterval` throwing during enumeration is the designed path, not
      // a fault: nothing is selected, which is the state this file always runs
      // in. Try the next source.
    }
  }

  return undefined;
}

/**
 * What one action of `recipe` costs in milliseconds, from the best source there is.
 *
 * Three sources, narrowest first, because that is the order of authority:
 *
 * 1. The skill's per-recipe getter ({@link masteryIntervalFor}) — mastery-,
 *    gear- and modifier-aware, and action-scoped so it answers while nothing is
 *    selected.
 * 2. The skill-wide interval, for the artisan skills where one interval really
 *    does cover every recipe.
 * 3. {@link NOMINAL_INTERVAL_MS}, which is not read off anything.
 *
 * Only reaching (3) is recorded. The previous arrangement had it backwards: it
 * resolved (2) first and reported *its* exhaustion, so a skill that prices every
 * recipe correctly through (1) still filed a failure per pass, and the four
 * loudest entries in `adapterFailures` described skills that were working.
 */
export function resolveInterval(
  site: string,
  skill: AnySkill,
  recipe: object,
  skillInterval: number | undefined,
): number {
  const perRecipe = perRecipeInterval(skill, recipe);
  if (perRecipe !== undefined) return perRecipe;
  if (skillInterval !== undefined) return skillInterval;

  recordFallback(site, 'neither the recipe nor the skill reported a usable interval');
  return NOMINAL_INTERVAL_MS;
}

/** Last-resort interval when a skill will not report one at all. */
const NOMINAL_INTERVAL_MS = 3000;

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

/**
 * The per-recipe interval, or nothing when no per-recipe source answered.
 *
 * Split out from {@link masteryIntervalFor} so a caller can tell "this skill
 * prices its recipes individually" from "nothing priced this action at all".
 * The exported wrapper still takes a fallback and returns a number, because
 * most callers only want the figure; {@link resolveInterval} needs the
 * distinction, because it is the one place that decides whether a genuine
 * failure has occurred and should be recorded.
 */
function perRecipeInterval(skill: AnySkill, recipe: object): number | undefined {
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
      return undefined;
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
      if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return undefined;
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
        : undefined;
    }

    const name = getters[skill.id];
    if (name === undefined) return undefined;

    const withGetter = skill as unknown as Record<string, ((action: object) => number) | undefined>;
    const getter = withGetter[name];
    if (typeof getter !== 'function') return undefined;

    const interval = getter.call(skill, recipe);
    return Number.isFinite(interval) && interval > 0 ? interval : undefined;
  } catch (error) {
    noteSwallowed('candidates.masteryIntervalFor', error);
    return undefined;
  }
}

/** The per-recipe interval, or `fallback` when this skill does not price recipes individually. */
export function masteryIntervalFor(skill: AnySkill, recipe: object, fallback: number): number {
  return perRecipeInterval(skill, recipe) ?? fallback;
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
    // Passive regen does not mean the rock never runs out.
    //
    // This used to return the bare swing for any rock with `hasPassiveRegen`,
    // on the reading that such a rock refills itself. The dump settles it:
    // *every* rock in the game carries the flag, so the respawn correction
    // below has never once applied -- and the rocks it would matter most for
    // are the ones with the least forgiving numbers. Mithril yields 6 ore and
    // then waits 20 seconds; Crystal yields 66 and waits two minutes. Both were
    // priced as though the wait did not exist, which is how Crystal came to
    // advertise 120,000 GP/h against a measured 10,800.
    //
    // Regen refills the rock over time, so the true cost sits between the bare
    // swing and the full amortisation below. How much HP a regen tick restores
    // is not stated in the typings, so the slower bound is used deliberately:
    // understating a rate is recoverable by measurement, and overstating one is
    // what cost this project an afternoon of planning. The candidate label says
    // the rate is unverified for these rocks, and the Delivering line now
    // measures the truth against it.

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

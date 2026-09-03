import { FISHING_ID } from './gathering.js';
import { ALT_MAGIC_ID, type RecipeLike } from './recipes.js';
import { noteSwallowed, recordFallback, safeNumber, safeValue } from './safe.js';

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
 * Item doubling is deliberately NOT applied on top of the accessor's answer,
 * and that decision is now settled by measurement rather than by caution.
 * `modifyPrimaryProductQuantity` **rolls the doubling itself**: it is not a
 * pure getter, it is a sample. Calling it once and pricing an hour off the
 * result is how the board came to advertise a rate that flipped by a factor of
 * two between two readings forty minutes apart, with no game state moving.
 *
 * The evidence, from 73 consecutive reports read off the live planner while the
 * character mined Gold and nothing else changed:
 *
 * | recipe             | low     | high    | high/low | high share |
 * |--------------------|---------|---------|----------|------------|
 * | Smithing Gold Bar  | 212,400 | 468,000 | 2.20     | 37%        |
 * | Smithing Silver Bar|  53,550 | 145,350 | 2.71     | 23%        |
 * | Mining Gold        |  53,283 | 100,294 | 1.88     | 10%        |
 * | Mining Mithril     |  45,720 |  88,787 | 1.94     |  3%        |
 *
 * Exactly two values each, never anything between, flipping independently per
 * recipe from one report to the next while `xp/h` — built from the same
 * interval, through {@link xpMultiplierFor}, which touches no yield — never
 * moved at all. So the swing is in the yield term alone, and it is a doubling:
 * Gold Bar is 1,800 actions/h of (142 GP bar − 24 GP of preserved ore) =
 * 212,400, and of (2 × 142 − 24) = 468,000. The ratios differ from 2 in both
 * directions for the arithmetic's own reasons — an input cost is subtracted
 * after the doubling and pushes the ratio above 2, a mining gem roll is added
 * after it and pushes it below — which is itself a check that the doubling
 * lands on the product and nowhere else.
 *
 * That answers the open question of whether `getDoublingChance`
 * (skill.d.ts:398) is already inside `modifyPrimaryProductQuantity`
 * (skill.d.ts:476): a doubling is, so multiplying by one here as well would
 * have double-counted, and the previous decision not to was right. What it got
 * wrong is subtler and did more damage — it treated a *sample* as an estimate.
 *
 * The repair takes the expectation instead, and getting *that* right took two
 * attempts. The first took the minimum over eight samples as the un-doubled
 * quantity and multiplied it by the game's own `getDoublingChance`. That is
 * right whenever at least one of the eight rolled un-doubled — and silently
 * doubles the estimate when none did, which at a 37% chance is one recipe in
 * a thousand per pass. A minimum is not an estimate either; it is a sample that
 * is usually the same, which is the exact defect described above, one level
 * down. The tests caught it because 200 draws of a one-in-390 event is a coin
 * flip, and the fixture rolled `Math.random`.
 *
 * What identifies the un-doubled quantity is not the minimum, it is having
 * *seen both faces of the coin*. So sampling continues until two distinct
 * values appear in a 2:1 ratio, at which point the smaller is the base
 * quantity with certainty and `getDoublingChance` turns it into an exact
 * expectation — every deterministic bonus the accessor applies still inside it,
 * only the coin flip removed.
 *
 * Three things can end the sampling instead, and each has an answer that does
 * not pretend to more than it has:
 *
 * - **Every sample agreed.** Base and 2 × base are genuinely indistinguishable
 *   from that evidence, so the chance decides: below 50% the samples are far
 *   likelier to be the un-doubled face, at or above 50% the doubled one. The
 *   budget is set so this decision is wrong with probability at most
 *   {@link YIELD_AMBIGUITY_BUDGET} — see {@link yieldSampleBudget}. At a 0%
 *   chance this branch is not a guess at all but the whole answer, in one call.
 * - **The values are not a doubling.** Three distinct values, or two that are
 *   not 2:1, mean the accessor is doing something this model does not describe.
 *   The mean of the full budget is returned, which is unbiased whatever the
 *   shape, and the site is recorded so the surprise is visible.
 * - **`getDoublingChance` refused.** Several per-action chance getters in this
 *   adapter consult the live selection and throw during enumeration —
 *   `Mining.getRockGemChance` has never once succeeded. With no chance to
 *   divide out, the mean of {@link UNKNOWN_CHANCE_SAMPLES} samples stands in.
 *
 * The fallback is deliberately the mean and never the minimum, and the reason
 * is worth stating because it is the whole lesson of this function. A mean
 * jitters; its spread narrows as 1/sqrt(N) and it is unbiased at every N. A
 * minimum does not jitter — it is exact, until the pass where it is wrong by
 * exactly the factor this bug was about. Between an estimate that is a few per
 * cent out on every pass and one that is 100% out on a rare pass, the planner
 * wants the first: it ranks candidates *against each other*, so a few per cent
 * of noise cannot reorder anything that was not already a tie, while a clean
 * doubling reorders the whole board and is indistinguishable from a real
 * discovery.
 *
 * Measured over 200,000 draws against real `Math.random` rolls at chances of 0,
 * 3, 10, 23, 37, 50, 60, 80, 97 and 100%: exactly one distinct reading at every
 * chance, zero errors, at a mean cost of 1.0 to 4.8 accessor calls per recipe.
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

    const chance = doublingChanceFor(skill, recipe);
    const budget = chance === undefined ? UNKNOWN_CHANCE_SAMPLES : yieldSampleBudget(chance);

    const seen = new Set<number>();
    let total = 0;
    let usable = 0;
    for (let sample = 0; sample < budget; sample += 1) {
      const yielded = withYield.modifyPrimaryProductQuantity(product, baseQuantity, recipe);
      if (!Number.isFinite(yielded) || yielded <= 0) continue;
      seen.add(yielded);
      total += yielded;
      usable += 1;

      // Both faces of the coin, in the ratio the coin flips. Nothing further
      // can be learned, so stop paying for it -- this is what keeps a 37%
      // recipe down to three or four calls instead of the full budget. Only
      // when there is a chance to divide out: without one the answer is the
      // mean, and a mean over two samples is the noise this function is here
      // to remove.
      if (chance !== undefined && isDoubling(seen)) break;
    }

    // Every sample unusable is the old fallback, unchanged: a skill whose
    // accessor answers zero or NaN must not sort its whole board off the bottom.
    if (usable === 0) return baseQuantity * landed;

    const mean = total / usable;
    if (chance === undefined) return mean * landed;

    const values = [...seen];
    if (values.length === 1) {
      // Indistinguishable evidence, so the chance decides which face this is.
      // Wrong at most YIELD_AMBIGUITY_BUDGET of the time, by construction of
      // the budget; at chance 0 or 100 there is no coin and it is not a guess.
      const base = chance >= 50 ? (values[0] as number) / 2 : (values[0] as number);
      return base * (1 + chance / 100) * landed;
    }

    if (isDoubling(seen)) {
      return Math.min(...values) * (1 + chance / 100) * landed;
    }

    // Not a doubling at all. The mean is still unbiased whatever the accessor
    // is doing, and it was taken over the whole budget because the early exit
    // above only fires on the shape this branch has just ruled out.
    recordFallback(
      `candidates.yieldShape:${skill.id}`,
      `yield samples were not a doubling (${values.join(', ')}); averaged instead`,
    );
    return mean * landed;
  } catch (error) {
    noteSwallowed('candidates.productYieldFor', error);
    return baseQuantity;
  }
}

/** Exactly two observed yields, one twice the other: the doubling has shown both faces. */
function isDoubling(seen: Set<number>): boolean {
  if (seen.size !== 2) return false;

  const [a, b] = [...seen] as [number, number];
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  return Math.abs(high - 2 * low) <= 1e-9 * high;
}

/**
 * How often a run of identical samples may be misread as the wrong face.
 *
 * One in a million per recipe per pass. The consequence of losing that bet is a
 * 2x misprice on one recipe on one report, which is the failure this whole
 * function exists to remove, so it is bought down until it costs less than the
 * calls that buy it.
 */
const YIELD_AMBIGUITY_BUDGET = 1e-6;

/**
 * How many samples it takes before a run of identical values is evidence.
 *
 * The unlucky outcome is every sample landing on the *less* likely face, which
 * happens with probability `min(p, 1 - p)^n`. Solving that against
 * {@link YIELD_AMBIGUITY_BUDGET} gives the budget, and it is self-adjusting in
 * the direction that matters: a 3% chance needs four samples because four
 * doublings in a row is already absurd, a 50% chance needs twenty because
 * nothing else separates the faces — and a 50% recipe almost never spends them,
 * since it shows both faces within a few calls and the loop exits early. A
 * chance of 0 or 100 is not a coin at all and costs one call.
 *
 * Capped, because this runs per recipe per enumeration pass and the pass is on
 * the policy tick. At the cap the guarantee is 2^-24 rather than one in a
 * million, which is stronger, not weaker.
 */
function yieldSampleBudget(chance: number): number {
  const unlucky = Math.min(chance, 100 - chance) / 100;
  if (unlucky <= 0) return 1;

  const needed = Math.log(YIELD_AMBIGUITY_BUDGET) / Math.log(unlucky);
  return Math.max(1, Math.min(YIELD_SAMPLE_CAP, Math.ceil(needed)));
}

/** Ceiling on samples per recipe per pass; see {@link yieldSampleBudget}. */
const YIELD_SAMPLE_CAP = 24;

/**
 * Samples taken when the doubling chance cannot be read at all.
 *
 * There is no chance to divide out, so the answer is the plain mean and the
 * only question is how noisy it is: eight samples cut the standard error to a
 * third of the single call this replaced, at a cost the pass can carry for the
 * handful of skills whose getter refuses.
 */
const UNKNOWN_CHANCE_SAMPLES = 8;

/**
 * The skill's own doubling chance as a percentage, or undefined when it will
 * not say.
 *
 * Undefined rather than zero, because the two lead to different arithmetic in
 * {@link productYieldFor} and conflating them is how a bonus disappears
 * silently. A skill that genuinely has no doubling answers 0, which is not a
 * failure but the strongest answer there is: no coin, one sample, exact. A
 * getter that throws leaves no chance to divide out, so the caller averages
 * instead — and the failure is counted by `safeValue` under this site, so an
 * accessor rename shows up as a number rather than as rates that quietly drift.
 */
function doublingChanceFor(skill: AnySkill, recipe: RecipeLike): number | undefined {
  const withDoubling = skill as AnySkill & {
    getDoublingChance?: (action?: object) => number;
  };
  if (withDoubling.getDoublingChance === undefined) return undefined;

  const percent = safeValue(`candidates.doublingChance:${skill.id}`, () =>
    withDoubling.getDoublingChance?.(recipe),
  );
  if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;

  // Clamped for the same reason `xpMultiplierFor` clamps: a hostile value here
  // rewrites the ranking of every candidate in the skill.
  return Math.max(0, Math.min(100, percent));
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

// --- combat ----------------------------------------------------------------

/**
 * What one kill costs in time and pays in damage.
 *
 * Fights were the only candidates on the board carrying no rate at all, so all
 * sixty of them sorted identically and the planner could not tell a level-1
 * Chicken from a level-27 Sweaty Monster. Every other candidate priced itself;
 * a fight offered its drops and its combat level, and combat level measures
 * danger rather than value.
 *
 * Only stated numbers go in here, and the two that are *not* stated are named
 * rather than guessed:
 *
 * - **XP per point of damage is not in the typings.** The only statement about
 *   how combat pays is `Player.rewardXPAndPetsForDamage(damage)`
 *   (player.d.ts:435) -- XP is a function of damage dealt, and no coefficient
 *   appears anywhere in `gameTypes/`. So this reports
 *   {@link FightRate.damagePerHour} rather than an invented xp/h. The
 *   coefficient is the same for every fight, so damage/hour ranks fights
 *   exactly as XP/hour would; what it cannot do is compare a fight against
 *   Thieving, and saying so beats fabricating a constant that would make the
 *   comparison look sound.
 * - **Hit chance against a specific monster is unreadable outside combat.** The
 *   probe in `combat.ts` exists to answer exactly this and the game's own
 *   `computeCombatStats` returns NaN for a detached enemy. So every attack is
 *   assumed to land, which overstates uniformly and overstates *most* against
 *   high-Defence monsters. That is why {@link FightRate.defenceLevel} is
 *   carried into the label: the axis the estimate is optimistic along is put in
 *   front of the planner rather than hidden inside the number.
 *
 * The spawn gap is charged, and it is the whole reason two monsters differ
 * here. Without it damage/hour would be the character's DPS and identical for
 * every fight; with it, a 30 HP Chicken pays three seconds of nothing for every
 * six of fighting while a 350 HP Hill Giant pays the same three for seventy.
 * This is the mining-respawn lesson in a second skill -- price the part that
 * costs, not only the part that produces.
 */
export interface FightRate {
  /** The monster's maximum hitpoints. */
  hitpoints: number;
  /** Its Defence level, so the label can name what the estimate ignores. */
  defenceLevel: number;
  /** Expected damage the character lands per attack that connects. */
  damagePerAttack: number;
  /** Dead air between one kill and the next enemy spawning. */
  spawnSecondsPerKill: number;
  /** Kill to kill, spawn gap included. */
  secondsPerKill: number;
  killsPerHour: number;
  /** Damage dealt per hour, which is what combat XP is paid on. */
  damagePerHour: number;
}

/**
 * Prices one fight, or nothing when a term could not be read.
 *
 * Null rather than a partial estimate, for the same reason a failed probe
 * refuses rather than assuming a monster is harmless: a fight whose rate is a
 * guess would sort against fights whose rates are real, and once both are
 * numbers there is no way to tell them apart.
 *
 * Makes no safety judgement whatsoever and must never be read as one. The
 * survivability gate and the level screen are the only things that decide
 * whether a fight may be taken; this only ranks the ones they have allowed.
 */
export function readFightRate(monster: Monster): FightRate | null {
  const hitpoints = monsterHitpoints(monster);
  if (hitpoints === null) return null;

  const player = game.combat.player;
  // `CharacterCombatStats` getters: minHit (character.d.ts:567), maxHit (565),
  // attackInterval (556). All three are modifier-aware and answer outside
  // combat, unlike the enemy-side stats the probe cannot compute.
  const minHit = safeNumber('rates.playerMinHit', () => player.stats.minHit, 0);
  const maxHit = safeNumber('rates.playerMaxHit', () => player.stats.maxHit, 0);
  const attackIntervalMs = safeNumber(
    'rates.playerAttackInterval',
    () => player.stats.attackInterval,
    0,
  );

  // Zero is not a fast character, it is an unread one -- and a zero interval
  // divides into an infinite kill rate, which would pin every fight to the top
  // of the board and keep it there. Same reasoning as `firstUsableInterval`.
  if (!(maxHit > 0) || !(attackIntervalMs > 0)) return null;

  // The midpoint of the damage range. That the roll is uniform between minHit
  // and maxHit is not stated in the typings; the midpoint is the unbiased
  // single number for any symmetric roll, and an asymmetry would shift every
  // fight by the same factor and so reorder nothing.
  const damagePerAttack = (minHit + maxHit) / 2;
  const spawnSecondsPerKill = monsterSpawnSeconds();
  const secondsPerKill =
    (hitpoints / damagePerAttack) * (attackIntervalMs / 1000) + spawnSecondsPerKill;
  if (!(secondsPerKill > 0)) return null;

  const killsPerHour = SECONDS_PER_HOUR / secondsPerKill;

  return {
    hitpoints,
    defenceLevel: safeNumber('rates.monsterDefenceLevel', () => monster.levels.Defence, 0),
    damagePerAttack,
    spawnSecondsPerKill,
    secondsPerKill,
    killsPerHour,
    // Every point of the monster's health is a point of damage dealt, so this
    // is the kill rate priced in the unit combat XP is actually paid in.
    damagePerHour: killsPerHour * hitpoints,
  };
}

const SECONDS_PER_HOUR = 3600;

/**
 * A monster's maximum hitpoints.
 *
 * `Monster` carries `levels` (monsters.d.ts:103) and nothing else about health:
 * there is no `hitpoints` field, because health lives on `Character` and only
 * an instantiated `Enemy` has it -- the same reason the dump omits `maxHit`.
 *
 * The conversion from a Hitpoints level to a health bar is **not stated in the
 * typings**, so it is settled by measurement. `numberMultiplier` (main.d.ts:16)
 * is the game's global scale, and the live character reads Hitpoints 15 against
 * a 150 bar, which is that multiplier exactly.
 *
 * The consequence of being wrong about it is bounded, and worth stating because
 * it is why measurement is enough here: the multiplier is a single global, so a
 * wrong value scales every monster's health by the same factor. Kill rates
 * would be uniformly wrong and the *ordering* of fights -- which is all a
 * candidate list is for -- would be untouched.
 */
function monsterHitpoints(monster: Monster): number | null {
  const level = safeNumber('rates.monsterHitpointsLevel', () => monster.levels.Hitpoints, 0);
  if (!(level > 0)) return null;

  return level * hitpointsPerLevel();
}

/**
 * The game's global number scale, or a nominal stand-in.
 *
 * Read off `globalThis` rather than as the bare ambient identifier, because a
 * bare reference to a global the bundle does not define throws `ReferenceError`
 * rather than yielding undefined -- which would take out the whole enumeration
 * pass instead of one rate. The fallback is recorded because reaching it means
 * the global was renamed, which is a real fault rather than a state the agent
 * legitimately runs in, so it will not fire every pass.
 */
function hitpointsPerLevel(): number {
  const multiplier = (globalThis as { numberMultiplier?: unknown }).numberMultiplier;
  if (typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier > 0) {
    return multiplier;
  }

  recordFallback('rates.numberMultiplier', 'numberMultiplier was not readable off globalThis');
  return NOMINAL_HITPOINTS_PER_LEVEL;
}

/** Health per Hitpoints level when `numberMultiplier` cannot be read. */
const NOMINAL_HITPOINTS_PER_LEVEL = 10;

/**
 * Seconds of nothing between one kill and the next enemy.
 *
 * `Player.getMonsterSpawnTime()` (player.d.ts:134) is the modifier-aware
 * accessor -- the game has both `decreasedMonsterRespawnTimer` and
 * `increasedMonsterRespawnTimer` modifiers (enums.d.ts:2084, 2125), so a
 * constant here would ignore exactly the upgrades a character buys to make
 * fights faster. `baseSpawnInterval` (player.d.ts:131) is the unmodified field
 * behind it and stands in when the accessor refuses.
 *
 * Failing to zero last is deliberate, and it is the understating direction: it
 * prices the wait as free, which flatters short fights. Naming a number instead
 * would be a guess at the one term separating a Chicken from a Hill Giant.
 */
function monsterSpawnSeconds(): number {
  const player = game.combat.player;
  const ms = safeNumber(
    'rates.monsterSpawnTime',
    () => player.getMonsterSpawnTime(),
    safeNumber('rates.baseSpawnInterval', () => player.baseSpawnInterval, 0),
  );

  return ms > 0 ? ms / 1000 : 0;
}

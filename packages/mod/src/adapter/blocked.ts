import type { BlockedSeverity, Candidate } from '@melvor-agent/shared';
import { readActiveRecipeIds } from './active.js';
import { canAfford, missingInputs } from './affordability.js';
import { readGatherCandidates } from './candidates.js';
import { readCannotAttackReason } from './combat.js';
import { readFoodReserve, readUnusableCombatStyles } from './equipment.js';
import { readSeedShortfalls } from './farming.js';
import { STARTABLE_SKILL_IDS } from './gathering.js';
import { readSlayerBlockedReason } from './management.js';
import { MS_PER_HOUR, firstUsableInterval, resolveInterval } from './rates.js';
import {
  type RecipeLike,
  currentLevelFor,
  isRecipeRealmUnlocked,
  readMasteryGate,
  recipeRequirement,
  safeRecipes,
} from './recipes.js';
import { noteSwallowed } from './safe.js';
import { readShopGoals } from './shop.js';
import { type StockDemand, demandFromShortfall } from './stock-demand.js';

/**
 * Everything the planner needs that is deliberately *not* a candidate.
 *
 * A candidate is something the agent has proven it can execute, and keeping
 * that guarantee absolute is what makes choosing by index safe. So the
 * prerequisite half of planning -- what is blocked and on what, what is still
 * level-locked, which skill is unstocked rather than unavailable, what the run
 * is saving toward, and whether the objective now running has been superseded
 * -- lives here instead, as context to read before picking a real candidate.
 *
 * Split out of `candidates.ts` so that "what can be done" and "what cannot, and
 * why" are two files. They shared one file and one set of helpers, and the
 * recurring failure across every comment below is a skill falling out of both
 * lists at once and reading, from outside, as though it did not exist.
 */

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
  /**
   * The same shortfall as a stock figure, for the candidate that produces it.
   *
   * Absent on every entry that is a fact rather than a shortfall -- a level
   * requirement, a refusal notice -- and absent on a shortfall whose consumer
   * will not price its own interval, because a demand with no rate behind it
   * would be a number nobody derived. See {@link StockDemand}.
   */
  demands?: StockDemand[];
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

  // And why a whole combat style is unavailable. `readEquipCandidates` gates on
  // `game.checkRequirements` and drops the reason, so a bank holding three
  // tiers of crossbow and 2,134 arrows produced exactly one equip candidate --
  // a scimitar -- and no line anywhere saying what refused the rest. A goal
  // reading "Ranged 3/20" for a run that cannot equip a ranged weapon is the
  // silence this list exists to end.
  blocked.push(...readUnusableCombatStyles());

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

        // The same shortfall as a number, sized against this recipe's own rate.
        //
        // Computed here because this is the only place the consumer's
        // actions-per-hour and its per-action need are both in scope, and the
        // scale of a stock target is entirely a fact about the consumer -- see
        // `demandFromShortfall` for why an hour of it is the unit. Recomputing
        // it later would mean walking every recipe of every skill a second time
        // per report, and re-deriving an interval that has already been
        // resolved once here with a fallback chain three deep.
        const demands = missing.flatMap((entry) => {
          const demand = demandFromShortfall(
            `${skill.name}: ${recipe.name}`,
            entry,
            actionsPerHour,
          );
          return demand === null ? [] : [demand];
        });

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
          ...(demands.length === 0 ? {} : { demands }),
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
    //
    // Realm-locked recipes are excluded, and the requirement is read off the
    // track the recipe is actually gated on. Both matter for the same reason
    // the candidate tally had to stop calling everything mastery-locked: a
    // level here reads as "grind and it opens", and for Into the Abyss content
    // that is false twice over. Every Harvesting vein carries `level: 0` and an
    // `abyssalLevel` (dump: Twisted Vein, abyssal 11), so the standard pair says
    // "already unlocked" while the Abyssal realm reports `unlocked: false` with
    // "Complete Into the Abyss x1" outstanding -- no amount of Harvesting XP
    // reaches it. See recipeRequirement for the two-track split.
    let nearest: { recipe: RecipeLike; level: number; abyssal: boolean } | null = null;
    for (const recipe of recipes) {
      if (!isRecipeRealmUnlocked(recipe)) continue;

      const requirement = recipeRequirement(recipe);
      if (requirement.level <= currentLevelFor(skill, requirement.abyssal)) continue;
      if (nearest === null || requirement.level < nearest.level) {
        nearest = { recipe, level: requirement.level, abyssal: requirement.abyssal };
      }
    }

    if (nearest === null) continue;

    const track = nearest.abyssal ? 'Abyssal level' : 'level';
    locked.push({
      label: `${skill.name}: ${nearest.recipe.name} unlocks at ${track} ${nearest.level} (currently ${currentLevelFor(skill, nearest.abyssal)})`,
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

      // The best recipe the level allows, in a realm the character can enter.
      // If one exists, the block is materials rather than progression, and that
      // is the whole point.
      //
      // Both filters were wrong for Into the Abyss content, and wrong in the
      // direction that invents work. Every Harvesting vein reads `level: 0` on
      // the standard track and carries its real requirement on `abyssalLevel`,
      // so this named Abyssal Vein as "unlocked at level 0" and told the planner
      // to go buy materials for a skill whose seven veins are *all* in realms
      // reporting `unlocked: false` -- and which consume no materials at all.
      // A shopping list for a realm you cannot enter is exactly the misdirection
      // the candidate tally was mislabelling in the same breath.
      const reachable = recipes.filter((recipe) => {
        if (!isRecipeRealmUnlocked(recipe)) return false;
        const requirement = recipeRequirement(recipe);
        return requirement.level <= currentLevelFor(skill, requirement.abyssal);
      });
      const best = reachable[0];
      if (best === undefined) continue;

      out.push({
        label: `${skill.name} has no candidates because nothing it can make is in stock, not because it is unavailable — ${best.name} is unlocked at level ${recipeRequirement(best).level} and needs materials bought or gathered.`,
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
 * Why no fight, dungeon or combat event can be taken, when none can.
 *
 * The candidate half of {@link readCannotAttackReason}, and the reason it had
 * to become a reader. All evening the executor abandoned both Fight Leech
 * objectives with
 *
 *     abandoning objective; the game refuses it in this state:
 *       Wind Strike is selected but the bank cannot pay for it (needs 1x Mind Rune)
 *
 * while the list offered `221. Fight Leech (Wet Forest, combat level 20) — 200
 * HP (defence 10), ~84 kills/h, ~16,744 damage/h` as fully available, and a
 * grep of the entire candidate text for "Wind Strike" or "Mind Rune" returned
 * nothing. Every combat goal — `ranged-20`, `defence-20`, `hp-40`, `prayer-20`,
 * `first-dungeon` — was blocked on a fact the planner had no way to read.
 *
 * One line, not one per fight. There are around two hundred reachable fights
 * and the blocked window is twelve; two hundred identical copies would truncate
 * away every other diagnostic, which is precisely how four notices written in a
 * day were shipped and never once read. The count is stated instead.
 *
 * Named producers for the same reason recipes have them since
 * `Magic: Superheat II — Earth Rune from Runecrafting: Earth Rune`: "needs 1x
 * Mind Rune" is a fact, and "Mind Rune from Runecrafting: Mind Rune" is a move.
 *
 * **This guard cannot starve its own precondition, and that was checked rather
 * than assumed.** What it withholds is combat; what restores the ability to
 * attack is runes (a Runecrafting candidate), ammunition (Fletching, the shop,
 * or the quiver reflex) or a different weapon (an equip candidate) — not one of
 * them a fight. That is the difference from the bank-slot cap, whose only
 * replenishment was the gathering it was blocking.
 *
 * @param withheld - How many fights were withheld, for the label.
 */
export function readUnfightableCombat(withheld: number): {
  label: string;
  xpPerHour: number;
  severity: BlockedSeverity;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    const reason = readCannotAttackReason();
    if (reason === null) return [];

    return [
      {
        label: `Combat: none of the ${withheld} reachable fights, dungeons or combat events can be taken — ${reason.detail}. They are withheld rather than offered, because the game refuses every one of them in this state${describeProducers(reason.missing)}`,
        xpPerHour: 0,
        // Not `low` like the rest of the combat lines. Those say "you cannot
        // fight *this* yet", which is progression context; this says combat is
        // unavailable entirely, and it is the only line standing between five
        // goals and silence.
        severity: 'high',
        missing: reason.missing,
      },
    ];
  } catch (error) {
    noteSwallowed('candidates.readUnfightableCombat', error);
    // A reason that cannot be read is not reported as one. Combat keeps being
    // offered, and the executor's own refusal remains the backstop it has
    // always been.
    return [];
  }
}

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

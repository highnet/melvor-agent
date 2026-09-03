import { noteSwallowed, safeBoolean, safeNumber } from './safe.js';

/**
 * The shape a skill's actions share, and the gates that decide which of them
 * the character may attempt.
 *
 * Split out of `candidates.ts` because every enumeration in this directory —
 * the generic one, the four specialised gathering ones, and the blocked and
 * locked diagnostics — asks the same four questions of a recipe: what is it,
 * is its realm open, which level track gates it, and does the mastery gate
 * admit it. One copy of each answer is what keeps those lists agreeing.
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
export const ALT_MAGIC_ID = 'melvorD:Magic';

/** Recipe list for a skill, or null when the skill does not expose one. */
export function safeRecipes(skill: {
  actions?: { allObjects: RecipeLike[] };
}): RecipeLike[] | null {
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
  /**
   * Present on SingleProductArtisanSkillRecipe and the gathering recipes.
   *
   * Narrowed from `object` to the two fields every caller here reads off it.
   * `SingleProductRecipe.product` (skill.d.ts:1024) and
   * `SingleProductArtisanSkillRecipe.product` (artisanSkill.d.ts:131) are both
   * `AnyItem`, so an id and a name are always there -- and while this was
   * `object`, naming the item a recipe produces meant a cast at every site,
   * which is how the join between "something is short of Earth Runes" and
   * "this candidate makes Earth Runes" stayed a sentence.
   */
  product?: { id: string; name: string };
  baseQuantity?: number;
  /** ArtisanSkillRecipe.itemCosts (artisanSkill.d.ts:82); absent on gathering. */
  itemCosts?: { item: AnyItem; quantity: number }[];
  /**
   * An Alt Magic spell prices itself in runes, not in `itemCosts`.
   *
   * `AltMagicSpell extends BaseSpell` (altMagic.d.ts:66), which declares
   * `runesRequired: RuneQuantity[]` and an optional `runesRequiredAlt`
   * (spells.d.ts:27-28); `fixedItemCosts` (altMagic.d.ts:72) is the spell's
   * equivalent of `itemCosts`. Nothing here ever read any of them, so every
   * spell priced itself as free. See {@link spellCosts}.
   */
  runesRequired?: { item: AnyItem; quantity: number }[];
  runesRequiredAlt?: { item: AnyItem; quantity: number }[];
  fixedItemCosts?: { item: AnyItem; quantity: number }[];
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
export function isRecipeRealmUnlocked(recipe: RecipeLike): boolean {
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
export function recipeRequirement(recipe: RecipeLike): {
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
 * The level track a recipe is actually gated on.
 *
 * Melvor-realm and Abyssal progressions are separate (`Skill.level`
 * skill.d.ts:167, `Skill.abyssalLevel` skill.d.ts:186), and comparing across
 * them is how a zero became an invitation once already -- see recipeRequirement.
 */
export function currentLevelFor(skill: AnySkill, abyssal: boolean): number {
  return safeNumber(
    `candidates.skillLevel:${skill.id}`,
    () => (abyssal ? skill.abyssalLevel : skill.level),
    0,
  );
}

/**
 * Which of a skill's recipes the mastery gate says are unlocked, or null when
 * it is not answering that question.
 *
 * `isMasteryActionUnlocked` (skill.d.ts:806, abstract) is what keeps a
 * level-gated recipe off the board for every skill in this loop. Alt Magic
 * overrides it (altMagic.d.ts:109) alongside `hasMastery` (:102),
 * `computeTotalMasteryActions` (:107) and `updateTotalUnlockedMasteryActions`
 * (:108) -- the full set a skill overrides when it has no mastery at all -- and
 * its answer for a spell is not "this spell is locked".
 *
 * The cost of not distinguishing the two was a full day. Every one of the 26
 * spells was dropped here, silently: no candidate, no blocked entry, no
 * adapter-failure line, nothing thrown. `set_objective` cast Just Learning
 * perfectly and took Magic 2 to 10 in six minutes, while `list_candidates`
 * showed the skill did not exist. The live report is what settled it: Magic was
 * in `game.skills`, `readLockedActions` enumerated the same registry and
 * reported "Bone Offering unlocks at level 18", `adapterFailures` named no site
 * in this file, and `canAfford` cannot refuse a spell (AltMagic declares no
 * `getRecipeCosts` and a spell has no `itemCosts`) -- which leaves exactly one
 * silent `continue`.
 *
 * Two signals, either sufficient, because the typings state the *shape* of the
 * override and not what it returns:
 *
 * 1. `hasMastery` false (skill.d.ts:178, overridden at skill.d.ts:680 and again
 *    by Alt Magic). A skill that says it has no mastery is not being asked
 *    whether a mastery action is unlocked; the question does not apply.
 * 2. Every recipe refused. No skill ships with all of its actions locked -- the
 *    level-1 action is always available -- so a gate that admits nothing is a
 *    category error, not a lock. This is the backstop that does not depend on
 *    a value the typings decline to state.
 *
 * Returning a set rather than a predicate so each recipe is asked exactly once
 * per pass: the probe and the gate are the same call.
 */
export function readMasteryGate(
  skill: AnySkill,
  withActions: { isMasteryActionUnlocked?: (recipe: object) => boolean },
  recipes: readonly RecipeLike[],
): Set<RecipeLike> | null {
  const ask = withActions.isMasteryActionUnlocked;
  if (typeof ask !== 'function') return null;

  const hasMastery = safeBoolean(
    `candidates.hasMastery:${skill.id}`,
    () => (skill as AnySkill & { hasMastery: boolean }).hasMastery,
    true,
  );
  if (!hasMastery) return null;

  const unlocked = new Set<RecipeLike>();
  for (const recipe of recipes) {
    try {
      if (ask.call(withActions, recipe) !== false) unlocked.add(recipe);
    } catch (error) {
      noteSwallowed(`candidates.masteryUnlocked:${skill.id}`, error);
      unlocked.add(recipe);
    }
  }

  return unlocked.size === 0 && recipes.length > 0 ? null : unlocked;
}

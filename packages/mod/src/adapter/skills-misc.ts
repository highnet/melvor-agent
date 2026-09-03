import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { readConsumableItems } from './disposal.js';
import type { GatheringProjection } from './gathering.js';
import { noteSwallowed, safeValue } from './safe.js';

/**
 * Skills that share no base class with anything else and need their own routine.
 *
 * Each entry below was read out of the typings individually. The variety is the
 * point: Firemaking selects a log then burns it, Cooking selects per *category*
 * and starts per category, Thieving takes an area and an NPC together, Astrology
 * has a single study call, Agility runs a whole prebuilt course with no per-item
 * selection at all, and Harvesting clicks a vein. Any shared abstraction across
 * these would be invented rather than observed.
 */
export const MISC_SKILL_IDS = [
  'melvorD:Firemaking',
  'melvorD:Cooking',
  'melvorD:Thieving',
  'melvorD:Astrology',
  'melvorD:Agility',
  'melvorD:Magic',
  'melvorItA:Harvesting',
] as const;

export type MiscSkillId = (typeof MISC_SKILL_IDS)[number];

/** Whether an id names one of the individually-routed skills. */
export function isMiscSkill(skillId: string): skillId is MiscSkillId {
  return (MISC_SKILL_IDS as readonly string[]).includes(skillId);
}

interface Startable {
  id: string;
  isActive: boolean;
  canStop: boolean;
  stop(): boolean;
}

function projectFrom(skill: Startable, selected: string[]): GatheringProjection {
  return {
    skillId: skill.id,
    active: skill.isActive,
    selected,
    activeActionId: game.activeAction?.id ?? null,
  };
}

/** Refuses when another skill already holds the game's single action slot. */
function actionSlotHeldBy(skillId: string): string | null {
  const active = game.activeAction;
  if (active === undefined || active.id === skillId) return null;
  return `another action is running: ${active.id}`;
}

/**
 * Starts one of the individually-routed skills on a specific recipe.
 *
 * @param skillId - One of {@link MISC_SKILL_IDS}.
 * @param recipeId - Log, cooking recipe, NPC, constellation, spell or vein id.
 *                   Ignored for Agility, which runs a prebuilt course.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the skill is now running that recipe.
 */
export function startMiscSkill(
  skillId: string,
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  // Several skill properties on `Game` are optional in the typings (expansion
  // content). Resolving first turns a missing skill into an honest refusal
  // rather than a TypeError from deep inside the routine.
  if (miscSkillInstance(skillId) === null) {
    return fail('misc.start', 'precondition', `skill ${skillId} is absent from this game version`);
  }

  switch (skillId) {
    case 'melvorD:Firemaking':
      return startFiremaking(recipeId, isSuspended);
    case 'melvorD:Cooking':
      return startCooking(recipeId, isSuspended);
    case 'melvorD:Thieving':
      return startThieving(recipeId, isSuspended);
    case 'melvorD:Astrology':
      return startAstrology(recipeId, isSuspended);
    case 'melvorD:Agility':
      return startAgility(isSuspended);
    case 'melvorD:Magic':
      return startAltMagic(recipeId, isSuspended);
    case 'melvorItA:Harvesting':
      return startHarvesting(recipeId, isSuspended);
    default:
      return fail('misc.start', 'precondition', `no verified routine for skill ${skillId}`);
  }
}

// --- Firemaking ------------------------------------------------------------

function startFiremaking(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = game.firemaking;
  const log = skill.actions.getObjectByID(recipeId);
  if (log === undefined) {
    return fail('firemaking.burn', 'precondition', `no log registered with id ${recipeId}`);
  }

  const project = (): GatheringProjection =>
    projectFrom(skill, skill.selectedRecipe === undefined ? [] : [skill.selectedRecipe.id]);

  return act(
    {
      name: 'firemaking.burn',
      observe: project,
      precondition: () => {
        if (!skill.isMasteryActionUnlocked(log)) {
          return `log ${recipeId} is locked (needs level ${log.level})`;
        }
        // Firemaking consumes the log, so an empty bank means a silent no-op.
        if (game.bank.getQty(log.log) < 1) return `no ${log.log.id} in the bank to burn`;
        const current = project();
        if (current.active && current.selected.includes(recipeId)) {
          return `already burning ${recipeId}`;
        }
        return actionSlotHeldBy('melvorD:Firemaking');
      },
      perform: () => {
        if (skill.selectedRecipe?.id !== recipeId) skill.selectLog(log);
        if (!skill.isActive) skill.burnLog();
        return undefined;
      },
      changed: (_before, after) => after.active && after.selected.includes(recipeId),
    },
    isSuspended,
  );
}

// --- Cooking ---------------------------------------------------------------

function startCooking(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = game.cooking;
  const recipe = skill.actions.getObjectByID(recipeId);
  if (recipe === undefined) {
    return fail('cooking.cook', 'precondition', `no recipe registered with id ${recipeId}`);
  }

  // Cooking is per-category: each category has its own selected recipe and its
  // own start button, and several can be running at once.
  const category = recipe.category;

  const project = (): GatheringProjection =>
    projectFrom(skill, [...skill.selectedRecipes.values()].map((selected) => selected.id).sort());

  return act(
    {
      name: 'cooking.cook',
      observe: project,
      precondition: () => {
        if (!skill.isMasteryActionUnlocked(recipe)) {
          return `recipe ${recipeId} is locked (needs level ${recipe.level})`;
        }
        if (!skill.getRecipeCosts(recipe).checkIfOwned()) {
          return `missing ingredients for ${recipeId}`;
        }
        if (skill.isActive && skill.activeCookingCategory === category) {
          return `already cooking in category ${category.id}`;
        }
        return actionSlotHeldBy('melvorD:Cooking');
      },
      perform: () => {
        if (skill.selectedRecipes.get(category)?.id !== recipeId) {
          skill.onRecipeSelectionClick(recipe);
        }
        skill.onActiveCookButtonClick(category);
        return undefined;
      },
      // The post-condition is category-level, because that is what Cooking
      // actually tracks as "the thing I am doing".
      changed: () => skill.isActive && skill.activeCookingCategory === category,
    },
    isSuspended,
  );
}

// --- Thieving --------------------------------------------------------------

function startThieving(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = game.thieving;
  const npc = skill.actions.getObjectByID(recipeId);
  if (npc === undefined) {
    return fail('thieving.steal', 'precondition', `no NPC registered with id ${recipeId}`);
  }

  const area = npc.area;
  if (area === undefined) {
    return fail('thieving.steal', 'precondition', `NPC ${recipeId} has no thieving area`);
  }

  const project = (): GatheringProjection =>
    projectFrom(skill, skill.currentNPC === undefined ? [] : [skill.currentNPC.id]);

  return act(
    {
      name: 'thieving.steal',
      observe: project,
      precondition: () => {
        if (!skill.isMasteryActionUnlocked(npc)) {
          return `NPC ${recipeId} is locked (needs level ${npc.level})`;
        }
        if (skill.isActive && skill.currentNPC === npc) return `already stealing from ${recipeId}`;
        return actionSlotHeldBy('melvorD:Thieving');
      },
      // Thieving takes both together, so there is no separate selection step.
      perform: () => skill.startThieving(area, npc),
      changed: () => skill.isActive && skill.currentNPC === npc,
    },
    isSuspended,
  );
}

// --- Astrology -------------------------------------------------------------

function startAstrology(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = game.astrology;
  const constellation = skill.actions.getObjectByID(recipeId);
  if (constellation === undefined) {
    return fail(
      'astrology.study',
      'precondition',
      `no constellation registered with id ${recipeId}`,
    );
  }

  // `activeConstellation` is a non-optional getter, so it always reports
  // something; `isActive` is what distinguishes studying from idle.
  const project = (): GatheringProjection =>
    projectFrom(skill, skill.isActive ? [skill.activeConstellation.id] : []);

  return act(
    {
      name: 'astrology.study',
      observe: project,
      precondition: () => {
        if (!skill.isMasteryActionUnlocked(constellation)) {
          return `constellation ${recipeId} is locked (needs level ${constellation.level})`;
        }
        if (skill.isActive && skill.activeConstellation === constellation) {
          return `already studying ${recipeId}`;
        }
        return actionSlotHeldBy('melvorD:Astrology');
      },
      perform: () => skill.studyConstellationOnClick(constellation),
      changed: () => skill.isActive && skill.activeConstellation === constellation,
    },
    isSuspended,
  );
}

// --- Agility ---------------------------------------------------------------

function startAgility(isSuspended: () => boolean): ActionResult<GatheringProjection> {
  const skill = game.agility;

  const project = (): GatheringProjection =>
    projectFrom(skill, skill.activeCourse.builtObstacles.size > 0 ? ['course'] : []);

  return act(
    {
      name: 'agility.run',
      observe: project,
      precondition: () => {
        // Agility has no per-recipe selection: it runs whatever course the
        // player has already built. An empty course would start nothing.
        if (skill.activeCourse.builtObstacles.size === 0) {
          return 'no obstacles built on the active agility course';
        }
        if (skill.isActive) return 'agility is already running';
        return actionSlotHeldBy('melvorD:Agility');
      },
      perform: () => skill.start(),
      changed: (before, after) => !before.active && after.active,
    },
    isSuspended,
  );
}

// --- Alt Magic -------------------------------------------------------------

function startAltMagic(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = game.altMagic;
  // Alt Magic spells live in the skill's own actions registry. `game.attackSpells`
  // is the combat spellbook and a different type entirely.
  const spell = skill.actions.getObjectByID(recipeId);
  if (spell === undefined) {
    return fail('altMagic.cast', 'precondition', `no alt magic spell registered as ${recipeId}`);
  }

  // The spell *and* what it is set to destroy. Alt Magic's recipe is genuinely
  // both: the live measurement that started this showed the consumed item is
  // half the cost of a cast, and a projection naming only the spell reports a
  // fuel swap as "nothing changed". Carrying it is what lets `act` prove a
  // re-selection landed instead of taking the caller's word for it.
  const project = (): GatheringProjection => {
    const selection = liveSelectionId(spell);
    return projectFrom(skill, [
      ...(skill.selectedSpell === undefined ? [] : [skill.selectedSpell.id]),
      ...(selection === null ? [] : [selection]),
    ]);
  };

  // Set by the precondition when the only reason this call is allowed through
  // is that the running cast's fuel has gone stale; `changed` then has to prove
  // the replacement landed, because the spell half of the projection was
  // already true before the call and would otherwise report a no-op as success.
  let refreshing = false;
  /** What was selected when `refreshing` was set, so `changed` can see it go. */
  let staleSelectionId: string | null = null;

  return act(
    {
      name: 'altMagic.cast',
      observe: project,
      precondition: () => {
        // Spells consuming a chosen item used to be refused outright, on the
        // grounds that the mapping from spell to valid item would have to be
        // guessed. It does not: `getSpellItemSelection` (altMagic.d.ts:119)
        // returns exactly the bank items a given spell will accept, and
        // `selectBarOnClick` (:125) does the same for Superheat's bar.
        //
        // The refusal cost more than one spell. Item Alchemy is the game's
        // dedicated turn-items-into-GP action and Superheat smelts without
        // occupying the furnace, and both were unreachable -- while Magic sat
        // at level 2 against a stated goal of 20, and the agent had no
        // automatic way to convert stock into money at all.
        //
        // The refusal quotes `chooseSelection`'s own reason. It used to say
        // "nothing eligible is banked" for every empty answer, which is false
        // whenever the bank is full of items the spell accepts and the cast is
        // being refused because it would destroy them at a loss -- a refusal
        // the operator cannot interpret is a refusal that gets overridden.
        refreshing = false;
        if (needsSelection(spell)) {
          const outcome = chooseSelection(spell);
          if (!outcome.ok) return `spell ${recipeId} cannot be cast: ${outcome.reason}`;
          refreshing = !outcome.keepsCurrent;
          staleSelectionId = refreshing ? liveSelectionId(spell) : null;
        }
        // A cast that is already running is normally left alone -- but only
        // while what it is consuming is still something it is allowed to
        // consume. This short-circuit used to be unconditional, which made the
        // consumed item a decision taken once at start and never revisited, and
        // that is a decision with a shelf life: the stack empties, or a guard
        // added afterwards starts covering it. Both were observed. A rune guard
        // shipped, was built and reloaded, and the agent went on burning Nature
        // Runes because the item chosen before the fix survived in
        // `selectedConversionItem` (altMagic.d.ts:126) -- only a manual
        // stop/start cleared it, after which the measured draw fell from two
        // Nature Runes a cast to one Nature and one Arrow Shaft. The emptying
        // half was three hours away at the time of writing: 4,322 Arrow Shafts
        // at ~1,800 casts an hour, after which the cast would have been aimed
        // at a selection that no longer existed and, by this same
        // short-circuit, would never have been re-aimed.
        //
        // Cheap enough to run every tick because it adds no work: the
        // precondition above already walks the offered list on every call and
        // throws the answer away. `keepsCurrent` is that walk's by-product. Note
        // what it deliberately does not do -- re-select because something
        // *better* appeared. That would churn the fuel on every tie broken
        // differently and disturb a running cast for no gain; see
        // {@link SelectionOutcome}.
        if (skill.isActive && skill.selectedSpell === spell && !refreshing) {
          return `already casting ${recipeId}`;
        }
        return actionSlotHeldBy('melvorD:Magic');
      },
      perform: () => {
        if (skill.selectedSpell !== spell) skill.selectSpellOnClick(spell);

        // After the spell, because the selection menus are per-spell: choosing
        // first would set it against whatever was previously selected.
        const outcome = chooseSelection(spell);
        if (outcome.ok) {
          const selection = outcome.selection;
          if (selection.kind === 'bar') skill.selectBarOnClick(selection.recipe);
          else skill.selectItemOnClick(selection.item);
        }

        if (!skill.isActive) skill.castButtonOnClick();
        return undefined;
      },
      // The cast is running the right spell, and -- when this call existed only
      // to replace stale fuel -- it is no longer aimed at the stale fuel. The
      // second clause is what stops a refresh that silently did nothing from
      // reporting `ok`: `selectItemOnClick` (altMagic.d.ts:143) is a UI
      // callback whose side effects the typings do not state, so whether it can
      // be applied to a running cast at all is checked rather than assumed.
      changed: () =>
        skill.isActive &&
        skill.selectedSpell === spell &&
        (!refreshing || liveSelectionId(spell) !== staleSelectionId),
    },
    isSuspended,
  );
}

/**
 * The id of what the game currently has this spell set to consume, if anything.
 *
 * Two fields, because Alt Magic has two kinds of selection and only one of them
 * applies to a given spell: `selectedSmithingRecipe` (altMagic.d.ts:124) for
 * Superheat, whose selection is a recipe, and `selectedConversionItem` (:126)
 * for every spell that destroys a bank item. Reading the wrong one would answer
 * `undefined` for a spell that is perfectly well aimed, and re-select on every
 * tick forever.
 */
function liveSelectionId(spell: AltMagicSpell): string | null {
  const magic = game.altMagic;
  const selected = safeValue('skills-misc.liveSelectionId', () =>
    spell.produces === PRODUCES_BAR ? magic.selectedSmithingRecipe : magic.selectedConversionItem,
  );
  return selected?.id ?? null;
}

// --- Harvesting (Into the Abyss) -------------------------------------------

function startHarvesting(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = game.harvesting;
  if (skill === undefined) {
    return fail('harvesting.harvest', 'precondition', 'Harvesting is not present in this game');
  }

  const vein = skill.actions.getObjectByID(recipeId);
  if (vein === undefined) {
    return fail('harvesting.harvest', 'precondition', `no vein registered with id ${recipeId}`);
  }

  const project = (): GatheringProjection =>
    projectFrom(skill, skill.selectedVein === undefined ? [] : [skill.selectedVein.id]);

  return act(
    {
      name: 'harvesting.harvest',
      observe: project,
      precondition: () => {
        if (!skill.isMasteryActionUnlocked(vein)) {
          return `vein ${recipeId} is locked (needs level ${vein.level})`;
        }
        const current = project();
        if (current.active && current.selected.includes(recipeId)) {
          return `already harvesting ${recipeId}`;
        }
        return actionSlotHeldBy('melvorItA:Harvesting');
      },
      perform: () => {
        skill.onVeinClick(vein);
        return skill.isActive ? undefined : skill.start();
      },
      changed: (_before, after) => after.active && after.selected.includes(recipeId),
    },
    isSuspended,
  );
}

/**
 * Stops one of the individually-routed skills.
 *
 * @param skillId - One of {@link MISC_SKILL_IDS}.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the skill left the active state.
 */
export function stopMiscSkill(
  skillId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = miscSkillInstance(skillId);
  if (skill === null) {
    return fail('misc.stop', 'precondition', `no verified routine for skill ${skillId}`);
  }

  return act(
    {
      name: `${skillId}.stop`,
      observe: () => projectFrom(skill, []),
      precondition: () => {
        if (!skill.isActive) return `${skillId} is not active`;
        // A wait, not a refusal — see the same check in the gathering adapter.
        // "Cannot stop" is a moment (mid-action, or stunned), and reporting it
        // as a precondition made the policy tier abandon whatever was queued
        // behind it.
        if (!skill.canStop) {
          return { wait: `${skillId} cannot stop yet — it is mid-action or stunned` };
        }
        return null;
      },
      perform: () => skill.stop(),
      changed: (before, after) => before.active && !after.active,
    },
    isSuspended,
  );
}

function miscSkillInstance(skillId: string): Startable | null {
  const instance = ((): unknown => {
    switch (skillId) {
      case 'melvorD:Firemaking':
        return game.firemaking;
      case 'melvorD:Cooking':
        return game.cooking;
      case 'melvorD:Thieving':
        return game.thieving;
      case 'melvorD:Astrology':
        return game.astrology;
      case 'melvorD:Agility':
        return game.agility;
      case 'melvorD:Magic':
        return game.altMagic;
      case 'melvorItA:Harvesting':
        return game.harvesting;
      default:
        return undefined;
    }
  })();

  return instance === undefined || instance === null ? null : (instance as Startable);
}

/** Whether a spell needs a second selection before it can be cast. */
function needsSelection(spell: AltMagicSpell): boolean {
  try {
    return spell.specialCost.quantity > 0;
  } catch (error) {
    noteSwallowed('skills-misc.needsSelection', error);
    return false;
  }
}

/**
 * The `AltMagicProductionID` and `AltMagicConsumptionID` sentinels, as literals.
 *
 * Both are plain `declare enum`s (altMagic.d.ts:28-37 and :19-27), so the
 * runtime bundle carries no value for them and `AltMagicProductionID.Bar` is a
 * bare global reference resolved when this runs. `candidates.ts` and
 * `registries.ts` both already spell their sentinels out for that reason; this
 * file did not, and it is the one place where the reference is inside a
 * catch-all: an unresolved global there is swallowed into "no selection", which
 * refuses *every* item-consuming spell with a message about the bank. The
 * numbers are taken from the declaration rather than from memory.
 */
const PRODUCES_GP = -1;
const PRODUCES_BAR = -2;
const CONSUMES_BAR_INGREDIENTS_WITH_COAL = -3;

/** What a spell will consume: a Smithing recipe for Superheat, else a bank item. */
type SpellSelection = { kind: 'bar'; recipe: SmithingRecipe } | { kind: 'item'; item: AnyItem };

/**
 * A selection, or the reason there is none.
 *
 * The reason is carried rather than collapsed to `null` because the caller
 * cannot reconstruct it. `startAltMagic` used to turn every empty answer into
 * "nothing eligible is banked", which is one of four different situations and
 * the wrong one in three of them -- and an operator reading "nothing eligible
 * is banked" against a bank full of ore has been sent looking in the wrong
 * place by this repo before.
 */
type SelectionChoice = { ok: true; selection: SpellSelection } | { ok: false; reason: string };

/**
 * A choice, plus whether the game's *live* selection is still admissible.
 *
 * `keepsCurrent` is the answer to a different question from `selection`, and
 * the difference is the whole point: `selection` is what would be chosen now,
 * `keepsCurrent` is whether what the game is already consuming is still allowed
 * to be consumed. Acting on the first would re-pick the fuel every time the
 * ranking shifted -- a tie broken the other way, a cheaper stack arriving --
 * and every re-pick carries the risk of disturbing a running cast. Acting on
 * the second only intervenes when the current fuel is *gone or newly forbidden*,
 * which is the condition that actually goes wrong. See {@link startAltMagic}.
 *
 * Free to compute. `chooseSelection` already walks the offered list to rank it,
 * so asking whether the live selection is in that list costs one comparison per
 * item and no extra bank walk.
 */
type SelectionOutcome =
  | { ok: true; selection: SpellSelection; keepsCurrent: boolean }
  | { ok: false; reason: string };

/**
 * What a spell should consume, chosen from the game's own list of eligible items.
 *
 * Two shapes. Superheat consumes the ingredients of a Smithing recipe and
 * produces its bar, so the selection is a `SmithingRecipe` and the right one is
 * the bar with the best margin the character can both smith and afford.
 * Everything else -- Item Alchemy and the conversion spells -- consumes a bank
 * item, and which item is right depends on what the spell pays; see below.
 *
 * The candidates are drawn through the sell guards -- `readConsumableItems`,
 * which shares `saleExclusionReason` with the sell list -- rather than from the
 * raw bank. Consuming an item destroys it exactly as selling does, so the
 * reasons not to sell food, ammunition, seeds, spell runes, mastery tokens or
 * anything a Township task wants apply here unchanged. Sharing the guard chain
 * means a guard added for one path protects both, instead of the two drifting
 * until the newer one burns the larder. The single difference is the sale value
 * itself: a stack worth 0 GP is not worth listing and is the *best* thing to
 * burn, so it is offered here and not there.
 *
 * That reuse is load-bearing rather than tidy, and it took a live measurement to
 * show it. For 100 seconds of `Just Learning` the bank moved Air Rune -49,
 * Nature Rune -98, Rune Essence +49: 49 casts, each paying 1 Nature + 1 Air as
 * the spell's rune cost and then destroying a *second* Nature Rune as the item
 * it consumed, because a Nature Rune sells for 1 and nothing stopped it. The
 * sell guards had a hole -- they knew about attack-spell runes and no attack
 * spell wants a Nature Rune -- so this function inherited the hole verbatim.
 * `readAltMagicFuelIds` in candidates.ts closes it on both paths at once, which
 * is the whole reason the selection is not allowed its own item list.
 *
 * The refusal lives here, with the ranking, rather than in the caller: this is
 * the only place that knows which item would be destroyed and what it is worth,
 * and a caller that re-derived either would be a second ranking to keep in step
 * with this one.
 */
function chooseSelection(spell: AltMagicSpell): SelectionOutcome {
  try {
    const magic = game.altMagic;

    // Superheat: the produced thing is a bar, so the selection is the recipe.
    if (spell.produces === PRODUCES_BAR) {
      let best: { recipe: SmithingRecipe; net: number } | null = null;
      // Whether the recipe the game is *already* superheating still passes every
      // test below. Set inside the loop rather than re-derived afterwards, so
      // the answer cannot drift from the filters that produced it.
      // `selectedSmithingRecipe` (altMagic.d.ts:124) is undefined when nothing
      // is selected, which reads as "not current" and re-selects.
      let keepsCurrent = false;
      const current = safeValue(
        'skills-misc.selectedSmithingRecipe',
        () => magic.selectedSmithingRecipe,
      );

      for (const recipe of game.smithing.actions.allObjects) {
        try {
          if (recipe.level > game.smithing.level) continue;
          if (!game.smithing.isMasteryActionUnlocked(recipe)) continue;

          const useCoal = spell.specialCost.type === CONSUMES_BAR_INGREDIENTS_WITH_COAL;
          if (!magic.getSuperheatBarCosts(recipe, useCoal, 1).checkIfOwned()) continue;

          if (current !== undefined && recipe.id === current.id) keepsCurrent = true;

          const net = saleValueOf(recipe.product);
          if (best === null || net > best.net) best = { recipe, net };
        } catch (error) {
          noteSwallowed('skills-misc.chooseSelection', error);
          // A recipe that will not price itself is not selected.
        }
      }

      return best === null
        ? { ok: false, reason: 'no smithable bar has its ingredients in the bank' }
        : { ok: true, selection: { kind: 'bar', recipe: best.recipe }, keepsCurrent };
    }

    // Everything else consumes a bank item the game will name for us.
    // `getSpellItemSelection` (altMagic.d.ts:139) returns exactly what this
    // spell accepts, so eligibility is never guessed at.
    const eligible = new Set(magic.getSpellItemSelection(spell).map((item) => item.id));
    if (eligible.size === 0) {
      return { ok: false, reason: `nothing ${spell.name} accepts is in the bank` };
    }

    // A spell must not be fed its own product. Just Learning yields a Rune
    // Essence, a Rune Essence sells for 0, and the consumable list deliberately
    // admits worthless stacks -- so without this the spell can convert essence
    // into essence indefinitely, paying a Nature and an Air Rune per cast for a
    // net change of nothing. `produces` is `AltMagicProductionID | AnyItem`
    // (altMagic.d.ts:75); the sentinels are numbers, so an object is an item.
    const produced =
      typeof spell.produces === 'object' ? (spell.produces as AnyItem).id : undefined;

    const offered: AnyItem[] = [];
    for (const item of readConsumableItems()) {
      if (!eligible.has(item.id)) continue;
      if (item.id === produced) continue;
      offered.push(item);
    }

    if (offered.length === 0) {
      return {
        ok: false,
        reason: `every item ${spell.name} accepts is withheld by a sell guard — food under the reserve, ammunition, seeds, runes a castable attack spell or a reachable Alt Magic spell needs, mastery tokens, what a Township task wants, or a locked stack`,
      };
    }

    // Which item to destroy depends on what the spell pays, and the two cases
    // want *opposite* items. One `>` served both and always picked the dearest.
    //
    // `produces` is `AltMagicProductionID | AnyItem` (altMagic.d.ts:75), and GP
    // is the -1 sentinel (:29). Alchemy pays a ratio of the consumed item's own
    // value, so the dearest eligible item is right. Every other item-consuming
    // spell pays a fixed product regardless of the input -- Just Learning
    // yields exactly one Rune Essence whether it eats an Arrow Shaft worth 1 or
    // a Gold Ore worth 30 -- so there the dearest item is precisely the wrong
    // one, and the mistake is unrecoverable in the way selling the same item
    // would at least not have been.
    const choice =
      spell.produces === PRODUCES_GP
        ? chooseAlchemyItem(magic, spell, offered)
        : chooseCheapestItem(offered);
    if (!choice.ok) return choice;

    // Whether what the game is *already* consuming is still allowed to be.
    //
    // Membership of `offered` is the whole test for a fixed-product spell: it
    // is what the bank still holds, minus everything the sell guards withhold,
    // minus the spell's own product. An emptied stack leaves the bank and a
    // newly guarded one leaves the list, and both are exactly the cases that
    // must force a re-selection.
    //
    // Alchemy needs one more clause, because `chooseAlchemyItem` refuses on a
    // margin the offered list knows nothing about: an item that still exists
    // and is still unguarded can stop clearing its own sale price when a
    // modifier lapses, and going on burning it would book a loss as income.
    // Compared by id -- `readConsumableItems` returns the bank's own objects
    // and `selectedConversionItem` (altMagic.d.ts:126) need not be the same one.
    const live = safeValue(
      'skills-misc.selectedConversionItem',
      () => magic.selectedConversionItem,
    );
    const keepsCurrent =
      live !== undefined &&
      offered.some((item) => item.id === live.id) &&
      (spell.produces !== PRODUCES_GP ||
        magic.getAlchemyGP(live, spell.productionRatio) > saleValueOf(live));

    return { ...choice, keepsCurrent };
  } catch (error) {
    noteSwallowed('skills-misc.chooseSelection', error);
    return { ok: false, reason: 'the item selection could not be read' };
  }
}

/**
 * The least valuable offered item, for a spell whose product is fixed.
 *
 * Nothing about the input changes the output, so the entire cost of the cast is
 * whatever the consumed item was worth. Ties at zero are fine: an item that
 * sells for nothing is as good a candidate as any other, and the sell guards
 * have already removed everything that is scarce rather than merely cheap.
 *
 * Deliberately no profitability refusal here, unlike alchemy. The product is an
 * item plus Magic XP rather than GP, so there is no like-for-like comparison to
 * make; refusing whenever the cheapest offered item outvalues a Rune Essence
 * would make Just Learning uncastable on most banks, and picking the cheapest
 * already bounds the loss to the least valuable thing the guards will part with.
 */
function chooseCheapestItem(offered: readonly AnyItem[]): SelectionChoice {
  let best: { item: AnyItem; value: number } | null = null;
  for (const item of offered) {
    const value = saleValueOf(item);
    if (best === null || value < best.value) best = { item, value };
  }

  return best === null
    ? { ok: false, reason: 'no offered item could be priced' }
    : { ok: true, selection: { kind: 'item', item: best.item } };
}

/**
 * The offered item alchemy pays the most *over its sale price* to destroy.
 *
 * The margin over selling is the whole quantity of interest, because alchemy
 * and the shop consume the item identically: the alternative to casting is not
 * keeping the item, it is selling it. `getAlchemyGP` (altMagic.d.ts:162) is the
 * game's own modified payout for `productionRatio` (:76), so a ratio raised by
 * a modifier is accounted for without this code knowing about the modifier.
 *
 * A cast that pays no more than the shop is refused rather than merely ranked
 * last. Item Alchemy I converts at 0.4x against a shop paying 1.0x, so casting
 * it burns four runes to destroy 60% of an item's value -- and the planner
 * books the difference as income, because the GP genuinely lands. Alchemy only
 * beats selling from tier III (1.6x) upward. Break-even is refused too: the
 * runes are paid either way, so a cast has to clear the sale price to have paid
 * for itself at all.
 *
 * Checked per item rather than once for the spell, so an item-specific modifier
 * cannot make the ratio profitable for one item and be assumed for the rest.
 */
function chooseAlchemyItem(
  magic: AltMagic,
  spell: AltMagicSpell,
  offered: readonly AnyItem[],
): SelectionChoice {
  let best: { item: AnyItem; margin: number } | null = null;
  // The most-paying rejected item, kept only to make the refusal legible: an
  // operator needs the two numbers that failed the comparison, not "no".
  let nearest: { item: AnyItem; gp: number; value: number } | null = null;

  for (const item of offered) {
    const gp = magic.getAlchemyGP(item, spell.productionRatio);
    if (!Number.isFinite(gp) || gp <= 0) continue;

    const value = saleValueOf(item);
    if (gp <= value) {
      if (nearest === null || gp > nearest.gp) nearest = { item, gp, value };
      continue;
    }

    const margin = gp - value;
    if (best === null || margin > best.margin) best = { item, margin };
  }

  if (best !== null) return { ok: true, selection: { kind: 'item', item: best.item } };

  if (nearest === null) {
    return { ok: false, reason: `no item ${spell.name} accepts has a readable alchemy value` };
  }

  return {
    ok: false,
    reason: `${spell.name} pays less GP than selling: at ${spell.productionRatio}x its best offer, ${nearest.item.name}, alchemises for ${nearest.gp} against a sale value of ${nearest.value} — sell the item instead`,
  };
}

/** GP an item sells for, or 0 when it sells for another currency. */
function saleValueOf(item: AnyItem): number {
  try {
    const sale = item.sellsFor;
    return sale.currency === game.gp ? sale.quantity : 0;
  } catch (error) {
    noteSwallowed('skills-misc.saleValueOf', error);
    return 0;
  }
}

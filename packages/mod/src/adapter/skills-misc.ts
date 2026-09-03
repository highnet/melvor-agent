import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { readSellCandidates } from './candidates.js';
import type { GatheringProjection } from './gathering.js';
import { noteSwallowed } from './safe.js';

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

  const project = (): GatheringProjection =>
    projectFrom(skill, skill.selectedSpell === undefined ? [] : [skill.selectedSpell.id]);

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
        if (needsSelection(spell)) {
          const outcome = chooseSelection(spell);
          if (!outcome.ok) return `spell ${recipeId} cannot be cast: ${outcome.reason}`;
        }
        if (skill.isActive && skill.selectedSpell === spell) return `already casting ${recipeId}`;
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
      changed: () => skill.isActive && skill.selectedSpell === spell,
    },
    isSuspended,
  );
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
type SelectionOutcome = { ok: true; selection: SpellSelection } | { ok: false; reason: string };

/**
 * What a spell should consume, chosen from the game's own list of eligible items.
 *
 * Two shapes. Superheat consumes the ingredients of a Smithing recipe and
 * produces its bar, so the selection is a `SmithingRecipe` and the right one is
 * the bar with the best margin the character can both smith and afford.
 * Everything else -- Item Alchemy and the conversion spells -- consumes a bank
 * item, and which item is right depends on what the spell pays; see below.
 *
 * The candidates are drawn through the sell guards rather than from the raw
 * bank. Consuming an item destroys it exactly as selling does, so the reasons
 * not to sell food, ammunition, seeds, spell runes, mastery tokens or anything
 * a Township task wants apply here unchanged. Reusing the filter means a guard
 * added for one path protects both, instead of the two drifting until the newer
 * one burns the larder.
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

      for (const recipe of game.smithing.actions.allObjects) {
        try {
          if (recipe.level > game.smithing.level) continue;
          if (!game.smithing.isMasteryActionUnlocked(recipe)) continue;

          const useCoal = spell.specialCost.type === CONSUMES_BAR_INGREDIENTS_WITH_COAL;
          if (!magic.getSuperheatBarCosts(recipe, useCoal, 1).checkIfOwned()) continue;

          const net = saleValueOf(recipe.product);
          if (best === null || net > best.net) best = { recipe, net };
        } catch (error) {
          noteSwallowed('skills-misc.chooseSelection', error);
          // A recipe that will not price itself is not selected.
        }
      }

      return best === null
        ? { ok: false, reason: 'no smithable bar has its ingredients in the bank' }
        : { ok: true, selection: { kind: 'bar', recipe: best.recipe } };
    }

    // Everything else consumes a bank item the game will name for us.
    // `getSpellItemSelection` (altMagic.d.ts:139) returns exactly what this
    // spell accepts, so eligibility is never guessed at.
    const eligible = new Set(magic.getSpellItemSelection(spell).map((item) => item.id));
    if (eligible.size === 0) {
      return { ok: false, reason: `nothing ${spell.name} accepts is in the bank` };
    }

    const offered: AnyItem[] = [];
    for (const option of readSellCandidates()) {
      const itemId = String((option.params as { itemId?: unknown }).itemId ?? '');
      if (!eligible.has(itemId)) continue;

      const item = game.items.getObjectByID(itemId);
      if (item !== undefined) offered.push(item);
    }

    if (offered.length === 0) {
      return {
        ok: false,
        reason: `every item ${spell.name} accepts is withheld by a sell guard — food under the reserve, ammunition, seeds, runes a castable spell needs, mastery tokens, what a Township task wants, or a locked stack`,
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
    return spell.produces === PRODUCES_GP
      ? chooseAlchemyItem(magic, spell, offered)
      : chooseCheapestItem(offered);
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
function chooseCheapestItem(offered: readonly AnyItem[]): SelectionOutcome {
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
): SelectionOutcome {
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

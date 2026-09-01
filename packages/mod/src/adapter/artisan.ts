import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { affordableAlternative, affordableNonShardItem } from './candidates.js';
import type { GatheringProjection } from './gathering.js';

/**
 * The six skills that inherit `ArtisanSkill`.
 *
 * Unlike the gathering skills, these genuinely do share one API — `ArtisanSkill`
 * defines `selectRecipeOnClick`, `selectedRecipe`, `createButtonOnClick` and
 * `getRecipeCosts` for all of them — so one verified routine covers all six.
 * This is a real shared base class in the game's own hierarchy, not an
 * abstraction invented here.
 */
export const ARTISAN_SKILL_IDS = [
  'melvorD:Smithing',
  'melvorD:Crafting',
  'melvorD:Fletching',
  'melvorD:Herblore',
  'melvorD:Runecrafting',
  'melvorD:Summoning',
] as const;

export type ArtisanSkillId = (typeof ARTISAN_SKILL_IDS)[number];

/** Whether an id names one of the artisan skills. */
export function isArtisanSkill(skillId: string): skillId is ArtisanSkillId {
  return (ARTISAN_SKILL_IDS as readonly string[]).includes(skillId);
}

/**
 * The minimal shape of `ArtisanSkill` this module relies on.
 *
 * Declared structurally rather than importing the ambient generic, whose type
 * parameters differ per skill and would force a cast at every call site.
 */
interface ArtisanLike {
  id: string;
  name: string;
  isActive: boolean;
  canStop: boolean;
  selectedRecipe?: { id: string };
  actions: { getObjectByID(id: string): { id: string; level: number } | undefined };
  isMasteryActionUnlocked(recipe: object): boolean;
  getRecipeCosts(recipe: object): { checkIfOwned(): boolean };
  /** Present on skills whose recipes accept alternative inputs, e.g. Fletching. */
  setAltRecipes?: Map<object, number>;
  /** Summoning's equivalent: which secondary material a tablet is made from. */
  selectedNonShardCosts?: Map<object, AnyItem>;
  selectRecipeOnClick(recipe: object): void;
  createButtonOnClick(): void;
  stop(): boolean;
}

/**
 * Resolves a skill instance, or null when the game does not have it.
 *
 * The null check matters: several skill properties on `Game` are optional in
 * the typings (expansion content), and a future game version could drop or
 * rename any of them. Without it, a missing skill surfaces as a
 * `TypeError: cannot read 'actions' of undefined` from deep inside an adapter
 * call instead of an honest refusal.
 */
function artisanSkill(skillId: string): ArtisanLike | null {
  const instance = ((): unknown => {
    switch (skillId) {
      case 'melvorD:Smithing':
        return game.smithing;
      case 'melvorD:Crafting':
        return game.crafting;
      case 'melvorD:Fletching':
        return game.fletching;
      case 'melvorD:Herblore':
        return game.herblore;
      case 'melvorD:Runecrafting':
        return game.runecrafting;
      case 'melvorD:Summoning':
        return game.summoning;
      default:
        return undefined;
    }
  })();

  return instance === undefined || instance === null ? null : (instance as ArtisanLike);
}

function project(skill: ArtisanLike): GatheringProjection {
  const selected = skill.selectedRecipe;
  return {
    skillId: skill.id,
    active: skill.isActive,
    selected: selected === undefined ? [] : [selected.id],
    activeActionId: game.activeAction?.id ?? null,
  };
}

/**
 * Starts an artisan skill on a specific recipe.
 *
 * Same composite shape as gathering, for the same reason: `selectRecipeOnClick`
 * and `createButtonOnClick` are UI click handlers with undocumented side
 * effects, so the post-condition — this skill is ticking on this recipe — is
 * what gets verified rather than either individual step.
 *
 * The materials check is the interesting precondition here and has no analogue
 * in gathering: `Costs.checkIfOwned()` asks the game whether the player can
 * actually afford the recipe. Without it the agent would press Create against
 * an empty bank forever, which is exactly the "grinds into a wall" failure the
 * budget system exists to catch late and this catches immediately.
 *
 * @param skillId - One of {@link ARTISAN_SKILL_IDS}.
 * @param recipeId - The recipe to produce.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the skill is now producing that recipe.
 */
export function startArtisan(
  skillId: string,
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = artisanSkill(skillId);
  if (skill === null) {
    return fail(
      'artisan.start',
      'precondition',
      `${skillId} is not an artisan skill, or is absent from this game version`,
    );
  }

  const recipe = skill.actions.getObjectByID(recipeId);
  if (recipe === undefined) {
    return fail(
      `${skill.name}.craft`,
      'precondition',
      `no recipe registered with id ${recipeId} for ${skillId}`,
    );
  }

  return act(
    {
      name: `${skill.name}.craft`,
      observe: () => project(skill),
      precondition: () => {
        if (!skill.isMasteryActionUnlocked(recipe)) {
          return `recipe ${recipeId} is locked (needs level ${recipe.level})`;
        }
        // Ask the game whether the materials are actually there, rather than
        // reimplementing the cost calculation. A recipe with alternative inputs
        // is priced against the *selected* alternative, so one the character
        // can plainly make reads as unaffordable until the right one is chosen.
        if (
          !skill.getRecipeCosts(recipe).checkIfOwned() &&
          affordableAlternative(recipe) === null &&
          affordableNonShardItem(recipe) === null
        ) {
          return `missing materials for ${recipeId}`;
        }
        const current = project(skill);
        if (current.active && current.selected.includes(recipeId)) {
          return `already crafting ${recipeId}`;
        }
        const active = game.activeAction;
        if (active !== undefined && active.id !== skillId) {
          return `another action is running: ${active.id}`;
        }
        return null;
      },
      perform: () => {
        // Point the recipe at inputs the bank actually holds before starting.
        // Without this the skill starts against a material it does not have and
        // stops immediately, which reads as a mysterious no-op.
        const alternative = affordableAlternative(recipe);
        if (alternative !== null && typeof skill.setAltRecipes?.set === 'function') {
          skill.setAltRecipes.set(recipe, alternative);
        }

        // Summoning's equivalent: pick a secondary material actually held.
        const nonShard = affordableNonShardItem(recipe);
        if (nonShard !== null && typeof skill.selectedNonShardCosts?.set === 'function') {
          skill.selectedNonShardCosts.set(recipe, nonShard);
        }

        if (skill.selectedRecipe?.id !== recipeId) {
          skill.selectRecipeOnClick(recipe);
        }
        // Whether selecting also starts is undocumented, so Create is pressed
        // only if the skill is not already ticking.
        if (!skill.isActive) skill.createButtonOnClick();
        return undefined;
      },
      changed: (_before, after) => after.active && after.selected.includes(recipeId),
    },
    isSuspended,
  );
}

/**
 * Stops an artisan skill.
 *
 * @param skillId - One of {@link ARTISAN_SKILL_IDS}.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the skill left the active state.
 */
export function stopArtisan(
  skillId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = artisanSkill(skillId);
  if (skill === null) {
    return fail('artisan.stop', 'precondition', `${skillId} is not an artisan skill`);
  }

  return act(
    {
      name: `${skill.name}.stop`,
      observe: () => project(skill),
      precondition: () => {
        if (!skill.isActive) return `${skillId} is not active`;
        if (!skill.canStop) return `${skillId} reports it cannot stop right now`;
        return null;
      },
      perform: () => skill.stop(),
      changed: (before, after) => before.active && !after.active,
    },
    isSuspended,
  );
}

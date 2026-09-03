/**
 * What the character is *actually doing* — down to the recipe.
 *
 * Knowing that Woodcutting is running is not enough to decide anything: an
 * agent told to cut Willow while it is cutting Oak sees "Woodcutting is active"
 * and idles forever, which is exactly what happened live — the objective was
 * accepted and the character kept cutting the wrong tree for hours. The
 * transition this project exists to perform was invisible to the tier that had
 * to decide on it.
 *
 * There is no shared accessor for this. Every skill names its selection
 * differently, so this is a small verified table: one read per skill, each
 * checked against the typings, each guarded because these getters throw when
 * nothing is selected rather than returning undefined.
 */

import { safeValue } from './safe.js';

/** Ids of the actions the given skill currently has selected. */
function activeRecipesFor(skillId: string): string[] {
  switch (skillId) {
    // Woodcutting is the only skill that runs several actions at once.
    case 'melvorD:Woodcutting':
      return [
        ...(safeValue('active.woodcuttingTrees', () => game.woodcutting.activeTrees) ?? []),
      ].map((tree) => tree.id);

    case 'melvorD:Mining': {
      const rock =
        safeValue('active.miningRock', () => game.mining.activeRock) ??
        safeValue('active.miningSelectedRock', () => game.mining.selectedRock);
      return rock === undefined ? [] : [rock.id];
    }

    case 'melvorD:Fishing': {
      const fish = safeValue('active.fishingFish', () => game.fishing.activeFish);
      return fish === undefined ? [] : [fish.id];
    }

    case 'melvorD:Thieving': {
      const npc = safeValue('active.thievingNPC', () => game.thieving.currentNPC);
      return npc === undefined ? [] : [npc.id];
    }

    case 'melvorD:Astrology': {
      const constellation =
        safeValue('active.astrologyConstellation', () => game.astrology.activeConstellation) ??
        safeValue('active.astrologyStudied', () => game.astrology.studiedConstellation);
      return constellation === undefined ? [] : [constellation.id];
    }

    case 'melvorD:Agility': {
      const obstacle = safeValue('active.agilityObstacle', () => game.agility.activeObstacle);
      return obstacle === undefined ? [] : [obstacle.id];
    }

    // Alt Magic is registered under `melvorD:Magic` and names its selection
    // `selectedSpell` (altMagic.d.ts:121), not `activeRecipe` -- it extends
    // CraftingSkill but never gained that field. Without this case it fell to
    // the artisan `default` below, read undefined, and returned []. The caller
    // documents "cannot tell" as "not the one I want", so the policy stopped
    // and recast the spell every single tick: the live log was
    // `altMagic.cast ok` / `melvorD:Magic.stop ok` alternating every two
    // seconds, indefinitely, for zero XP. Every cast was accepted and every
    // stop verified, so nothing above the adapter could see it as anything but
    // work -- the same shape as the Agility restart loop.
    //
    // `selectedSpell` rather than `activeSpell` (:122): the latter is a bare
    // getter with no `?`, so it is the one that throws when nothing is chosen,
    // which is the state this is read in most often.
    case 'melvorD:Magic': {
      const spell = safeValue('active.altMagicSpell', () => game.altMagic.selectedSpell);
      return spell === undefined ? [] : [spell.id];
    }

    case 'melvorItA:Harvesting': {
      // Harvesting only exists with the Into the Abyss expansion installed.
      const vein = safeValue('active.harvestingVein', () => game.harvesting?.activeVein);
      return vein === undefined ? [] : [vein.id];
    }

    case 'melvorD:Cooking': {
      const recipe = safeValue('active.cookingRecipe', () => game.cooking.activeRecipe);
      return recipe === undefined ? [] : [recipe.id];
    }

    // Every artisan skill inherits `activeRecipe` from ArtisanSkill, so one
    // branch covers Smithing, Crafting, Fletching, Herblore, Runecrafting,
    // Summoning and Firemaking.
    default: {
      const skill = game.skills.getObjectByID(skillId) as
        | (AnySkill & { activeRecipe?: { id: string } })
        | undefined;
      const recipe = safeValue('active.artisanRecipe', () => skill?.activeRecipe);
      return recipe === undefined ? [] : [recipe.id];
    }
  }
}

/**
 * The recipes the active skill is running.
 *
 * Empty when nothing is active, and also when the skill's selection could not
 * be read — the caller treats "cannot tell" the same as "not the one I want",
 * which restarts the action. Restarting the right recipe is cheap; running the
 * wrong one for an hour is not.
 */
export function readActiveRecipeIds(): string[] {
  const active = game.activeAction;
  if (active === undefined) return [];
  return activeRecipesFor(active.id);
}

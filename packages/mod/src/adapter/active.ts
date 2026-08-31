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

/** Reads a value that may throw when the skill has nothing selected. */
function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/** Ids of the actions the given skill currently has selected. */
function activeRecipesFor(skillId: string): string[] {
  switch (skillId) {
    // Woodcutting is the only skill that runs several actions at once.
    case 'melvorD:Woodcutting':
      return [...(safely(() => game.woodcutting.activeTrees) ?? [])].map((tree) => tree.id);

    case 'melvorD:Mining': {
      const rock = safely(() => game.mining.activeRock) ?? safely(() => game.mining.selectedRock);
      return rock === undefined ? [] : [rock.id];
    }

    case 'melvorD:Fishing': {
      const fish = safely(() => game.fishing.activeFish);
      return fish === undefined ? [] : [fish.id];
    }

    case 'melvorD:Thieving': {
      const npc = safely(() => game.thieving.currentNPC);
      return npc === undefined ? [] : [npc.id];
    }

    case 'melvorD:Astrology': {
      const constellation =
        safely(() => game.astrology.activeConstellation) ??
        safely(() => game.astrology.studiedConstellation);
      return constellation === undefined ? [] : [constellation.id];
    }

    case 'melvorD:Agility': {
      const obstacle = safely(() => game.agility.activeObstacle);
      return obstacle === undefined ? [] : [obstacle.id];
    }

    case 'melvorItA:Harvesting': {
      // Harvesting only exists with the Into the Abyss expansion installed.
      const vein = safely(() => game.harvesting?.activeVein);
      return vein === undefined ? [] : [vein.id];
    }

    case 'melvorD:Cooking': {
      const recipe = safely(() => game.cooking.activeRecipe);
      return recipe === undefined ? [] : [recipe.id];
    }

    // Every artisan skill inherits `activeRecipe` from ArtisanSkill, so one
    // branch covers Smithing, Crafting, Fletching, Herblore, Runecrafting,
    // Summoning and Firemaking.
    default: {
      const skill = game.skills.getObjectByID(skillId) as
        | (AnySkill & { activeRecipe?: { id: string } })
        | undefined;
      const recipe = safely(() => skill?.activeRecipe);
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

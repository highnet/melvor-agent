import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

export const FARMING_ID = 'melvorD:Farming';

/**
 * `FarmingPlotState` values, inlined as numbers.
 *
 * The enum is an ambient `const enum`, which cannot be referenced under
 * `isolatedModules` — the same constraint that forced realm ids to be literals.
 */
const PLOT_LOCKED = 0;
const PLOT_EMPTY = 1;
const PLOT_GROWING = 2;
const PLOT_GROWN = 3;
const PLOT_DEAD = 4;

export interface FarmPlotState {
  id: string;
  /** `locked` | `empty` | `growing` | `grown` | `dead`. */
  state: 'locked' | 'empty' | 'growing' | 'grown' | 'dead';
  plantedRecipeId: string | null;
  plantedName: string | null;
  categoryId: string;
}

function describeState(state: number): FarmPlotState['state'] {
  switch (state) {
    case PLOT_LOCKED:
      return 'locked';
    case PLOT_EMPTY:
      return 'empty';
    case PLOT_GROWING:
      return 'growing';
    case PLOT_GROWN:
      return 'grown';
    case PLOT_DEAD:
      return 'dead';
    default:
      // An unrecognised state is treated as unusable rather than guessed at.
      return 'locked';
  }
}

/**
 * Reads every farming plot.
 *
 * Farming is the clearest case of the transitions this agent exists for: a plot
 * is planted, ignored for a long time, then harvested and replanted. The game's
 * offline progress grows the crops but never replants them, so an unattended
 * player loses every cycle after the first.
 *
 * @returns One entry per plot, including locked ones so the planner can see
 *          what capacity exists rather than only what is usable.
 */
export function readFarmPlots(): FarmPlotState[] {
  return game.farming.plots.allObjects.map((plot) => ({
    id: plot.id,
    state: describeState(plot.state),
    plantedRecipeId: plot.plantedRecipe?.id ?? null,
    plantedName: plot.plantedRecipe?.name ?? null,
    categoryId: plot.category.id,
  }));
}

/** Projection for a single plot: what harvesting or planting should change. */
function projectPlot(plotId: string): { state: string; recipeId: string | null } {
  const plot = game.farming.plots.getObjectByID(plotId);
  return {
    state: plot === undefined ? 'missing' : describeState(plot.state),
    recipeId: plot?.plantedRecipe?.id ?? null,
  };
}

/**
 * Harvests one plot.
 *
 * `harvestPlot` returns a boolean, but a `true` return does not prove the plot
 * actually emptied, so the state transition is what is verified. Dead crops are
 * harvested too — that is how the plot is cleared for replanting.
 *
 * @param plotId - Namespaced `FarmingPlot` id.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the plot left the grown/dead state.
 */
export function harvestFarmPlot(
  plotId: string,
  isSuspended: () => boolean,
): ActionResult<{ state: string; recipeId: string | null }> {
  const plot = game.farming.plots.getObjectByID(plotId);
  if (plot === undefined) {
    return fail('farming.harvest', 'precondition', `no farming plot registered as ${plotId}`);
  }

  return act(
    {
      name: 'farming.harvest',
      observe: () => projectPlot(plotId),
      precondition: () => {
        const state = describeState(plot.state);
        if (state !== 'grown' && state !== 'dead') {
          return `plot ${plotId} is ${state}; only grown or dead plots can be harvested`;
        }
        return null;
      },
      perform: () => game.farming.harvestPlot(plot),
      changed: (before, after) =>
        (before.state === 'grown' || before.state === 'dead') && after.state !== before.state,
    },
    isSuspended,
  );
}

/**
 * Plants a seed in one plot.
 *
 * `plantPlot` returns a number rather than a boolean, and what that number
 * means is not documented in the typings — another reason the observed state
 * change is the verdict rather than the return value.
 *
 * @param plotId - Namespaced `FarmingPlot` id.
 * @param recipeId - Namespaced `FarmingRecipe` id, i.e. the seed.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the plot became `growing` with that recipe.
 */
export function plantFarmPlot(
  plotId: string,
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<{ state: string; recipeId: string | null }> {
  const plot = game.farming.plots.getObjectByID(plotId);
  if (plot === undefined) {
    return fail('farming.plant', 'precondition', `no farming plot registered as ${plotId}`);
  }

  const recipe = game.farming.actions.getObjectByID(recipeId);
  if (recipe === undefined) {
    return fail('farming.plant', 'precondition', `no farming recipe registered as ${recipeId}`);
  }

  return act(
    {
      name: 'farming.plant',
      observe: () => projectPlot(plotId),
      precondition: () => {
        const state = describeState(plot.state);
        if (state !== 'empty') return `plot ${plotId} is ${state}, not empty`;
        if (game.farming.level < recipe.level) {
          return `Farming level ${game.farming.level} is below ${recipe.level} for ${recipeId}`;
        }
        if (recipe.category !== plot.category) {
          return `${recipeId} is a ${recipe.category.id} crop; plot ${plotId} is ${plot.category.id}`;
        }
        const seed = recipe.seedCost;
        const held = game.bank.getQty(seed.item);
        if (held < seed.quantity) {
          return `need ${seed.quantity}x ${seed.item.name}, hold ${held}`;
        }
        return null;
      },
      perform: () => game.farming.plantPlot(plot, recipe),
      changed: (before, after) =>
        before.state === 'empty' && after.state === 'growing' && after.recipeId === recipeId,
    },
    isSuspended,
  );
}

/**
 * Seeds that could be planted right now, best XP first.
 *
 * Only seeds actually held in the bank are offered — an unplantable seed is a
 * planner trap, not a choice.
 */
export function readPlantableSeeds(): {
  recipeId: string;
  name: string;
  categoryId: string;
  level: number;
  xp: number;
  seedsHeld: number;
}[] {
  return game.farming.actions.allObjects
    .filter((recipe) => game.farming.level >= recipe.level)
    .map((recipe) => ({
      recipeId: recipe.id,
      name: recipe.name,
      categoryId: recipe.category.id,
      level: recipe.level,
      xp: recipe.baseExperience,
      seedsHeld: game.bank.getQty(recipe.seedCost.item),
    }))
    .filter((entry) => entry.seedsHeld > 0)
    .sort((a, b) => b.xp - a.xp);
}

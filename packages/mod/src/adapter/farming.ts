import type { ActionResult, Candidate } from '@melvor-agent/shared';
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
  /** Whether a locked plot can be bought right now. */
  canUnlock: boolean;
  /** Percent compost applied; 0 means the crop has a 50% chance to die. */
  compostLevel: number;
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
    // Only meaningful while locked, and cheap enough to always ask.
    canUnlock: plot.state === PLOT_LOCKED && game.farming.canUnlockPlot(plot),
    compostLevel: plot.compostLevel,
  }));
}

/**
 * Buys a locked plot.
 *
 * Every farming plot starts locked, including the first, and a locked plot can
 * never be planted. The agent held sixteen allotment seeds and Farming level 1
 * for a full day while the farm reported "no empty plots" — the capability to
 * open a plot simply did not exist, so Farming was unreachable no matter what
 * else was fixed.
 *
 * `unlockPlotOnClick` returns void, so the state leaving `locked` is the
 * evidence rather than any return value.
 *
 * @param plotId - Namespaced `FarmingPlot` id.
 */
export function unlockFarmPlot(
  plotId: string,
  isSuspended: () => boolean,
): ActionResult<{ state: string; recipeId: string | null }> {
  const plot = game.farming.plots.getObjectByID(plotId);
  if (plot === undefined) {
    return fail('farming.unlock', 'precondition', `no farming plot registered as ${plotId}`);
  }

  return act(
    {
      name: 'farming.unlock',
      observe: () => projectPlot(plotId),
      precondition: () => {
        if (plot.state !== PLOT_LOCKED) return `plot ${plotId} is already unlocked`;
        // Asking the game rather than pricing it here: the costs are a `Costs`
        // object covering currencies and items, and re-deriving affordability
        // would be inventing a second source of truth.
        if (!game.farming.canUnlockPlot(plot)) {
          return `plot ${plotId} cannot be unlocked yet (level or cost not met)`;
        }
        return null;
      },
      perform: () => game.farming.unlockPlotOnClick(plot),
      changed: (before, after) => before.state === 'locked' && after.state !== 'locked',
    },
    isSuspended,
  );
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
  /** Seeds consumed per plot. Three for an allotment, not one. */
  seedCost: number;
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
      seedCost: recipe.seedCost.quantity,
    }))
    .filter((entry) => entry.seedsHeld > 0)
    .sort((a, b) => b.xp - a.xp);
}

/**
 * Every seed the farm can ever plant, at any level.
 *
 * Deliberately unfiltered by level, which is the whole point. Seeds for crops
 * the character cannot plant yet are not surplus — they are exactly the stock
 * that becomes useful as Farming rises, and the sell list was offering 32
 * Ancient Corn Seeds and 30 Ancient Carrot Seeds while Farming sat at level 1
 * blocking the only untrained skill left in scope.
 *
 * A seed is worth a few GP and a harvest is worth Farming XP, which is the
 * scarce thing here; there is no bank balance at which that trade is correct.
 * Selling seeds is not a judgement the planner should be offered.
 */
export function readAllSeedIds(): Set<string> {
  const seeds = new Set<string>();
  for (const recipe of game.farming.actions.allObjects) {
    try {
      seeds.add(recipe.seedCost.item.id);
    } catch {
      // A recipe with no readable seed cost is skipped rather than throwing:
      // failing to protect one seed beats failing to build the sell list.
    }
  }
  return seeds;
}

/**
 * Ingredients the character holds barely enough of to use once.
 *
 * Scarcity is the signal. Two Garum Seeds were nearly sold as part of a batch
 * meant for Oak Logs — the list had reordered between the listing and the plan
 * — and they are the only herb seeds obtained in a full session, the entire
 * basis of the Herblore chain, and a Garum Herb planting costs exactly two.
 *
 * The drift guard caught that one, and it catches several an hour; it only
 * takes a single gap for something irreplaceable to go. This is the cheaper
 * belt: an item that is a recipe input and is held at or below a single
 * craft's worth is not offered for sale at all.
 *
 * Deliberately narrow. Hold three of something that costs two and it is
 * sellable again, because then it is stock rather than the last of a kind.
 */
export function readBarelyEnoughIngredientIds(): Set<string> {
  const scarce = new Set<string>();

  const consider = (itemId: string, cost: number, held: number): void => {
    if (cost > 0 && held > 0 && held <= cost) scarce.add(itemId);
  };

  try {
    for (const recipe of game.farming.actions.allObjects) {
      const seed = recipe.seedCost;
      consider(seed.item.id, seed.quantity, game.bank.getQty(seed.item));
    }
  } catch {
    // A skill that cannot report its recipes protects nothing.
  }

  try {
    for (const recipe of game.herblore.actions.allObjects) {
      for (const cost of recipe.itemCosts) {
        consider(cost.item.id, cost.quantity, game.bank.getQty(cost.item));
      }
    }
  } catch {
    // Same.
  }

  return scarce;
}

/** The cheapest compost actually held, or null when there is none. */
export function readHeldCompost(): { itemId: string; held: number } | null {
  const compost = game.farming.composts.allObjects.find((item) => game.bank.getQty(item) > 0);
  if (compost === undefined) return null;

  return { itemId: compost.id, held: game.bank.getQty(compost) };
}

/**
 * Applies compost to a plot.
 *
 * Compost raises the harvest yield and, more importantly, stops crops dying —
 * a dead plot is the whole growth cycle wasted, and an unattended agent is
 * exactly who cannot notice one. Buying compost and never applying it, which
 * is what the shop capability alone allowed, is strictly worse than not buying
 * it.
 *
 * `compostPlot` returns a boolean, so the plot's compost level is observed
 * either side instead.
 *
 * @param plotId - Namespaced `FarmingPlot` id.
 * @param compostId - Namespaced `CompostItem` id, already in the bank.
 * @param amount - How many to apply; the game caps the level at 100.
 */
export function compostFarmPlot(
  plotId: string,
  compostId: string,
  amount: number,
  isSuspended: () => boolean,
): ActionResult<{ plotId: string; compostLevel: number }> {
  const farming = game.farming;
  const plot = farming.plots.getObjectByID(plotId);
  if (plot === undefined) {
    return fail('farming.compost', 'precondition', `no farming plot ${plotId}`);
  }

  const compost = farming.composts.getObjectByID(compostId);
  if (compost === undefined) {
    return fail('farming.compost', 'precondition', `no compost item ${compostId}`);
  }

  const project = (): { plotId: string; compostLevel: number } => ({
    plotId,
    compostLevel: plot.compostLevel,
  });

  return act(
    {
      name: 'farming.compost',
      observe: project,
      precondition: () => {
        if (plot.compostLevel >= 100) return `plot ${plotId} is already fully composted`;
        if (game.bank.getQty(compost) <= 0) return `bank holds no ${compostId}`;
        if (!Number.isInteger(amount) || amount <= 0) {
          return `amount must be a positive integer, got ${amount}`;
        }
        return null;
      },
      perform: () => farming.compostPlot(plot, compost, amount),
      changed: (before, after) => after.compostLevel > before.compostLevel,
    },
    isSuspended,
  );
}

/**
 * Plots worth composting.
 *
 * Only planted, uncomposted plots: composting an empty plot is not wrong, but
 * it is worth nothing until something is growing in it, and the compost is
 * consumed either way.
 */
export function readCompostCandidates(): Candidate[] {
  const farming = game.farming;
  const candidates: Candidate[] = [];

  const affordable = farming.composts.allObjects.find((item) => game.bank.getQty(item) > 0);
  if (affordable === undefined) return [];

  for (const plot of farming.plots.allObjects) {
    try {
      // Ambient const enums are unavailable under verbatimModuleSyntax, so
      // the shared string mapping is the honest way to ask this question.
      //
      // Empty plots count, and matter more than growing ones: compost applied
      // before the seed goes in protects the whole cycle, and the game's own
      // plot UI offers it exactly there.
      const state = describeState(plot.state);
      if (state !== 'growing' && state !== 'empty') continue;
      if (plot.compostLevel >= 100) continue;

      candidates.push({
        kind: 'compost_plot',
        params: {
          kind: 'compost_plot',
          plotId: plot.id,
          compostId: affordable.id,
          amount: Math.min(5, game.bank.getQty(affordable)),
        },
        label: `Compost ${plot.plantedRecipe?.name ?? 'the crop'} in ${plot.id} with ${affordable.name} (${plot.compostLevel}% — protects against the crop dying)`,
        available: true,
      });
    } catch {
      // A plot that cannot report its state is not a candidate.
    }
  }

  return candidates;
}

/**
 * Farming work that is ready now.
 *
 * Farming is the clearest "transitions, not uptime" skill in the game: a plot
 * is planted, ignored for twenty minutes, and then must be harvested and
 * replanted or it simply sits there. The capability existed and nothing offered
 * it, so the agent grew nothing all day.
 *
 * Grown and dead plots come first — a dead plot is a wasted cycle either way,
 * and clearing it is what allows the next planting.
 */
export function readFarmCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  let plots: FarmPlotState[];
  try {
    plots = readFarmPlots();
  } catch {
    return [];
  }

  // An unlockable plot comes first: it is a one-off that makes every later
  // harvest and planting possible, and it is cheap at the low levels.
  const unlockable = plots.filter((plot) => plot.canUnlock);
  if (unlockable.length > 0) {
    candidates.push({
      kind: 'tend_farm',
      params: { kind: 'tend_farm' },
      label: `Unlock ${unlockable.length} farm plot(s) — every plot starts locked, and a locked plot can never be planted`,
      available: true,
    });
  }

  const ready = plots.filter((plot) => plot.state === 'grown' || plot.state === 'dead');
  if (ready.length > 0) {
    candidates.push({
      kind: 'tend_farm',
      params: { kind: 'tend_farm' },
      label: `Tend the farm — ${ready.length} plot(s) ready to harvest or clear, and a plot left standing grows nothing`,
      available: true,
    });
    return candidates;
  }

  const empty = plots.filter((plot) => plot.state === 'empty');
  // `return candidates`, not `return []`: an unlock candidate may already be
  // waiting in the list, and a bare `[]` silently discarded it. With one plot
  // growing and two unlockable, the farm offered nothing at all.
  if (empty.length === 0) return candidates;

  // Only seeds there are actually enough of. An allotment takes three seeds,
  // and offering "Plant Potatoes — 2 seeds held" invites the planner to choose
  // something the game will refuse.
  //
  // This is the third instance today of asking "is any held" where the question
  // was "is there enough" — the others equipped one arrow of 1,259 and pointed
  // a Summoning recipe at a log there was nowhere near enough of.
  const plantable = readPlantableSeeds().filter((seed) => seed.seedsHeld >= seed.seedCost);

  for (const seed of plantable.slice(0, 3)) {
    candidates.push({
      kind: 'tend_farm',
      params: { kind: 'tend_farm', seedRecipeId: seed.recipeId },
      label: `Plant ${seed.name} in ${empty.length} empty plot(s) — ${seed.seedsHeld} seeds held`,
      available: true,
    });
  }

  return candidates;
}

/**
 * Seeds the character holds but not enough of to plant.
 *
 * Farming sat at level 1 for a whole session on a two-seed shortfall, and
 * nothing said so. The candidate list offered "Plant Potatoes — 2 seeds held",
 * which reads like an opportunity; the reflex correctly declined it; and the
 * only trace was a reflex warning that stopped appearing once the reflex was
 * fixed. The shortfall itself was never stated anywhere.
 *
 * It is a blocked opportunity in the exact sense the blocked list exists for: a
 * thing the character is level-unlocked for and lacks the inputs to do, with
 * the missing item named. Farming 30 gates Herblore, so this two-seed gap was
 * the last skill in scope waiting on something nobody had said out loud.
 */
export function readSeedShortfalls(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    // Only when there is somewhere to plant; a shortfall for a farm with no
    // empty plot is not what is blocking anything.
    const hasEmptyPlot = readFarmPlots().some((plot) => plot.state === 'empty');
    if (!hasEmptyPlot) return [];

    return game.farming.actions.allObjects
      .filter((recipe) => game.farming.level >= recipe.level)
      .map((recipe) => ({
        recipe,
        held: game.bank.getQty(recipe.seedCost.item),
        cost: recipe.seedCost.quantity,
      }))
      .filter((entry) => entry.held > 0 && entry.held < entry.cost)
      .map((entry) => ({
        label: `Farming: ${entry.recipe.name} needs ${entry.cost} seeds to plant one plot`,
        xpPerHour: 0,
        missing: [
          {
            itemId: entry.recipe.seedCost.item.id,
            name: entry.recipe.seedCost.item.name,
            need: entry.cost,
            have: entry.held,
          },
        ],
      }));
  } catch {
    return [];
  }
}

import { checkAbort, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyAction, PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Executes a `tend_farm` objective.
 *
 * Farming is the sharpest example of what this project exists for. The game's
 * offline progress *grows* crops but never harvests or replants them, so a
 * player who leaves for a day collects exactly one cycle and wastes the rest.
 * An agent that harvests and replants turns a single cycle into as many as the
 * elapsed time allows — value that comes entirely from the transition, not from
 * uptime.
 *
 * Order is harvest-then-plant, and deliberately so: harvesting frees plots, and
 * a plot cleared this tick becomes plantable on the next. Doing both in one
 * pass would plan the plant against a plot state the harvest has not produced yet.
 *
 * Dead crops are harvested too — that is how a failed plot is cleared.
 *
 * Farming is a *passive* skill: it does not occupy the game's single action
 * slot, so this never checks `activeAction` and never conflicts with a gathering
 * objective running alongside it.
 */
export const tendFarm: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;

  if (objective.params.kind !== 'tend_farm') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `tendFarm received params of kind ${objective.params.kind}`,
    };
  }

  const minutes = elapsedMinutes(now, objectiveStartedAt);
  const abort = checkAbort(snapshot, objective.abortWhen, minutes, deathsSinceStart);
  if (abort.abort) {
    return { kind: 'abort', outcome: abort.outcome, detail: abort.detail };
  }

  if (isObjectiveComplete(snapshot, objective.successWhen)) {
    return { kind: 'complete', detail: `all ${objective.successWhen.length} criteria met` };
  }

  if (snapshot.isOfflineLoop) {
    return {
      kind: 'idle',
      reason: 'waiting_for_game',
      detail: 'offline progress is still resolving',
    };
  }

  const plots = snapshot.farm;
  if (plots.length === 0) {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: 'no farming plots exist in this save',
    };
  }

  // Unlocking comes before everything. Every plot starts locked, so a farm that
  // has never been opened reports no empty plots and no ready plots, and the
  // executor would idle forever on a skill it is perfectly able to train.
  const unlockable = plots.filter((plot) => plot.canUnlock);
  if (unlockable.length > 0) {
    return {
      kind: 'act',
      actions: unlockable.map((plot): PolicyAction => ({ type: 'unlock_plot', plotId: plot.id })),
      reason: `unlocking ${unlockable.length} farm plot(s)`,
    };
  }

  // Harvest first. Every ready plot goes in one batch: they are independent, and
  // batching means a full farm is cleared in one tick rather than one per tick.
  const ready = plots.filter((plot) => plot.state === 'grown' || plot.state === 'dead');
  if (ready.length > 0) {
    return {
      kind: 'act',
      actions: ready.map((plot): PolicyAction => ({ type: 'harvest_plot', plotId: plot.id })),
      reason: `harvesting ${ready.length} plot(s): ${ready.map((p) => p.plantedName ?? p.id).join(', ')}`,
    };
  }

  const seedRecipeId = objective.params.seedRecipeId;
  if (seedRecipeId === undefined) {
    return {
      kind: 'idle',
      reason: 'nothing_to_do',
      detail: 'no seed configured; harvesting only',
    };
  }

  const empty = plots.filter((plot) => plot.state === 'empty');
  if (empty.length > 0) {
    return {
      kind: 'act',
      actions: empty.map(
        (plot): PolicyAction => ({ type: 'plant_plot', plotId: plot.id, recipeId: seedRecipeId }),
      ),
      reason: `planting ${seedRecipeId} in ${empty.length} empty plot(s)`,
    };
  }

  const growing = plots.filter((plot) => plot.state === 'growing').length;
  return {
    kind: 'idle',
    reason: 'already_running',
    detail: `${growing} plot(s) growing; nothing to harvest or plant`,
  };
};

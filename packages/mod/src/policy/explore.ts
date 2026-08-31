import { checkAbort, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Executes the exploration objectives — surveying and excavating.
 *
 * Unlike the one-shot management actions, these are *sustained*: surveying a
 * hex and digging a site both run for as long as the game will let them, so
 * they behave like gathering and are complete only when their criteria say so.
 *
 * They cannot reuse the gathering executor, though, because neither has a
 * recipe. A hex is a position and a dig site consumes a map, so "is the right
 * thing already running" is answered differently for each, from the snapshot's
 * active action rather than from a recipe id.
 */
export const explore: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;
  const params = objective.params;

  if (
    params.kind !== 'survey_hex' &&
    params.kind !== 'excavate_dig_site' &&
    params.kind !== 'make_paper'
  ) {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `explore received params of kind ${params.kind}`,
    };
  }

  const abort = checkAbort(
    snapshot,
    objective.abortWhen,
    elapsedMinutes(now, objectiveStartedAt),
    deathsSinceStart,
  );
  if (abort.abort) return { kind: 'abort', outcome: abort.outcome, detail: abort.detail };

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

  const active = snapshot.activeAction;

  if (params.kind === 'survey_hex') {
    if (active !== null && active.id === 'melvorAoD:Cartography') {
      // Which hex is being surveyed is not worth re-deciding every tick: the
      // adapter picked the best one from live geometry when it started, and
      // interrupting a partly surveyed hex throws that progress away.
      return {
        kind: 'idle',
        reason: 'already_running',
        detail: 'already surveying',
      };
    }

    return {
      kind: 'act',
      actions: [{ type: 'survey_hex' }],
      reason: 'surveying the best hex in range',
    };
  }

  if (params.kind === 'make_paper') {
    // Paper making is Cartography's other action, so "already surveying" and
    // "already making paper" are the same skill holding the slot; only the
    // recipe distinguishes them.
    if (active !== null && active.id === 'melvorAoD:Cartography') {
      return {
        kind: 'idle',
        reason: 'already_running',
        detail: 'Cartography already holds the action slot',
      };
    }

    return {
      kind: 'act',
      actions: [{ type: 'make_paper', recipeId: params.recipeId }],
      reason: `making ${params.recipeId}`,
    };
  }

  if (active !== null && active.id === 'melvorAoD:Archaeology') {
    return {
      kind: 'idle',
      reason: 'already_running',
      detail: `already excavating (${active.recipeIds.join(', ') || 'site unknown'})`,
    };
  }

  return {
    kind: 'act',
    actions: [{ type: 'excavate_dig_site', digSiteId: params.digSiteId }],
    reason: `excavating ${params.digSiteId}`,
  };
};

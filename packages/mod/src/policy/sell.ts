import { bankQuantity, checkAbort, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Executes a `sell_items` objective.
 *
 * This is the first real *transition*: it converts accumulated resources into
 * currency, which is the kind of decision the game's own offline progress
 * cannot make. The whole project exists for these, not for uptime.
 *
 * Same ordering discipline as gathering — abort, then success, then act — for
 * the same reason: an objective that has blown its budget must not get one more
 * tick of work.
 *
 * Only the surplus above `keepQuantity` is offered for sale, so an objective
 * that wants to keep a working stock says so once rather than the policy layer
 * guessing at it each tick.
 */
export const sellItems: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;

  if (objective.params.kind !== 'sell_items') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `sellItems received params of kind ${objective.params.kind}`,
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

  const { itemId, keepQuantity } = objective.params;
  const held = bankQuantity(snapshot, itemId);
  const surplus = held - keepQuantity;

  if (surplus <= 0) {
    // Not an abort: the objective's success criteria may still be reachable by
    // some other means, and the budget will end it if they are not.
    return {
      kind: 'idle',
      reason: 'nothing_to_do',
      detail: `holding ${held} of ${itemId}, keeping ${keepQuantity} — nothing to sell`,
    };
  }

  return {
    kind: 'act',
    actions: [{ type: 'sell', itemId, quantity: surplus }],
    reason: `selling ${surplus} of ${itemId}, keeping ${keepQuantity}`,
  };
};

import { checkAbort, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Executes an `equip_item` or `equip_food` objective.
 *
 * Equipping is a one-shot transition rather than a grind: there is no rate and
 * no level to reach, so the objective is complete the moment the item is worn.
 * Success is therefore read from the snapshot rather than from a criterion the
 * planner had to invent.
 */
export const equipGear: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;
  const params = objective.params;

  if (params.kind !== 'equip_item' && params.kind !== 'equip_food') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `equipGear received params of kind ${params.kind}`,
    };
  }

  const abort = checkAbort(
    snapshot,
    objective.abortWhen,
    elapsedMinutes(now, objectiveStartedAt),
    deathsSinceStart,
  );
  if (abort.abort) return { kind: 'abort', outcome: abort.outcome, detail: abort.detail };

  if (snapshot.isOfflineLoop) {
    return {
      kind: 'idle',
      reason: 'waiting_for_game',
      detail: 'offline progress is still resolving',
    };
  }

  if (params.kind === 'equip_food') {
    const equipped = snapshot.combat.food.some(
      (slot) => slot.itemId === params.itemId && slot.qty > 0,
    );
    if (equipped) return { kind: 'complete', detail: `${params.itemId} is equipped as food` };

    return {
      kind: 'act',
      actions: [{ type: 'equip_food', itemId: params.itemId, quantity: params.quantity }],
      reason: `equipping ${params.itemId} as food`,
    };
  }

  const worn = snapshot.combat.equipment.some((slot) => slot.itemId === params.itemId);
  if (worn) return { kind: 'complete', detail: `${params.itemId} is equipped` };

  // The success criteria the planner attached still apply; an equip objective
  // that also names a level target is unusual but not illegal.
  if (isObjectiveComplete(snapshot, objective.successWhen)) {
    return { kind: 'complete', detail: 'success criteria met' };
  }

  return {
    kind: 'act',
    actions: [
      params.slotId === undefined
        ? { type: 'equip', itemId: params.itemId }
        : { type: 'equip', itemId: params.itemId, slotId: params.slotId },
    ],
    reason: `equipping ${params.itemId}`,
  };
};

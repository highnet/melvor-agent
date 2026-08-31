import { checkAbort, elapsedMinutes } from './criteria.js';
import type { PolicyAction, PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Executes the one-shot management objectives.
 *
 * Mastery spending, attack style, prayers, potions and Slayer tasks all share a
 * shape: apply a decision, observe it landed, done. There is no rate and no
 * level to reach, so completion is read from the snapshot rather than from a
 * criterion the planner had to invent — which matters, because an invented
 * criterion for a one-shot action is usually either instantly true or never
 * true, and both waste a planning cycle.
 *
 * The adapter still verifies each action properly; this tier only decides
 * *whether it is still worth doing*.
 */
export const manage: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;
  const params = objective.params;

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

  switch (params.kind) {
    case 'spend_mastery':
      // The adapter refuses on an empty pool, and the failure limit ends the
      // objective, so there is no useful snapshot check to make first: pool XP
      // is not carried in the snapshot.
      return act(
        {
          type: 'spend_mastery',
          skillId: params.skillId,
          actionId: params.actionId,
          levels: params.levels,
        },
        `spending ${params.skillId} mastery pool on ${params.actionId}`,
      );

    case 'set_attack_style':
      return act(
        { type: 'set_attack_style', attackTypeId: params.attackTypeId, styleId: params.styleId },
        `setting ${params.attackTypeId} style to ${params.styleId}`,
      );

    case 'toggle_prayer':
      return act(
        { type: 'toggle_prayer', prayerId: params.prayerId },
        `toggling prayer ${params.prayerId}`,
      );

    case 'use_potion':
      return act({ type: 'use_potion', itemId: params.itemId }, `drinking ${params.itemId}`);

    case 'new_slayer_task':
      // Taking a task while one is unfinished throws the old one away, which is
      // a real cost: partial kill progress is lost.
      if (snapshot.combat.inCombat) {
        return {
          kind: 'idle',
          reason: 'already_running',
          detail: 'in combat; not rerolling the task mid-fight',
        };
      }
      return act(
        {
          type: 'new_slayer_task',
          categoryId: params.categoryId,
          payWithCoins: params.payWithCoins,
        },
        `taking a new slayer task from ${params.categoryId}`,
      );

    default:
      return {
        kind: 'abort',
        outcome: 'failed_precondition',
        detail: `manage received params of kind ${params.kind}`,
      };
  }
};

/**
 * Emits one action and treats the objective as finished.
 *
 * A one-shot decision is complete once it has been *attempted and verified* by
 * the adapter. Leaving the objective open would make the policy tier re-issue
 * it every tick, which for a prayer toggle would flip it on and off forever.
 */
function act(action: PolicyAction, reason: string): PolicyDecision {
  return { kind: 'act', actions: [action], reason, completeAfter: true };
}

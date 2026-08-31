import { checkAbort, currencyAmount, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

const GP_CURRENCY_ID = 'melvorD:GP';

/**
 * Executes a `buy_shop_upgrade` objective.
 *
 * Shop purchases are the progression lever: Auto Eat tiers, bank slots, skill
 * upgrades. They are also the one place the agent spends rather than earns, so
 * the objective carries its own GP floor and this tier refuses to cross it.
 *
 * The floor is checked here rather than in the adapter because it is a *policy*
 * decision — how much to keep in reserve depends on what the agent plans to do
 * next, which the adapter has no view of.
 */
export const buyShopUpgrade: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;

  if (objective.params.kind !== 'buy_shop_upgrade') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `buyShopUpgrade received params of kind ${objective.params.kind}`,
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

  const { purchaseId, quantity, gpFloor } = objective.params;
  const gp = currencyAmount(snapshot, GP_CURRENCY_ID);

  if (gp <= gpFloor) {
    // Idle rather than abort: the agent may be earning, and the time budget
    // will end the objective if it never gets there.
    return {
      kind: 'idle',
      reason: 'nothing_to_do',
      detail: `GP ${gp} is at or below the objective's floor of ${gpFloor}`,
    };
  }

  // A purchase is done once it lands. Without completeAfter the objective would
  // sit here re-buying the same upgrade on every tick until its budget ran out,
  // which for a stackable purchase would empty the bank.
  return {
    kind: 'act',
    actions: [{ type: 'buy', purchaseId, quantity }],
    reason: `buying ${quantity}x ${purchaseId} with ${gp} GP (floor ${gpFloor})`,
    completeAfter: true,
  };
};

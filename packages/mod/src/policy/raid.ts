import { checkAbort, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Executes a `run_golbin_raid` objective.
 *
 * A raid is unlike every other objective: it makes no progress on its own. It
 * stops at a modal and waits, so the policy tier's job here is not "start it
 * and watch" but "keep answering it". Each tick either starts the raid or takes
 * the next decision it is stuck on.
 *
 * The raid ends by budget rather than by success criteria. There is no level to
 * reach and no item to accumulate — a run is over when it dies or when the
 * agent walks away with the coins, and walking away is what the budget means
 * here rather than a failure.
 */
export const runGolbinRaid: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;
  const params = objective.params;

  if (params.kind !== 'run_golbin_raid') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `runGolbinRaid received params of kind ${params.kind}`,
    };
  }

  const abort = checkAbort(
    snapshot,
    objective.abortWhen,
    elapsedMinutes(now, objectiveStartedAt),
    deathsSinceStart,
  );
  if (abort.abort) {
    // Leaving a raid running when the objective is over would keep the ordinary
    // game loop paused indefinitely, which costs far more than the raid earns.
    return {
      kind: 'act',
      actions: [{ type: 'stop_raid' }],
      reason: `${abort.detail}; fleeing keeps the coins earned so far`,
    };
  }

  if (isObjectiveComplete(snapshot, objective.successWhen)) {
    return { kind: 'act', actions: [{ type: 'stop_raid' }], reason: 'objective met; leaving' };
  }

  if (snapshot.isOfflineLoop) {
    return {
      kind: 'idle',
      reason: 'waiting_for_game',
      detail: 'offline progress is still resolving',
    };
  }

  // Start and advance are the same intent from here: the adapter refuses
  // whichever does not apply, and asking it is cheaper than tracking a copy of
  // the raid's state machine in a tier that cannot see the game.
  return {
    kind: 'act',
    actions: [{ type: 'advance_raid', difficulty: params.difficulty }],
    reason: 'taking the raid to its next decision',
  };
};

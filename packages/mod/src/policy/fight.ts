import { checkAbort, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * HP floor. Below this fraction of max HP, disengage at the next kill boundary.
 *
 * This is the runtime backup the brief asks for, independent of the gate and of
 * the planner. The gate proves a fight is survivable *before* it starts; this
 * catches the fight having become unsurvivable since — a potion expired, prayer
 * points ran out, gear degraded.
 */
const HP_FLOOR_FRACTION = 0.5;

/** Below this many food items, disengage: the sustain argument no longer holds. */
const FOOD_FLOOR = 5;

/**
 * Executes a `fight_monster` objective.
 *
 * This tier decides *whether to keep fighting*. It never decides whether a fight
 * is safe to start — that is `assessSurvivability`, run by the runtime against
 * fresh game data before any engage intent is performed. Splitting it this way
 * means the gate cannot be bypassed by a policy bug, and the policy cannot be
 * bypassed by a gate bug.
 *
 * Disengagement is deliberately not immediate. Combat cannot be exited cleanly
 * mid-fight, so a floor crossing is recorded and the disengage intent is emitted
 * to be taken at the next gap — taking it early is the whole point.
 */
export const fightMonster: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;

  if (objective.params.kind !== 'fight_monster') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `fightMonster received params of kind ${objective.params.kind}`,
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

  const { combat } = snapshot;

  // --- runtime backup, checked before anything else about the fight ---
  const hpFraction = combat.maxHitpoints > 0 ? combat.hitpoints / combat.maxHitpoints : 0;
  const foodRemaining = combat.food.reduce((sum, slot) => sum + slot.qty, 0);

  if (combat.inCombat) {
    if (hpFraction < HP_FLOOR_FRACTION) {
      return {
        kind: 'act',
        actions: [{ type: 'disengage' }],
        reason: `HP ${(hpFraction * 100).toFixed(0)}% below floor ${HP_FLOOR_FRACTION * 100}%; disengaging`,
      };
    }
    if (foodRemaining < FOOD_FLOOR) {
      return {
        kind: 'act',
        actions: [{ type: 'disengage' }],
        reason: `food down to ${foodRemaining}; the sustain argument no longer holds`,
      };
    }
    return {
      kind: 'idle',
      reason: 'already_running',
      detail: `fighting, HP ${(hpFraction * 100).toFixed(0)}%, food ${foodRemaining}`,
    };
  }

  const active = snapshot.activeAction;
  if (active !== null) {
    return {
      kind: 'idle',
      reason: 'nothing_to_do',
      detail: `${active.name} holds the active action slot`,
    };
  }

  const { monsterId, areaId } = objective.params;
  return {
    kind: 'act',
    actions: [{ type: 'engage', monsterId, areaId }],
    reason: `engaging ${monsterId} in ${areaId}`,
  };
};

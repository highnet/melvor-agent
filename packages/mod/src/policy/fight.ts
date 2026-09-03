import { COMBAT_ACTION_ID, releaseActionSlot } from './action-slot.js';
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

/**
 * How far below the auto eater's own trigger to let HP fall before bailing.
 *
 * Auto Eat fires at `autoEatThreshold` percent of max HP. A floor *above* that
 * trigger means the policy leaves the fight before the eater is ever allowed to
 * do its job, and the two guards then fight each other instead of the monster.
 *
 * Measured live: the flat 50% floor against an eater triggering at 30% left the
 * character oscillating in the band between them -- `combat.engage ok` /
 * `combat.disengage ok` alternating on the 3s policy clock for minutes, HP
 * hovering near 43%, too low for the policy to keep fighting and too high for
 * Auto Eat to heal. It never ate and it never fought.
 *
 * The margin is what makes crossing it *evidence*: with an eater owned and food
 * to spend, HP below its trigger means the eater is not keeping up, which is a
 * real reason to leave. Above the trigger it means nothing has happened yet.
 */
const AUTO_EAT_FLOOR_MARGIN = 0.05;

/**
 * The fraction of max HP below which to disengage.
 *
 * Two regimes, because the sustain argument is genuinely different. Without an
 * auto eater HP only recovers between fights, and half a bar is a sane place to
 * stop. With one, the eater *is* the sustain mechanism and the floor belongs
 * below its trigger -- see AUTO_EAT_FLOOR_MARGIN.
 *
 * `autoEatThreshold` is a **percentage** despite the schema comment calling it
 * a fraction: the live snapshot reads 30 against a 150 HP bar, and the eater
 * fires at 45.
 */
function hpFloorFor(combat: { autoEatThreshold: number }, foodRemaining: number): number {
  const triggerFraction = combat.autoEatThreshold / 100;

  // No eater, or nothing for it to eat: the flat floor is the only backstop.
  if (triggerFraction <= 0 || foodRemaining < FOOD_FLOOR) return HP_FLOOR_FRACTION;

  return Math.max(0, triggerFraction - AUTO_EAT_FLOOR_MARGIN);
}

/** Below this many food items, disengage: the sustain argument no longer holds. */
const FOOD_FLOOR = 5;

/**
 * Whether a floor is crossed right now, named so the reason can be logged.
 *
 * One function for both floors because both answer the same question — "is
 * fighting still the right thing to be doing" — and the caller must ask it in
 * two places: before leaving a fight and before starting one. Two copies of
 * that test is exactly how they came to disagree, with the entry side simply
 * not having one.
 *
 * @returns A sentence naming the crossing, or null when nothing is crossed.
 */
function crossedFloor(hpFraction: number, hpFloor: number, foodRemaining: number): string | null {
  if (hpFraction < hpFloor) {
    return `HP ${(hpFraction * 100).toFixed(0)}% below floor ${(hpFloor * 100).toFixed(0)}%`;
  }
  if (foodRemaining < FOOD_FLOOR) {
    return `food down to ${foodRemaining}; the sustain argument no longer holds`;
  }
  return null;
}

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
  const params = objective.params;

  if (params.kind !== 'fight_monster' && params.kind !== 'run_dungeon') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `fightMonster received params of kind ${params.kind}`,
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

  const hpFloor = hpFloorFor(combat, foodRemaining);
  const crossed = crossedFloor(hpFraction, hpFloor, foodRemaining);

  // Evaluated before the `inCombat` split, and that ordering is the fix.
  //
  // Both floors used to live *inside* the in-combat branch, so a crossing could
  // only ever end the current fight — nothing consulted them on the way in. The
  // next tick therefore found combat stopped, skipped the floors entirely and
  // engaged again, and the tick after that crossed the same floor and stopped
  // again. A floor that governs leaving but not starting cannot terminate
  // anything; it can only alternate.
  //
  // That is the whole shape of the live loop: `combat.engage ok` /
  // `combat.disengage ok` on the 3s policy clock for seventeen minutes across
  // two game reloads, no kills, no XP, no GP. The give-away in the log is that
  // the *first* engage of an episode holds for 42s and 24s and every subsequent
  // one holds for exactly 3.0s -- one policy tick. Something became true during
  // the first fight and stayed true, and the executor asked about it only at
  // the one moment it could not act on the answer.
  //
  // Refusing to engage is not idling in the bad sense. Out of combat both
  // conditions are the ones that mend themselves: hitpoints regenerate, and
  // `refillFood` and `cookWhenFoodLow` restock the slot the fight emptied.
  // Standing still is what gives them the chance the thrash denied them, and if
  // the condition does not clear the budget and the no-movement detector
  // replan it -- which is a diagnosis, where the loop was silence.
  if (crossed !== null) {
    if (combat.inCombat) {
      return { kind: 'act', actions: [{ type: 'disengage' }], reason: `${crossed}; disengaging` };
    }
    return {
      kind: 'idle',
      reason: 'waiting_to_recover',
      detail: `${crossed}; not starting another fight until that clears`,
    };
  }

  if (combat.inCombat) {
    return {
      kind: 'idle',
      reason: 'already_running',
      detail: `fighting, HP ${(hpFraction * 100).toFixed(0)}%, food ${foodRemaining}`,
    };
  }

  // Stop and engage are separate ticks: `stop` has to be observed before the
  // engage is attempted, or the engage runs against a state the stop has not
  // produced yet.
  const inTheWay = releaseActionSlot(snapshot, [COMBAT_ACTION_ID]);
  if (inTheWay !== null) {
    return {
      kind: 'act',
      actions: [inTheWay.action],
      reason: `${inTheWay.reason} to fight`,
    };
  }

  if (params.kind === 'run_dungeon') {
    return {
      kind: 'act',
      actions: [{ type: 'run_dungeon', dungeonId: params.dungeonId }],
      reason: `entering dungeon ${params.dungeonId}`,
    };
  }

  return {
    kind: 'act',
    actions: [{ type: 'engage', monsterId: params.monsterId, areaId: params.areaId }],
    reason: `engaging ${params.monsterId} in ${params.areaId}`,
  };
};

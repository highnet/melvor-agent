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
 * The fraction of max HP a fight may be *started* at.
 *
 * There was no such floor, and the gap killed the character twice in eight
 * minutes. From the log, deaths 56 and 57, each three lines in the same second:
 *
 *     23:11:32 error   character died (1 since last check); clearing the objective
 *     23:11:32 planner plan advanced (1 left): Fight Sweaty Monster
 *     23:11:32 adapter combat.engage ok — inCombat false -> true
 *
 * Death cleared the objective, the plan advanced to the next fight, and the
 * executor engaged again *in the same second*, on a corpse's worth of health.
 * The disengage floor below cannot help: it only runs `if (combat.inCombat)`,
 * and this is the tick before that becomes true.
 *
 * Deliberately higher than the disengage floor, and that asymmetry is the whole
 * point. Leaving a fight is an emergency judged on what is left; entering one is
 * a choice, and the honest bar for choosing is "healthy", not "not yet dying".
 * Hysteresis also stops a character hovering at the disengage floor from
 * re-entering the moment it ticks a point above it, which is the shape of every
 * other loop found today.
 *
 * Auto Eat does not make this unnecessary. It fires *during* a fight at its own
 * threshold; it does nothing about starting one already below that threshold,
 * which is exactly the state a death leaves behind.
 */
const ENGAGE_HP_FRACTION = 0.8;

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

  if (combat.inCombat) {
    if (hpFraction < hpFloor) {
      return {
        kind: 'act',
        actions: [{ type: 'disengage' }],
        reason: `HP ${(hpFraction * 100).toFixed(0)}% below floor ${(hpFloor * 100).toFixed(0)}%; disengaging`,
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

  // Health is checked here rather than beside the disengage floor above,
  // because that branch is guarded by `if (combat.inCombat)` and this is the
  // tick before it. Idle rather than act: HP regenerates on its own out of
  // combat and the reflex tier eats, so waiting is what fixes this, and an
  // objective that reported failure here would be abandoned and replanned into
  // another fight at the same health.
  if (hpFraction < ENGAGE_HP_FRACTION) {
    return {
      kind: 'idle',
      reason: 'waiting_for_game',
      detail: `HP ${(hpFraction * 100).toFixed(0)}% is below the ${ENGAGE_HP_FRACTION * 100}% needed to start a fight; waiting`,
    };
  }

  return {
    kind: 'act',
    actions: [{ type: 'engage', monsterId: params.monsterId, areaId: params.areaId }],
    reason: `engaging ${params.monsterId} in ${params.areaId}`,
  };
};

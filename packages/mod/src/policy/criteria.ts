import type { AbortConditions, StateSnapshot } from '@melvor-agent/shared';
import { currencyAmount } from '@melvor-agent/shared';

const GP_CURRENCY_ID = 'melvorD:GP';

/**
 * Criterion evaluation now lives in `shared`; see `criteria.ts` there.
 *
 * It moved because the planner has to ask the same question at the other end of
 * the loop — whether a plan step's criteria are satisfied *before* it starts,
 * which makes it a no-op — and two switches over the criterion union would have
 * agreed on the day they were written and drifted afterwards. Re-exported here
 * so every policy executor keeps importing its completion test from the module
 * that owns the abort test beside it.
 */
export {
  bankQuantity,
  currencyAmount,
  isCriterionMet,
  isObjectiveComplete,
  skillLevel,
} from '@melvor-agent/shared';

export type AbortVerdict =
  | { abort: false }
  | {
      abort: true;
      outcome: 'aborted_budget' | 'aborted_gp_floor' | 'aborted_deaths' | 'aborted_stuck';
      detail: string;
    };

/**
 * Whether an objective has blown its budget.
 *
 * Checked every policy tick, before any action is chosen. Without this the
 * agent grinds into a wall for six hours; the time budget in particular is the
 * only condition that always eventually fires, which is why it is required
 * rather than optional in the schema.
 *
 * @param snapshot - Current observation.
 * @param abortWhen - The objective's budget.
 * @param elapsedMinutes - Wall-clock minutes since the objective started.
 * @param deathsSinceStart - Deaths observed during this objective.
 * @returns Whether to abort, and why.
 */
/** Below this share of max HP, with no food, nothing is worth continuing. */
const CRITICAL_HP_FRACTION = 0.25;

/**
 * Below this share of max HP, nothing is worth continuing *whatever* the food.
 *
 * Lower than the critical fraction because it overrides the food check rather
 * than joining it: reaching here means the eat reflex is already losing.
 */
const EMERGENCY_HP_FRACTION = 0.15;

export function checkAbort(
  snapshot: StateSnapshot,
  abortWhen: AbortConditions,
  elapsedMinutes: number,
  deathsSinceStart: number,
): AbortVerdict {
  // A universal floor, checked before anything the planner asked for. Damage is
  // not exclusive to combat — a failed pickpocket hurts — and with no food there
  // is no way back up, so continuing any activity is just waiting to die. This
  // sits here rather than in one executor because the next damaging skill will
  // not be Thieving.
  const maxHp = snapshot.combat.maxHitpoints;
  const hpFraction = maxHp > 0 ? snapshot.combat.hitpoints / maxHp : 1;
  const foodLeft = snapshot.combat.food.reduce((sum, slot) => sum + slot.qty, 0);

  if (hpFraction < CRITICAL_HP_FRACTION && foodLeft <= 0) {
    return {
      abort: true,
      outcome: 'aborted_stuck',
      detail: `hitpoints at ${(hpFraction * 100).toFixed(0)}% with no food equipped; stopping rather than continuing to take damage with no way to heal`,
    };
  }

  // Food that cannot keep up is not safety. Live, Thieving a Golbin took the
  // character to 6 hitpoints of 120 with 33 food equipped and the eat reflex
  // firing sixty-six times — it ate, and the damage outpaced it. The earlier
  // floor did not fire precisely because food *was* available, which turned a
  // guard into a blind spot.
  //
  // Below this, the activity is unsafe whatever the food situation, and the
  // honest response is to stop rather than to keep eating into a losing race.
  if (hpFraction < EMERGENCY_HP_FRACTION) {
    return {
      abort: true,
      outcome: 'aborted_stuck',
      detail: `hitpoints at ${(hpFraction * 100).toFixed(0)}% with ${foodLeft} food left; eating is not keeping up with the damage, so stopping is the only thing that will`,
    };
  }

  if (elapsedMinutes > abortWhen.minutesExceed) {
    return {
      abort: true,
      outcome: 'aborted_budget',
      detail: `ran ${elapsedMinutes.toFixed(1)}min, budget was ${abortWhen.minutesExceed}min`,
    };
  }

  if (abortWhen.gpBelow !== undefined) {
    const gp = currencyAmount(snapshot, GP_CURRENCY_ID);
    if (gp < abortWhen.gpBelow) {
      return {
        abort: true,
        outcome: 'aborted_gp_floor',
        detail: `GP ${gp} fell below floor ${abortWhen.gpBelow}`,
      };
    }
  }

  if (abortWhen.deathsExceed !== undefined && deathsSinceStart > abortWhen.deathsExceed) {
    return {
      abort: true,
      outcome: 'aborted_deaths',
      detail: `${deathsSinceStart} deaths, limit was ${abortWhen.deathsExceed}`,
    };
  }

  return { abort: false };
}

/** Minutes between two wall-clock timestamps, floored at zero. */
export function elapsedMinutes(now: number, startedAt: number): number {
  return Math.max(0, (now - startedAt) / 60_000);
}

/**
 * The single number that says whether an objective is producing anything.
 *
 * Pure and exported so the decision inside it is pinned by a test rather than
 * living in a private method where it was silently wrong for a day.
 *
 * Total level and GP only. `completionPercent` was in this marker and is
 * precisely why the stuck detector never fired on a dead objective: Township
 * ticks in the background and nudges completion on its own, so a fight that
 * killed nothing for seventeen minutes — GP frozen at exactly 30,816, total
 * level at 391 — still looked like progress and reset the clock every time
 * completion drifted a hundredth of a percent.
 *
 * The distinction the marker has to draw is between *the objective working* and
 * *the character existing*. Completion measures the second.
 */
export function progressMarker(totalLevel: number, gp: number): number {
  return totalLevel * 1e9 + gp;
}

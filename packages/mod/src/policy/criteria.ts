import type { AbortConditions, StateSnapshot, SuccessCriterion } from '@melvor-agent/shared';

const GP_CURRENCY_ID = 'melvorD:GP';

/** Current amount of a currency in the snapshot, or 0 when absent. */
export function currencyAmount(snapshot: StateSnapshot, currencyId: string): number {
  return snapshot.currencies.find((entry) => entry.id === currencyId)?.amount ?? 0;
}

/** Quantity of a banked item, or 0 when the bank holds none. */
export function bankQuantity(snapshot: StateSnapshot, itemId: string): number {
  return snapshot.bank.items.find((entry) => entry.id === itemId)?.qty ?? 0;
}

/** Level of a skill, or 0 when the skill is not registered. */
export function skillLevel(snapshot: StateSnapshot, skillId: string): number {
  return snapshot.skills.find((entry) => entry.id === skillId)?.level ?? 0;
}

/**
 * Whether one success criterion currently holds.
 *
 * @param snapshot - The observation to evaluate against.
 * @param criterion - A machine-checkable condition chosen by the planner.
 * @returns True when the criterion is satisfied.
 */
export function isCriterionMet(snapshot: StateSnapshot, criterion: SuccessCriterion): boolean {
  switch (criterion.type) {
    case 'skill_level_at_least':
      return skillLevel(snapshot, criterion.skillId) >= criterion.level;
    case 'item_qty_at_least':
      return bankQuantity(snapshot, criterion.itemId) >= criterion.qty;
    case 'currency_at_least':
      return currencyAmount(snapshot, criterion.currencyId) >= criterion.amount;
  }
}

/** An objective is complete when every one of its criteria holds. */
export function isObjectiveComplete(
  snapshot: StateSnapshot,
  criteria: readonly SuccessCriterion[],
): boolean {
  // An empty list means "no criterion applies" — a one-shot action whose
  // executor decides when it is done. Vacuous truth would mean the opposite:
  // instantly complete, before acting even once. That bug is invisible, because
  // the objective is accepted and then immediately reported completed.
  if (criteria.length === 0) return false;

  return criteria.every((criterion) => isCriterionMet(snapshot, criterion));
}

export type AbortVerdict =
  | { abort: false }
  | {
      abort: true;
      outcome: 'aborted_budget' | 'aborted_gp_floor' | 'aborted_deaths';
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

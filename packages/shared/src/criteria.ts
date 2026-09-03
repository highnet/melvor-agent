import type { SuccessCriterion } from './objective.js';
import type { StateSnapshot } from './snapshot.js';

/**
 * Evaluating a {@link SuccessCriterion} against an observation.
 *
 * This lives in `shared` rather than in the mod's policy tier because two
 * different tiers ask the same question from opposite ends. The mod asks "is
 * this objective finished yet"; the planner has to ask "would this objective be
 * finished *before it started*" — and a plan step that is already satisfied
 * when it is queued completes without acting.
 *
 * One implementation, so the two answers cannot drift. A second switch over the
 * criterion union in the planner would compile, agree on the day it was
 * written, and quietly disagree the first time a criterion type is added.
 */

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

/**
 * Whether a criterion, once satisfied, stays satisfied.
 *
 * The distinction decides *when* an already-met criterion can be called a
 * no-op. A level target that holds now holds forever: `Skill.level` is a
 * readonly getter (`skill.d.ts:167`) derived from XP, and the only mutator the
 * typings expose is `addXP`, documented as adding experience and returning
 * whether that "resulted in a level increase" (`skill.d.ts:320-325`). Nothing
 * in the typings takes XP away.
 *
 * A bank count and a currency balance move in both directions, and the plan
 * tool's own headline example is a chain that spends one: "mine 200 Gold Ore,
 * then smelt". A step whose stock target is met today can be genuine work by
 * the time the step before it has consumed the stock — so these are only ever
 * safe to judge at the moment a step actually starts.
 */
export function isMonotonicCriterion(criterion: SuccessCriterion): boolean {
  return criterion.type === 'skill_level_at_least';
}

/**
 * Names what a satisfied criterion is measuring, with the number it read.
 *
 * The reading matters more than the verdict. "Cooking 44 is already met" sends
 * the caller back with a number to beat; "that target is already met" sends
 * them back to guess again — and the guess that produced the refusal was made
 * from a listing that had gone stale, so guessing twice is the failure mode.
 *
 * @returns A phrase naming the current value, or null when the criterion is not
 *          in fact satisfied.
 */
export function describeSatisfied(
  snapshot: StateSnapshot,
  criterion: SuccessCriterion,
): string | null {
  if (!isCriterionMet(snapshot, criterion)) return null;

  switch (criterion.type) {
    case 'skill_level_at_least': {
      const skill = snapshot.skills.find((entry) => entry.id === criterion.skillId);
      const name = skill?.name ?? criterion.skillId;
      return `${name} is already level ${skill?.level ?? 0}, so a target of ${criterion.level} is met before it starts`;
    }
    case 'item_qty_at_least': {
      const entry = snapshot.bank.items.find((item) => item.id === criterion.itemId);
      const name = entry?.name ?? criterion.itemId;
      return `the bank already holds ${entry?.qty ?? 0}x ${name}, so a target of ${criterion.qty} is met before it starts`;
    }
    case 'currency_at_least': {
      const entry = snapshot.currencies.find((currency) => currency.id === criterion.currencyId);
      const name = entry?.name ?? criterion.currencyId;
      return `${name} is already ${(entry?.amount ?? 0).toLocaleString()}, so a target of ${criterion.amount.toLocaleString()} is met before it starts`;
    }
  }
}

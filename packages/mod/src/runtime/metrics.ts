import type { Objective, StateSnapshot } from '@melvor-agent/shared';

/**
 * The numbers an objective's cost is measured in.
 *
 * Extracted from `agent.ts`, where `snapshot.currencies.find(...)?.amount ?? 0`
 * appeared five times -- in the quality sample, the stuck detector, the bank
 * reflex, the metrics capture and the journal entry -- each with its own copy
 * of the currency id and its own fallback.
 */

const GP_CURRENCY_ID = 'melvorD:GP';

/**
 * GP held, from a validated snapshot.
 *
 * Zero when the currency is absent rather than undefined: every caller is
 * doing arithmetic with the result, and a missing currency is a bank with no
 * GP in it as far as any of them are concerned.
 */
export function snapshotGp(snapshot: StateSnapshot): number {
  return snapshot.currencies.find((entry) => entry.id === GP_CURRENCY_ID)?.amount ?? 0;
}

/**
 * Where the run stands against the currency goal it is working toward.
 *
 * The reflex tier's licence to sell surplus, resolved from the objective the
 * planner set and the snapshot in hand. Null in all three of the cases where
 * there is no licence, and the distinction between them does not matter to the
 * caller because the answer is the same: do not sell for money.
 *
 * - No objective, so nothing has said what the run is for.
 * - An objective with no `fundingTarget`, which is every objective unless the
 *   operator wrote a currency goal in `GOALS.md`.
 * - A target naming a currency the snapshot does not carry. A missing currency
 *   reads as zero everywhere else in this file, and zero-of-a-million would
 *   authorise the largest sale the guards allow on the strength of a reading
 *   that failed. Failing closed is the recoverable direction.
 *
 * Kept here rather than in `agent.ts` so it can be driven by a test directly;
 * the decision it feeds is irreversible, and `agent.ts` is not importable from
 * one.
 */
export function fundingStanding(
  snapshot: StateSnapshot,
  objective: Objective | null,
): { held: number; target: number } | null {
  const target = objective?.fundingTarget;
  if (target === undefined) return null;

  const currency = snapshot.currencies.find((entry) => entry.id === target.currencyId);
  if (currency === undefined) return null;

  return { held: currency.amount, target: target.amount };
}

/** What an objective is charged against: what it moved, and what it cost. */
export interface ObjectiveMetrics {
  totalLevel: number;
  gp: number;
  deaths: number;
}

/** The metrics an objective's cost will be measured against, at its start. */
export function objectiveMetrics(
  snapshot: StateSnapshot,
  deathsSinceStart: number,
): ObjectiveMetrics {
  return {
    totalLevel: snapshot.totalLevel,
    gp: snapshotGp(snapshot),
    deaths: deathsSinceStart,
  };
}

/**
 * What an objective actually moved.
 *
 * Deaths are clamped at zero because the count they come from is reset when a
 * new objective is adopted: an objective that started after a death and ended
 * before another would otherwise be journalled as having resurrected the
 * character.
 */
export function objectiveDeltas(
  started: ObjectiveMetrics,
  ended: ObjectiveMetrics,
): ObjectiveMetrics {
  return {
    totalLevel: ended.totalLevel - started.totalLevel,
    gp: ended.gp - started.gp,
    deaths: Math.max(0, ended.deaths - started.deaths),
  };
}

import type { Objective, StateSnapshot } from '@melvor-agent/shared';

/**
 * An intent the policy layer produces.
 *
 * Deliberately not a game call: the policy layer is pure and never touches the
 * adapter. The runtime translates these into adapter actions, which is what
 * keeps this tier testable against recorded snapshots.
 *
 * Every variant here must have a corresponding adapter action. A variant with
 * no executor is the failure the capability registry exists to catch.
 */
export type PolicyAction =
  /** Be gathering this recipe with this skill. One intent, not select-then-start. */
  | { type: 'gather'; skillId: string; recipeId: string }
  | { type: 'stop_gathering'; skillId: string }
  /** Sell a named quantity of one item. Never a filter, never the whole bank. */
  | { type: 'sell'; itemId: string; quantity: number };

/** Why the policy layer chose to do nothing. Surfaced in the log, not swallowed. */
export type PolicyIdleReason =
  | 'objective_satisfied'
  | 'already_running'
  | 'nothing_to_do'
  | 'waiting_for_game';

export type PolicyDecision =
  | { kind: 'act'; actions: PolicyAction[]; reason: string }
  | { kind: 'idle'; reason: PolicyIdleReason; detail: string }
  | { kind: 'complete'; detail: string }
  | {
      kind: 'abort';
      outcome: 'aborted_budget' | 'aborted_gp_floor' | 'aborted_deaths' | 'failed_precondition';
      detail: string;
    };

/** Everything a policy executor is allowed to see. No clock reads, no globals. */
export interface PolicyContext {
  snapshot: StateSnapshot;
  objective: Objective;
  /** Wall clock, injected so the tier stays deterministic under test. */
  now: number;
  /** When the current objective started, for the minutes budget. */
  objectiveStartedAt: number;
  /** Deaths observed since the objective started. */
  deathsSinceStart: number;
}

/**
 * A pure executor for one objective kind.
 *
 * Registering one is what makes an `ObjectiveKind` legal: the planner cannot
 * emit a kind that has no executor here, because the runtime rejects it before
 * the params are parsed.
 */
export type PolicyExecutor = (context: PolicyContext) => PolicyDecision;

/**
 * Re-exports of the shared contract types used across the adapter's public
 * surface, so `docs:api` has a single import to resolve and callers never
 * reach past the adapter for a shape it returns.
 */
export type {
  ActionResult,
  Candidate,
  FailureReason,
  Objective,
  StateSnapshot,
} from '@melvor-agent/shared';

import type { StateSnapshot } from '@melvor-agent/shared';

export type SkillState = StateSnapshot['skills'][number];
export type ActiveActionState = StateSnapshot['activeAction'];
export type CombatState = StateSnapshot['combat'];
export type BankState = StateSnapshot['bank'];

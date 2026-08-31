import { z } from 'zod';
import { journalDigestSchema, logRecordSchema } from './journal.js';
import { candidateSchema, objectiveSchema } from './objective.js';
import { gameIdSchema, qualitySampleSchema, stateSnapshotSchema } from './snapshot.js';

/**
 * The agent's lifecycle. All three tiers are gated on this.
 *
 * `suspended` exists because offline progress is not a startup-only event: a
 * stalled loop longer than `Game.MIN_OFFLINE_TIME` (60s) drops a *running*
 * game into the offline loop mid-session. See docs/api-notes.md §3.
 */
export const runStateSchema = z.enum([
  /** Loaded, but automation has never been armed. */
  'idle',
  /** Armed and permitted to act. */
  'running',
  /** Offline progress in flight. No ticks, no snapshots, no actions. */
  'suspended',
  /** Refusing to arm — stale dump, wrong character, or a failed guard. */
  'blocked',
  /** Kill switch pulled. Only a game reload leaves this state. */
  'killed',
]);
export type RunState = z.infer<typeof runStateSchema>;

/** Commands the TUI (or the in-game panel) can issue. */
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('arm') }),
  z.object({ type: z.literal('disarm') }),
  /** Hard stop. Tears down every listener and timer. For the operator. */
  z.object({ type: z.literal('kill') }),
  /**
   * Undoes a kill, back to idle rather than to running.
   *
   * A latch with no release is a reload disguised as a button; the operator
   * who pulled the switch is the one who decides when it goes back.
   */
  z.object({ type: z.literal('revive') }),
  z.object({ type: z.literal('replan'), reason: z.string() }),
  z.object({ type: z.literal('set_objective'), objective: objectiveSchema }),
  /**
   * A sequence to work through unattended.
   *
   * One objective at a time means a planning session has to be present at every
   * transition, and when it is not the agent falls back to the dumbest thing
   * that keeps it moving. A plan is how a session hands over several hours of
   * intent — earn, spend, train, spend again — and then leaves.
   *
   * Capped, because a plan is not a schedule: the further ahead it reaches, the
   * more of it was written against state that no longer holds.
   */
  z.object({ type: z.literal('set_plan'), objectives: z.array(objectiveSchema).min(1).max(8) }),
  z.object({ type: z.literal('dump_knowledge') }),
  z.object({ type: z.literal('export_save') }),
]);
export type Command = z.infer<typeof commandSchema>;

/**
 * Something the agent is level-unlocked for but cannot do for want of an input.
 *
 * Shared by the report and the planner request: the planner needs it to reason
 * about prerequisites, which a candidate list alone cannot express.
 */
export const blockedOpportunitySchema = z.object({
  label: z.string(),
  xpPerHour: z.number().nonnegative(),
  missing: z.array(
    z.object({
      itemId: gameIdSchema,
      name: z.string(),
      need: z.number().nonnegative(),
      have: z.number().nonnegative(),
    }),
  ),
});
export type BlockedOpportunity = z.infer<typeof blockedOpportunitySchema>;

/** mod -> service. Posted on every policy tick. */
export const agentReportSchema = z.object({
  runState: runStateSchema,
  snapshot: stateSnapshotSchema.nullable(),
  objective: objectiveSchema.nullable(),
  candidates: z.array(candidateSchema),
  /**
   * Things the agent is level-unlocked for but lacks the inputs to do, with the
   * missing item named. Context for the planner, never selectable: the best
   * move is often to produce the input for something better, and a candidate
   * list alone cannot express that.
   */
  blockedOpportunities: z.array(blockedOpportunitySchema).default([]),
  logs: z.array(logRecordSchema),
  quality: z.array(qualitySampleSchema),
  /** Non-null while the agent is refusing to arm; rendered verbatim by the TUI. */
  blockedReason: z.string().nullable(),
});
export type AgentReport = z.infer<typeof agentReportSchema>;

/** service -> mod, in response to a report. Commands are delivered at most once. */
export const agentReplySchema = z.object({
  commands: z.array(commandSchema),
});
export type AgentReply = z.infer<typeof agentReplySchema>;

/** service -> TUI. Everything the dashboard renders. */
export const dashboardSchema = z.object({
  connected: z.boolean(),
  /** ms since the last report from the mod; null if none ever received. */
  lastReportAgeMs: z.number().int().nonnegative().nullable(),
  report: agentReportSchema.nullable(),
  digest: journalDigestSchema,
  /** Progress per real-time hour: the control condition is a single skill left running. */
  levelsPerHour: z.number().nullable(),
  gpPerHour: z.number().nullable(),
});
export type Dashboard = z.infer<typeof dashboardSchema>;

export const plannerRequestSchema = z.object({
  snapshot: stateSnapshotSchema,
  candidates: z.array(candidateSchema),
  /** Higher-value options blocked on a missing input. Context, not choices. */
  blockedOpportunities: z.array(blockedOpportunitySchema).default([]),
  digest: journalDigestSchema,
  trigger: z.enum([
    'game_start',
    'offline_loop_exited',
    'objective_completed',
    'objective_aborted',
    'unlock_acquired',
    'death',
    'resource_exhausted',
    'budget_exceeded',
    'stuck_detected',
    'operator',
  ]),
});
export type PlannerRequest = z.infer<typeof plannerRequestSchema>;

/**
 * The safety boundary. Parsed, then every objective is checked against the
 * capability registry before anything reaches a game function.
 */
export const plannerResponseSchema = z.object({
  /**
   * May be empty. "Nothing is reachable right now" is a legitimate answer, and
   * forcing at least one objective would push the planner into inventing work
   * — exactly the failure the candidate-selection design exists to prevent.
   */
  objectives: z.array(objectiveSchema),
  reasoning: z.string(),
});
export type PlannerResponse = z.infer<typeof plannerResponseSchema>;

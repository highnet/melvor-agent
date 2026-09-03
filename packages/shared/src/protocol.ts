import { z } from 'zod';
import { BLOCKED_SEVERITIES } from './blocked.js';
import { journalDigestSchema, journalEntrySchema, logRecordSchema } from './journal.js';
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
  /** Save and reload the page, so a newly built mod is actually loaded. */
  z.object({ type: z.literal('reload_game') }),
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
  /**
   * How urgent this is, set by whoever produced the entry.
   *
   * The list is longer than anything will render, so something has to be cut.
   * Before this the cut was `slice(0, 12)` over a hand-maintained
   * concatenation, which made priority a property of where a `push` happened to
   * sit: a food-reserve countdown and "Yew unlocks at level 60" competed on
   * position alone, and the ordering had already been rewritten twice for
   * exactly that reason. Only the producer knows whether a line is a countdown
   * or a fact, so the producer says.
   *
   * Defaulted, so an older mod's reports still validate and read as ordinary.
   */
  severity: z.enum(BLOCKED_SEVERITIES).default('normal'),
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

/**
 * A guarded read in the adapter that threw, and how often.
 *
 * The adapter swallows exceptions on purpose -- game getters refuse to answer
 * in states the agent legitimately runs in -- but it used to swallow them
 * silently, about a hundred bare catches against one that reported anything. So
 * a renamed accessor showed up as a candidate quietly missing from the list and
 * a rate quietly sitting at its nominal fallback, with no signal anywhere.
 *
 * That is worse than an error, because the whole diagnostic loop here is
 * comparing an advertised rate against a realised one, and a rate that fell
 * back is not visibly a rate that is wrong.
 */
export const adapterFailureSchema = z.object({
  /** `file.what`, e.g. `candidates.thievingSuccessRate`. */
  site: z.string(),
  count: z.number().int().nonnegative(),
  lastError: z.string(),
  /**
   * `'stuck'` when this is an action loop rather than a guarded read.
   *
   * The stuck ledgers in `adapter/act.ts` ride out on this same list, because
   * it is the one counted diagnostic that already reaches the panel and the
   * state summary; their site is an action name (`reflex.repairTownship`) and
   * their count is stuck *runs*, not passes. Absent on a read — so an older
   * mod, which sends none of these, still validates against a newer service.
   */
  kind: z.literal('stuck').optional(),
});
export type AdapterFailure = z.infer<typeof adapterFailureSchema>;

/**
 * An objective whose actions are verified and whose own counter is not moving.
 *
 * The other half of the advertised-versus-realised comparison. That one catches
 * a rate that was modelled wrong — Crystal advertising 120,000 GP/h against
 * 10,800 delivered — and cannot see the failure where the actions themselves
 * achieve nothing: Agility stopping and starting every three seconds, each call
 * returning `ok` with real before/after evidence, for zero XP. Both were found
 * by an operator noticing a number looked wrong, hours in.
 */
export const stalledCounterSchema = z.object({
  /** The counter the objective's success condition names, e.g. `Agility xp`. */
  counter: z.string(),
  /** What it has been stuck at. */
  value: z.number(),
  /** Rounds of fully verified actions across the flat window. */
  successes: z.number().int().nonnegative(),
  minutes: z.number().nonnegative(),
  /** What the most recent verified action actually changed, if anything. */
  lastChange: z.string(),
});
export type StalledCounter = z.infer<typeof stalledCounterSchema>;

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
  /**
   * The steps still queued behind the current objective, in order.
   *
   * A count was carried here for a long time, and a count answers exactly one
   * question: is this a gap between steps or a stop? Those read identically
   * from outside — no objective, no active action — and that ambiguity
   * produced three wrong diagnoses in one morning, twice nearly undoing work
   * that was running correctly.
   *
   * But it cannot answer the next question, which is whether the queue is
   * still *right*. Every step was chosen against the candidates available when
   * the plan was written, so the further ahead it reaches the more of it was
   * decided against state that has since moved — and with only a number, a
   * session could neither see a stale step nor revise one. Its only lever was
   * to replace the whole plan, which is why plans were rewritten wholesale all
   * session. The objectives themselves make both answerable.
   */
  plan: z.array(objectiveSchema).default([]),
  /**
   * When the current objective started, in epoch milliseconds.
   *
   * Mastery rewards sustained use of one action and ranking is instantaneous,
   * so the two pull against each other and nothing was measuring the pull. An
   * objective's age is the whole evidence for churn: without it, a swap made
   * four minutes into an hour-long objective looked exactly like one made
   * after fifty.
   */
  objectiveStartedAt: z.number().int().nonnegative().nullable().default(null),
  /**
   * When the running bundle was built.
   *
   * The mod only reloads with the game, so the code on disk and the code
   * actually running can be hours apart. Without this, "is that fix live yet?"
   * was unanswerable from outside the game — a whole session of changes were
   * described as pending a reload with no way to confirm when one happened.
   *
   * Optional so an older mod still validates against a newer service.
   */
  buildStamp: z.string().nullable().optional(),
  logs: z.array(logRecordSchema),
  /**
   * Objectives that finished since the last report.
   *
   * The journal has a schema, a store method and a digest the planner reads,
   * and nothing ever wrote to it -- `addJournalEntry` had one caller, a test.
   * So `get_journal` could only ever answer "Nothing attempted yet", and the
   * property it exists to provide (do not re-propose what was abandoned) did
   * not exist. The mod knows every outcome and was throwing it away as a log
   * string; this is the field that carries it.
   */
  journalEntries: z.array(journalEntrySchema).default([]),
  quality: z.array(qualitySampleSchema),
  /**
   * Guarded adapter reads that threw, worst first, cumulative for the run.
   *
   * Cumulative rather than drained, because the question asked at 8am is "what
   * has been failing all night" and a counter that resets every three seconds
   * cannot answer it. Optional so an older mod still validates.
   */
  adapterFailures: z.array(adapterFailureSchema).default([]),
  /** Non-null while the agent is refusing to arm; rendered verbatim by the TUI. */
  blockedReason: z.string().nullable(),
  /**
   * A condition the agent cannot resolve on its own, stated for a human.
   *
   * Distinct from `blockedReason`, which says the agent is refusing to arm.
   * This says the agent is *running* and getting nowhere: the stuck detector
   * has escalated repeatedly to a planner that answered nothing, or a
   * suspension outlasted any offline-progress calculation. Both are states the
   * agent can only report, and both previously produced silence — an HTTP round
   * trip every three seconds all night, or no reports at all.
   *
   * Optional so an older mod still validates against a newer service.
   */
  needsAttention: z.string().nullable().default(null),
  /**
   * Set while the current objective's actions verify and its counter does not.
   *
   * Null in the healthy case, and cleared as soon as the counter moves. A
   * replan has already been requested by the time this is populated; the field
   * exists so a planning session can see *why* rather than being handed a
   * fresh objective with no account of what went wrong with the last one.
   *
   * Defaulted so an older mod still validates against a newer service.
   */
  stalledCounter: stalledCounterSchema.nullable().default(null),
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
  /**
   * The one field an external check should read. Null while nothing is wrong.
   *
   * Everything the agent can escalate ends up here — refusing to arm, stuck
   * with no plan, suspended past any plausible catch-up, or gone silent
   * entirely — because a watchdog that has to know which of four fields to
   * inspect is a watchdog nobody writes. `connected: false` in particular said
   * nothing about *why*, and the suspended path could not say anything at all:
   * it returned before reporting, so the tell for "offline progress never
   * finished" and the tell for "the game was closed" were the same silence.
   */
  needsAttention: z.string().nullable(),
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
  /**
   * Steps still queued behind the current objective.
   *
   * Exists to tell "between steps" apart from "stopped", which read
   * identically and should not. A snapshot taken in the gap between one
   * objective finishing and the next starting shows no objective and no active
   * action — exactly what a stalled agent shows — and that ambiguity produced
   * three wrong diagnoses in one morning, twice nearly undoing work that was
   * running correctly.
   */
  planRemaining: z.number().int().nonnegative().default(0),
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

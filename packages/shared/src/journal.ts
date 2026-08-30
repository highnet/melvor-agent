import { z } from 'zod';
import { objectiveSchema, outcomeSchema } from './objective.js';

/**
 * One attempted objective: what it cost and how it ended.
 *
 * The full journal lives on disk in the planner service. `characterStorage` is
 * capped at 8,192 bytes per character per mod (docs/api-notes.md §5), which is
 * nowhere near enough — only a digest goes in-game.
 */
export const journalEntrySchema = z.object({
  objective: objectiveSchema,
  startedAt: z.number().int().positive(),
  endedAt: z.number().int().positive(),
  outcome: outcomeSchema,
  /** Deltas measured across the attempt, so cost is observed rather than assumed. */
  deltas: z.object({
    totalLevel: z.number().int(),
    gp: z.number(),
    deaths: z.number().int().nonnegative(),
  }),
  note: z.string().optional(),
});
export type JournalEntry = z.infer<typeof journalEntrySchema>;

/**
 * What the planner actually sees: recent entries verbatim, older ones rolled
 * into aggregate lines. Unbounded history would eat the context budget, and
 * the planner re-proposing what it abandoned yesterday is the failure this
 * exists to prevent.
 */
export const journalDigestSchema = z.object({
  recent: z.array(journalEntrySchema),
  aggregates: z.array(
    z.object({
      kind: z.string(),
      attempts: z.number().int().positive(),
      completed: z.number().int().nonnegative(),
      aborted: z.number().int().nonnegative(),
      medianMinutes: z.number().nonnegative(),
      note: z.string().optional(),
    }),
  ),
});
export type JournalDigest = z.infer<typeof journalDigestSchema>;

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export type LogLevel = z.infer<typeof logLevelSchema>;

/** Every action and planner decision, with reasoning. Panel + disk. */
export const logRecordSchema = z.object({
  at: z.number().int().positive(),
  level: logLevelSchema,
  source: z.enum(['reflex', 'policy', 'planner', 'adapter', 'runtime', 'operator']),
  message: z.string(),
  /** Structured evidence — usually a serialised ActionResult. */
  data: z.unknown().optional(),
});
export type LogRecord = z.infer<typeof logRecordSchema>;

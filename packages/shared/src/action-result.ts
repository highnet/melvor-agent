import { z } from 'zod';

/**
 * Why an action failed.
 *
 * - `precondition`  — we refused to call the game at all; requirements unmet.
 * - `no_state_change` — the game call ran and did not throw, but the observed
 *   state is unchanged. This is the common case, not the exotic one: several
 *   game methods return `void` (`Bank.removeItemQuantity`, `Woodcutting.selectTree`)
 *   or `boolean | undefined` (`Player.equipFood`), so the return value cannot be
 *   trusted as evidence.
 * - `threw` — the game call raised.
 * - `suspended` — the game was inside its offline-progress loop, so we declined
 *   to act. Acting mid-catch-up produces nonsense. See docs/api-notes.md §3.
 */
export const failureReasonSchema = z.enum([
  'precondition',
  'no_state_change',
  'threw',
  'suspended',
]);
export type FailureReason = z.infer<typeof failureReasonSchema>;

/**
 * The contract every adapter action returns. Never `void`.
 *
 * On success it carries the before/after projection that *proves* the state
 * changed, so callers verify evidence rather than trusting a return code.
 */
export type ActionResult<T> =
  | { ok: true; action: string; observed: { before: T; after: T }; detail?: string }
  | { ok: false; action: string; reason: FailureReason; detail: string };

export const actionResultSchema = <T extends z.ZodTypeAny>(observed: T) =>
  z.discriminatedUnion('ok', [
    z.object({
      ok: z.literal(true),
      action: z.string(),
      observed: z.object({ before: observed, after: observed }),
      detail: z.string().optional(),
    }),
    z.object({
      ok: z.literal(false),
      action: z.string(),
      reason: failureReasonSchema,
      detail: z.string(),
    }),
  ]);

export const ok = <T>(action: string, before: T, after: T, detail?: string): ActionResult<T> => ({
  ok: true,
  action,
  observed: { before, after },
  ...(detail === undefined ? {} : { detail }),
});

export const fail = <T>(
  action: string,
  reason: FailureReason,
  detail: string,
): ActionResult<T> => ({ ok: false, action, reason, detail });

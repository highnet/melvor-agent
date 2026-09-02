/**
 * How often a stuck agent may ask the planner again, and when it gives up
 * asking and calls for a person.
 *
 * `detectStuck` used to call `requestReplan('stuck_detected')` on every tick
 * once the fifteen-minute flat-progress window elapsed. Each of those becomes a
 * `/plan` POST, and `plan()` returns `{ objectives: [] }` unconditionally --
 * planning happens in an attached Claude Code session or it does not happen at
 * all. So a stuck agent issued one HTTP round trip every three seconds, all
 * night, for an answer that was guaranteed empty before it was sent: roughly
 * 1,200 requests an hour, none of which could ever change anything.
 *
 * Retrying is still right. A session may attach at any moment, and the first
 * request after it does is the one that ends the stall. What is wrong is the
 * *rate*, and the assumption underneath it -- that asking again is free and
 * that someone is eventually going to answer.
 */

/** First retry, one minute after the stall is declared. */
export const STUCK_REPLAN_BASE_MS = 60_000;

/**
 * Ceiling on the retry interval.
 *
 * Ten minutes: a session attaching to a stalled overnight run waits at most
 * that long to be asked, against six requests an hour instead of 1,200.
 */
export const STUCK_REPLAN_MAX_MS = 600_000;

/**
 * Retries before the agent stops treating this as something it can fix.
 *
 * Four covers roughly the first half hour of a stall. Past that the planner has
 * been asked repeatedly and answered nothing every time, which is not a
 * transient condition -- it is a run that has no session attached and nothing
 * queued, and the only thing that ends it is a human.
 */
export const STUCK_ESCALATIONS_BEFORE_ATTENTION = 4;

/**
 * Delay before the next stuck replan, doubling each time.
 *
 * @param escalations - Replans already issued for this stuck episode.
 * @returns Milliseconds to wait, capped at {@link STUCK_REPLAN_MAX_MS}.
 */
export function stuckReplanDelayMs(escalations: number): number {
  if (escalations <= 0) return STUCK_REPLAN_BASE_MS;
  const doubled = STUCK_REPLAN_BASE_MS * 2 ** escalations;
  // `**` on a large exponent reaches Infinity rather than overflowing to
  // something small, so the cap holds however long a stall runs.
  return Math.min(doubled, STUCK_REPLAN_MAX_MS);
}

/**
 * The escalation an external check can see, once retrying has stopped helping.
 *
 * @param escalations - Replans issued for this stuck episode.
 * @param stuckForMs - How long progress has been flat.
 * @param objective - What the agent believes it is doing, for the message.
 * @returns A sentence for a human, or null while retrying is still reasonable.
 */
export function describeStuckAttention(
  escalations: number,
  stuckForMs: number,
  objective: string | null,
): string | null {
  if (escalations < STUCK_ESCALATIONS_BEFORE_ATTENTION) return null;

  return `no total level or GP movement for ${Math.round(stuckForMs / 60_000)}min across ${escalations} replan requests, all of which returned nothing. The agent is running and achieving nothing; it is doing "${
    objective ?? 'no objective'
  }". Attach a planning session, or set an objective directly.`;
}

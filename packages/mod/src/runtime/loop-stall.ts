/**
 * Whether the game loop is still ticking, as a state machine over a counter
 * and a clock.
 *
 * Deliberately fed from the policy clock, which is a plain setInterval, and
 * never from the tick loop itself. The stuck detector already had this
 * backwards: it rode the very clock whose failure it was meant to catch, so a
 * dead loop took its own alarm with it.
 *
 * The failure this exists for looked perfectly healthy from outside. Reports
 * kept arriving on the independent timer, `runState` stayed `running`, and
 * the snapshot went on naming whatever skill was last active -- so the
 * service, the panel and every MCP reading agreed the character was working
 * while nothing had happened for an hour.
 *
 * Separated from `Agent` so it can be driven directly by a test. The tick
 * count and the clock are both passed in, which is what keeps this side of the
 * adapter boundary and what makes the fifteen-second threshold checkable
 * without waiting fifteen seconds.
 */

/** How long a silent loop is tolerated before it is called a stall. */
export const LOOP_STALL_MS = 15_000;

/** What one observation revealed, or nothing when it revealed nothing new. */
export type LoopStallEvent = { kind: 'resumed' } | { kind: 'stalled'; stalledMs: number };

export class LoopStallWatch {
  /** Tick count at the previous policy tick, for the liveness comparison. */
  private lastSeenTickCount = 0;

  /** When the loop was first seen not to tick, or null while it is healthy. */
  private stalledSince: number | null = null;

  /** Whether the current stall has already been reported. */
  private reported = false;

  /**
   * Folds one reading of the tick counter in.
   *
   * @param tickCount - Ticks since load. Only its movement matters.
   * @param running - Whether the agent is armed. A stall matters only while
   *                  something is supposed to be happening; the counter is
   *                  still tracked either way, so arming does not inherit a
   *                  stall from the time before it.
   * @param now - `Date.now()`, passed in so the threshold is testable.
   * @returns The event to report, or null.
   */
  observe(tickCount: number, running: boolean, now: number): LoopStallEvent | null {
    const ticked = tickCount !== this.lastSeenTickCount;
    this.lastSeenTickCount = tickCount;

    if (ticked) {
      this.reported = false;
      if (this.stalledSince !== null) {
        this.stalledSince = null;
        return { kind: 'resumed' };
      }
      return null;
    }

    if (!running) return null;

    if (this.stalledSince === null) {
      this.stalledSince = now;
      return null;
    }

    // Reported once per stall, not once per tick: an alarm that repeats every
    // three seconds fills the log queue and evicts the diagnostics that would
    // explain it.
    if (this.reported) return null;
    if (now - this.stalledSince < LOOP_STALL_MS) return null;

    this.reported = true;
    return { kind: 'stalled', stalledMs: now - this.stalledSince };
  }
}

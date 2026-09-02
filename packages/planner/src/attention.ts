import type { AgentReport } from '@melvor-agent/shared';

/**
 * How long the mod may go quiet before silence is itself the alarm.
 *
 * Reports arrive every three seconds, so two minutes is forty missed ones —
 * far past a slow tick or a single failed request, and short enough that a
 * check running every few minutes still catches a night that ended at 01:00.
 */
const SILENT_AFTER_MS = 120_000;

/**
 * The single question an unattended check asks: is anyone needed?
 *
 * Every escalation the agent can produce arrives by a different route —
 * `blockedReason` for a refused arm, `needsAttention` for a stuck or stranded
 * run, and plain silence for a game that closed or a suspension that never
 * ended — and none of them was reachable without knowing which field to look
 * at. `connected: false` was the closest thing available and carried no reason,
 * which is how a suspended agent could stop reporting entirely and read
 * identically to a machine that had been shut down.
 *
 * Ordered by what invalidates what: a stale report's contents describe a moment
 * that has passed, so silence is reported before anything inside it.
 *
 * @param report - The mod's last report, or null when none has ever arrived.
 * @param ageMs - Milliseconds since that report, or null when there is none.
 * @returns A sentence for a human, or null while nothing needs one.
 */
export function describeAttention(report: AgentReport | null, ageMs: number | null): string | null {
  // Never having reported is the state before a run starts, not a failed one.
  // Alarming on it would mean the service alarms from the moment it boots.
  if (report === null || ageMs === null) return null;

  // A latched kill switch is an operator decision, and telling the operator
  // about their own decision every two minutes is how an alarm gets ignored.
  if (report.runState === 'killed') return null;

  if (ageMs > SILENT_AFTER_MS) {
    return `the mod has not reported for ${Math.round(ageMs / 1000)}s — the game is closed, the tab is gone, or the loop died. Last known state: ${report.runState}.`;
  }

  if (report.needsAttention !== null && report.needsAttention !== undefined) {
    return report.needsAttention;
  }

  if (report.blockedReason !== null) {
    return `the agent is refusing to arm: ${report.blockedReason}`;
  }

  return null;
}

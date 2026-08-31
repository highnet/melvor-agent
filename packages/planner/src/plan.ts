import type { PlannerRequest, PlannerResponse } from '@melvor-agent/shared';
import { plannerResponseSchema } from '@melvor-agent/shared';

/**
 * Selects and orders objectives.
 *
 * **Planning happens in a Claude Code session, or it does not happen.** There is
 * no API-key path and no heuristic: an agent attached over MCP reads the state,
 * the candidates and the journal, and calls `set_objective`.
 *
 * That leaves this endpoint with one job — to say *no* well. When nothing is
 * attached it returns an empty objective list, and the mod keeps executing the
 * objective it already has. That is the watchdog behaviour the brief asks for,
 * and it degrades to the last thing an agent actually chose rather than to
 * something no agent ever endorsed.
 *
 * Two paths were tried and removed. A rate-maximising heuristic is the
 * *anti-goal*: the game already gives away 24 hours of one skill for free, so
 * "run the best-rate skill" adds nothing over closing the client — and in
 * practice it chose Firemaking with no logs banked and failed once per tick for
 * ten minutes. A direct API planner worked, but it is a second brain making
 * decisions the session cannot see, with its own key, budget and failure modes.
 *
 * @param request - Snapshot, candidates and journal digest from the mod.
 * @returns Always an empty objective list, with a reason.
 */
export async function plan(request: PlannerRequest): Promise<PlannerResponse> {
  const reason =
    request.candidates.length === 0
      ? 'no candidates are currently available'
      : `waiting for a planning session (${request.candidates.length} candidates ready, trigger: ${request.trigger})`;

  return plannerResponseSchema.parse({ objectives: [], reasoning: reason });
}

/** Live planner status, surfaced on /health so it is visible without digging. */
export function plannerStatus() {
  return {
    model: 'claude code session (MCP)',
    note: 'Objectives come from an attached session via set_objective. Nothing plans autonomously.',
  };
}

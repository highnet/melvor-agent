import type {
  Candidate,
  ObjectiveParams,
  PlannerRequest,
  PlannerResponse,
  SuccessCriterion,
} from '@melvor-agent/shared';
import { plannerResponseSchema } from '@melvor-agent/shared';

const GP_CURRENCY_ID = 'melvorD:GP';

/**
 * Selects and orders objectives.
 *
 * Phase 1 makes no model calls. This stub picks the highest-XP candidate the
 * mod reported, which exercises the full contract — request parsed, response
 * validated against the same schema a model response would face — without
 * introducing an external dependency before the mechanics are proven.
 *
 * The shape of the eventual model call is fixed by this signature: the planner
 * only ever *chooses among* `request.candidates`. It cannot author an objective
 * of its own, and it never fetches a URL during a planning call.
 *
 * @param request - Snapshot, candidates and journal digest from the mod.
 * @returns A validated planner response.
 */
export async function plan(request: PlannerRequest): Promise<PlannerResponse> {
  const best = [...request.candidates].sort((a, b) => score(b) - score(a))[0];

  if (best === undefined) {
    // An empty candidate list is a legitimate state — nothing is reachable
    // right now — and must not be papered over with an invented objective.
    return plannerResponseSchema.parse({
      objectives: [],
      reasoning: 'no candidates were available',
    });
  }

  const response: PlannerResponse = {
    objectives: [
      {
        id: `stub-${request.trigger}-${request.snapshot.capturedAt}`,
        kind: best.kind,
        params: best.params,
        successWhen: [successFor(best.params, request)],
        abortWhen: { minutesExceed: 120 },
        expectedDurationMin: 60,
        rationale: `stub planner: best-scoring candidate (${best.label})`,
      },
    ],
    reasoning: `Chose ${best.label} from ${request.candidates.length} candidates. Trigger: ${request.trigger}.`,
  };

  // Validated on the way out too, so the stub cannot emit something the mod
  // would reject — the failure would otherwise only surface in the game.
  return plannerResponseSchema.parse(response);
}

/**
 * Ranks candidates.
 *
 * Gathering is ranked on XP/hr and selling on nothing yet — a sale is a one-off
 * with no duration, so it has no rate to compare against a rate. Ordering the
 * two against each other is exactly the judgement the model is for; until then
 * the stub prefers gathering so the agent always has something to run.
 */
function score(candidate: Candidate): number {
  return candidate.kind === 'gather_resource' ? (candidate.xpPerHour ?? 0) : -1;
}

/**
 * Derives a machine-checkable success criterion for a chosen candidate.
 *
 * Exhaustive over `ObjectiveParams`, so adding an objective kind without
 * deciding what "done" means for it fails the build rather than shipping an
 * objective that can never complete.
 */
function successFor(params: ObjectiveParams, request: PlannerRequest): SuccessCriterion {
  switch (params.kind) {
    case 'gather_resource': {
      const current =
        request.snapshot.skills.find((skill) => skill.id === params.skillId)?.level ?? 1;
      return {
        type: 'skill_level_at_least',
        skillId: params.skillId,
        level: Math.min(120, Math.floor(current / 5) * 5 + 5),
      };
    }
    case 'sell_items': {
      const gp =
        request.snapshot.currencies.find((entry) => entry.id === GP_CURRENCY_ID)?.amount ?? 0;
      // A modest, always-reachable target: the point of a sale objective is the
      // transition, not a savings goal.
      return {
        type: 'currency_at_least',
        currencyId: GP_CURRENCY_ID,
        amount: Math.max(1, Math.floor(gp * 1.1)),
      };
    }
  }
}

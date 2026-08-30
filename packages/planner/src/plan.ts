import type { PlannerRequest, PlannerResponse } from '@melvor-agent/shared';
import { plannerResponseSchema } from '@melvor-agent/shared';

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
  const best = [...request.candidates].sort((a, b) => (b.xpPerHour ?? 0) - (a.xpPerHour ?? 0))[0];

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
        successWhen: [
          {
            type: 'skill_level_at_least',
            skillId: best.params.skillId,
            level: nextLevelTarget(request, best.params.skillId),
          },
        ],
        abortWhen: { minutesExceed: 120 },
        expectedDurationMin: 60,
        rationale: `stub planner: highest XP/hr candidate (${best.label}, ${Math.round(best.xpPerHour ?? 0)} xp/hr)`,
      },
    ],
    reasoning: `Chose ${best.label} from ${request.candidates.length} candidates on XP/hr. Trigger: ${request.trigger}.`,
  };

  // Validated on the way out too, so the stub cannot emit something the mod
  // would reject — the failure would otherwise only surface in the game.
  return plannerResponseSchema.parse(response);
}

/** Next round-number level above the skill's current one. */
function nextLevelTarget(request: PlannerRequest, skillId: string): number {
  const current = request.snapshot.skills.find((skill) => skill.id === skillId)?.level ?? 1;
  return Math.min(120, Math.floor(current / 5) * 5 + 5);
}

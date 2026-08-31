import Anthropic from '@anthropic-ai/sdk';
import type {
  Candidate,
  ObjectiveParams,
  PlannerRequest,
  PlannerResponse,
  SuccessCriterion,
} from '@melvor-agent/shared';
import { plannerResponseSchema } from '@melvor-agent/shared';
import { chooseObjective } from './claude.js';

const GP_CURRENCY_ID = 'melvorD:GP';

/**
 * Daily output-token ceiling for planning.
 *
 * The agent runs for days and replans on every completion, abort and offline
 * exit, so an unbounded planner is an unbounded bill. Past the cap it falls
 * back to the heuristic and keeps playing.
 */
const DAILY_TOKEN_BUDGET = Number(process.env.PLANNER_DAILY_TOKEN_BUDGET ?? 200_000);

/** Consecutive model failures before the planner is considered unhealthy. */
const FAILURE_THRESHOLD = 2;

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

let tokensUsedToday = 0;
let budgetDay = new Date().toISOString().slice(0, 10);
let consecutiveFailures = 0;

/** Live planner health, surfaced on /health so it is visible without digging. */
export function plannerStatus() {
  return {
    model: client === null ? 'heuristic (no ANTHROPIC_API_KEY)' : 'claude',
    tokensUsedToday,
    dailyTokenBudget: DAILY_TOKEN_BUDGET,
    consecutiveFailures,
    degraded: consecutiveFailures >= FAILURE_THRESHOLD,
  };
}

/** Whether the model should be consulted at all this call. */
function modelAvailable(): string | null {
  if (client === null) return 'no ANTHROPIC_API_KEY set';

  const today = new Date().toISOString().slice(0, 10);
  if (today !== budgetDay) {
    budgetDay = today;
    tokensUsedToday = 0;
    consecutiveFailures = 0;
  }

  if (tokensUsedToday >= DAILY_TOKEN_BUDGET) {
    return `daily token budget spent (${tokensUsedToday}/${DAILY_TOKEN_BUDGET})`;
  }
  // Degrade, never halt: after repeated failures stop paying for calls that are
  // not working and let the heuristic carry the agent until the next day.
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    return `planner degraded after ${consecutiveFailures} consecutive failures`;
  }
  return null;
}

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
  const unavailable = modelAvailable();

  if (unavailable === null && client !== null) {
    const result = await chooseObjective(request, client);

    if (result.ok) {
      consecutiveFailures = 0;
      tokensUsedToday += result.usage.outputTokens;

      const chosen = request.candidates[result.choice.candidateIndex];
      if (chosen !== undefined) {
        // Params are copied from the candidate, never from the model. The model
        // chose *which*; it cannot choose *what*.
        return plannerResponseSchema.parse({
          objectives: [
            {
              id: `claude-${request.trigger}-${request.snapshot.capturedAt}`,
              kind: chosen.kind,
              params: chosen.params,
              successWhen: [successForChoice(chosen, result.choice.targetLevel, request)],
              abortWhen: { minutesExceed: result.choice.abortMinutes },
              expectedDurationMin: Math.min(result.choice.abortMinutes, 60),
              rationale: result.choice.rationale,
            },
          ],
          reasoning: result.choice.reasoning,
        });
      }
    } else {
      consecutiveFailures += 1;
      console.warn(`[planner] model call failed (${consecutiveFailures}): ${result.reason}`);
    }
  } else if (unavailable !== null) {
    console.log(`[planner] using heuristic: ${unavailable}`);
  }

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
 * Success criterion for a model-chosen candidate.
 *
 * Uses the chosen level where the candidate names a skill, and falls back to
 * the heuristic's own criterion otherwise — a sale or a purchase has no level
 * to reach.
 */
function successForChoice(
  candidate: Candidate,
  targetLevel: number,
  request: PlannerRequest,
): SuccessCriterion {
  const params = candidate.params;
  if ('skillId' in params) {
    return { type: 'skill_level_at_least', skillId: params.skillId, level: targetLevel };
  }
  return successFor(params, request);
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

/** Current GP in the snapshot, or 0. */
function currentGp(request: PlannerRequest): number {
  return request.snapshot.currencies.find((entry) => entry.id === GP_CURRENCY_ID)?.amount ?? 0;
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
      const gp = currentGp(request);
      // A modest, always-reachable target: the point of a sale objective is the
      // transition, not a savings goal.
      return {
        type: 'currency_at_least',
        currencyId: GP_CURRENCY_ID,
        amount: Math.max(1, Math.floor(gp * 1.1)),
      };
    }
    case 'buy_shop_upgrade': {
      // A purchase completes when it has happened, which the mod observes
      // directly; the currency target here is only a floor so the objective
      // does not sit forever if the purchase becomes unaffordable.
      return {
        type: 'currency_at_least',
        currencyId: GP_CURRENCY_ID,
        amount: Math.max(1, Math.floor(currentGp(request) * 1.5)),
      };
    }
    case 'tend_farm': {
      // Farming completes on Farming level, which rises from harvesting and is
      // the only signal that does not depend on which crop was chosen.
      const current =
        request.snapshot.skills.find((skill) => skill.id === 'melvorD:Farming')?.level ?? 1;
      return {
        type: 'skill_level_at_least',
        skillId: 'melvorD:Farming',
        level: Math.min(120, current + 1),
      };
    }
    case 'fight_monster': {
      // Combat objectives are measured in Hitpoints levels, which rise from any
      // combat style and so do not assume a particular one.
      const current =
        request.snapshot.skills.find((skill) => skill.id === 'melvorD:Hitpoints')?.level ?? 1;
      return {
        type: 'skill_level_at_least',
        skillId: 'melvorD:Hitpoints',
        level: Math.min(120, current + 1),
      };
    }
  }
}

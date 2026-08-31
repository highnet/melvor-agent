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

/** Reported on /health so it is obvious which planner is actually deciding. */
const MODEL_LABEL = process.env.PLANNER_MODEL ?? 'claude-opus-5';

/**
 * Daily output-token ceiling for planning.
 *
 * The agent runs for days and replans on every completion, abort and offline
 * exit, so an unbounded planner is an unbounded bill. Past the cap the planner
 * declines to choose and the mod keeps running its current objective.
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
    model: client === null ? 'none (no ANTHROPIC_API_KEY)' : MODEL_LABEL,
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
  // not working. The agent keeps its current objective until the next day.
  if (consecutiveFailures >= FAILURE_THRESHOLD) {
    return `planner degraded after ${consecutiveFailures} consecutive failures`;
  }
  return null;
}

/**
 * Selects and orders objectives.
 *
 * **An agent decides, or nothing does.** There is no heuristic fallback that
 * invents an objective, because a heuristic that picks the highest XP/hr is not
 * a worse planner — it is the *anti-goal*. The game already gives away 24 hours
 * of one skill for free, so "always run the best-rate skill" adds nothing over
 * closing the client. Every bit of this project's value is in the judgement
 * calls a rate comparison cannot make: burn the logs you just cut, buy the
 * upgrade that unlocks the next tier, stop farming something the bank is
 * drowning in.
 *
 * So when no agent can answer, the response is **empty**, and the mod keeps
 * executing the objective it already has. That is the watchdog behaviour the
 * brief asks for — degrade, never halt — and it is meaningfully different from
 * falling back to a heuristic: the agent keeps doing the last thing a planner
 * actually chose, rather than starting something no planner ever endorsed.
 *
 * The safety property is unchanged: the model picks an index into
 * `request.candidates` and the params are copied from the candidate verbatim,
 * so it chooses *which*, never *what*.
 *
 * @param request - Snapshot, candidates and journal digest from the mod.
 * @returns A validated response, empty when no agent could choose.
 */
export async function plan(request: PlannerRequest): Promise<PlannerResponse> {
  if (request.candidates.length === 0) {
    // A legitimate state — nothing is reachable right now — and one that must
    // not be papered over with an invented objective.
    return plannerResponseSchema.parse({
      objectives: [],
      reasoning: 'no candidates were available',
    });
  }

  const unavailable = modelAvailable();
  if (unavailable !== null) {
    return declineToPlan(`planner unavailable: ${unavailable}`);
  }
  if (client === null) {
    return declineToPlan('planner unavailable: no client');
  }

  const result = await chooseObjective(request, client);

  if (!result.ok) {
    consecutiveFailures += 1;
    console.warn(`[planner] model call failed (${consecutiveFailures}): ${result.reason}`);
    return declineToPlan(`planner failed: ${result.reason}`);
  }

  consecutiveFailures = 0;
  tokensUsedToday += result.usage.outputTokens;

  const chosen = request.candidates[result.choice.candidateIndex];
  if (chosen === undefined) {
    // chooseObjective already range-checks; reaching here means the list moved
    // underneath the call, which is not something to guess around.
    return declineToPlan(`chosen index ${result.choice.candidateIndex} no longer exists`);
  }

  return plannerResponseSchema.parse({
    objectives: [
      {
        id: `claude-${request.trigger}-${request.snapshot.capturedAt}`,
        kind: chosen.kind,
        // Params are copied from the candidate, never from the model.
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

/**
 * Returns no objectives, loudly.
 *
 * The mod treats an empty response as "keep the current objective", so this is
 * the degrade path rather than a halt. It is logged at warn because an agent
 * planning nothing for a long stretch is a condition the operator should see.
 */
function declineToPlan(reason: string): PlannerResponse {
  console.warn(`[planner] ${reason} — keeping the current objective`);
  return plannerResponseSchema.parse({ objectives: [], reasoning: reason });
}

/**
 * Success criterion for a model-chosen candidate.
 *
 * Differs from {@link successFor} in one way that matters: the model supplies
 * the target level, so a skill objective uses *its* judgement of what is
 * reachable in the budget it also chose, rather than a mechanical next-multiple
 * -of-five. Non-skill kinds have no level to reach, so they fall through to the
 * derived criterion.
 */
function successForChoice(
  candidate: Candidate,
  targetLevel: number,
  request: PlannerRequest,
): SuccessCriterion {
  const params = candidate.params;
  if (params.kind === 'gather_resource') {
    return { type: 'skill_level_at_least', skillId: params.skillId, level: targetLevel };
  }
  return successFor(params, request);
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

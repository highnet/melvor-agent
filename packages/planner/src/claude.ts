import type Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { Candidate, JournalDigest, PlannerRequest } from '@melvor-agent/shared';

const MODEL = process.env.PLANNER_MODEL ?? 'claude-opus-5';

/**
 * The model's answer.
 *
 * Note what is *not* here: no skill id, no recipe id, no params of any kind.
 * The model returns an **index into the candidate list** the mod supplied, and
 * the caller builds the objective from `candidates[index].params` verbatim.
 *
 * That makes authoring an invalid objective structurally impossible rather than
 * merely forbidden. A hallucinated recipe id cannot survive a integer index —
 * which matters, because a hand-written id is exactly the mistake that produced
 * "no tree registered with id melvorD:Normal_Tree" on the first live run.
 */
const PLANNER_CHOICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidateIndex', 'targetLevel', 'abortMinutes', 'rationale', 'reasoning'],
  properties: {
    candidateIndex: {
      type: 'integer',
      description: 'Zero-based index into the candidates list. Must be one of the listed indices.',
    },
    targetLevel: {
      type: 'integer',
      minimum: 1,
      maximum: 120,
      description: 'Skill level to reach before this objective is considered done.',
    },
    abortMinutes: {
      type: 'integer',
      minimum: 5,
      maximum: 720,
      description: 'Give up after this many minutes even if the target is not reached.',
    },
    rationale: {
      type: 'string',
      description: 'One sentence, for the operator log, on why this beats the alternatives.',
    },
    reasoning: {
      type: 'string',
      description: 'Two or three sentences of the actual reasoning, including what was rejected.',
    },
  },
} as const;

export interface PlannerChoice {
  candidateIndex: number;
  targetLevel: number;
  abortMinutes: number;
  rationale: string;
  reasoning: string;
}

/**
 * What the agent is for, stated once.
 *
 * Kept first and byte-stable so it caches: the render order is tools, then
 * system, then messages, and any change here invalidates everything after it.
 * The volatile snapshot goes in the user turn for the same reason.
 */
const SYSTEM = `You are the planner for an autonomous Melvor Idle agent that runs unattended for days.

The single most important thing to understand about this game: it already simulates up to 24 hours of offline progress for ONE running action. A player who leaves a good skill running and comes back tomorrow gets that for free, with the laptop shut.

So your value is not in choosing something to grind. It is in TRANSITIONS — noticing when the current activity has stopped being the best use of time, when a gathered resource should now be processed, when a purchase would unlock a better option, when a skill has hit a wall. If your choices look like "leave one skill running forever", you have added nothing over closing the game.

You will be given a list of candidate objectives. Every candidate is something the agent has already PROVEN it can execute right now — requirements met, materials affordable, recipe unlocked. You choose among them by index. You cannot invent one, and you should not try: anything not in the list is not currently possible.

How to choose well:
- Prefer a transition that unlocks or enables something over raw XP rate. Burning logs you just gathered beats cutting more logs you cannot use.
- Read the BLOCKED list. If a much better option is missing only an input you can produce, produce that input — even if it scores lower on its own. That two-step is usually the highest-value move available, and it is invisible if you only compare the candidates' own rates.
- Watch for a resource piling up unused in the bank. That is usually a signal to process or sell it.
- Do not re-propose something the journal shows was recently abandoned, unless the state that caused the abort has clearly changed.
- Set targetLevel to something reachable in roughly the time you allow, not a round number far away. An objective that never completes blocks every later decision.
- Set abortMinutes to a real budget. Without it the agent grinds into a wall for hours.

You may also be given memory: operator directives, long-term facts the agent has established, and notes from the last day or two. Treat operator directives as binding. Treat long-term memory as established unless the current state plainly contradicts it. Treat recent notes as observations, not conclusions — they are scratch, and a single note is not yet a fact.

Be decisive. A merely good choice made now beats a perfect one made after the agent has idled.`;

export interface PlannerUsage {
  inputTokens: number;
  outputTokens: number;
}

export type ClaudeResult =
  | { ok: true; choice: PlannerChoice; usage: PlannerUsage }
  | { ok: false; reason: string };

/**
 * Asks Claude to choose an objective.
 *
 * Returns a discriminated result rather than throwing: the caller falls back to
 * a deterministic heuristic on any failure, and an agent that stops playing
 * because a planning call failed is worse than one that plays slightly worse.
 *
 * @param request - Snapshot, candidates and journal digest from the mod.
 * @param client - Anthropic client, injected so tests need no network.
 * @param memory - Rendered memory block: operator directives, long-term facts,
 *                 recent notes. Empty when there is none.
 * @returns The model's choice, or a reason it could not be obtained.
 */
export async function chooseObjective(
  request: PlannerRequest,
  client: Anthropic,
  memory = '',
): Promise<ClaudeResult> {
  if (request.candidates.length === 0) {
    return { ok: false, reason: 'no candidates to choose from' };
  }

  try {
    const response = await client.messages.parse({
      model: MODEL,
      max_tokens: 4096,
      // Planning runs often and is a bounded comparison, not a research task.
      // `medium` is the cost-saving step-down that still holds quality here;
      // this is the lever to raise if the choices start looking careless.
      output_config: {
        effort: 'medium',
        format: jsonSchemaOutputFormat(PLANNER_CHOICE_SCHEMA),
      },
      // Stable-first so the prefix caches: the role never changes, memory
      // changes between sessions, and the snapshot changes every call. Putting
      // memory after the role means a memory edit invalidates only the tail.
      system:
        memory === ''
          ? [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }]
          : [
              { type: 'text', text: SYSTEM },
              { type: 'text', text: memory, cache_control: { type: 'ephemeral' } },
            ],
      messages: [{ role: 'user', content: renderRequest(request) }],
    });

    // A refusal is an HTTP 200 with no usable content, so `stop_reason` has to
    // be checked before reading the parse result.
    if (response.stop_reason === 'refusal') {
      return {
        ok: false,
        reason: `model refused: ${response.stop_details?.category ?? 'unknown category'}`,
      };
    }

    const choice = response.parsed_output as PlannerChoice | null | undefined;
    if (choice === null || choice === undefined) {
      return { ok: false, reason: 'model returned no parseable choice' };
    }

    // The index is the one field the schema cannot constrain, since the valid
    // range changes per request. Out of range is a hallucination, not a choice.
    if (choice.candidateIndex < 0 || choice.candidateIndex >= request.candidates.length) {
      return {
        ok: false,
        reason: `candidateIndex ${choice.candidateIndex} is outside 0..${request.candidates.length - 1}`,
      };
    }

    return {
      ok: true,
      choice,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

/** Renders the volatile half of the prompt: state, options, history. */
function renderRequest(request: PlannerRequest): string {
  const { snapshot } = request;
  const gp = snapshot.currencies.find((c) => c.id === 'melvorD:GP')?.amount ?? 0;

  const skills = snapshot.skills
    .filter((skill) => skill.level > 1)
    .sort((a, b) => b.level - a.level)
    .map((skill) => `${skill.name} ${skill.level}`)
    .join(', ');

  // Only the top of the bank: a full inventory is mostly noise, and the signal
  // the planner needs is "what has piled up", which the largest stacks carry.
  const bank = [...snapshot.bank.items]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 15)
    .map((item) => `${item.qty}x ${item.name}`)
    .join(', ');

  const farm = summariseFarm(snapshot.farm);

  return [
    `Trigger for this replan: ${request.trigger}`,
    '',
    '## Character',
    `Total level ${snapshot.totalLevel}, completion ${snapshot.completionPercent.toFixed(2)}%, GP ${gp.toLocaleString()}`,
    `Skills above level 1: ${skills || '(none)'}`,
    `Currently doing: ${snapshot.activeAction?.name ?? 'nothing'}`,
    `Bank ${snapshot.bank.slotsUsed}/${snapshot.bank.slotsMax} slots. Largest stacks: ${bank || '(empty)'}`,
    `Farm: ${farm}`,
    `Combat: HP ${snapshot.combat.hitpoints}/${snapshot.combat.maxHitpoints}, auto-eat ${snapshot.combat.autoEatThreshold > 0 ? 'owned' : 'NOT owned'}`,
    '',
    '## Candidates (choose one by index)',
    ...request.candidates.map((candidate, index) => `${index}. ${describeCandidate(candidate)}`),
    '',
    ...renderBlocked(request.blockedOpportunities ?? []),
    '## Recent history',
    renderDigest(request.digest),
  ].join('\n');
}

/**
 * Renders the blocked list.
 *
 * This is what lets the planner reason about prerequisites. Without it the best
 * available move often looks worse than it is: cutting oak scores 13k xp/h on
 * its own and is worth far more once you see it unlocks burning oak at 72k.
 */
function renderBlocked(
  blocked: {
    label: string;
    xpPerHour: number;
    missing: { name: string; need: number; have: number }[];
  }[],
): string[] {
  if (blocked.length === 0) return [];
  return [
    '## Blocked — higher value, missing an input (NOT selectable)',
    'Producing one of these inputs is often the best move available.',
    ...blocked.map(
      (entry) =>
        `- ${entry.label} — ${Math.round(entry.xpPerHour).toLocaleString()} xp/h — needs ${entry.missing
          .map((m) => `${m.need}x ${m.name} (have ${m.have})`)
          .join(', ')}`,
    ),
    '',
  ];
}

function describeCandidate(candidate: Candidate): string {
  const parts = [candidate.label];
  if (candidate.xpPerHour !== undefined && candidate.xpPerHour > 0) {
    parts.push(`${Math.round(candidate.xpPerHour).toLocaleString()} xp/h`);
  }
  if (candidate.gpPerHour !== undefined && candidate.gpPerHour > 0) {
    parts.push(`${Math.round(candidate.gpPerHour).toLocaleString()} gp/h`);
  }
  if (candidate.requiresLevel !== undefined) parts.push(`needs level ${candidate.requiresLevel}`);
  return parts.join(' — ');
}

function summariseFarm(farm: { state: string }[]): string {
  if (farm.length === 0) return 'no plots';
  const counts = farm.reduce<Record<string, number>>((acc, plot) => {
    acc[plot.state] = (acc[plot.state] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(', ');
}

/**
 * Renders the journal digest.
 *
 * Recent attempts verbatim, older ones as aggregate lines — feeding the whole
 * history would eat the context budget, and re-proposing what was abandoned
 * yesterday is the specific failure this exists to prevent.
 */
function renderDigest(digest: JournalDigest): string {
  if (digest.recent.length === 0 && digest.aggregates.length === 0) {
    return '(nothing attempted yet)';
  }

  const lines: string[] = [];

  for (const entry of digest.recent) {
    const minutes = Math.round((entry.endedAt - entry.startedAt) / 60_000);
    lines.push(
      `- ${entry.objective.kind} "${entry.objective.rationale}" → ${entry.outcome} after ${minutes}min (levels ${entry.deltas.totalLevel >= 0 ? '+' : ''}${entry.deltas.totalLevel}, gp ${entry.deltas.gp >= 0 ? '+' : ''}${entry.deltas.gp})`,
    );
  }

  for (const aggregate of digest.aggregates) {
    lines.push(
      `- earlier: ${aggregate.kind} attempted ${aggregate.attempts}x (${aggregate.completed} completed, ${aggregate.aborted} aborted, median ${Math.round(aggregate.medianMinutes)}min)`,
    );
  }

  return lines.join('\n');
}

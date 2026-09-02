import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * The queued plan, and the clock on the objective running.
 *
 * The report carried a *count* of queued steps, which answers exactly one
 * question — gap or stop — and cannot answer the next one: is any of it still
 * right. Steps are chosen against the candidate list as it stood when the plan
 * was written, so a session could neither see a stale step nor revise one, and
 * its only lever was to replace the whole plan.
 */

const CHOP = {
  kind: 'gather_resource',
  params: { kind: 'gather_resource', skillId: 'melvorD:Woodcutting', recipeId: 'melvorD:Oak_Tree' },
  label: 'Woodcutting: Oak',
  available: true,
} as const;

const SMELT = {
  kind: 'gather_resource',
  params: { kind: 'gather_resource', skillId: 'melvorD:Smithing', recipeId: 'melvorD:Bronze_Bar' },
  label: 'Smithing: Bronze Bar',
  available: true,
} as const;

function step(candidate: typeof CHOP, rationale: string) {
  return {
    id: `plan-${rationale}`,
    kind: candidate.kind,
    params: candidate.params,
    successWhen: [
      { type: 'skill_level_at_least', skillId: candidate.params.skillId, level: 40 } as const,
    ],
    abortWhen: { minutesExceed: 60 },
    expectedDurationMin: 60,
    rationale,
  };
}

function storeWith(report: Record<string, unknown>) {
  return {
    report: {
      runState: 'running',
      blockedReason: null,
      candidates: [],
      plan: [],
      objective: null,
      objectiveStartedAt: null,
      quality: [],
      logs: [],
      journalEntries: [],
      blockedOpportunities: [],
      snapshot: {
        characterName: 'test',
        gameVersion: 'v1.3.1',
        totalLevel: 98,
        completionPercent: 0.79,
        currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 100 }],
        skills: [],
        bank: { slotsUsed: 1, slotsMax: 20, items: [] },
        activeAction: null,
        combat: { hitpoints: 10, maxHitpoints: 10, autoEatThreshold: 0 },
      },
      ...report,
    },
    reportAgeMs: 100,
    readQuality: async () => [],
    rememberShownCandidates() {},
  };
}

describe('the queued plan in get_agent_state', () => {
  it('names every queued step rather than counting them', async () => {
    const store = storeWith({
      candidates: [CHOP, SMELT],
      plan: [step(CHOP, 'cut oak for the bars'), step(SMELT, 'smelt what was cut')],
    });

    const text = await TOOLS.get_agent_state!({}, { store, memoryRoot: '.' } as never);

    expect(text).toContain('cut oak for the bars');
    expect(text).toContain('smelt what was cut');
    expect(text).toContain('to level 40');
  });

  it('flags a step whose choice is no longer offered', async () => {
    // Identity is kind plus params, the same test the choice guard uses.
    // Comparing labels would flag every step on every read, because labels
    // carry live numbers — which is how a warning becomes noise.
    const store = storeWith({
      candidates: [CHOP],
      plan: [step(CHOP, 'still available'), step(SMELT, 'gone')],
    });

    const text = await TOOLS.get_agent_state!({}, { store, memoryRoot: '.' } as never);
    const lines = text.split('\n');

    expect(lines.find((line) => line.includes('still available'))).not.toContain('STALE');
    expect(lines.find((line) => line.includes('gone'))).toContain('STALE');
  });

  it('reports how long the current objective has been running', async () => {
    const store = storeWith({
      objective: step(CHOP, 'cutting oak'),
      objectiveStartedAt: Date.now() - 25 * 60_000,
    });

    const text = await TOOLS.get_agent_state!({}, { store, memoryRoot: '.' } as never);

    expect(text).toContain('25min in');
  });
});

describe('the commitment floor', () => {
  function swapStore(startedMinutesAgo: number) {
    const queued: unknown[] = [];
    return {
      queued,
      report: {
        snapshot: null,
        candidates: [CHOP],
        objective: step(SMELT, 'the objective being replaced'),
        objectiveStartedAt: Date.now() - startedMinutesAgo * 60_000,
      },
      rememberShownCandidates() {},
      resolveChoice: (index: number) => ({ index, moved: false }),
      enqueue(command: unknown) {
        queued.push(command);
      },
    };
  }

  it('warns when an objective is replaced minutes after it started', async () => {
    const store = swapStore(2);

    const text = await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 40, abortMinutes: 60, rationale: 'better number' },
      { store } as never,
    );

    expect(text).toContain('the objective being replaced');
    // A warning, never a refusal: the pull is real in both directions and the
    // operator is told rather than overruled.
    expect(store.queued).toHaveLength(1);
  });

  it('says nothing once the objective has held for a while', async () => {
    const store = swapStore(45);

    const text = await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 40, abortMinutes: 60, rationale: 'time to move on' },
      { store } as never,
    );

    expect(text).not.toContain('the objective being replaced');
  });

  it('is silenced by an explicit urgent flag', async () => {
    const store = swapStore(1);

    const text = await TOOLS.set_objective!(
      {
        candidateIndex: 0,
        targetLevel: 40,
        abortMinutes: 60,
        rationale: 'the fight is going badly',
        urgent: true,
      },
      { store } as never,
    );

    expect(text).not.toContain('the objective being replaced');
  });
});

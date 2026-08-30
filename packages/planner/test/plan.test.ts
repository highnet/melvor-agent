import { plannerRequestSchema, plannerResponseSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { plan } from '../src/plan.js';
import { Store } from '../src/store.js';

const snapshot = {
  capturedAt: 1_700_000_000_000,
  gameVersion: 'v1.3.1',
  characterName: 'throwaway',
  gamemodeId: 'melvorD:Standard',
  currentRealmId: 'melvorD:Melvor',
  isOfflineLoop: false,
  totalLevel: 120,
  completionPercent: 1.5,
  currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 1000 }],
  skills: [
    { id: 'melvorD:Woodcutting', name: 'Woodcutting', level: 13, xp: 1800, isActive: false },
  ],
  bank: { slotsUsed: 0, slotsMax: 20, items: [] },
  activeAction: null,
  combat: {
    inCombat: false,
    hitpoints: 100,
    maxHitpoints: 100,
    prayerPoints: 0,
    autoEatThreshold: 0,
    autoEatHPLimit: 0,
    autoEatEfficiency: 0,
    maxHit: 10,
    minHit: 1,
    accuracy: 100,
    attackInterval: 2600,
    maxBarrier: 0,
    combatLevel: 12,
    food: [],
    selectedEquipmentSet: 0,
    equipment: [],
    enemy: null,
  },
};

function candidate(label: string, xpPerHour: number, recipeId: string) {
  return {
    kind: 'gather_resource' as const,
    params: { kind: 'gather_resource' as const, skillId: 'melvorD:Woodcutting', recipeId },
    label,
    xpPerHour,
    gpPerHour: 10,
    requiresLevel: 1,
    available: true as const,
  };
}

function request(candidates: ReturnType<typeof candidate>[]) {
  return plannerRequestSchema.parse({
    snapshot,
    candidates,
    digest: { recent: [], aggregates: [] },
    trigger: 'game_start',
  });
}

describe('plan', () => {
  it('chooses the highest XP/hr candidate', async () => {
    const response = await plan(
      request([
        candidate('Normal', 100, 'melvorD:Normal_Tree'),
        candidate('Oak', 300, 'melvorD:Oak_Tree'),
      ]),
    );
    expect(response.objectives).toHaveLength(1);
    expect(response.objectives[0]?.params).toMatchObject({ recipeId: 'melvorD:Oak_Tree' });
  });

  it('emits only objectives whose params came from a candidate', async () => {
    // The planner chooses among candidates; it must never author params of its
    // own. Anything else is a capability the policy layer may not have.
    const only = candidate('Normal', 100, 'melvorD:Normal_Tree');
    const response = await plan(request([only]));
    expect(response.objectives[0]?.params).toEqual(only.params);
  });

  it('returns no objectives rather than inventing one when nothing is reachable', async () => {
    const response = await plan(request([]));
    expect(response.objectives).toEqual([]);
    expect(response.reasoning).toContain('no candidates');
  });

  it('produces responses that survive the same validation the mod applies', async () => {
    const response = await plan(request([candidate('Normal', 100, 'melvorD:Normal_Tree')]));
    expect(plannerResponseSchema.safeParse(response).success).toBe(true);
  });

  it('sets a time budget on every objective it emits', async () => {
    // Without abort conditions the agent grinds into a wall for six hours.
    const response = await plan(request([candidate('Normal', 100, 'melvorD:Normal_Tree')]));
    for (const objective of response.objectives) {
      expect(objective.abortWhen.minutesExceed).toBeGreaterThan(0);
    }
  });
});

describe('journal digest', () => {
  it('keeps recent entries verbatim and rolls the rest into aggregates', () => {
    const store = new Store('./data-test');
    const base = {
      objective: {
        id: 'x',
        kind: 'gather_resource' as const,
        params: {
          kind: 'gather_resource' as const,
          skillId: 'melvorD:Woodcutting',
          recipeId: 'melvorD:Normal_Tree',
        },
        successWhen: [
          { type: 'skill_level_at_least' as const, skillId: 'melvorD:Woodcutting', level: 20 },
        ],
        abortWhen: { minutesExceed: 60 },
        expectedDurationMin: 30,
        rationale: 'test',
      },
      startedAt: 1,
      endedAt: 60_001,
      deltas: { totalLevel: 1, gp: 10, deaths: 0 },
    };

    for (let i = 0; i < 15; i += 1) {
      store.addJournalEntry({ ...base, outcome: i % 2 === 0 ? 'completed' : 'aborted_budget' });
    }

    const digest = store.digest(10);
    expect(digest.recent).toHaveLength(10);
    // The other 5 must survive as counts, not vanish.
    expect(digest.aggregates).toHaveLength(1);
    expect(digest.aggregates[0]?.attempts).toBe(5);
    expect((digest.aggregates[0]?.completed ?? 0) + (digest.aggregates[0]?.aborted ?? 0)).toBe(5);
  });
});

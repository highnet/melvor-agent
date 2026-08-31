import { stateSnapshotSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { manage } from '../src/policy/manage.js';
import { objective, snapshot } from './fixtures.js';

const HUT = 'melvorF:Basic_Hut';
const GRASSLANDS = 'melvorF:Grasslands';

function context(params: { kind: 'build_township' | 'repair_township' }) {
  const snap = snapshot();
  return {
    snapshot: snap,
    objective: objective({
      kind: params.kind,
      params: { kind: params.kind, buildingId: HUT, biomeId: GRASSLANDS },
      successWhen: [],
    }),
    now: snap.capturedAt,
    objectiveStartedAt: snap.capturedAt,
    deathsSinceStart: 0,
  };
}

describe('township objectives', () => {
  it('builds once and completes, rather than building every tick', () => {
    // Without completeAfter the policy would re-issue the intent on each tick
    // and drain the town's resources into a wall of huts.
    expect(manage(context({ kind: 'build_township' }))).toEqual({
      kind: 'act',
      actions: [{ type: 'build_township', buildingId: HUT, biomeId: GRASSLANDS }],
      reason: `building ${HUT} in ${GRASSLANDS}`,
      completeAfter: true,
    });
  });

  it('repairs through the same one-shot path', () => {
    expect(manage(context({ kind: 'repair_township' }))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'repair_township', buildingId: HUT, biomeId: GRASSLANDS }],
      completeAfter: true,
    });
  });

  it('does not touch the town while offline progress is resolving', () => {
    const offline = { ...context({ kind: 'build_township' }) };
    offline.snapshot = { ...offline.snapshot, isOfflineLoop: true };
    expect(manage(offline)).toMatchObject({ kind: 'idle', reason: 'waiting_for_game' });
  });
});

describe('township snapshot', () => {
  it('accepts a town and accepts its absence', () => {
    // A character who never created a town is the common case, and it has to
    // validate as cleanly as one who did — the schema is what blocks the agent
    // when it fails.
    expect(stateSnapshotSchema.safeParse(snapshot()).success).toBe(true);

    const withTown = snapshot({
      township: {
        created: true,
        level: 12,
        population: 340,
        happiness: 55,
        education: 20,
        healthPercent: 100,
        storageUsed: 4000,
        storageMax: 50_000,
        worship: 'Aeris',
        season: 'Spring',
        resources: [{ id: 'melvorF:Wood', name: 'Wood', amount: 1200, cap: 50_000 }],
      },
    });
    expect(stateSnapshotSchema.safeParse(withTown).success).toBe(true);
  });
});

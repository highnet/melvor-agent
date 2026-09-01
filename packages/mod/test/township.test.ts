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
  it('keeps building rather than stopping after one', () => {
    // This asserted the opposite until Township level turned out to gate the
    // biome Herblore needs. Completing after a single building meant a town
    // could only grow while a planner sat queueing each one, which an
    // unattended agent has no way to do.
    //
    // The original fear — re-issuing every tick and draining the town into a
    // wall of huts — is real, and is now answered where it belongs: the
    // adapter refuses to build unless the town can afford four, so a batch
    // goes up while it is comfortable and stops with a reserve intact.
    expect(manage(context({ kind: 'build_township' }))).toEqual({
      kind: 'act',
      actions: [{ type: 'build_township', buildingId: HUT, biomeId: GRASSLANDS }],
      reason: `building ${HUT} in ${GRASSLANDS}`,
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

describe('building repeats rather than completing after one', () => {
  it('does not mark itself complete after a single building', () => {
    // A town grows by building many times. Completing after one meant Township
    // could only advance while a planner sat queueing each building, which is
    // exactly what an unattended agent does not have — and Township level is
    // what gates the biome that Herblore needs.
    const decision = manage({
      snapshot: snapshot({}),
      objective: objective({
        kind: 'build_township',
        params: {
          kind: 'build_township',
          buildingId: 'melvorF:Basic_Shelter',
          biomeId: 'melvorF:Grasslands',
        },
        successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Township', level: 5 }],
      }),
      now: 0,
      objectiveStartedAt: 0,
      deathsSinceStart: 0,
    });

    expect(decision).toMatchObject({ kind: 'act' });
    expect(decision).not.toHaveProperty('completeAfter', true);
  });

  it('leaves genuine one-shots completing after one action', () => {
    // Setting an attack style is a decision taken once; the distinction is the
    // whole point of the change.
    const decision = manage({
      snapshot: snapshot({}),
      objective: objective({
        kind: 'set_attack_style',
        params: {
          kind: 'set_attack_style',
          attackTypeId: 'melee',
          styleId: 'melvorD:Stab',
        },
        successWhen: [],
      }),
      now: 0,
      objectiveStartedAt: 0,
      deathsSinceStart: 0,
    });

    expect(decision).toMatchObject({ kind: 'act', completeAfter: true });
  });
});

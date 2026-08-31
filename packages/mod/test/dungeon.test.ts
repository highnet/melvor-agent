import { describe, expect, it } from 'vitest';
import { fightMonster } from '../src/policy/fight.js';
import { objective, snapshot } from './fixtures.js';

const DUNGEON = 'melvorD:Chicken_Coop';

function dungeonObjective() {
  return objective({
    kind: 'run_dungeon',
    params: { kind: 'run_dungeon', dungeonId: DUNGEON },
    successWhen: [{ type: 'item_qty_at_least', itemId: 'melvorD:Normal_Logs', qty: 100_000 }],
  });
}

function context(snap = snapshot()) {
  return {
    snapshot: snap,
    objective: dungeonObjective(),
    now: snap.capturedAt,
    objectiveStartedAt: snap.capturedAt,
    deathsSinceStart: 0,
  };
}

describe('dungeon objectives', () => {
  it('emits a run_dungeon action rather than an engage', () => {
    const decision = fightMonster(context());
    expect(decision).toMatchObject({
      kind: 'act',
      actions: [{ type: 'run_dungeon', dungeonId: DUNGEON }],
    });
  });

  it('applies the same runtime backup as a monster fight', () => {
    // A dungeon run that has become unsurvivable must break off for the same
    // reasons a single fight would: the gate proved it safe before it started,
    // not that it stayed safe.
    const hurt = snapshot({
      combat: {
        ...snapshot().combat,
        inCombat: true,
        hitpoints: 20,
        food: [{ id: 'melvorD:Shrimp', name: 'Shrimp', qty: 50 }],
      },
    });

    expect(fightMonster(context(hurt))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'disengage' }],
    });
  });

  it('waits while offline progress is still resolving', () => {
    const offline = snapshot({ isOfflineLoop: true });
    expect(fightMonster(context(offline))).toMatchObject({ kind: 'idle' });
  });
});

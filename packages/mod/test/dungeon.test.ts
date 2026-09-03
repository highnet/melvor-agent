import { describe, expect, it } from 'vitest';
import { fightMonster } from '../src/policy/fight.js';
import { objective, snapshot } from './fixtures.js';

const DUNGEON = 'melvorD:Chicken_Coop';

/**
 * A character the floors have no objection to.
 *
 * The shared fixture equips no food at all, which since the floors began
 * gating *entry* as well as exit is a state in which starting a fight is
 * refused — correctly, and for the same reason the survivability gate refuses
 * one: an empty slot is no sustain argument. These two cases are about routing
 * (a dungeon rather than an engage, and clearing the action slot), so they need
 * a character who is allowed to fight at all.
 */
function fightable(overrides: Record<string, unknown> = {}) {
  const base = snapshot();
  return snapshot({
    ...overrides,
    combat: {
      ...base.combat,
      food: [{ itemId: 'melvorD:Shrimp', itemName: 'Shrimp', qty: 50, healsFor: 30 }],
    },
  });
}

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
    const decision = fightMonster(context(fightable()));
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
        // `id`/`name` here for a long time, which are not the field names
        // `foodSlotStateSchema` uses — so the slot read as empty food and the
        // disengage below could have been proving the wrong thing.
        food: [{ itemId: 'melvorD:Shrimp', itemName: 'Shrimp', qty: 50, healsFor: 30 }],
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

describe('switching into combat', () => {
  it('stops a running skill instead of waiting behind it', () => {
    // Melvor runs one action at a time, so a skill still running is not a
    // reason to wait — it is the thing to clear. Waiting meant a fight
    // objective set while the character was fishing did nothing, silently.
    const fishing = fightable({
      activeAction: {
        id: 'melvorD:Fishing',
        name: 'Fishing',
        isActive: true,
        recipeIds: ['melvorD:Raw_Shrimp'],
      },
    });

    expect(fightMonster(context(fishing))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'stop_gathering', skillId: 'melvorD:Fishing' }],
    });
  });
});

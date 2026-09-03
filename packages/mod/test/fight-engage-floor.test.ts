import { describe, expect, it } from 'vitest';
import { fightMonster } from '../src/policy/fight.js';
import { objective, snapshot } from './fixtures.js';

/**
 * The health a fight may be *started* at.
 *
 * The gap this closes killed the character twice in eight minutes. Deaths 56
 * and 57, each three log lines in the same second:
 *
 *     character died (1 since last check); clearing the objective
 *     plan advanced (1 left): Fight Sweaty Monster
 *     combat.engage ok — inCombat false -> true
 *
 * The disengage floor cannot catch it: that branch is guarded by
 * `if (combat.inCombat)`, and this is the tick before it becomes true.
 */
const MONSTER = 'melvorD:Leech';

function fightObjective() {
  return objective({
    kind: 'fight_monster',
    params: { kind: 'fight_monster', monsterId: MONSTER, areaId: 'melvorD:Wet_Forest' },
    successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Hitpoints', level: 40 }],
  });
}

/** Out of combat at `hitpoints`, with an auto eater and a full larder. */
function idleAt(hitpoints: number) {
  const base = snapshot();
  return {
    ...base,
    activeAction: null,
    combat: {
      ...base.combat,
      inCombat: false,
      hitpoints,
      maxHitpoints: 150,
      autoEatThreshold: 30,
      food: [{ itemId: 'melvorD:Seahorse', itemName: 'Seahorse', qty: 200, healsFor: 130 }],
    },
  };
}

function decide(snap: ReturnType<typeof idleAt>) {
  return fightMonster({
    snapshot: snap,
    objective: fightObjective(),
    now: snap.capturedAt,
    objectiveStartedAt: snap.capturedAt,
    deathsSinceStart: 0,
  });
}

describe('starting a fight', () => {
  it('waits rather than engaging on a corpse\u2019s worth of health', () => {
    // 38 of 150 is 25% — the exact reading when death 56 was followed by an
    // engage in the same second.
    expect(decide(idleAt(38))).toMatchObject({ kind: 'idle' });
  });

  it('still waits above the disengage floor but below the engage floor', () => {
    // The asymmetry is the point: 60% is fine to keep fighting at and not a
    // sane place to start. Without it a character hovering at the leave floor
    // re-enters the moment it ticks a point above it.
    expect(decide(idleAt(90))).toMatchObject({ kind: 'idle' });
  });

  it('engages when healthy', () => {
    expect(decide(idleAt(150))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'engage', monsterId: MONSTER }],
    });
  });
});

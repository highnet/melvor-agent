import { describe, expect, it } from 'vitest';
import { fightMonster } from '../src/policy/fight.js';
import { objective, snapshot } from './fixtures.js';

/**
 * The HP floor, against an auto eater.
 *
 * The live failure this pins: a flat 50% floor with an auto eater triggering at
 * 30% left the character oscillating in the band between them —
 * `combat.engage ok` / `combat.disengage ok` alternating on the 3s policy clock
 * for minutes, HP hovering near 43%, too low for the policy to keep fighting
 * and too high for Auto Eat to heal. It never ate and it never fought.
 */
const MONSTER = 'melvorD:Leech';

function fightObjective() {
  return objective({
    kind: 'fight_monster',
    params: { kind: 'fight_monster', monsterId: MONSTER, areaId: 'melvorD:Wet_Forest' },
    successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Hitpoints', level: 40 }],
  });
}

/** A snapshot mid-fight at `hitpoints`, with an auto eater and a full larder. */
function fighting(hitpoints: number, autoEatThreshold: number, meals = 200) {
  const base = snapshot();
  return {
    ...base,
    combat: {
      ...base.combat,
      inCombat: true,
      hitpoints,
      maxHitpoints: 150,
      autoEatThreshold,
      food: [{ itemId: 'melvorD:Seahorse', itemName: 'Seahorse', qty: meals, healsFor: 130 }],
    },
  };
}

function decide(snap: ReturnType<typeof fighting>) {
  return fightMonster({
    snapshot: snap,
    objective: fightObjective(),
    now: snap.capturedAt,
    objectiveStartedAt: snap.capturedAt,
    deathsSinceStart: 0,
  });
}

describe('the HP floor when an auto eater is owned', () => {
  it('keeps fighting in the band above the eater trigger', () => {
    // 69 of 150 is 46% — under the old flat 50% floor, and the exact reading
    // that produced the live loop. Auto Eat fires at 30%, so nothing has gone
    // wrong yet and there is no reason to leave.
    expect(decide(fighting(69, 30))).toMatchObject({ kind: 'idle' });
  });

  it('disengages once HP falls below what the eater guarantees', () => {
    // 30 of 150 is 20%, under the 30% trigger less the margin: the eater is
    // not keeping up, which is evidence rather than a guess.
    expect(decide(fighting(30, 30))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'disengage' }],
    });
  });

  it('keeps the flat floor when no eater is owned', () => {
    // autoEatThreshold 0 means no auto-eat owned, per the schema. HP only
    // recovers between fights, so half a bar is the sane place to stop.
    expect(decide(fighting(69, 0))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'disengage' }],
    });
  });

  it('keeps the flat floor when the larder is empty, eater or not', () => {
    // An eater with nothing to eat is not a sustain argument.
    expect(decide(fighting(69, 30, 0))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'disengage' }],
    });
  });
});

import { describe, expect, it } from 'vitest';
import { fightMonster } from '../src/policy/fight.js';
import { objective, snapshot } from './fixtures.js';

/**
 * A safety floor has to govern *starting* a fight, not only leaving one.
 *
 * The live failure: `combat.engage ok` / `combat.disengage ok` alternating on
 * the 3s policy clock for seventeen minutes across two game reloads, no kills,
 * no XP, no GP. Both floors lived inside the `inCombat` branch, so a crossing
 * ended the current fight and was then never consulted again — the next tick
 * found combat stopped, skipped the floors and engaged, and the tick after
 * crossed the same floor and stopped. The give-away in the log is that the
 * first engage of an episode holds 42s and 24s and every later one holds
 * exactly 3.0s: one policy tick.
 *
 * These drive the real executor over consecutive ticks, because a single tick
 * cannot express the bug — each individual decision was correct.
 */
const MONSTER = 'melvorD:Leech';
const AREA = 'melvorD:Wet_Forest';

function fightObjective() {
  return objective({
    kind: 'fight_monster',
    params: { kind: 'fight_monster', monsterId: MONSTER, areaId: AREA },
    successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Hitpoints', level: 40 }],
  });
}

/**
 * @param inCombat - Whether the game is fighting at this tick.
 * @param hitpoints - Current HP against a 150 bar.
 * @param meals - Items across the equipped food slots.
 */
function state(inCombat: boolean, hitpoints: number, meals: number) {
  const base = snapshot();
  return {
    ...base,
    combat: {
      ...base.combat,
      inCombat,
      hitpoints,
      maxHitpoints: 150,
      autoEatThreshold: 30,
      food: [{ itemId: 'melvorD:Seahorse', itemName: 'Seahorse', qty: meals, healsFor: 130 }],
    },
  };
}

function decide(snap: ReturnType<typeof state>) {
  return fightMonster({
    snapshot: snap,
    objective: fightObjective(),
    now: snap.capturedAt,
    objectiveStartedAt: snap.capturedAt,
    deathsSinceStart: 0,
  });
}

describe('a crossed floor stops the fight from restarting', () => {
  it('does not re-engage on the tick after an HP-floor disengage', () => {
    // 30 of 150 is 20%, below the 25% the eater guarantees: a real crossing.
    const leaving = decide(state(true, 30, 200));
    expect(leaving).toMatchObject({ kind: 'act', actions: [{ type: 'disengage' }] });

    // The next tick, with the disengage taken and nothing else changed. This
    // is the tick that used to engage.
    const next = decide(state(false, 30, 200));
    expect(next.kind).toBe('idle');
    expect(next).toMatchObject({ reason: 'waiting_to_recover' });
  });

  it('does not re-engage on the tick after a food-floor disengage', () => {
    // Four meals across the slots, under the floor of five. HP is healthy, so
    // this is the food floor alone and nothing else.
    const leaving = decide(state(true, 140, 4));
    expect(leaving).toMatchObject({ kind: 'act', actions: [{ type: 'disengage' }] });

    const next = decide(state(false, 140, 4));
    expect(next.kind).toBe('idle');
  });

  it('names the floor it is waiting on, so the wait is diagnosable', () => {
    // Silence is what the live loop produced: seventeen minutes of verified
    // calls and no statement anywhere of which condition was driving them.
    const waiting = decide(state(false, 30, 200));
    expect(waiting).toMatchObject({ kind: 'idle' });
    expect('detail' in waiting && waiting.detail).toContain('below floor');
  });

  it('engages again once the floor clears', () => {
    // Standing still is a wait, not a refusal: HP regenerates out of combat and
    // the food reflexes restock the slot. The objective must resume by itself.
    expect(decide(state(false, 140, 200))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'engage', monsterId: MONSTER, areaId: AREA }],
    });
  });

  it('still fights when no floor is crossed', () => {
    expect(decide(state(true, 140, 200))).toMatchObject({
      kind: 'idle',
      reason: 'already_running',
    });
  });
});

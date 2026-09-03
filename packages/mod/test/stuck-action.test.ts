import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, resetActLedger } from '../src/adapter/act.js';

/**
 * The ledger in `act` that notices an action failing the same way forever.
 *
 * Four loops were found by hand on 2026-09-03, each after running for a long
 * time while every tier above the adapter read it as work: Agility stopping and
 * starting every three seconds for zero XP, Alt Magic casting and stopping
 * every two, the gear reflex re-equipping every 1.5, and Township repair once a
 * minute for a whole day. The shape is exact — the call reads a selection it
 * does not take, and for an agent that never clicks a UI that selection is
 * absent — and every one of them produced a truthful `no_state_change` on its
 * very first call. What was missing is that nothing remembered the second.
 *
 * So the fakes here transcribe the shipped early return rather than
 * paraphrasing the action. A fake that simply succeeded would have been green
 * for the whole life of the township bug, which is what made
 * `township-repair.test.ts` worth writing.
 */

const never = (): boolean => false;

/**
 * `Township.repairBuilding`, transcribed from the shipped v1.3.1 source: the
 * biome comes from `currentTownBiome` (township.d.ts:423) and an absent one is
 * a silent no-op — nothing spent, nothing thrown, no notification.
 */
class FakeTownship {
  currentTownBiome?: { id: string };
  efficiency = 85;
  spent = 0;

  repairBuilding(): void {
    if (this.currentTownBiome === undefined) return;
    this.spent += 10;
    this.efficiency = 100;
  }
}

/** The repair as the reflex issues it, against whatever town it is handed. */
const repair = (township: FakeTownship) =>
  act(
    {
      name: 'reflex.repairTownship',
      observe: () => ({
        buildingId: 'melvorF:Miners_Pit',
        biomeId: 'melvorF:Mountains',
        efficiency: township.efficiency,
      }),
      perform: () => township.repairBuilding(),
      changed: (before, after) => after.efficiency > before.efficiency,
    },
    never,
  );

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetActLedger();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('an action that keeps failing against an unmoved projection', () => {
  it('says nothing for the first four, then reports once on the fifth', () => {
    const township = new FakeTownship();

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = repair(township);
      expect(result.ok).toBe(false);
      // The first four are honest single failures. Reporting them would be the
      // noise that buried this diagnostic for a day in the first place.
      expect(result.detail).not.toContain('STUCK');
    }

    const fifth = repair(township);
    expect(fifth.detail).toContain('STUCK');
    expect(fifth.detail).toContain('reflex.repairTownship');
    // The count, so the line says how long this has been going on.
    expect(fifth.detail).toContain('5 times in a row');
    // And the projection that did not move, which is what identifies the bug.
    expect(fifth.detail).toContain('"efficiency":85');
    expect(warn).toHaveBeenCalledTimes(1);

    // Once on the transition, not once per pass: the sixth through tenth calls
    // are as stuck as the fifth and must not add a word.
    for (let attempt = 6; attempt <= 10; attempt += 1) {
      expect(repair(township).detail).not.toContain('STUCK');
    }
    expect(warn).toHaveBeenCalledTimes(1);

    // Nothing was ever spent, which is the whole point: this is a report, not
    // a refusal, and the call still runs every time.
    expect(township.spent).toBe(0);
  });

  it('reports again after the same action gets stuck on a different projection', () => {
    const township = new FakeTownship();
    for (let attempt = 1; attempt <= 5; attempt += 1) repair(township);
    expect(warn).toHaveBeenCalledTimes(1);

    // A different building degrading to a different efficiency is a new loop,
    // and a new loop is worth a line even for an action already known bad.
    township.efficiency = 40;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(repair(township).detail).not.toContain('STUCK');
    }
    expect(repair(township).detail).toContain('"efficiency":40');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('forgets the run as soon as the action works', () => {
    const township = new FakeTownship();
    for (let attempt = 1; attempt <= 4; attempt += 1) repair(township);

    // The town page opens — the fix `withTownBiome` makes permanent — and the
    // repair lands. A ledger that kept counting across that would report a
    // healthy action, which is worse than reporting nothing.
    township.currentTownBiome = { id: 'melvorF:Mountains' };
    expect(repair(township).ok).toBe(true);
    expect(township.spent).toBe(10);

    township.efficiency = 85;
    // Absent, not `undefined`: `exactOptionalPropertyTypes` makes them
    // different things, and the game reads an absent biome as "viewing all
    // biomes" — the state an agent that never clicks is always in.
    // biome-ignore lint/performance/noDelete: assigning undefined is a different state.
    delete township.currentTownBiome;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(repair(township).detail).not.toContain('STUCK');
    }
    expect(warn).not.toHaveBeenCalled();
    expect(repair(township).detail).toContain('STUCK');
  });

  it('keeps one action clear of another', () => {
    const town = new FakeTownship();
    const cast = () =>
      act(
        {
          name: 'altMagic.cast',
          observe: () => ({ skillId: 'melvorD:Magic', active: false }),
          perform: () => undefined,
          changed: (_before, after) => after.active,
        },
        never,
      );

    // Interleaved, because that is how they arrive: the reflex tick and the
    // policy tick land alternately, and a single shared counter would report
    // the wrong action at half the threshold.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(repair(town).detail).not.toContain('STUCK');
      expect(cast().detail).not.toContain('STUCK');
    }
    expect(warn).not.toHaveBeenCalled();

    expect(repair(town).detail).toContain('reflex.repairTownship');
    expect(cast().detail).toContain('altMagic.cast');
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

/**
 * The blind spot the identical-projection key has, and the counter that covers
 * it.
 *
 * `equipment.eatFood` projects live hitpoints and `combat.loot` the pending
 * drop count, so a loop in either moves its projection on every pass and never
 * repeats a key. A detector that silently stops working on those is the same
 * class of bug it was built to catch.
 */
describe('an action whose projection moves but never arrives', () => {
  it('stays quiet well past the identical limit', () => {
    let hitpoints = 400;
    const eat = () =>
      act(
        {
          name: 'equipment.eatFood',
          observe: () => {
            hitpoints += 1;
            return { hp: hitpoints, quantity: 8 };
          },
          perform: () => undefined,
          changed: (before, after) => after.quantity < before.quantity,
        },
        never,
      );

    for (let attempt = 1; attempt <= 39; attempt += 1) {
      expect(eat().detail).not.toContain('STUCK');
    }
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports once at forty, and says the projection was moving', () => {
    let hitpoints = 400;
    const eat = () =>
      act(
        {
          name: 'equipment.eatFood',
          observe: () => {
            hitpoints += 1;
            return { hp: hitpoints, quantity: 8 };
          },
          perform: () => undefined,
          changed: (before, after) => after.quantity < before.quantity,
        },
        never,
      );

    for (let attempt = 1; attempt <= 39; attempt += 1) eat();
    const fortieth = eat();
    expect(fortieth.detail).toContain('40 times in a row');
    expect(fortieth.detail).toContain('projection kept moving');
    expect(warn).toHaveBeenCalledTimes(1);

    for (let attempt = 41; attempt <= 60; attempt += 1) {
      expect(eat().detail).not.toContain('STUCK');
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('the ledger under a process that runs for days', () => {
  it('tracks at most sixty-four actions at once', () => {
    // Names are a fixed set of literals plus a few built from skill ids, so
    // this cap should never bind. It exists so that a future dynamic name is a
    // delayed report rather than a leak.
    const failOnce = (name: string) =>
      act(
        {
          name,
          observe: () => ({ n: 0 }),
          perform: () => undefined,
          changed: () => false,
        },
        never,
      );

    for (let index = 0; index < 200; index += 1) failOnce(`stress.${index}`);
    expect(warn).not.toHaveBeenCalled();

    // The oldest were evicted, so their runs restart from one rather than
    // reporting on stale counts.
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect(failOnce('stress.0').detail).not.toContain('STUCK');
    }
    expect(failOnce('stress.0').detail).toContain('STUCK');

    // The most recent entry kept its count instead: one call away from the
    // limit after four earlier failures.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(failOnce('stress.199').detail).not.toContain('STUCK');
    }
    expect(failOnce('stress.199').detail).toContain('STUCK');
  });
});

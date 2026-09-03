import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRepairableBuildings, repairTownshipBuilding } from '../src/adapter/township.js';
import { repairDegradedBuildings } from '../src/runtime/combat-reflex.js';

/**
 * Repairing a building the agent never has open on screen.
 *
 * The bug this exists for, once a minute for a whole day:
 *
 *   reflex.repairTownship: state unchanged after call:
 *   {"buildingId":"melvorF:Miners_Pit","biomeId":"melvorF:Mountains","count":1,"efficiency":85}
 *   -> {"buildingId":"melvorF:Miners_Pit","biomeId":"melvorF:Mountains","count":1,"efficiency":85}
 *
 * `Township.repairBuilding` (township.d.ts:723) takes a building and no biome:
 * it is the game's own button callback and reads `currentTownBiome` (:423),
 * returning immediately when nothing is selected. The agent never opens the
 * town page, so that early return was every call it ever made — no resources
 * spent, no efficiency moved, nothing thrown, nothing reported by the game.
 * `canAffordRepair(building, biome)` (:691) *does* take the biome, and answered
 * truthfully about a biome the repair itself would never look at, so the
 * offer stayed valid and the reflex retried forever.
 *
 * So the fake reproduces that early return rather than paraphrasing repair.
 * A fake that simply set efficiency to 100 would have been green throughout the
 * bug, which is exactly what the typings alone could not rule out. The real
 * reader, the real reflex and the real adapter run against it.
 */

const MINERS_PIT = { id: 'melvorF:Miners_Pit', name: "Miner's Pit" };
const BASIC_HUT = { id: 'melvorF:Basic_Hut', name: 'Basic Hut' };

type FakeBuilding = typeof MINERS_PIT;

class FakeBiome {
  readonly buildingsBuilt = new Map<FakeBuilding, number>();
  readonly buildingEfficiency = new Map<FakeBuilding, number>();

  constructor(
    readonly id: string,
    readonly availableBuildings: FakeBuilding[],
  ) {}

  getBuildingCount(building: FakeBuilding): number {
    return this.buildingsBuilt.get(building) ?? 0;
  }

  /** Faithful to `TownshipBiome.getBuildingEfficiency` (township.d.ts:44): absent means 100. */
  getBuildingEfficiency(building: FakeBuilding): number {
    return this.buildingEfficiency.get(building) ?? 100;
  }

  setBuildingEfficiency(building: FakeBuilding, amount: number): boolean {
    const old = this.getBuildingEfficiency(building);
    this.buildingEfficiency.set(building, amount);
    return old < amount;
  }
}

const MOUNTAINS = new FakeBiome('melvorF:Mountains', [MINERS_PIT]);
const GRASSLANDS = new FakeBiome('melvorF:Grasslands', [BASIC_HUT]);

/** Repairs the fake charges, so "spent nothing" is visible rather than inferred. */
let stoneSpent = 0;
/** Biomes the town has paid for; a locked biome must not be offered or touched. */
let unlocked: Set<FakeBiome>;

class FakeTownship {
  currentTownBiome?: FakeBiome;

  readonly biomes = {
    allObjects: [MOUNTAINS, GRASSLANDS],
    getObjectByID: (id: string): FakeBiome | undefined =>
      [MOUNTAINS, GRASSLANDS].find((biome) => biome.id === id),
  };

  readonly buildings = {
    getObjectByID: (id: string): FakeBuilding | undefined =>
      [MINERS_PIT, BASIC_HUT].find((building) => building.id === id),
  };

  readonly townData = { townCreated: true };

  isBiomeUnlocked(biome: FakeBiome): boolean {
    return unlocked.has(biome);
  }

  canAffordRepair(_building: FakeBuilding, biome: FakeBiome | undefined): boolean {
    // Takes the biome explicitly, which is half of why the bug survived: this
    // answered about the right biome while the repair looked at another.
    return biome !== undefined;
  }

  /**
   * `Township.repairBuilding`, transcribed from the shipped game (v1.3.1):
   * the biome comes from `currentTownBiome`, and an absent one is a silent
   * no-op — no throw, no return value, no notification the mod can see.
   */
  repairBuilding(building: FakeBuilding, _render = true): void {
    const biome = this.currentTownBiome;
    if (biome === undefined) return;
    if (!this.canAffordRepair(building, biome)) return;
    stoneSpent += 10;
    biome.setBuildingEfficiency(building, 100);
  }
}

let township: FakeTownship;

beforeEach(() => {
  MOUNTAINS.buildingsBuilt.set(MINERS_PIT, 1);
  MOUNTAINS.buildingEfficiency.set(MINERS_PIT, 85);
  GRASSLANDS.buildingsBuilt.set(BASIC_HUT, 2);
  GRASSLANDS.buildingEfficiency.set(BASIC_HUT, 40);
  unlocked = new Set([MOUNTAINS, GRASSLANDS]);
  stoneSpent = 0;
  township = new FakeTownship();
  (globalThis as Record<string, unknown>).game = { township };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
});

const never = (): boolean => false;

describe('repairing a degraded building', () => {
  it('raises efficiency without the town page being open', () => {
    // The whole bug in one assertion: `currentTownBiome` is absent, which is
    // the only state an agent that never clicks a biome is ever in.
    expect(township.currentTownBiome).toBeUndefined();

    const result = repairTownshipBuilding('melvorF:Miners_Pit', 'melvorF:Mountains', never);

    expect(result.ok).toBe(true);
    expect(MOUNTAINS.getBuildingEfficiency(MINERS_PIT)).toBe(100);
    expect(stoneSpent).toBe(10);
  });

  it('leaves the town page where it found it', () => {
    // Leaving the biome selected would redirect a human's next click to a
    // biome they did not choose. Absent and `undefined` are different things to
    // the game: an absent `currentTownBiome` means "viewing all biomes", so the
    // property has to be gone, not merely undefined.
    repairTownshipBuilding('melvorF:Miners_Pit', 'melvorF:Mountains', never);
    expect('currentTownBiome' in township).toBe(false);

    township.currentTownBiome = GRASSLANDS;
    repairTownshipBuilding('melvorF:Miners_Pit', 'melvorF:Mountains', never);
    expect(township.currentTownBiome).toBe(GRASSLANDS);
  });

  it('restores the town page even when the repair throws', () => {
    // A `finally` rather than a trailing statement, because a half-scoped town
    // would outlive the failed action and mislead every later call.
    township.repairBuilding = () => {
      throw new Error('boom');
    };

    const result = repairTownshipBuilding('melvorF:Miners_Pit', 'melvorF:Mountains', never);

    expect(result.ok).toBe(false);
    expect('currentTownBiome' in township).toBe(false);
  });

  it('refuses a building that is already whole', () => {
    MOUNTAINS.buildingEfficiency.set(MINERS_PIT, 100);

    const result = repairTownshipBuilding('melvorF:Miners_Pit', 'melvorF:Mountains', never);

    expect(result.ok).toBe(false);
    expect(stoneSpent).toBe(0);
  });
});

describe('the reflex that kept retrying', () => {
  it('repairs the worst building and then stops offering it', () => {
    // The loop end to end, through the real reader and the real reflex: the
    // town offers two degraded buildings, the worst is repaired, and the next
    // pass no longer offers it. Before the fix the second read was identical to
    // the first, which is what "17 times in one observation window" was.
    const repair = (buildingId: string, biomeId: string) =>
      repairTownshipBuilding(buildingId, biomeId, never);

    const first = readRepairableBuildings();
    expect(first).toHaveLength(2);

    const outcome = repairDegradedBuildings({ repairable: first }, repair);
    expect(outcome?.name).toBe('reflex.repairTownship');
    // Worst first: the hut at 40 outranks the pit at 85.
    expect(outcome?.result.ok).toBe(true);
    expect(GRASSLANDS.getBuildingEfficiency(BASIC_HUT)).toBe(100);

    const second = readRepairableBuildings();
    expect(second).toEqual([
      { buildingId: 'melvorF:Miners_Pit', biomeId: 'melvorF:Mountains', efficiency: 85 },
    ]);

    expect(repairDegradedBuildings({ repairable: second }, repair)?.result.ok).toBe(true);
    expect(readRepairableBuildings()).toEqual([]);
  });

  it('has nothing to do in a town that is whole', () => {
    // The quiet case matters: a reflex that fires on a healthy town is the
    // noise that buried this diagnostic for a day.
    MOUNTAINS.buildingEfficiency.set(MINERS_PIT, 100);
    GRASSLANDS.buildingEfficiency.set(BASIC_HUT, 100);

    expect(readRepairableBuildings()).toEqual([]);
    expect(repairDegradedBuildings({ repairable: [] }, () => expect.fail('must not repair'))).toBe(
      null,
    );
  });

  it('never offers a biome the town has not unlocked', () => {
    unlocked = new Set([MOUNTAINS]);

    expect(readRepairableBuildings()).toEqual([
      { buildingId: 'melvorF:Miners_Pit', biomeId: 'melvorF:Mountains', efficiency: 85 },
    ]);
  });
});

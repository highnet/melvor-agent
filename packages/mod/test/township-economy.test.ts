import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAdapterFailures, resetAdapterFailures } from '../src/adapter/safe.js';
import {
  readTownshipCandidates,
  readTownshipEconomy,
  valueOfBuilding,
} from '../src/adapter/township.js';

/**
 * What happiness actually does, and what a build is worth.
 *
 * Happiness had been read, reported and rendered for the whole run and nothing
 * had ever asked what it governs. The typings do not say — `currentHappiness`
 * (township.d.ts:479) is an undocumented number — so it was settled from the
 * shipped v1.3.1 source in the nw.js cache (`learnings/mod-api.md`):
 *
 *   computeTownPopulation() { ... this.townData.population = applyModifier(population, this.townData.happiness); }
 *   get currentPopulation() { return applyModifier(this.townData.population, this.townData.health, 3); }
 *   get baseXPRate() { return this.currentPopulation; }
 *   getGPGainRate() { const gain = this.currentPopulation * this.GP_PER_CITIZEN * (this.taxRate / 100); ... }
 *
 * with `applyModifier(base, mod, 0)` = `floor(base * (1 + mod/100))` and type 3
 * = `floor(base * (mod/100))` (f_000195.js:42).
 *
 * The fake below transcribes that arithmetic rather than paraphrasing it, for
 * the reason `township-build-quantity.test.ts` gives: a fake that returned what
 * the adapter expects would be green whether or not the adapter is right, which
 * is exactly how the repair bug survived its own tests. In particular the two
 * *floors* are the whole point — they are why one Garden is worth nothing and
 * twelve are worth six percent of the town, and a fake using plain multiplication
 * would hide that.
 */

const GP_PER_CITIZEN = 15;
const TAX_RATE = 25;

/** `applyModifier(base, modifier, 0)`, from the shipped game. */
function applyPercentBonus(base: number, modifier: number): number {
  return Math.floor(base * (1 + modifier / 100));
}

/** `applyModifier(base, modifier, 3)`, from the shipped game. */
function applyPercentOf(base: number, modifier: number): number {
  return Math.floor(base * (modifier / 100));
}

interface Provides {
  population: number;
  happiness: number;
}

class FakeBuilding {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly provides: Provides,
    /** `maxUpgrades` — what `getBuildingCountRemainingForLevelUp` counts down to. */
    readonly maxUpgrades: number,
  ) {}
}

const HUT = new FakeBuilding(
  'melvorF:Wooden_Hut',
  'Wooden Hut',
  {
    population: 1,
    happiness: 0,
  },
  200,
);
const GARDENS = new FakeBuilding(
  'melvorF:Gardens',
  'Gardens',
  {
    population: 0,
    happiness: 0.5,
  },
  100,
);
const TAILOR = new FakeBuilding(
  'melvorF:Tailor',
  'Tailor',
  {
    population: 0,
    happiness: 0,
  },
  20,
);

// Registry order is deliberately worst-first, so the ordering test below cannot
// pass by the reader simply preserving the order it read them in.
const ALL_BUILDINGS = [TAILOR, GARDENS, HUT];

class FakeBiome {
  readonly realm = { id: 'melvorD:Melvor' };
  readonly built = new Map<FakeBuilding, number>();
  readonly availableBuildings = ALL_BUILDINGS;

  constructor(
    readonly id: string,
    readonly name: string,
  ) {}

  getBuildingCount(building: FakeBuilding): number {
    return this.built.get(building) ?? 0;
  }

  /** The game's default for a building with no recorded efficiency is 100. */
  getBuildingEfficiency(): number {
    return 100;
  }

  getCurrentBuildingInUpgradeChain(building: FakeBuilding): FakeBuilding {
    return building;
  }
}

const GRASSLANDS = new FakeBiome('melvorF:Grasslands', 'Grasslands');

/** How many of any one building the town can currently pay for. */
let affordable = 12;

class FakeTownship {
  TICK_LENGTH = 300;
  upgradeQty = 1;
  currentTownBiome?: FakeBiome;

  readonly townData = {
    townCreated: true,
    happiness: 0,
    health: 90,
    population: 0,
  };

  readonly biomes = { allObjects: [GRASSLANDS] };
  readonly buildings = { allObjects: ALL_BUILDINGS };
  readonly resources = { allObjects: [] };

  get taxRate(): number {
    return TAX_RATE;
  }

  /** `computeTownPopulation`, transcribed. The test calls it after building. */
  computeTownPopulation(): void {
    let population = 0;
    for (const biome of this.biomes.allObjects) {
      for (const building of this.buildings.allObjects) {
        population +=
          biome.getBuildingCount(building) * this.getPopulationProvidesForBiome(building);
      }
    }
    this.townData.population = applyPercentBonus(population, this.townData.happiness);
  }

  /** `computeTownHappiness`, transcribed. */
  computeTownHappiness(): void {
    let happiness = 0;
    for (const biome of this.biomes.allObjects) {
      for (const building of this.buildings.allObjects) {
        happiness += biome.getBuildingCount(building) * this.getHappinessProvidesForBiome(building);
      }
    }
    this.townData.happiness = happiness;
  }

  getPopulationProvidesForBiome(building: FakeBuilding): number {
    // applyModifier(base, efficiency, 4) — the unfloored variant, efficiency 100.
    return building.provides.population;
  }

  getHappinessProvidesForBiome(building: FakeBuilding): number {
    return building.provides.happiness;
  }

  getProvidesForBiome(building: FakeBuilding): Provides {
    return building.provides;
  }

  get currentPopulation(): number {
    return applyPercentOf(this.townData.population, this.townData.health);
  }

  get baseXPRate(): number {
    return this.currentPopulation;
  }

  /** No mastery or modifier terms in the fake; the game's own hook, unchanged. */
  modifyXP(amount: number): number {
    return amount;
  }

  getGPGainRate(): number {
    return Math.floor(this.currentPopulation * GP_PER_CITIZEN * (TAX_RATE / 100));
  }

  getBuildingCountRemainingForLevelUp(building: FakeBuilding, biome: FakeBiome): number {
    return building.maxUpgrades - biome.getBuildingCount(building);
  }

  getMaxAffordableBuildingQty(): number {
    return affordable;
  }

  isBiomeUnlocked(): boolean {
    return true;
  }

  isBuildingAvailable(): boolean {
    return true;
  }

  isBuildingMaxed(building: FakeBuilding, biome: FakeBiome): boolean {
    return biome.getBuildingCount(building) >= building.maxUpgrades;
  }

  canBuildTierOfBuilding(): boolean {
    return true;
  }

  canAffordBuilding(_b: FakeBuilding, _biome: FakeBiome, quantity: number): boolean {
    return quantity <= affordable;
  }

  canAffordRepair(): boolean {
    return false;
  }

  getTotalRepairCosts(): Map<unknown, unknown> {
    return new Map();
  }

  canAffordRepairAllCosts(): boolean {
    return false;
  }
}

let township: FakeTownship;

beforeEach(() => {
  resetAdapterFailures();
  affordable = 12;
  GRASSLANDS.built.clear();
  township = new FakeTownship();
  // 184 population, exactly the live town this was written against.
  GRASSLANDS.built.set(HUT, 184);
  township.computeTownHappiness();
  township.computeTownPopulation();
  (globalThis as Record<string, unknown>).game = {
    township,
    modifiers: { flatTownshipPopulation: 0 },
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
});

describe('what the town is worth per hour', () => {
  it('reports the XP and GP the town pays, through the game own accessors', () => {
    // 184 population at 90% health is 165 working citizens; that figure is both
    // the Township XP per tick and what the town taxes. Twelve 300-second ticks
    // an hour.
    const economy = readTownshipEconomy();

    expect(economy).not.toBeNull();
    expect(economy?.basePopulation).toBe(184);
    expect(economy?.population).toBe(184);
    expect(economy?.workingPopulation).toBe(165);
    expect(economy?.xpPerHour).toBe(165 * 12);
    expect(economy?.gpPerHour).toBe(Math.floor(165 * 15 * 0.25) * 12);
  });

  it('reads zero happiness as a multiplier of one, not as a fault', () => {
    // The answer the operator asked for. At happiness 0 the town is not
    // decaying and nothing is being lost against a baseline: population is
    // exactly the sum of what the buildings provide.
    const economy = readTownshipEconomy();
    expect(economy?.happiness).toBe(0);
    expect(economy?.population).toBe(economy?.basePopulation);
  });

  it('scales the whole town when happiness is positive', () => {
    township.townData.happiness = 6;
    township.computeTownPopulation();

    const economy = readTownshipEconomy();
    // floor(184 * 1.06) = 195, floor(195 * 0.9) = 175.
    expect(economy?.population).toBe(195);
    expect(economy?.workingPopulation).toBe(175);
    expect(economy?.xpPerHour).toBe(175 * 12);
  });

  it('reports a population model that no longer matches the game', () => {
    // The transcribed formula is the one thing here that can silently drift from
    // the engine, and a drift would misprice every build without any symptom.
    // So it proves itself against the game's own figure on every read.
    township.townData.population = 900;

    const economy = readTownshipEconomy();
    expect(economy?.modelMismatch).toContain('900');
    expect(readAdapterFailures().some((f) => f.site === 'township.populationModel')).toBe(true);
  });

  it('refuses to price a build while the model is disagreeing', () => {
    // A projection built on a formula the game just contradicted would rank
    // buildings against each other on a wrong scale, and nothing downstream
    // could tell. Null, never a zero standing in for unknown.
    township.townData.population = 900;
    expect(valueOfBuilding(HUT as never, GRASSLANDS as never)).toBeNull();
  });
});

describe('what a build is worth', () => {
  it('prices Gardens by the batch, because one of them rounds away to nothing', () => {
    // The finding that decided the unit. Gardens give +0.5 happiness each;
    // floor(184 * 1.005) is 184, so a per-building figure says the only source
    // of happiness in reach is worth exactly zero — and would sort it below
    // buildings that provide nothing at all, with the arithmetic impeccable.
    const one = valueOfBuilding(GARDENS as never, GRASSLANDS as never);
    expect(one?.quantity).toBe(12);
    // floor(184 * 1.06) = 195 -> floor(195 * 0.9) = 175, against 165 now.
    expect(one?.happinessGain).toBe(6);
    expect(one?.xpPerHour).toBe((175 - 165) * 12);

    affordable = 1;
    const single = valueOfBuilding(GARDENS as never, GRASSLANDS as never);
    expect(single?.quantity).toBe(1);
    expect(single?.xpPerHour).toBe(0);
  });

  it('prices a population building by the citizens it adds', () => {
    const value = valueOfBuilding(HUT as never, GRASSLANDS as never);
    // 12 more huts is 196 raw population -> floor(196 * 0.9) = 176.
    expect(value?.populationGain).toBe(12);
    expect(value?.xpPerHour).toBe((176 - 165) * 12);
    expect(value?.gpPerHour).toBeGreaterThan(0);
  });

  it('prices a building the town is not paid for at zero', () => {
    // Zero is a real answer here and most of the town's buildings give it.
    // It must not be confused with the null that means "cannot be priced".
    const value = valueOfBuilding(TAILOR as never, GRASSLANDS as never);
    expect(value).not.toBeNull();
    expect(value?.xpPerHour).toBe(0);
    expect(value?.gpPerHour).toBe(0);
  });

  it('clamps the batch to what is left before the building maxes', () => {
    // The game's own clamp in `buildBuilding`:
    //   Math.min(getBuildingCountRemainingForLevelUp(...), upgradeQty)
    // Pricing 12 when only 3 can go up would advertise four times the truth.
    GRASSLANDS.built.set(TAILOR, 17);
    expect(valueOfBuilding(TAILOR as never, GRASSLANDS as never)?.quantity).toBe(3);
  });
});

describe('which building the town should put up', () => {
  it('offers the builds worth the most first, whatever order the registry lists them in', () => {
    // Nothing chose between seventeen build candidates: they came off the
    // reader in registry order, every one labelled "20 more here reaches the
    // next Township level", so whichever building the registry happened to list
    // first was the town's strategy.
    //
    // The registry here lists them worst-first on purpose. A reader that simply
    // preserved its input would fail this and pass a fixture in any other
    // order, which is the shape of test that let the repair bug through.
    const ids = readTownshipCandidates()
      .filter((c) => c.kind === 'build_township')
      .map((c) => (c.params as { buildingId: string }).buildingId);

    // 12 huts add 12 citizens; 12 Gardens add 6 happiness, which is 6% of 184
    // and so 11 citizens; the Tailor adds neither.
    expect(ids).toEqual([HUT.id, GARDENS.id, TAILOR.id]);
  });

  it('no longer claims a maxed-out count is a Township level', () => {
    // `getBuildingCountRemainingForLevelUp` is `maxUpgrades - count` in the
    // shipped source and says nothing whatever about Township level. The
    // sentence was false on every build candidate the agent has ever emitted.
    const label = readTownshipCandidates().find(
      (c) => (c.params as { buildingId?: string }).buildingId === HUT.id,
    )?.label;

    expect(label).not.toContain('reaches the next Township level');
    expect(label).toContain('maxes it here and unlocks its upgrade');
  });

  it('puts the rate a build buys into the label a planner reads', () => {
    const label = readTownshipCandidates().find(
      (c) => (c.params as { buildingId?: string }).buildingId === GARDENS.id,
    )?.label;

    expect(label).toContain('Township xp/h');
    expect(label).toContain('happiness');
  });
});

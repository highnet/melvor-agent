import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTownshipBuilding } from '../src/adapter/township.js';

/**
 * Building one building, and not as many as the town can pay for.
 *
 * The audit that followed the repair bug asked the same question of every
 * button callback the adapter calls: what does this method read that it does
 * not take? `Township.buildBuilding(building)` (township.d.ts:722) reads two
 * things. The biome — `currentTownBiome`, the bug that cost a day — and the
 * quantity. From the shipped v1.3.1 source, read out of the nw.js cache:
 *
 *   const upgradeQty = this.upgradeQty > 0 ? this.upgradeQty : this.getMaxAffordableBuildingQty(building, biome);
 *   const qtyToBuild = Math.min(this.getBuildingCountRemainingForLevelUp(building, biome), upgradeQty);
 *
 * `upgradeQty` (township.d.ts:439) is the town page's 1 / 5 / MAX dropdown and
 * MAX is `-1`, so a human clicking MAX once turns every later agent build into
 * "spend everything affordable" — the exact outcome the adapter's reserve
 * exists to prevent, and one it cannot see coming, because the reserve proves
 * the town can afford four and the call then buys as many as it likes.
 *
 * The fake transcribes that arithmetic rather than paraphrasing a build. A fake
 * that built one because it was asked for one would be green either way, which
 * is precisely how the repair bug survived its own tests.
 */

const HUT = { id: 'melvorF:Basic_Hut', name: 'Basic Hut' };

class FakeBiome {
  readonly realm = { id: 'melvorD:Melvor' };
  readonly built = new Map<typeof HUT, number>();

  constructor(readonly id: string) {}

  getBuildingCount(building: typeof HUT): number {
    return this.built.get(building) ?? 0;
  }

  getBuildingEfficiency(): number {
    return 100;
  }
}

const GRASSLANDS = new FakeBiome('melvorF:Grasslands');

/** How many the town could pay for at once; the MAX dropdown resolves to this. */
const AFFORDABLE = 9;

class FakeTownship {
  currentTownBiome?: FakeBiome;
  /** The game's own default. A human clicking MAX sets this to -1. */
  upgradeQty = 1;
  built = 0;

  readonly townData = { townCreated: true };

  readonly biomes = {
    getObjectByID: (id: string): FakeBiome | undefined =>
      id === GRASSLANDS.id ? GRASSLANDS : undefined,
  };

  readonly buildings = {
    getObjectByID: (id: string): typeof HUT | undefined => (id === HUT.id ? HUT : undefined),
  };

  isBiomeUnlocked(): boolean {
    return true;
  }

  isBuildingAvailable(): boolean {
    return true;
  }

  isBuildingMaxed(): boolean {
    return false;
  }

  canBuildTierOfBuilding(): boolean {
    return true;
  }

  canAffordBuilding(_building: typeof HUT, _biome: FakeBiome, quantity: number): boolean {
    return quantity <= AFFORDABLE;
  }

  getMaxAffordableBuildingQty(): number {
    return AFFORDABLE;
  }

  getBuildingCountRemainingForLevelUp(): number {
    return 100;
  }

  /** `Township.buildBuilding`, transcribed from the shipped game (v1.3.1). */
  buildBuilding(building: typeof HUT): void {
    const biome = this.currentTownBiome;
    if (biome === undefined) return;
    const upgradeQty = this.upgradeQty > 0 ? this.upgradeQty : this.getMaxAffordableBuildingQty();
    const quantity = Math.min(this.getBuildingCountRemainingForLevelUp(), upgradeQty);
    if (quantity <= 0) return;
    if (!this.canAffordBuilding(building, biome, quantity)) return;
    this.built += quantity;
    biome.built.set(building, biome.getBuildingCount(building) + quantity);
  }
}

let township: FakeTownship;

beforeEach(() => {
  GRASSLANDS.built.clear();
  township = new FakeTownship();
  (globalThis as Record<string, unknown>).game = { township };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
});

const never = (): boolean => false;

describe('building with the town page quantity set to MAX', () => {
  it('builds one, not everything the town can afford', () => {
    // The state a human leaves behind by clicking MAX once, weeks ago.
    township.upgradeQty = -1;

    const result = buildTownshipBuilding(HUT.id, GRASSLANDS.id, never);

    expect(result.ok).toBe(true);
    expect(township.built).toBe(1);
  });

  it('puts the human quantity back', () => {
    // Same argument as the biome: leaving the dropdown moved would change what
    // a human's next click does, and they would have no way to know why.
    township.upgradeQty = -1;
    buildTownshipBuilding(HUT.id, GRASSLANDS.id, never);
    expect(township.upgradeQty).toBe(-1);

    township.upgradeQty = 5;
    buildTownshipBuilding(HUT.id, GRASSLANDS.id, never);
    expect(township.upgradeQty).toBe(5);
  });

  it('restores it even when the build throws', () => {
    township.upgradeQty = 5;
    township.buildBuilding = () => {
      throw new Error('boom');
    };

    expect(buildTownshipBuilding(HUT.id, GRASSLANDS.id, never).ok).toBe(false);
    expect(township.upgradeQty).toBe(5);
  });

  it('still builds one when the dropdown is at its default', () => {
    expect(buildTownshipBuilding(HUT.id, GRASSLANDS.id, never).ok).toBe(true);
    expect(township.built).toBe(1);
  });
});

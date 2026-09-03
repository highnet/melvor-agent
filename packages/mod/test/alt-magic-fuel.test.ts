import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSellCandidates } from '../src/adapter/disposal.js';
import { startGathering } from '../src/adapter/gathering.js';

/**
 * Alt Magic must not be fed the runes Alt Magic runs on.
 *
 * Measured live over 100 seconds of `Just Learning`:
 *
 * ```
 * Air Rune -49   Nature Rune -98   Rune Essence +49
 * ```
 *
 * 49 casts. One Nature and one Air paid the spell's rune cost, which is right,
 * and then a *second* Nature Rune was destroyed as the item the spell consumes.
 * A Nature Rune is crafted from a Rune Essence, so the trade was 2 Nature + 1
 * Air in for 1 essence out — and Nature Rune is the input every castable Alt
 * Magic spell requires.
 *
 * The sell guards had a hole rather than a wrong ranking: `readSpellRuneIds`
 * walks `game.attackSpells`, no attack spell wants a Nature Rune, so the rune
 * fell through every guard and `chooseSelection` picked it as the cheapest
 * thing on offer. Note the hole is independent of ranking direction — the
 * previous, dearest-first rule would have burned a Topaz instead.
 *
 * Driven through the real `readSellCandidates` and the real `startGathering`
 * for the reason `alt-magic-selection.test.ts` states next door: a test that
 * mirrors the predicate cannot catch a bug in the predicate. The fakes stand in
 * for the game and nothing else.
 */

const MAGIC = 'melvorD:Magic';
const never = (): boolean => false;

// --- items -----------------------------------------------------------------

const GP_CURRENCY = { id: 'melvorD:GP', amount: 0 };

interface FakeItem {
  id: string;
  name: string;
  sellsFor: { currency: typeof GP_CURRENCY; quantity: number };
}

const item = (id: string, name: string, quantity: number): FakeItem => ({
  id,
  name,
  sellsFor: { currency: GP_CURRENCY, quantity },
});

// Sale values are the game's own, from `data/dump.json`. Two of them are the
// whole point: a Nature Rune sells for 1, which is why it won a
// cheapest-item ranking, and Arrow Shafts sell for 0, which is why they lost
// one they should have won.
const NATURE_RUNE = item('melvorF:Nature_Rune', 'Nature Rune', 1);
const AIR_RUNE = item('melvorD:Air_Rune', 'Air Rune', 1);
const EARTH_RUNE = item('melvorD:Earth_Rune', 'Earth Rune', 1);
const FIRE_RUNE = item('melvorD:Fire_Rune', 'Fire Rune', 1);
const SPIRIT_RUNE = item('melvorF:Spirit_Rune', 'Spirit Rune', 1);
const RUNE_ESSENCE = item('melvorD:Rune_Essence', 'Rune Essence', 0);
const ARROW_SHAFTS = item('melvorF:Arrow_Shafts', 'Arrow Shafts', 0);
const GOLD_ORE = item('melvorD:Gold_Ore', 'Gold Ore', 30);

const ITEMS = [
  NATURE_RUNE,
  AIR_RUNE,
  EARTH_RUNE,
  FIRE_RUNE,
  SPIRIT_RUNE,
  RUNE_ESSENCE,
  ARROW_SHAFTS,
  GOLD_ORE,
];

// --- spells ----------------------------------------------------------------

/** `AltMagicConsumptionID.AnyItem` (altMagic.d.ts:20), spelled out. */
const CONSUMES_ANY_ITEM = -1;
/** `AltMagicProductionID.Bar` (altMagic.d.ts:30), spelled out. */
const PRODUCES_BAR = -2;

interface FakeSpell {
  id: string;
  name: string;
  level: number;
  produces: number | FakeItem;
  productionRatio: number;
  specialCost: { type: number; quantity: number };
  runesRequired: { item: FakeItem; quantity: number }[];
}

/** Level 1, 1 Nature + 1 Air, one Rune Essence out — the measured spell. */
const JUST_LEARNING: FakeSpell = {
  id: 'melvorF:JustLearning',
  name: 'Just Learning',
  level: 1,
  produces: RUNE_ESSENCE,
  productionRatio: 1,
  specialCost: { type: CONSUMES_ANY_ITEM, quantity: 1 },
  runesRequired: [
    { item: NATURE_RUNE, quantity: 1 },
    { item: AIR_RUNE, quantity: 1 },
  ],
};

/** Magic 25: the milestone the run is stockpiling toward, hence the band. */
const SUPERHEAT_II: FakeSpell = {
  id: 'melvorF:SuperheatII',
  name: 'Superheat II',
  level: 25,
  produces: PRODUCES_BAR,
  productionRatio: 1,
  specialCost: { type: -3, quantity: 1 },
  runesRequired: [
    { item: NATURE_RUNE, quantity: 1 },
    { item: EARTH_RUNE, quantity: 3 },
    { item: FIRE_RUNE, quantity: 3 },
  ],
};

/** Magic 64, and the only claim on Spirit Rune — 63 levels out of reach. */
const SUPERHEAT_III: FakeSpell = {
  id: 'melvorF:SuperheatIII',
  name: 'Superheat III',
  level: 64,
  produces: PRODUCES_BAR,
  productionRatio: 1,
  specialCost: { type: -3, quantity: 1 },
  runesRequired: [
    { item: NATURE_RUNE, quantity: 1 },
    { item: EARTH_RUNE, quantity: 4 },
    { item: FIRE_RUNE, quantity: 4 },
    { item: SPIRIT_RUNE, quantity: 1 },
  ],
};

const SPELLS = [JUST_LEARNING, SUPERHEAT_II, SUPERHEAT_III];

// --- game ------------------------------------------------------------------

class FakeAltMagic {
  id = MAGIC;
  isActive = false;
  canStop = true;
  selectedSpell: FakeSpell | undefined;
  selectedConversionItem: FakeItem | undefined;
  selectedSmithingRecipe: unknown;

  actions = {
    allObjects: SPELLS,
    getObjectByID: (id: string): FakeSpell | undefined => SPELLS.find((s) => s.id === id),
  };

  /** The real method offers the whole bank for an `AnyItem` spell. */
  getSpellItemSelection(_spell: FakeSpell): FakeItem[] {
    return [...banked.values()].map((entry) => entry.item);
  }

  getAlchemyGP(consumed: FakeItem, conversionRatio: number): number {
    return Math.floor(consumed.sellsFor.quantity * conversionRatio);
  }

  selectSpellOnClick(spell: FakeSpell): void {
    this.selectedSpell = spell;
    this.selectedConversionItem = undefined;
  }

  selectItemOnClick(chosen: FakeItem): void {
    this.selectedConversionItem = chosen;
  }

  castButtonOnClick(): void {
    if (this.selectedSpell !== undefined) this.isActive = true;
  }

  stop(): boolean {
    this.isActive = false;
    return true;
  }
}

let altMagic: FakeAltMagic;
let banked: Map<string, { item: FakeItem; quantity: number }>;
let magicLevel: number;

/**
 * Bank order puts Rune Essence ahead of Arrow Shafts deliberately.
 *
 * Both sell for 0, and `chooseCheapestItem` breaks ties by taking the first it
 * meets. So if the "never eat your own product" guard were dropped, Just
 * Learning would select the essence it had just produced and the Arrow Shafts
 * assertion would fail — which is the point of ordering them this way.
 */
function stockBank(): void {
  banked = new Map(
    [
      NATURE_RUNE,
      AIR_RUNE,
      EARTH_RUNE,
      FIRE_RUNE,
      SPIRIT_RUNE,
      RUNE_ESSENCE,
      ARROW_SHAFTS,
      GOLD_ORE,
    ].map((entry) => [entry.id, { item: entry, quantity: 100 }]),
  );
}

function installGame(): void {
  (globalThis as Record<string, unknown>).game = {
    altMagic,
    activeAction: undefined,
    gp: GP_CURRENCY,
    items: { getObjectByID: (id: string) => ITEMS.find((entry) => entry.id === id) },
    bank: {
      items: banked,
      lockedItems: new Set<FakeItem>(),
      getQty: (wanted: FakeItem) => banked.get(wanted.id)?.quantity ?? 0,
    },
    // One object answers for Magic, so the level that gates the reserve band
    // and the spell book it reads come from the same place the adapter reads.
    skills: {
      getObjectByID: (id: string) =>
        id === MAGIC ? { id: MAGIC, level: magicLevel, actions: altMagic.actions } : { level: 1 },
    },
    // `spellCosts` picks `runesRequiredAlt` when this is set (player.d.ts:122);
    // present so the read is answered rather than swallowed.
    combat: { player: { useCombinationRunes: false } },
    smithing: {
      level: 1,
      actions: { allObjects: [] },
      isMasteryActionUnlocked: () => true,
    },
    attackSpells: { allObjects: [] },
    farming: { actions: { allObjects: [] } },
    herblore: { actions: { allObjects: [] } },
    township: { townData: { townCreated: false } },
  };
}

/** See alt-magic-selection.test.ts: undefined globals throw, and a throw in the
 * sell guards excludes every item, which would make these assertions pass for
 * the wrong reason. */
const GAME_CLASSES = ['MasteryTokenItem', 'EquipmentItem', 'FoodItem'] as const;

/** Item ids the sell list is currently offering. */
function sellableIds(): string[] {
  return readSellCandidates().map((candidate) =>
    String((candidate.params as { itemId?: unknown }).itemId ?? ''),
  );
}

beforeEach(() => {
  altMagic = new FakeAltMagic();
  magicLevel = 1;
  stockBank();
  GP_CURRENCY.amount = 0;

  for (const name of GAME_CLASSES) (globalThis as Record<string, unknown>)[name] = class {};
  installGame();
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
  for (const name of GAME_CLASSES) (globalThis as Record<string, unknown>)[name] = undefined;
});

describe('the sell list', () => {
  it('withholds the runes a castable Alt Magic spell spends', () => {
    // The bug in one assertion: Nature Rune was sellable, and therefore
    // consumable, while Just Learning was spending one per cast.
    expect(sellableIds()).not.toContain(NATURE_RUNE.id);
    expect(sellableIds()).not.toContain(AIR_RUNE.id);
  });

  it('withholds the runes of a spell within reach but not yet castable', () => {
    // Magic 1, Superheat II at 25. "Castable right now" would sell the Earth
    // and Fire Runes being saved for it — the stockpile is the whole point.
    expect(magicLevel).toBe(1);
    expect(sellableIds()).not.toContain(EARTH_RUNE.id);
    expect(sellableIds()).not.toContain(FIRE_RUNE.id);
  });

  it('still sells a rune whose only spell is far out of reach', () => {
    // A guard that reserves everything is as bad as one that reserves nothing.
    // Spirit Rune is claimed only by Superheat III, 63 levels away.
    expect(sellableIds()).toContain(SPIRIT_RUNE.id);
    expect(sellableIds()).toContain(GOLD_ORE.id);
  });

  it('reserves the far rune once the character is near enough to cast it', () => {
    magicLevel = 40;
    installGame();

    expect(sellableIds()).not.toContain(SPIRIT_RUNE.id);
  });

  it('does not offer a stack worth nothing, which is a sale, not a scarcity', () => {
    // Arrow Shafts sell for 0 GP, so the shop path drops them. That is correct
    // for selling and is exactly what starved the consumption path.
    expect(sellableIds()).not.toContain(ARROW_SHAFTS.id);
  });
});

describe('Just Learning', () => {
  it('consumes the dead-weight Arrow Shafts, not its own Nature Rune', () => {
    const result = startGathering(MAGIC, JUST_LEARNING.id, never);

    expect(result.ok).toBe(true);
    expect(altMagic.selectedConversionItem).toBe(ARROW_SHAFTS);
    expect(altMagic.isActive).toBe(true);
  });

  it('never selects a rune it spends, even as the last thing in the bank', () => {
    // Everything cheaper than a rune gone, and the one unreserved rune with it,
    // so a Nature Rune at 1 GP is the cheapest thing in the bank by a factor of
    // thirty — the exact shape of the live bank when the 98 Nature Runes went.
    banked.delete(ARROW_SHAFTS.id);
    banked.delete(RUNE_ESSENCE.id);
    banked.delete(SPIRIT_RUNE.id);
    installGame();

    const result = startGathering(MAGIC, JUST_LEARNING.id, never);

    expect(result.ok).toBe(true);
    expect(altMagic.selectedConversionItem).toBe(GOLD_ORE);
  });

  it('does not eat the Rune Essence it just produced', () => {
    // Essence in, essence out, two runes gone: a loop that reads as progress.
    const result = startGathering(MAGIC, JUST_LEARNING.id, never);

    expect(result.ok).toBe(true);
    expect(altMagic.selectedConversionItem).not.toBe(RUNE_ESSENCE);
  });

  it('refuses rather than reaching for a reserved rune when nothing else is left', () => {
    // The guard has to fail closed. If the only items banked are the spell's
    // own fuel, the answer is "no cast", not "cast once and lose two runes".
    banked.delete(ARROW_SHAFTS.id);
    banked.delete(RUNE_ESSENCE.id);
    banked.delete(GOLD_ORE.id);
    banked.delete(SPIRIT_RUNE.id);
    installGame();

    const result = startGathering(MAGIC, JUST_LEARNING.id, never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('withheld by a sell guard');
    expect(altMagic.isActive).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startGathering } from '../src/adapter/gathering.js';

/**
 * Which item an Alt Magic spell destroys, driven through the real executor.
 *
 * The bug this exists for: `chooseSelection` ranked every item-consuming spell
 * by `getAlchemyGP` descending, so *every* spell consumed the most valuable
 * eligible thing in the bank. That is right for Item Alchemy, which pays a
 * ratio of the consumed item's own value, and exactly backwards for every other
 * item-consuming spell, whose product is fixed regardless of the input: Just
 * Learning yields one Rune Essence whether it eats a Copper Ore or a Gold Ore.
 * Destroying a bank item cannot be undone.
 *
 * Deliberately not a mirror of the ranking. A copied predicate cannot catch a
 * bug about which candidate the real function ranks first: `alt-magic.test.ts`
 * next door mirrors the surrounding decisions -- bar or item, and alchemy's
 * margin over selling -- and was green for the whole life of this bug, because
 * the one thing it did not copy was the comparison that was wrong. So the fakes
 * stand in for the game and `startGathering` is called for real, which also
 * means the whole sell-guard filter behind `readSellCandidates` runs.
 *
 * Item ids are chosen so that the winner is neither first nor last in the same
 * iteration in both directions: the sell list is sorted by item id, so Copper
 * (2 GP), Gold (30) and Silver (20) are visited in that order. A "take the
 * first" bug would pass the fixed-product case and fail alchemy; "take the
 * last" fails both. Only ranking by value passes both.
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

const COPPER = item('melvorD:Copper_Ore', 'Copper Ore', 2);
const GOLD = item('melvorD:Gold_Ore', 'Gold Ore', 30);
const SILVER = item('melvorD:Silver_Ore', 'Silver Ore', 20);
const RUNE_ESSENCE = item('melvorD:Rune_Essence', 'Rune Essence', 1);

const BRONZE_BAR = item('melvorD:Bronze_Bar', 'Bronze Bar', 3);
const STEEL_BAR = item('melvorD:Steel_Bar', 'Steel Bar', 25);
const GOLD_BAR = item('melvorD:Gold_Bar', 'Gold Bar', 142);

const ITEMS = [COPPER, GOLD, SILVER, RUNE_ESSENCE, BRONZE_BAR, STEEL_BAR, GOLD_BAR];

// --- spells ----------------------------------------------------------------

/**
 * The sentinels from `AltMagicProductionID` (altMagic.d.ts:28-37) and
 * `AltMagicConsumptionID` (:19-27).
 *
 * Spelled out here for the same reason the adapter spells them out: both are
 * plain `declare enum`s, so a `AltMagicProductionID.Bar` in the adapter is a
 * bare global reference. Writing this test found that out -- the adapter still
 * had two of them, inside a catch-all, so under vitest every spell refused with
 * "the item selection could not be read" and the suite would have looked
 * uniformly, wrongly red.
 */
const PRODUCES_GP = -1;
const PRODUCES_BAR = -2;
const CONSUMES_ANY_ITEM = -1;
const CONSUMES_BAR_INGREDIENTS_WITH_COAL = -3;

interface FakeSpell {
  id: string;
  name: string;
  level: number;
  produces: number | FakeItem;
  productionRatio: number;
  specialCost: { type: number; quantity: number };
}

/** Produces one Rune Essence per cast whatever it consumes: ratio, not value. */
const JUST_LEARNING: FakeSpell = {
  id: 'melvorF:JustLearning',
  name: 'Just Learning',
  level: 1,
  produces: RUNE_ESSENCE,
  productionRatio: 1,
  specialCost: { type: CONSUMES_ANY_ITEM, quantity: 1 },
};

/** 0.4x against a shop that pays 1.0x -- casting it destroys 60% of the value. */
const ALCHEMY_I: FakeSpell = {
  id: 'melvorD:ItemAlchemyI',
  name: 'Item Alchemy I',
  level: 10,
  produces: PRODUCES_GP,
  productionRatio: 0.4,
  specialCost: { type: CONSUMES_ANY_ITEM, quantity: 1 },
};

/** 1.6x: the first tier that beats selling, and the first worth casting. */
const ALCHEMY_III: FakeSpell = {
  id: 'melvorD:ItemAlchemyIII',
  name: 'Item Alchemy III',
  level: 76,
  produces: PRODUCES_GP,
  productionRatio: 1.6,
  specialCost: { type: CONSUMES_BAR_INGREDIENTS_WITH_COAL, quantity: 1 },
};

const SUPERHEAT_I: FakeSpell = {
  id: 'melvorD:SuperheatI',
  name: 'Superheat I',
  level: 1,
  produces: PRODUCES_BAR,
  productionRatio: 1,
  specialCost: { type: CONSUMES_BAR_INGREDIENTS_WITH_COAL, quantity: 1 },
};

const SPELLS = [JUST_LEARNING, ALCHEMY_I, ALCHEMY_III, SUPERHEAT_I];

// --- smithing --------------------------------------------------------------

interface FakeRecipe {
  id: string;
  level: number;
  product: FakeItem;
}

const BRONZE: FakeRecipe = { id: 'melvorD:Bronze_Bar', level: 1, product: BRONZE_BAR };
const STEEL: FakeRecipe = { id: 'melvorD:Steel_Bar', level: 30, product: STEEL_BAR };
/** Worth the most and unaffordable, so "highest value" alone picks wrongly. */
const GOLD_SMELT: FakeRecipe = { id: 'melvorD:Gold_Bar', level: 40, product: GOLD_BAR };

// --- game ------------------------------------------------------------------

class FakeAltMagic {
  id = MAGIC;
  isActive = false;
  canStop = true;
  selectedSpell: FakeSpell | undefined;
  selectedConversionItem: FakeItem | undefined;
  selectedSmithingRecipe: FakeRecipe | undefined;

  /** What the bank offers this spell; the real method reads the bank itself. */
  itemSelection: FakeItem[] = [COPPER, GOLD, SILVER];

  actions = {
    getObjectByID: (id: string): FakeSpell | undefined => SPELLS.find((s) => s.id === id),
  };

  getSpellItemSelection(_spell: FakeSpell): FakeItem[] {
    return this.itemSelection;
  }

  /** Whole GP, as a currency payout must be. */
  getAlchemyGP(consumed: FakeItem, conversionRatio: number): number {
    return Math.floor(consumed.sellsFor.quantity * conversionRatio);
  }

  getSuperheatBarCosts(
    recipe: FakeRecipe,
    _useCoal: boolean,
    _costQty: number,
  ): { checkIfOwned: () => boolean } {
    return { checkIfOwned: () => affordableBars.has(recipe.id) };
  }

  selectSpellOnClick(spell: FakeSpell): void {
    this.selectedSpell = spell;
    // Faithful to the real skill: the selection menus are per-spell, so
    // choosing a spell clears whatever the previous one had selected.
    this.selectedConversionItem = undefined;
    this.selectedSmithingRecipe = undefined;
  }

  selectItemOnClick(chosen: FakeItem): void {
    this.selectedConversionItem = chosen;
  }

  selectBarOnClick(recipe: FakeRecipe): void {
    this.selectedSmithingRecipe = recipe;
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
let affordableBars: Set<string>;
let banked: Map<string, { item: FakeItem; quantity: number }>;
let locked: Set<FakeItem>;

function installGame(): void {
  (globalThis as Record<string, unknown>).game = {
    altMagic,
    activeAction: undefined,
    gp: GP_CURRENCY,
    items: { getObjectByID: (id: string) => ITEMS.find((entry) => entry.id === id) },
    bank: {
      items: banked,
      lockedItems: locked,
      getQty: (wanted: FakeItem) => banked.get(wanted.id)?.quantity ?? 0,
    },
    smithing: {
      level: 35,
      actions: { allObjects: [BRONZE, STEEL, GOLD_SMELT] },
      isMasteryActionUnlocked: () => true,
    },
    // Reached by the sell guards behind `readSellCandidates`, which is where
    // the eligible items are filtered. Each is the smallest shape that lets the
    // guard answer "nothing withheld" honestly rather than by throwing: a
    // reader that throws is swallowed into an empty sell list, and an empty
    // sell list makes every assertion below pass for no reason.
    skills: { getObjectByID: () => ({ level: 20 }) },
    attackSpells: { allObjects: [] },
    farming: { actions: { allObjects: [] } },
    herblore: { actions: { allObjects: [] } },
    township: { townData: { townCreated: false } },
  };
}

/**
 * The three `instanceof` guards in the sell filter name game classes that do
 * not exist under vitest. Left undefined they throw a ReferenceError, which
 * `saleExclusionReason` catches as "its sell guards could not be evaluated" and
 * excludes every item -- so the selection tests would pass on an empty list.
 * Empty classes are enough: no fake item is an instance of any of them.
 */
const GAME_CLASSES = ['MasteryTokenItem', 'EquipmentItem', 'FoodItem'] as const;

beforeEach(() => {
  altMagic = new FakeAltMagic();
  affordableBars = new Set([BRONZE.id, STEEL.id]);
  banked = new Map(
    [COPPER, GOLD, SILVER].map((entry) => [entry.id, { item: entry, quantity: 100 }]),
  );
  locked = new Set();
  GP_CURRENCY.amount = 0;

  for (const name of GAME_CLASSES) (globalThis as Record<string, unknown>)[name] = class {};
  installGame();
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
  for (const name of GAME_CLASSES) (globalThis as Record<string, unknown>)[name] = undefined;
});

describe('a spell whose product is fixed', () => {
  it('consumes the cheapest eligible item, not the dearest', () => {
    // The bug: Just Learning ate the Gold Ore. It produces exactly one Rune
    // Essence either way, so the 28 GP difference was destroyed for nothing.
    const result = startGathering(MAGIC, JUST_LEARNING.id, never);

    expect(result.ok).toBe(true);
    expect(altMagic.selectedConversionItem).toBe(COPPER);
    expect(altMagic.isActive).toBe(true);
  });

  it('skips an item the sell guards withhold', () => {
    // Alchemising destroys an item exactly as selling does, so the sell guards
    // are the guards here too -- a locked stack is the operator's own marking
    // and the one signal that reliably means "not this".
    locked.add(COPPER);
    const result = startGathering(MAGIC, JUST_LEARNING.id, never);

    expect(result.ok).toBe(true);
    // Silver at 20, not Gold at 30: still the cheapest of what is left.
    expect(altMagic.selectedConversionItem).toBe(SILVER);
  });
});

describe('alchemy that beats selling', () => {
  it('consumes the dearest eligible item', () => {
    // The opposite choice from the spell above, from the same bank: alchemy
    // pays 1.6x of whatever it eats, so the margin grows with the item's value.
    const result = startGathering(MAGIC, ALCHEMY_III.id, never);

    expect(result.ok).toBe(true);
    expect(altMagic.selectedConversionItem).toBe(GOLD);
  });
});

describe('alchemy that loses money', () => {
  it('is refused, and says so rather than blaming the bank', () => {
    // Item Alchemy I pays 0.4x against a shop paying 1.0x, so every cast burns
    // runes to destroy 60% of an item's value -- and the planner books it as
    // income, because the GP genuinely lands.
    const result = startGathering(MAGIC, ALCHEMY_I.id, never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('precondition');
    expect(result.detail).toContain('pays less GP than selling');
    // The numbers that failed the comparison, so the refusal can be checked
    // rather than merely believed: 30 GP of Gold Ore for 12 GP.
    expect(result.detail).toContain('Gold Ore');
    expect(result.detail).toContain('12');
    expect(result.detail).toContain('30');
    // The old message. It was the only thing an empty selection could say, and
    // it is false here: the bank holds 300 items this spell would accept.
    expect(result.detail).not.toContain('nothing eligible is banked');
  });

  it('touches nothing in the game', () => {
    // A refusal that had already selected the spell would leave the skill armed
    // with a losing cast for whatever ran next.
    startGathering(MAGIC, ALCHEMY_I.id, never);

    expect(altMagic.selectedSpell).toBeUndefined();
    expect(altMagic.selectedConversionItem).toBeUndefined();
    expect(altMagic.isActive).toBe(false);
  });
});

describe('Superheat', () => {
  it('picks the highest-value bar whose ingredients are owned', () => {
    // Superheat's selection is a Smithing recipe rather than a bank item, and
    // its ranking is unchanged: the bar is the product, so dearest wins. Gold
    // Bar is worth the most and its ore is not banked, so a ranking that
    // forgot to check affordability would pick it.
    const result = startGathering(MAGIC, SUPERHEAT_I.id, never);

    expect(result.ok).toBe(true);
    expect(altMagic.selectedSmithingRecipe).toBe(STEEL);
    expect(altMagic.selectedConversionItem).toBeUndefined();
  });

  it('refuses when no affordable recipe has its ingredients', () => {
    affordableBars.clear();
    const result = startGathering(MAGIC, SUPERHEAT_I.id, never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('no smithable bar has its ingredients in the bank');
  });
});

describe('a spell with nothing to consume', () => {
  it('names the empty bank rather than a losing trade', () => {
    // The two refusals must stay distinguishable: one is fixed by gathering
    // something, the other by casting a different spell.
    altMagic.itemSelection = [];
    const result = startGathering(MAGIC, JUST_LEARNING.id, never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('nothing Just Learning accepts is in the bank');
  });
});

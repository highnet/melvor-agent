import { describe, expect, it } from 'vitest';
import {
  dumpAltMagicProduction,
  dumpAltMagicSpecialCost,
  dumpBurntLog,
  dumpChanceProducts,
  dumpTieredProducts,
} from '../src/adapter/registries.js';

/**
 * Three skills that do not fit the single-product shape.
 *
 * `dumpSkillRecipes` reads `itemCosts` and `product`. Alt Magic, Herblore and
 * Firemaking use neither, so 131 rows dumped an empty `productId` and a
 * `productSellsFor` of 0 — reading exactly like an Agility obstacle, which
 * genuinely produces no item. The distinction these tests exist to keep is
 * between "produces nothing" and "produces something this dumper could not
 * see", because the second is invisible and the first is a fact.
 *
 * The real dumpers are imported rather than restated. A mirror agrees with
 * itself by construction: `mining-respawn.test.ts` mirrored the amortisation
 * and kept passing for weeks after the implementation moved to a different
 * accessor. These four take their inputs as plain objects, so no `game` stub is
 * needed — which is also why they were extracted from the registry loop.
 */

describe('Herblore tiers', () => {
  const potion = (n: number) => ({
    id: `melvorD:Potion_${n}`,
    name: `Potion (Tier ${n + 1})`,
    sellsFor: { quantity: 10 * (n + 1), currency: { id: 'melvorD:GP' } },
    tier: n,
    charges: 5 + n,
    action: { id: 'melvorD:Mining', name: 'Mining' },
  });

  it('records all four potions, not one', () => {
    // The whole failure: one product id would have to name a tier, and naming
    // any tier is wrong about the other three.
    const tiers = dumpTieredProducts([potion(0), potion(1), potion(2), potion(3)], [1, 20, 50, 85]);

    expect(tiers).toHaveLength(4);
    expect(tiers.map((t) => t.itemId)).toEqual([
      'melvorD:Potion_0',
      'melvorD:Potion_1',
      'melvorD:Potion_2',
      'melvorD:Potion_3',
    ]);
  });

  it('carries the mastery level that gates each tier', () => {
    // Without the gate the four rows read as four things obtainable now, when
    // three of them are locked.
    const tiers = dumpTieredProducts([potion(0), potion(1)], [1, 20, 50, 85]);

    expect(tiers.map((t) => t.masteryLevelRequired)).toEqual([1, 20]);
  });

  it('prices every tier', () => {
    // An unpriced product defaults to zero, which is the wrong direction: a
    // tier worth 40 GP would read as worthless.
    expect(dumpTieredProducts([potion(3)], [1, 20, 50, 85])[0]?.sellsFor).toBe(40);
  });

  it('carries charges and the action the potion applies to', () => {
    // Charges decide how many potions a run consumes; the action decides
    // whether the potion is relevant to what the agent is doing at all.
    const [tier] = dumpTieredProducts([potion(0)], [1]);

    expect(tier?.charges).toBe(5);
    expect(tier?.actionId).toBe('melvorD:Mining');
  });

  it('records an ungated tier as 0 rather than inventing a level', () => {
    // A missing entry in `tierMasteryLevels` is unknown, and a plausible
    // guessed level is worse than a stated zero.
    expect(dumpTieredProducts([potion(2)], [1])[0]?.masteryLevelRequired).toBe(0);
  });

  it('is empty for a recipe with no potions at all', () => {
    // Every skill but Herblore. An empty list here plus a blank productId is
    // the honest "this produces no item".
    expect(dumpTieredProducts(undefined, [1, 20, 50, 85])).toEqual([]);
  });
});

describe('Firemaking products', () => {
  const oakLogs = { id: 'melvorD:Oak_Logs', name: 'Oak Logs' };
  const ash = {
    id: 'melvorD:Ash',
    name: 'Ash',
    sellsFor: { quantity: 2, currency: { id: 'melvorD:GP' } },
  };
  const charcoal = {
    id: 'melvorD:Charcoal',
    name: 'Charcoal',
    sellsFor: { quantity: 15, currency: { id: 'melvorD:GP' } },
  };

  const skill = {
    getPrimaryProductInfo: () => ({ chance: 100, quantity: 1 }),
    getSecondaryProductInfo: () => ({ chance: 5, quantity: 2 }),
    defaultPrimaryProducts: [ash],
    defaultSecondaryProducts: [],
  };

  it('records the chance a product actually lands', () => {
    // A drop landing one burn in twenty priced as guaranteed is a twentyfold
    // overstatement, and it is the same one `productChanceFor` exists to stop
    // for Cooking and Fishing.
    const products = dumpChanceProducts(
      { primaryProducts: [ash], secondaryProducts: [charcoal] },
      skill,
    );

    expect(products.map((p) => [p.itemId, p.role, p.chance, p.quantity])).toEqual([
      ['melvorD:Ash', 'primary', 100, 1],
      ['melvorD:Charcoal', 'secondary', 5, 2],
    ]);
  });

  it('prices each product', () => {
    // An unpriced product defaults to zero, so a 15 GP Charcoal would read as
    // worthless and Firemaking would rank below skills that pay less.
    const products = dumpChanceProducts({ primaryProducts: [charcoal] }, skill);

    expect(products[0]?.sellsFor).toBe(15);
    expect(products[0]?.sellsForCurrencyId).toBe('melvorD:GP');
  });

  it("falls back to the skill's defaults only when the log names none", () => {
    // The two lists must never be summed: a log counted for both its own
    // products and the defaults double-counts everything it yields.
    const withOwn = dumpChanceProducts({ primaryProducts: [charcoal] }, skill);
    const withNone = dumpChanceProducts({ primaryProducts: [] }, skill);

    expect(withOwn.map((p) => p.itemId)).toEqual(['melvorD:Charcoal']);
    expect(withNone.map((p) => p.itemId)).toEqual(['melvorD:Ash']);
  });

  it('is empty for a recipe that is not a log', () => {
    expect(dumpChanceProducts(undefined, skill)).toEqual([]);
  });

  it('charges a burn for the log it consumes', () => {
    // `FiremakingLog` has no `itemCosts`, so all 33 logs dumped as free inputs
    // and burning priced as pure profit against every chain that pays for its
    // materials.
    expect(dumpBurntLog(oakLogs)).toEqual([
      { itemId: 'melvorD:Oak_Logs', name: 'Oak Logs', quantity: 1 },
    ]);
  });

  it('charges nothing for a recipe with no log', () => {
    expect(dumpBurntLog(undefined)).toEqual([]);
  });
});

describe('Alt Magic production', () => {
  it('names the GP sentinel rather than dropping it', () => {
    // `produces` is -1 for Item Alchemy, and -1 is not an item: a dumper
    // looking for `product` found nothing and the spell read as producing
    // nothing at all.
    const production = dumpAltMagicProduction(-1, 2);

    expect(production?.kind).toBe('GP');
    expect(production?.itemId).toBe('');
    expect(production?.productionRatio).toBe(2);
  });

  it('names every sentinel the enum declares', () => {
    // The enum is a plain `declare enum`, so the runtime may carry no value for
    // it and these have to be literals. A drift here is silent.
    const kinds = [-1, -2, -3, -4, -5, -6, -7, -8].map((id) => dumpAltMagicProduction(id, 1)?.kind);

    expect(kinds).toEqual([
      'GP',
      'Bar',
      'RandomGem',
      'RandomSuperiorGem',
      'PerfectFood',
      'RandomShards',
      'MagicXP',
      'AbyssalMagicXP',
    ]);
  });

  it('records an item product as an item, priced', () => {
    const production = dumpAltMagicProduction(
      {
        id: 'melvorD:Rune_Essence',
        name: 'Rune Essence',
        sellsFor: { quantity: 3, currency: { id: 'melvorD:GP' } },
      },
      1,
    );

    expect(production).toMatchObject({
      kind: 'Item',
      itemId: 'melvorD:Rune_Essence',
      sellsFor: 3,
      sellsForCurrencyId: 'melvorD:GP',
    });
  });

  it('keeps a sentinel it has never heard of', () => {
    // A game update adding a production id must not make a spell vanish from
    // the section — a missing row is the failure this change exists to end.
    expect(dumpAltMagicProduction(-99, 1)?.kind).toBe('Unknown(-99)');
  });

  it('is null for a recipe that is not a spell', () => {
    expect(dumpAltMagicProduction(undefined, 1)).toBeNull();
  });
});

describe('Alt Magic special cost', () => {
  it('names the class of item a cast destroys', () => {
    // No item list can hold "any item", so `itemCosts` and `fixedItemCosts` are
    // both empty and the spell reads as costing only its runes.
    expect(dumpAltMagicSpecialCost({ type: -1, quantity: 1 })).toEqual({
      consumes: 'AnyItem',
      quantity: 1,
      currencyId: '',
    });
  });

  it('records the currency that narrows the class', () => {
    expect(
      dumpAltMagicSpecialCost({ type: -2, quantity: 5, currency: { id: 'melvorD:GP' } }),
    ).toMatchObject({ consumes: 'JunkItem', currencyId: 'melvorD:GP' });
  });

  it('distinguishes a spell that consumes nothing from a row that is not a spell', () => {
    // A quantity of 0 is the executor's own test for whether a selection is
    // needed. Flattening it to null would erase that.
    expect(dumpAltMagicSpecialCost({ type: -5, quantity: 0 })).toEqual({
      consumes: 'None',
      quantity: 0,
      currencyId: '',
    });
    expect(dumpAltMagicSpecialCost(undefined)).toBeNull();
  });

  it('keeps a consumption id it has never heard of', () => {
    expect(dumpAltMagicSpecialCost({ type: -99, quantity: 1 })?.consumes).toBe('Unknown(-99)');
  });
});

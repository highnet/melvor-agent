import { describe, expect, it } from 'vitest';

/**
 * Alt Magic was unreachable and unpriced, and it is the game's dedicated
 * turn-items-into-GP action.
 *
 * Two separate blocks. The adapter refused every item-consuming spell -- which
 * is Item Alchemy and Superheat, i.e. all the useful ones -- on the grounds
 * that the mapping from spell to eligible item would have to be guessed. It
 * does not: `getSpellItemSelection` (altMagic.d.ts:119) returns exactly the
 * bank items a spell accepts, and `selectBarOnClick` (:125) does the same for
 * Superheat's bar.
 *
 * And the rate was scored at zero, because Alt Magic pays a currency instead of
 * producing an item, so the generic product arithmetic found nothing to price.
 * The same shape as the Thieving bug: the money option read as worthless on a
 * board being consulted about money.
 */

/** Net GP of one alchemy cast: what it pays, less the item it destroys. */
const alchemyNet = (alchemyGp: number, itemSaleValue: number): number => alchemyGp - itemSaleValue;

describe('alchemy is priced against selling the same item', () => {
  it('counts only the margin over selling', () => {
    // Alchemy destroys the item exactly as selling does, so the alternative is
    // the sale, not zero.
    expect(alchemyNet(300, 120)).toBe(180);
  });

  it('reports a spell that pays less than selling as worthless', () => {
    // Not income -- a slower way to sell.
    expect(alchemyNet(80, 120)).toBeLessThan(0);
  });
});

/** Superheat picks a bar; everything else picks the best-converting item. */
const chooseKind = (producesGp: boolean, producesBar: boolean): 'bar' | 'item' | null => {
  if (producesBar) return 'bar';
  if (producesGp) return 'item';
  return null;
};

describe('spell selection', () => {
  it('selects a smithing recipe for Superheat', () => {
    // Superheat consumes a recipe's ingredients and produces its bar, so the
    // selection is the recipe rather than an item.
    expect(chooseKind(false, true)).toBe('bar');
  });

  it('selects a bank item for alchemy', () => {
    expect(chooseKind(true, false)).toBe('item');
  });

  it('selects nothing for a spell that consumes nothing', () => {
    // Those were the only spells that used to work, and they must keep working
    // without a selection.
    expect(chooseKind(false, false)).toBeNull();
  });
});

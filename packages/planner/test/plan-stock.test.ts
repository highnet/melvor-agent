import { describe, expect, it } from 'vitest';

/**
 * A plan step can end on a quantity, not only on a level.
 *
 * `set_objective` has always had `untilItemId`/`untilQuantity`; `set_plan` did
 * not. So a plan could only end a step at a level, which either stops short of
 * the count the next step needs or runs hours past it -- and "mine 200 Gold
 * Ore, then smelt" was unsayable.
 *
 * That is exactly the shape a plan exists to remove: the chain had to be driven
 * by an operator watching for the moment to switch, which is what happened all
 * afternoon -- mining until someone noticed the smelter was dry, smelting until
 * someone noticed the ore was gone.
 */
const stockTargetFor = (
  untilItemId: unknown,
  untilQuantity: unknown,
): { itemId: string; quantity: number } | undefined => {
  const id = typeof untilItemId === 'string' ? untilItemId : undefined;
  const qty = Number(untilQuantity);
  return id !== undefined && Number.isFinite(qty) && qty > 0
    ? { itemId: id, quantity: qty }
    : undefined;
};

describe('plan step stock targets', () => {
  it('builds a target from an item and a count', () => {
    expect(stockTargetFor('melvorD:Gold_Ore', 200)).toEqual({
      itemId: 'melvorD:Gold_Ore',
      quantity: 200,
    });
  });

  it('ignores a count with no item', () => {
    // Half a target is not a target; it would silently never complete.
    expect(stockTargetFor(undefined, 200)).toBeUndefined();
  });

  it('ignores an item with no count', () => {
    expect(stockTargetFor('melvorD:Gold_Ore', undefined)).toBeUndefined();
  });

  it('rejects a non-positive count', () => {
    // Zero would complete on the first tick without acting, which looks like
    // success and is not.
    expect(stockTargetFor('melvorD:Gold_Ore', 0)).toBeUndefined();
  });

  it('leaves a level-only step alone', () => {
    expect(stockTargetFor(undefined, undefined)).toBeUndefined();
  });
});

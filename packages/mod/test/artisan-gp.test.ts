import { describe, expect, it } from 'vitest';

/**
 * Production recipes must be priced net of what they consume.
 *
 * Artisan recipes reported no GP at all -- not zero, absent -- so Smithing,
 * Crafting, Fletching, Herblore, Runecrafting, Summoning, Cooking, Firemaking
 * and Alt Magic were invisible to any planner asked to raise money, and the
 * board showed only gathering and Thieving. Live consequence: Gold Topaz Ring
 * sat available with its inputs banked while the agent mined ore, and nothing
 * on screen could compare them.
 *
 * Net rather than gross, because a production recipe *spends* to earn and the
 * difference is frequently the whole story rather than a correction.
 */
const netPerAction = (
  productGp: number,
  yielded: number,
  costs: { gp: number; quantity: number }[],
  preservationPercent = 0,
): number => {
  const revenue = productGp * yielded;
  if (revenue <= 0) return 0;
  const preserved = Math.max(0, Math.min(1, preservationPercent / 100));
  const spent = costs.reduce((sum, c) => sum + c.gp * c.quantity * (1 - preserved), 0);
  return revenue - spent;
};

describe('net GP for production recipes', () => {
  it('subtracts the inputs from the output', () => {
    // Silver Bar: one ore at 25 becomes a bar at 51.
    expect(netPerAction(51, 1, [{ gp: 25, quantity: 1 }])).toBe(26);
  });

  it('reports a loss-making recipe as worthless rather than lucrative', () => {
    // Leather armour reads 75 GP an action and is negative once the 100 GP of
    // leather it burns is priced. A gross figure would not merely approximate
    // this, it would point the wrong way.
    expect(netPerAction(75, 1, [{ gp: 100, quantity: 1 }])).toBeLessThan(0);
  });

  it('prices a multi-input recipe against every input', () => {
    // Five bars into a platebody: the value is not the platebody's price.
    expect(netPerAction(1_000, 1, [{ gp: 51, quantity: 5 }])).toBe(745);
  });

  it('credits preservation, which reduces what is actually consumed', () => {
    // Half the inputs survive, so half the cost is real.
    expect(netPerAction(51, 1, [{ gp: 25, quantity: 1 }], 50)).toBe(38.5);
  });

  it('counts the yield, not one unit', () => {
    // Runecrafting makes several runes per action; pricing one understates it
    // more than any other artisan skill.
    expect(netPerAction(10, 5, [{ gp: 1, quantity: 1 }])).toBe(49);
  });

  it('reports zero for a product with no sale value', () => {
    // Absent is not free, but zero is the recoverable direction.
    expect(netPerAction(0, 1, [{ gp: 25, quantity: 1 }])).toBe(0);
  });
});

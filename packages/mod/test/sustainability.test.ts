import { describe, expect, it } from 'vitest';

/**
 * How long a recipe's banked inputs will actually sustain it.
 *
 * `canAfford` asks whether one action is possible, which is a different
 * question from whether an objective is. A recipe with five bars banked
 * advertises a full rate, runs for twenty seconds, and then fails until the
 * failure limit abandons it -- and the planner that chose it had nothing on
 * screen suggesting it would.
 *
 * It cost two objectives in a single afternoon. Acolyte Wizard Robes was the
 * highest-XP recipe on the board and aborted instantly, consuming runes rather
 * than the essence that was banked; and the Gold Bar chain silently ran the
 * smelter dry while the plan still read as healthy.
 */
const sustain = (
  costs: { held: number; quantity: number }[],
  intervalMs: number,
): number | null => {
  if (costs.length === 0 || intervalMs <= 0) return null;
  let actions = Number.POSITIVE_INFINITY;
  for (const c of costs) {
    if (c.quantity <= 0) continue;
    actions = Math.min(actions, Math.floor(c.held / c.quantity));
  }
  return Number.isFinite(actions) ? (actions * intervalMs) / 60_000 : null;
};

describe('input horizon', () => {
  it('measures how many actions the stock covers', () => {
    // 1,141 essence at one each, two seconds an action.
    expect(sustain([{ held: 1_141, quantity: 1 }], 2_000)).toBeCloseTo(38.03, 1);
  });

  it('is bounded by the scarcest input', () => {
    // Five bars and one ore is one action, not five.
    expect(
      sustain(
        [
          { held: 100, quantity: 5 },
          { held: 1, quantity: 1 },
        ],
        2_000,
      ),
    ).toBeCloseTo(0.033, 2);
  });

  it('reports nothing for a recipe that consumes nothing', () => {
    // A gathering action is limited by time, not stock; inventing a horizon
    // there would be worse than silence.
    expect(sustain([], 3_000)).toBeNull();
  });

  it('reports zero when the stock covers no full action', () => {
    // The Acolyte Robes case: affordable-looking, abortable immediately.
    expect(sustain([{ held: 2, quantity: 5 }], 2_000)).toBe(0);
  });
});

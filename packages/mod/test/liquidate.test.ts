import { describe, expect, it } from 'vitest';
import type { ExpendableStack } from '../src/adapter/disposal.js';
import { liquidateSurplus } from '../src/runtime/combat-reflex.js';

const ok = () => ({ ok: true }) as never;

/**
 * A stack as the reader hands it over: sellable units, priced per unit.
 *
 * `quantity` is the sellable portion, never the bank count — see
 * `ExpendableStack`. Tests that care about the difference set `held` apart from
 * `quantity` explicitly.
 */
const stack = (overrides: Partial<ExpendableStack> = {}): ExpendableStack => {
  const quantity = overrides.quantity ?? 100;
  const unitValue = overrides.unitValue ?? 380;
  return {
    itemId: 'melvorD:Silver_Bar',
    name: 'Silver Bar',
    held: quantity,
    quantity,
    unitValue,
    value: quantity * unitValue,
    ...overrides,
  };
};

/**
 * Selling surplus while there is still headroom, rather than at zero.
 *
 * Gathering advertises its worth "if sold, not GP earned", and nothing sold --
 * so the bank filled while GP stood still, and the only automatic response
 * fired at zero free slots and sold the *cheapest* stack, realising as little
 * value as possible.
 *
 * The cost was measurable: in one afternoon the expansion reflex bought two
 * bank slots at escalating prices, roughly 75,000 GP, because the bank kept
 * reaching zero -- while sellable stock sat in it.
 */
describe('liquidateSurplus', () => {
  it('sells once the bank is under pressure', () => {
    const sold: [string, number][] = [];
    liquidateSurplus({ freeSlots: 2, best: stack(), funding: null }, (itemId, quantity) => {
      sold.push([itemId, quantity]);
      return ok();
    });

    expect(sold).toEqual([['melvorD:Silver_Bar', 100]]);
  });

  it('leaves a roomy bank alone', () => {
    // Nothing is being lost yet, and selling is irreversible.
    expect(
      liquidateSurplus({ freeSlots: 20, best: stack(), funding: null }, () => ok()),
    ).toBeNull();
  });

  it('does not sell for pocket change', () => {
    // A handful of low-value items is not worth an action that cannot be undone.
    const pennies = stack({ quantity: 4, unitValue: 30, value: 120 });
    expect(liquidateSurplus({ freeSlots: 1, best: pennies, funding: null }, () => ok())).toBeNull();
  });

  it('does nothing when every stack is guarded', () => {
    // The reader excludes food, ammunition, seeds, spell runes, mastery tokens
    // and task items, so "nothing to sell" is a normal and safe outcome.
    expect(liquidateSurplus({ freeSlots: 0, best: null, funding: null }, () => ok())).toBeNull();
  });

  it('still fires at zero, below the escape hatch', () => {
    // At zero it is worth taking the profitable sale before the cheapest-stack
    // fire sale runs.
    const sold: string[] = [];
    liquidateSurplus({ freeSlots: 0, best: stack(), funding: null }, (itemId) => {
      sold.push(itemId);
      return ok();
    });

    expect(sold).toHaveLength(1);
  });

  it('sells only the surplus above a task reserve, never the reserve', () => {
    // The measured behaviour the operator asked to keep: 100 of every 582 Gold
    // Bars held back for an open Township task. The candidate path had it
    // because `sell_items` subtracts `keepQuantity`; this path asked the bank
    // how many there were and sold all 582.
    const bars = stack({
      itemId: 'melvorD:Gold_Bar',
      name: 'Gold Bar',
      held: 582,
      quantity: 482,
      unitValue: 142,
      value: 482 * 142,
    });

    const sold: [string, number][] = [];
    liquidateSurplus({ freeSlots: 1, best: bars, funding: null }, (itemId, quantity) => {
      sold.push([itemId, quantity]);
      return ok();
    });

    expect(sold).toEqual([['melvorD:Gold_Bar', 482]]);
  });
});

describe('liquidateSurplus converts a large stack without waiting for pressure', () => {
  const big = stack({
    itemId: 'melvorD:Gold_Bar',
    name: 'Gold Bar',
    quantity: 1056,
    unitValue: 142,
    value: 149_952,
  });

  it('sells a six-figure stack even with space to spare', () => {
    // The actual incident: 216,000 GP of bars in a bank with five free slots,
    // while the run was short of GP for the purchase it was saving toward.
    const sold: string[] = [];
    liquidateSurplus({ freeSlots: 5, best: big, funding: null }, (itemId) => {
      sold.push(itemId);
      return ok();
    });

    expect(sold).toEqual(['melvorD:Gold_Bar']);
  });

  it('still leaves a modest stack alone when there is room', () => {
    // Selling is irreversible; without the excuse of bank pressure the bar has
    // to be a stack nobody would argue is still needed.
    expect(liquidateSurplus({ freeSlots: 5, best: stack(), funding: null }, () => ok())).toBeNull();
  });
});

/**
 * The gap the two thresholds above could not close.
 *
 * Measured live, and the numbers are what make the case: 582 Gold Bars at 142 GP
 * is 82,644 -- under the 100,000 "large stack" bar -- sitting in a bank with
 * nine free slots, well clear of the two-slot pressure line. So neither trigger
 * fired, GP stood at exactly 555,142 for hours against an operator goal of
 * 1,000,000, and it moved only when a human issued a `Sell` objective by hand,
 * four separate times, each one consuming a plan step.
 *
 * A funding target is not a third threshold. It is the number the operator wrote
 * in `GOALS.md`, which is what makes the sale defensible: the agent is executing
 * a decision that was already made rather than deciding that stock should become
 * money.
 */
describe('a stated funding goal', () => {
  /** 582 Gold Bars, none reserved: the stack that sat unsold all afternoon. */
  const bars = stack({
    itemId: 'melvorD:Gold_Bar',
    name: 'Gold Bar',
    quantity: 582,
    unitValue: 142,
    value: 82_644,
  });

  it('sells a stack that neither threshold would have touched', () => {
    const sold: [string, number][] = [];
    liquidateSurplus(
      { freeSlots: 9, best: bars, funding: { held: 555_142, target: 1_000_000 } },
      (itemId, quantity) => {
        sold.push([itemId, quantity]);
        return ok();
      },
    );

    // 444,858 GP short at 142 a bar is 3,133 bars — far more than are held, so
    // the whole sellable stack goes and the cap changes nothing here.
    expect(sold).toEqual([['melvorD:Gold_Bar', 582]]);
  });

  it('stops the moment the goal is met, rather than liquidating the bank', () => {
    // The property that keeps this from becoming a fire sale: the authorisation
    // expires on success. At the target the reflex falls back to the two
    // thresholds, and nine free slots with an 82,644 GP stack trips neither.
    expect(
      liquidateSurplus(
        { freeSlots: 9, best: bars, funding: { held: 1_000_000, target: 1_000_000 } },
        () => ok(),
      ),
    ).toBeNull();
  });

  it('sells no more than the shortfall needs', () => {
    // Every unit past the target is an irreversible trade made for no stated
    // reason. 1,000 GP short at 142 a bar is 8 bars, rounded up — selling 7
    // would leave the goal unmet and the sale would only have to happen again.
    const sold: [string, number][] = [];
    liquidateSurplus(
      { freeSlots: 9, best: bars, funding: { held: 999_000, target: 1_000_000 } },
      (itemId, quantity) => {
        sold.push([itemId, quantity]);
        return ok();
      },
    );

    expect(sold).toEqual([['melvorD:Gold_Bar', 8]]);
  });

  it('honours the task reserve while funding a goal', () => {
    // A goal is a licence to sell surplus, never a licence to sell the reserve:
    // the cap is applied to what the guards released, not to what is held.
    const reserved = stack({
      itemId: 'melvorD:Gold_Bar',
      name: 'Gold Bar',
      held: 582,
      quantity: 482,
      unitValue: 142,
      value: 482 * 142,
    });

    const sold: [string, number][] = [];
    liquidateSurplus(
      { freeSlots: 9, best: reserved, funding: { held: 0, target: 10_000_000 } },
      (itemId, quantity) => {
        sold.push([itemId, quantity]);
        return ok();
      },
    );

    expect(sold).toEqual([['melvorD:Gold_Bar', 482]]);
  });

  it('does not lift the pocket-change floor', () => {
    // A goal is a reason to convert surplus, not a reason to make a string of
    // tiny irreversible trades. The floor is the one threshold a funding target
    // deliberately does not override.
    const pennies = stack({ quantity: 4, unitValue: 30, value: 120 });
    expect(
      liquidateSurplus(
        { freeSlots: 9, best: pennies, funding: { held: 0, target: 1_000_000 } },
        () => ok(),
      ),
    ).toBeNull();
  });

  it('sells the whole stack under bank pressure, cap or no cap', () => {
    // At the pressure line the point is the slot, and a stack sold down to a
    // fraction still occupies it. So pressure overrides the shortfall cap.
    const sold: [string, number][] = [];
    liquidateSurplus(
      { freeSlots: 1, best: bars, funding: { held: 999_000, target: 1_000_000 } },
      (itemId, quantity) => {
        sold.push([itemId, quantity]);
        return ok();
      },
    );

    expect(sold).toEqual([['melvorD:Gold_Bar', 582]]);
  });

  it('sells nothing for money when no goal has asked for any', () => {
    // The default posture. Without an operator-stated target this reflex is
    // exactly what it was: a bank-pressure valve and a large-stack converter.
    expect(liquidateSurplus({ freeSlots: 9, best: bars, funding: null }, () => ok())).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { liquidateSurplus } from '../src/runtime/combat-reflex.js';

const ok = () => ({ ok: true }) as never;
const stack = (value: number) => ({ itemId: 'melvorD:Silver_Bar', name: 'Silver Bar', value });

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
    const sold: string[] = [];
    liquidateSurplus({ freeSlots: 2, best: stack(38_000) }, (itemId) => {
      sold.push(itemId);
      return ok();
    });

    expect(sold).toEqual(['melvorD:Silver_Bar']);
  });

  it('leaves a roomy bank alone', () => {
    // Nothing is being lost yet, and selling is irreversible.
    expect(liquidateSurplus({ freeSlots: 20, best: stack(38_000) }, () => ok())).toBeNull();
  });

  it('does not sell for pocket change', () => {
    // A handful of low-value items is not worth an action that cannot be undone.
    expect(liquidateSurplus({ freeSlots: 1, best: stack(120) }, () => ok())).toBeNull();
  });

  it('does nothing when every stack is guarded', () => {
    // The reader excludes food, ammunition, seeds, spell runes, mastery tokens
    // and task items, so "nothing to sell" is a normal and safe outcome.
    expect(liquidateSurplus({ freeSlots: 0, best: null }, () => ok())).toBeNull();
  });

  it('still fires at zero, below the escape hatch', () => {
    // At zero it is worth taking the profitable sale before the cheapest-stack
    // fire sale runs.
    const sold: string[] = [];
    liquidateSurplus({ freeSlots: 0, best: stack(38_000) }, (itemId) => {
      sold.push(itemId);
      return ok();
    });

    expect(sold).toHaveLength(1);
  });
});

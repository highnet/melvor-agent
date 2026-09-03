import { describe, expect, it } from 'vitest';
import { sellToEscapeFullBank } from '../src/runtime/combat-reflex.js';

const ok = () => ({ ok: true }) as never;

/**
 * The two-hour outage this exists for.
 *
 * Bank 59/59, 59,369 GP, a slot priced at 33,068 — and every gathering action
 * refused because its output had nowhere to go. Income was exactly zero, so the
 * price and the balance both stayed frozen. The agent re-planned into the same
 * wall 150 times.
 *
 * "Buying, never selling" was the right default and had a hole exactly the size
 * of that outage: it assumed buying was always eventually possible.
 */
describe('escaping a full bank that cannot be bought out of', () => {
  // `held` equals `quantity` because the reader only offers stacks it can
  // empty: a slot with anything left in it is still a used slot, so a stack
  // held back in part for a Township task cannot escape this deadlock at all.
  const keys = {
    itemId: 'melvorD:Rusty_Key',
    name: 'Rusty Key',
    held: 10,
    quantity: 10,
    unitValue: 12,
    value: 120,
  };
  const state = (overrides: Partial<Parameters<typeof sellToEscapeFullBank>[0]> = {}) => ({
    freeSlots: 0,
    canBuySlot: false,
    expendable: keys,
    ...overrides,
  });

  it('sells one cheap stack when no slot can be bought', () => {
    const sold: [string, number][] = [];
    sellToEscapeFullBank(state(), (itemId, quantity) => {
      sold.push([itemId, quantity]);
      return ok();
    });

    expect(sold).toEqual([['melvorD:Rusty_Key', 10]]);
  });

  it('never pre-empts buying a slot', () => {
    // Buying is strictly better: it is additive and destroys nothing. This must
    // only fire once that has failed.
    expect(sellToEscapeFullBank(state({ canBuySlot: true }), () => ok())).toBeNull();
  });

  it('does nothing while the bank still has room', () => {
    expect(sellToEscapeFullBank(state({ freeSlots: 3 }), () => ok())).toBeNull();
  });

  it('does nothing when every stack is protected', () => {
    // readSellCandidates already excludes task items, seeds, spell runes,
    // mastery tokens, the last of an ingredient and locked items. If nothing
    // survives that, there is genuinely nothing safe to sell.
    expect(sellToEscapeFullBank(state({ expendable: null }), () => ok())).toBeNull();
  });
});

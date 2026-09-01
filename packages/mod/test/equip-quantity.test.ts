import { describe, expect, it } from 'vitest';
import { equipQuantity } from '../src/adapter/equipment.js';

describe('how much of an item to equip', () => {
  it('puts the whole stack in a slot that holds a stack', () => {
    // The live failure: the agent equipped one Bronze Arrow out of 1,259, fired
    // it, and fought on with an empty quiver. Ranged stayed at level 1 and the
    // only visible symptom was the bank count dropping by exactly one.
    expect(equipQuantity(true, 1259)).toBe(1259);
  });

  it('equips one of anything worn rather than stacked', () => {
    expect(equipQuantity(false, 87)).toBe(1);
  });

  it('never asks for zero', () => {
    // A slot that allows quantity with nothing held would otherwise request 0,
    // which the game accepts as a no-op that looks like success.
    expect(equipQuantity(true, 0)).toBe(1);
  });
});

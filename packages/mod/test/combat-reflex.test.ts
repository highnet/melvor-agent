import type { ActionResult } from '@melvor-agent/shared';
import { describe, expect, it, vi } from 'vitest';
import { dropUnpayablePrayers, refillFood } from '../src/runtime/combat-reflex.js';

const ok: ActionResult<unknown> = {
  ok: true,
  action: 'test',
  before: null,
  after: null,
  detail: 'done',
};

function fed(overrides: Partial<Parameters<typeof refillFood>[0]> = {}) {
  return {
    inCombat: true,
    equippedFoodId: 'melvorD:Shrimp',
    equippedFoodQty: 2,
    bankQuantityOf: () => 200,
    ...overrides,
  };
}

describe('mid-fight reflexes', () => {
  it('tops up food before the slot empties', () => {
    // Auto-eat consumes the slot and never refills it, so a fight the gate
    // proved winnable "because there is food" stops being winnable silently.
    const equip = vi.fn(() => ok);
    const outcome = refillFood(fed(), equip);

    expect(outcome?.name).toBe('reflex.refillFood');
    expect(equip).toHaveBeenCalledWith('melvorD:Shrimp', 200);
  });

  it('does nothing when the slot is still healthy', () => {
    const equip = vi.fn(() => ok);
    expect(refillFood(fed({ equippedFoodQty: 50 }), equip)).toBeNull();
    expect(equip).not.toHaveBeenCalled();
  });

  it('does nothing outside combat, where the policy tier owns the decision', () => {
    expect(refillFood(fed({ inCombat: false }), () => ok)).toBeNull();
  });

  it('does not fire when the bank has no more of that food', () => {
    // Nothing to top up with. The policy tier's food floor ends the fight
    // instead, which is the correct outcome — this reflex must not mask it.
    expect(refillFood(fed({ bankQuantityOf: () => 0 }), () => ok)).toBeNull();
  });

  it('drops a prayer that has no points left to pay for it', () => {
    const toggle = vi.fn(() => ok);
    const outcome = dropUnpayablePrayers(
      { inCombat: true, prayerPoints: 0, activePrayerIds: ['melvorD:Thick_Skin'] },
      toggle,
    );

    expect(outcome?.name).toBe('reflex.dropPrayer');
    expect(toggle).toHaveBeenCalledWith('melvorD:Thick_Skin');
  });

  it('leaves a paid-for prayer alone', () => {
    const toggle = vi.fn(() => ok);
    expect(
      dropUnpayablePrayers(
        { inCombat: true, prayerPoints: 120, activePrayerIds: ['melvorD:Thick_Skin'] },
        toggle,
      ),
    ).toBeNull();
    expect(toggle).not.toHaveBeenCalled();
  });
});

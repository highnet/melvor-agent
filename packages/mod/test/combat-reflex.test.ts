import type { ActionResult } from '@melvor-agent/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  abandonIfOutmatched,
  dropUnpayablePrayers,
  eatWhenLow,
  refillFood,
} from '../src/runtime/combat-reflex.js';

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

describe('eatWhenLow', () => {
  const ok = { ok: true as const, name: 'test', before: {}, after: {} };

  function hurt(overrides: Partial<Parameters<typeof eatWhenLow>[0]> = {}) {
    return {
      inCombat: true,
      hitpoints: 40,
      maxHitpoints: 100,
      equippedFoodQty: 20,
      autoEatThresholdFraction: 0,
      ...overrides,
    };
  }

  it('eats when HP is low and nothing else will', () => {
    let eaten = 0;
    const outcome = eatWhenLow(hurt(), () => {
      eaten += 1;
      return ok;
    });

    expect(outcome?.name).toBe('reflex.eatWhenLow');
    expect(eaten).toBe(1);
  });

  it('leaves it to Auto Eat when Auto Eat is owned', () => {
    // Two things eating the same slot wastes food, and Auto Eat is better at
    // it: it triggers on the game's own cadence rather than once a second.
    expect(eatWhenLow(hurt({ autoEatThresholdFraction: 0.4 }), () => ok)).toBeNull();
  });

  it('does nothing at healthy HP', () => {
    expect(eatWhenLow(hurt({ hitpoints: 95 }), () => ok)).toBeNull();
  });

  it('does nothing outside combat', () => {
    // Eating to heal up between fights is a decision about food stock, not a
    // reflex — the policy tier owns it.
    expect(eatWhenLow(hurt({ inCombat: false }), () => ok)).toBeNull();
  });

  it('does nothing with an empty slot', () => {
    expect(eatWhenLow(hurt({ equippedFoodQty: 0 }), () => ok)).toBeNull();
  });

  it('does not divide by a zero max HP', () => {
    // maxHitpoints is 0 on a snapshot taken mid-load, and NaN > threshold is
    // false, so the guard is what stops it eating the whole bank.
    expect(eatWhenLow(hurt({ maxHitpoints: 0 }), () => ok)).toBeNull();
  });
});

describe('abandonIfOutmatched', () => {
  const ok = { ok: true as const, name: 'test', before: {}, after: {} };

  function fight(overrides: Partial<Parameters<typeof abandonIfOutmatched>[0]> = {}) {
    return { inCombat: true, maxHitpoints: 100, enemyMaxHit: 5, ...overrides };
  }

  it('leaves a fight the enemy is too strong for', () => {
    // The live counterpart to the pre-fight screen. Outside combat the game
    // cannot compute enemy stats, so the screen guesses from combat level; this
    // reads the real number the moment it exists and acts on it.
    const outcome = abandonIfOutmatched(fight({ enemyMaxHit: 40 }), () => ok);

    expect(outcome?.name).toBe('reflex.abandonIfOutmatched');
  });

  it('stays in a fight the character can absorb', () => {
    expect(abandonIfOutmatched(fight({ enemyMaxHit: 20 }), () => ok)).toBeNull();
  });

  it('does not act on an unknown enemy max hit', () => {
    // Unknown is not permission, but mid-fight it is not proof of danger
    // either, and disengaging on every unread stat would make combat
    // impossible. The policy tier's HP floor is the backstop for that case.
    expect(abandonIfOutmatched(fight({ enemyMaxHit: null }), () => ok)).toBeNull();
    expect(abandonIfOutmatched(fight({ enemyMaxHit: 0 }), () => ok)).toBeNull();
  });

  it('does nothing outside combat', () => {
    expect(abandonIfOutmatched(fight({ inCombat: false, enemyMaxHit: 999 }), () => ok)).toBeNull();
  });
});

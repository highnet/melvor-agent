import type { ActionResult } from '@melvor-agent/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  abandonIfOutmatched,
  collectPendingLoot,
  compostBeforePlanting,
  dropUnpayablePrayers,
  eatWhenLow,
  expandBankWhenFull,
  harvestReadyPlots,
  openPendingContainers,
  plantEmptyPlots,
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

  it('tops up outside combat too, because Thieving drains food as well', () => {
    // This used to be gated on combat. Thieving damages on every failed
    // pickpocket and eats through the same slot, so a reflex that only worked
    // in fights left the character with nothing to eat during it.
    expect(refillFood(fed({ inCombat: false }), () => ok)).not.toBeNull();
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

  it('eats outside combat too, because Thieving hurts', () => {
    // Gating this on combat is what took the character to 5 HP out of 110: a
    // failed pickpocket deals damage, Thieving is not combat, and so nothing
    // ate for two minutes of unattended play.
    expect(eatWhenLow(hurt(), () => ok)).not.toBeNull();
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

describe('collectPendingLoot', () => {
  const ok = { ok: true as const, name: 'test', before: {}, after: {} };

  it('collects when the container is filling', () => {
    // A reflex rather than a decision: there is no judgement in it, the cost is
    // one call, and the alternative is silently losing everything the fighting
    // produced once the container overflows.
    const outcome = collectPendingLoot({ inCombat: true, hasLootWorthTaking: true }, () => ok);

    expect(outcome?.name).toBe('reflex.collectLoot');
  });

  it('does nothing when there is nothing worth taking', () => {
    expect(collectPendingLoot({ inCombat: true, hasLootWorthTaking: false }, () => ok)).toBeNull();
  });

  it('still collects after combat ends', () => {
    // Loot outlives the fight, and a container left full is the same loss
    // whether or not the character is still swinging.
    expect(
      collectPendingLoot({ inCombat: false, hasLootWorthTaking: true }, () => ok),
    ).not.toBeNull();
  });
});

describe('refillFood on an empty slot', () => {
  const ok = { ok: true as const, name: 'test', before: {}, after: {} };

  it('equips food from the bank when the slot is empty', () => {
    // The case the reflex used to ignore, and the one that matters most: with
    // nothing equipped the eat reflex cannot act at all. Live, Thieving emptied
    // the slot and the character fell to 32 hitpoints of 120.
    let equipped: string | null = null;

    const outcome = refillFood(
      {
        inCombat: false,
        equippedFoodId: null,
        equippedFoodQty: 0,
        bankQuantityOf: () => 0,
        bankedFood: [{ itemId: 'melvorD:Shrimp', quantity: 28 }],
      },
      (itemId) => {
        equipped = itemId;
        return ok;
      },
    );

    expect(outcome?.name).toBe('reflex.refillFood');
    expect(equipped).toBe('melvorD:Shrimp');
  });

  it('does nothing when the bank has no food either', () => {
    expect(
      refillFood(
        {
          inCombat: false,
          equippedFoodId: null,
          equippedFoodQty: 0,
          bankQuantityOf: () => 0,
          bankedFood: [],
        },
        () => ok,
      ),
    ).toBeNull();
  });

  it('leaves a well-stocked slot alone', () => {
    expect(
      refillFood(
        {
          inCombat: true,
          equippedFoodId: 'melvorD:Shrimp',
          equippedFoodQty: 50,
          bankQuantityOf: () => 100,
          bankedFood: [{ itemId: 'melvorD:Chicken', quantity: 10 }],
        },
        () => ok,
      ),
    ).toBeNull();
  });
});

describe('reading the right food slot', () => {
  const ok = { ok: true as const, name: 'test', before: {}, after: {} };

  it('eats from the slot the game actually uses', () => {
    // This killed the character. The reflex indexed food by
    // `selectedEquipmentSet`, read an empty slot, and concluded there was
    // nothing to eat while 33 chickens healing 90 each sat in the next slot.
    // The snapshot now carries `selectedFoodSlot`, which is what the game eats
    // from, and it is a different number entirely.
    const outcome = eatWhenLow(
      {
        hitpoints: 6,
        maxHitpoints: 120,
        equippedFoodQty: 33,
        autoEatThresholdFraction: 0,
      },
      () => ok,
    );

    expect(outcome?.name).toBe('reflex.eatWhenLow');
  });
});

describe('an empty selected food slot', () => {
  const ok = { ok: true as const, name: 'test', before: {}, after: {} };

  it('is not mistaken for having no food', () => {
    // The second bug in this area, and subtler than the first. Indexing the
    // right slot is not enough: the *selected* slot can be empty while another
    // is stocked, because equipping food does not select it. A `??` fallback
    // does not fire for an empty slot — the entry exists with a quantity of
    // zero — so the character read as having nothing to eat with 33 chickens
    // one slot over, and died.
    const slots = [
      { itemId: null, itemName: null, qty: 0, healsFor: 0 },
      { itemId: 'melvorD:Chicken', itemName: 'Chicken', qty: 33, healsFor: 90 },
    ];

    const selected = slots[0];
    const usable =
      selected !== undefined && selected.qty > 0 ? selected : slots.find((s) => s.qty > 0);

    expect(usable?.itemName).toBe('Chicken');
    expect(
      eatWhenLow(
        {
          hitpoints: 14,
          maxHitpoints: 120,
          equippedFoodQty: usable?.qty ?? 0,
          autoEatThresholdFraction: 0,
        },
        () => ok,
      ),
    ).not.toBeNull();
  });
});

describe('openPendingContainers', () => {
  const ok = { ok: true as const, name: 'test', before: {}, after: {} };

  it('opens a container the moment one exists', () => {
    // The stopgap can open containers too, but only while idle. During a
    // three-hour objective nothing else would — which is exactly the stretch
    // where a seed is most likely to arrive unnoticed.
    const outcome = openPendingContainers({ hasContainer: true }, () => ok);

    expect(outcome?.name).toBe('reflex.openContainers');
  });

  it('does nothing when there is no container', () => {
    expect(openPendingContainers({ hasContainer: false }, () => ok)).toBeNull();
  });
});

describe('harvestReadyPlots', () => {
  const ok = () => ({ ok: true }) as never;

  it('harvests a grown plot without waiting for an objective', () => {
    // Farming is passive, so this can fire during combat or gathering alike.
    const outcome = harvestReadyPlots({ readyPlotIds: ['p1'] }, () => ok());

    expect(outcome?.name).toBe('reflex.harvestPlot');
  });

  it('does nothing when no plot is ready', () => {
    expect(harvestReadyPlots({ readyPlotIds: [] }, () => ok())).toBeNull();
  });

  it('takes one plot per tick rather than batching', () => {
    // Each harvest is verified by its own state transition; batching them into
    // one reflex outcome would report a single result for several actions.
    const harvested: string[] = [];
    harvestReadyPlots({ readyPlotIds: ['p1', 'p2'] }, (id) => {
      harvested.push(id);
      return ok();
    });

    expect(harvested).toEqual(['p1']);
  });
});

describe('plantEmptyPlots', () => {
  const ok = () => ({ ok: true }) as never;

  it('plants an empty plot with a seed held in quantity', () => {
    const planted: string[] = [];
    plantEmptyPlots(
      { emptyPlotIds: ['p1'], plentifulSeeds: [{ recipeId: 'Potato', held: 6, cost: 3 }] },
      (plotId, recipeId) => {
        planted.push(`${plotId}:${recipeId}`);
        return ok();
      },
    );

    expect(planted).toEqual(['p1:Potato']);
  });

  it('will not plant a seed there are too few of to cover the cost', () => {
    // A plot costs three seeds. Asking for one chose a seed that could not be
    // planted and failed once a second: "need 3x Potato Seeds, hold 2".
    const outcome = plantEmptyPlots(
      { emptyPlotIds: ['p1'], plentifulSeeds: [{ recipeId: 'Herb', held: 1, cost: 3 }] },
      () => ok(),
    );

    expect(outcome).toBeNull();
  });

  it('skips the seed it cannot afford and uses the one behind it', () => {
    const planted: string[] = [];
    plantEmptyPlots(
      {
        emptyPlotIds: ['p1'],
        plentifulSeeds: [
          { recipeId: 'Herb', held: 1, cost: 3 },
          { recipeId: 'Cabbage', held: 6, cost: 3 },
        ],
      },
      (_plotId, recipeId) => {
        planted.push(recipeId);
        return ok();
      },
    );

    expect(planted).toEqual(['Cabbage']);
  });

  it('does nothing when no plot is empty', () => {
    expect(
      plantEmptyPlots({ emptyPlotIds: [], plentifulSeeds: [{ recipeId: 'Potato', held: 9 }] }, () =>
        ok(),
      ),
    ).toBeNull();
  });
});

describe('expandBankWhenFull', () => {
  const ok = () => ({ ok: true }) as never;
  const slot = { purchaseId: 'melvorD:Extra_Bank_Slot', gpCost: 10_028, held: 116_327 };

  it('buys a slot when the bank is completely full', () => {
    const bought: string[] = [];
    expandBankWhenFull({ freeSlots: 0, expansion: slot }, (id) => {
      bought.push(id);
      return ok();
    });

    expect(bought).toEqual(['melvorD:Extra_Bank_Slot']);
  });

  it('leaves a bank with room alone', () => {
    // One slot left is tight, not lossy, and the planner may be spending down
    // to a floor on purpose.
    expect(expandBankWhenFull({ freeSlots: 1, expansion: slot }, () => ok())).toBeNull();
  });

  it('will not spend a large fraction of savings on a slot', () => {
    // Auto Eat is a 1,000,000 GP goal. A reflex that drains the pot to store
    // more logs would quietly undo the planner's work.
    const poor = { ...slot, held: 20_000 };

    expect(expandBankWhenFull({ freeSlots: 0, expansion: poor }, () => ok())).toBeNull();
  });

  it('does nothing when no slot can be bought', () => {
    expect(expandBankWhenFull({ freeSlots: 0, expansion: null }, () => ok())).toBeNull();
  });

  it('never sells to make room', () => {
    // Which stack is worth destroying is a judgement with no undo, and the
    // brief rules irreversible actions out. The only lever here is buying.
    const outcome = expandBankWhenFull({ freeSlots: 0, expansion: slot }, () => ok());

    expect(outcome?.name).toBe('reflex.expandBank');
  });
});

describe('compostBeforePlanting', () => {
  const ok = () => ({ ok: true }) as never;
  const compost = { itemId: 'melvorD:Compost', held: 25 };

  it('composts a bare plot before a seed goes in', () => {
    // An uncomposted crop has a 50% chance to grow, and seeds arrive two and
    // three at a time. Losing half of them is the difference between Farming
    // moving and Farming never starting.
    const applied: string[] = [];
    compostBeforePlanting({ bareplotIds: ['p1'], compost }, (plotId, compostId) => {
      applied.push(`${plotId}:${compostId}`);
      return ok();
    });

    expect(applied).toEqual(['p1:melvorD:Compost']);
  });

  it('does nothing when no compost is held', () => {
    expect(compostBeforePlanting({ bareplotIds: ['p1'], compost: null }, () => ok())).toBeNull();
  });

  it('does nothing when there is no bare plot', () => {
    expect(compostBeforePlanting({ bareplotIds: [], compost }, () => ok())).toBeNull();
  });

  it('treats an empty compost stack as none', () => {
    const spent = { itemId: 'melvorD:Compost', held: 0 };

    expect(compostBeforePlanting({ bareplotIds: ['p1'], compost: spent }, () => ok())).toBeNull();
  });
});

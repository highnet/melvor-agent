import type { ActionResult } from '@melvor-agent/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  abandonIfOutmatched,
  buyTrivialUpgrades,
  claimFinishedTasks,
  collectPendingLoot,
  compostBeforePlanting,
  dropUnpayablePrayers,
  eatWhenLow,
  expandBankWhenFull,
  harvestReadyPlots,
  openPendingContainers,
  plantEmptyPlots,
  refillFood,
  repairDegradedBuildings,
  stopWhenStarving,
  unlockAffordablePlots,
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

  it('leaves a bank with real room alone', () => {
    expect(expandBankWhenFull({ freeSlots: 8, expansion: slot }, () => ok())).toBeNull();
  });

  it('buys early when the slot is small change', () => {
    // The premise this replaces said one slot left was "tight, not lossy". At
    // zero the loss has already started, so waiting for zero is waiting for the
    // damage. When a slot is 5% of what is held, pre-empting is nearly free.
    const cheap = { purchaseId: 'melvorD:Extra_Bank_Slot', gpCost: 2_000, held: 100_000 };

    expect(expandBankWhenFull({ freeSlots: 2, expansion: cheap }, () => ok())).not.toBeNull();
  });

  it('waits for the emergency when the slot is dear', () => {
    // 27,044 against 49,356 held is 55% — real money. Under mere pressure that
    // waits; at zero free slots the same purchase goes through below.
    const dear = { purchaseId: 'melvorD:Extra_Bank_Slot', gpCost: 27_044, held: 49_356 };

    expect(expandBankWhenFull({ freeSlots: 2, expansion: dear }, () => ok())).toBeNull();
  });

  it('buys at zero free slots even when the slot costs most of the balance', () => {
    // The two-hour deadlock. Bank 59/59, 59,369 GP, slot priced 33,068 — over
    // the old half-of-GP cap by 3,384. Every gathering action was refused
    // because its output had nowhere to go, so income was zero and the balance
    // being protected could never grow. A savings floor only means something if
    // something can still earn.
    const dear = { purchaseId: 'melvorD:Extra_Bank_Slot', gpCost: 33_068, held: 59_369 };

    expect(expandBankWhenFull({ freeSlots: 0, expansion: dear }, () => ok())).not.toBeNull();
  });

  it('still refuses a slot it genuinely cannot afford', () => {
    const unaffordable = { purchaseId: 'melvorD:Extra_Bank_Slot', gpCost: 60_000, held: 59_369 };

    expect(expandBankWhenFull({ freeSlots: 0, expansion: unaffordable }, () => ok())).toBeNull();
  });

  it('buys even when the slot is a sizeable slice of what is held', () => {
    // The live case that moved this line: 52/52 with 55,678 GP against a
    // 15,885 slot. At a quarter-cap the guard sat and watched items be
    // discarded to protect a balance, which is the wrong trade — a full bank
    // loses continuously, savings are a stock.
    const pricey = { purchaseId: 'melvorD:Extra_Bank_Slot', gpCost: 15_885, held: 55_678 };

    expect(expandBankWhenFull({ freeSlots: 0, expansion: pricey }, () => ok())).not.toBeNull();
  });

  it('buys for a near-broke character too, because idle earns nothing', () => {
    // This test asserted the opposite, and the deadlock disproved it. The cap
    // was described as protecting "the near-broke case", but a near-broke
    // character with a full bank is the case that most needs the slot: it
    // cannot earn its way out, because every gathering action is refused while
    // its output has nowhere to go.
    //
    // 10,028 against 12,000 held is 84% of everything. It is still right. The
    // alternative is not "save the money", it is "stop playing".
    const poor = { ...slot, held: 12_000 };

    expect(expandBankWhenFull({ freeSlots: 0, expansion: poor }, () => ok())).not.toBeNull();
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

describe('unlockAffordablePlots', () => {
  const ok = () => ({ ok: true }) as never;

  it('buys a plot the moment the game says it can be bought', () => {
    // Unattended, the character would otherwise reach Farming 5 holding the
    // 10,000 GP for a Herb plot and never buy it — and the Herb plot is what
    // Herblore is waiting behind.
    const bought: string[] = [];
    unlockAffordablePlots({ unlockablePlotIds: ['herb1'] }, (id) => {
      bought.push(id);
      return ok();
    });

    expect(bought).toEqual(['herb1']);
  });

  it('does nothing when no plot can be unlocked', () => {
    // `canUnlock` is the game's own answer, covering both the level
    // requirement and the cost, so neither is second-guessed here.
    expect(unlockAffordablePlots({ unlockablePlotIds: [] }, () => ok())).toBeNull();
  });

  it('takes one plot per tick so each purchase is verified on its own', () => {
    const bought: string[] = [];
    unlockAffordablePlots({ unlockablePlotIds: ['p1', 'p2'] }, (id) => {
      bought.push(id);
      return ok();
    });

    expect(bought).toEqual(['p1']);
  });
});

describe('claimFinishedTasks', () => {
  const ok = () => ({ ok: true }) as never;

  it('claims a finished task without waiting for a planner', () => {
    // Free, additive and impossible to get wrong. An unclaimed task also holds
    // its slot, so the next one never starts — and Township XP gates the biome
    // the Herb producer lives in.
    const claimed: string[] = [];
    claimFinishedTasks({ claimable: [{ kind: 'township', taskId: 'melvorF:Task1' }] }, (k, id) => {
      claimed.push(`${k}:${id}`);
      return ok();
    });

    expect(claimed).toEqual(['township:melvorF:Task1']);
  });

  it('routes a casual task to the casual claim', () => {
    // The two claims are different calls; sending one to the other silently
    // does nothing.
    const claimed: string[] = [];
    claimFinishedTasks({ claimable: [{ kind: 'casual', taskId: 'melvorF:Casual1' }] }, (k, id) => {
      claimed.push(`${k}:${id}`);
      return ok();
    });

    expect(claimed).toEqual(['casual:melvorF:Casual1']);
  });

  it('does nothing when no task is finished', () => {
    expect(claimFinishedTasks({ claimable: [] }, () => ok())).toBeNull();
  });

  it('takes one per tick so each claim is verified on its own', () => {
    const claimed: string[] = [];
    claimFinishedTasks(
      {
        claimable: [
          { kind: 'township', taskId: 'a' },
          { kind: 'township', taskId: 'b' },
        ],
      },
      (_k, id) => {
        claimed.push(id);
        return ok();
      },
    );

    expect(claimed).toEqual(['a']);
  });
});

describe('buyTrivialUpgrades', () => {
  const ok = () => ({ ok: true }) as never;
  // The live shop, at the moment the oversight was pointed out.
  const shop = [
    { purchaseId: 'melvorD:Iron_Axe', name: 'Iron Axe', gpCost: 50 },
    { purchaseId: 'melvorD:Iron_Fishing_Rod', name: 'Iron Fishing Rod', gpCost: 100 },
    { purchaseId: 'melvorD:Iron_Pickaxe', name: 'Iron Pickaxe', gpCost: 250 },
    { purchaseId: 'melvorD:Mithril_Axe', name: 'Mithril Axe', gpCost: 10_000 },
  ];

  it('buys the cheapest upgrade the character can trivially afford', () => {
    const bought: string[] = [];
    buyTrivialUpgrades({ gp: 43_860, upgrades: shop }, (id) => {
      bought.push(id);
      return ok();
    });

    expect(bought).toEqual(['melvorD:Iron_Axe']);
  });

  it('buys an upgrade the character can comfortably afford', () => {
    // This test previously asserted the opposite. The old band was 2% of held
    // GP, on the argument that anything dearer was a trade-off for the planner
    // — and then the planner did not make it. A Mithril Axe at 10,000 against
    // 58,733 held is -20% on the cut interval of the action the agent was
    // running for hours, and it sat unbought until the operator pointed at it.
    const bought: string[] = [];
    buyTrivialUpgrades({ gp: 58_733, upgrades: [shop[3] as (typeof shop)[number]] }, (id) => {
      bought.push(id);
      return ok();
    });

    expect(bought).toEqual(['melvorD:Mithril_Axe']);
  });

  it('refuses a dear upgrade however rich the character is', () => {
    // The failure the raised fraction introduced. At 400,000 held, half is
    // 200,000, so the reflex would have bought the Adamant Pickaxe outright --
    // a fifth of the Auto Eat fund the run is explicitly saving for, spent by a
    // per-tick reflex that cannot know what the GP is for.
    //
    // The payback argument that made it look sound was wrong: a pickaxe does
    // not earn the activity's whole GP rate, only a fraction of it, so cost
    // divided by 120,000 GP-per-hour flatters every expensive tool on the list.
    const dear = [
      { purchaseId: 'melvorD:Adamant_Pickaxe', name: 'Adamant Pickaxe', gpCost: 200_000 },
    ];

    expect(buyTrivialUpgrades({ gp: 400_000, upgrades: dear }, () => ok())).toBeNull();
    expect(buyTrivialUpgrades({ gp: 5_000_000, upgrades: dear }, () => ok())).toBeNull();
  });

  it('still refuses to sink most of a balance into one purchase', () => {
    // The failure the cap was really guarding against, and the reason the line
    // is a half rather than no limit at all.
    const dear = [{ purchaseId: 'melvorD:Rune_Pickaxe', name: 'Rune Pickaxe', gpCost: 1_000_000 }];

    expect(buyTrivialUpgrades({ gp: 1_200_000, upgrades: dear }, () => ok())).toBeNull();
  });

  it('buys an unlocked pickaxe on a character mining for GP', () => {
    // The purchase the old quarter-of-GP rule was quietly hardest on. Requiring
    // cost <= gp/4 is requiring four times the price in hand, so the Mithril
    // Pickaxe at 50,000 -- unlocked, unbought, on a character mining Crystal
    // specifically to earn GP -- demanded 200,000 held. The better the upgrade,
    // the further the old rule pushed it away.
    const bought: string[] = [];
    buyTrivialUpgrades(
      {
        gp: 110_000,
        upgrades: [
          { purchaseId: 'melvorD:Mithril_Pickaxe', name: 'Mithril Pickaxe', gpCost: 50_000 },
        ],
      },
      (id) => {
        bought.push(id);
        return ok();
      },
    );

    expect(bought).toEqual(['melvorD:Mithril_Pickaxe']);
  });

  it('still buys a trivial upgrade for a poor character', () => {
    // Guards the regression an absolute reserve floor would have introduced: a
    // floor of 25,000 refuses a 50 GP axe to a character holding 1,000, which
    // is the exact oversight this reflex exists to prevent.
    const bought: string[] = [];
    buyTrivialUpgrades({ gp: 1_000, upgrades: shop }, (id) => {
      bought.push(id);
      return ok();
    });

    expect(bought).toEqual(['melvorD:Iron_Axe']);
  });

  it('buys nothing dear when the character is poor', () => {
    // The proportional floor, at a balance where it genuinely bites: 50 GP
    // against 60 held is nearly everything.
    //
    // This assertion used to sit at 150 GP held, on the reasoning that a third
    // of everything is a real sacrifice. Raising the cap to a half deliberately
    // reverses that case, and the reversal is right: 150 GP buys nothing else
    // that matters — a bank slot and a restock both cost far more — while the
    // axe is a permanent interval cut that compounds over every action after
    // it. Idle GP earns nothing.
    expect(buyTrivialUpgrades({ gp: 60, upgrades: shop }, () => ok())).toBeNull();
  });

  it('does nothing when everything worth having is already owned', () => {
    expect(buyTrivialUpgrades({ gp: 43_860, upgrades: [] }, () => ok())).toBeNull();
  });
});

describe('upgrading the food in the slot', () => {
  const ok = () => ({ ok: true }) as never;

  // This described a feature that has been removed, and the removal is the
  // lesson. Swapping to better banked food looked right — a character that
  // equipped Shrimp early otherwise eats Shrimp forever — but a food slot
  // already holding one item refuses a different one, so the call changed
  // nothing and the reflex repeated it every four seconds. `Beef 8 -> Beef 8`
  // in the projection, with no Beef in the bank at all.
  const occupied = {
    inCombat: false,
    equippedFoodId: 'melvorD:Beef',
    equippedFoodQty: 8,
    equippedFoodHeals: 3,
    bankQuantityOf: () => 0,
    bankedFood: [{ itemId: 'melvorD:Seahorse', quantity: 40, heals: 30 }],
  };

  it('does not try to swap food into an occupied slot', () => {
    expect(refillFood(occupied, () => ok())).toBeNull();
  });

  it('still picks the best food when the slot is empty', () => {
    // Where the upgrade genuinely belongs: readBankedFood sorts by healing, so
    // an empty slot always gets the best available.
    const equipped: string[] = [];
    refillFood({ ...occupied, equippedFoodId: null, equippedFoodQty: 0 }, (itemId) => {
      equipped.push(itemId);
      return ok();
    });

    expect(equipped).toEqual(['melvorD:Seahorse']);
  });
});

describe('repairDegradedBuildings', () => {
  const ok = () => ({ ok: true }) as never;

  it('repairs the worst building first', () => {
    // One repair per pass, so the pass has to spend it on the building losing
    // the most production rather than whichever the registry happened to list
    // first.
    const repaired: string[] = [];
    repairDegradedBuildings(
      {
        repairable: [
          { buildingId: 'melvorF:Statue', biomeId: 'melvorF:Grasslands', efficiency: 80 },
          { buildingId: 'melvorF:Farmland', biomeId: 'melvorF:Grasslands', efficiency: 20 },
        ],
      },
      (buildingId, biomeId) => {
        repaired.push(`${biomeId}/${buildingId}`);
        return ok();
      },
    );

    expect(repaired).toEqual(['melvorF:Grasslands/melvorF:Farmland']);
  });

  it('does nothing when the town is healthy', () => {
    // The adapter filters on both efficiency and affordability, so an empty
    // list is the normal case and must stay silent rather than reporting a
    // no-op every tick.
    const repaired: string[] = [];
    const outcome = repairDegradedBuildings({ repairable: [] }, (buildingId) => {
      repaired.push(buildingId);
      return ok();
    });

    expect(outcome).toBeNull();
    expect(repaired).toEqual([]);
  });
});

describe('stopWhenStarving with food in the bank', () => {
  const ok = () => ({ ok: true }) as never;
  const base = {
    hasAutoEat: false,
    maxHitpoints: 150,
    damagingSkillId: 'melvorD:Thieving',
    inCombat: false,
  };

  it('stops at critical health even though meals are banked', () => {
    // The death this reflex exists to prevent, and the one it allowed: the
    // guard returned early on `meals > 0`, so it could never fire while any
    // food existed anywhere. Eating happens from the equipped slot, so 99
    // banked Seahorse proved nothing about whether the character could eat.
    const stopped: string[] = [];
    stopWhenStarving({ ...base, meals: 99, hitpoints: 30 }, (damaging) => {
      stopped.push(damaging.kind === 'combat' ? 'combat' : damaging.skillId);
      return ok();
    });

    expect(stopped).toEqual(['melvorD:Thieving']);
  });

  it('does not stop at half health when meals are banked', () => {
    // Dipping under half with food available is ordinary play. Stopping there
    // would cost the run for nothing, which is why the two thresholds differ.
    const stopped: string[] = [];
    const outcome = stopWhenStarving({ ...base, meals: 99, hitpoints: 100 }, (damaging) => {
      stopped.push(damaging.kind === 'combat' ? 'combat' : damaging.skillId);
      return ok();
    });

    expect(outcome).toBeNull();
    expect(stopped).toEqual([]);
  });

  it('still stops at half health when there is no food at all', () => {
    // The original behaviour, which must survive the fix above.
    const stopped: string[] = [];
    stopWhenStarving({ ...base, meals: 0, hitpoints: 70 }, (damaging) => {
      stopped.push(damaging.kind === 'combat' ? 'combat' : damaging.skillId);
      return ok();
    });

    expect(stopped).toEqual(['melvorD:Thieving']);
  });

  it('leaves a non-damaging skill alone however low health is', () => {
    // Runecrafting does not cost health, so stopping it would strand the plan
    // for a danger that is not coming from the action slot.
    const outcome = stopWhenStarving(
      { ...base, damagingSkillId: null, inCombat: false, meals: 0, hitpoints: 1 },
      () => ok(),
    );

    expect(outcome).toBeNull();
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetActLedger } from '../src/adapter/act.js';
import {
  forgetStashedValuables,
  hasStashedValuables,
  readStrippableValuables,
  restoreStashedValuables,
  stashValuablesForCombat,
  whyInertInFight,
  whyQuiverIsDeadWeight,
} from '../src/adapter/valuables.js';
import {
  restoreValuablesAfterCombat,
  stripValuablesForFight,
} from '../src/runtime/combat-reflex.js';

/**
 * What comes off before a fight, what stays on, and what goes back.
 *
 * `Player.applyDeathPenalty` (player.d.ts:410) rolls one entry of the whole
 * equipment array and destroys whatever is in it. This character has died 55
 * times wearing a 3,900 GP Thiever's Cape — a Thieving reward, not a shop item
 * — and a 5,000 GP Jeweled Necklace, neither of which changes how a fight goes.
 *
 * Every item below is transcribed from the shipped v1.3.1 data rather than
 * invented, because the whole judgement rests on which items carry equipment
 * stats and which carry only modifiers. A fake that gave the Thiever's Cape a
 * defence bonus, or took `summoningMaxhit` off a combat familiar, would be
 * green while the real rule stripped armour.
 */

const globals = globalThis as Record<string, unknown>;

class FakeEquipmentItem {
  id = '';
  name = '';
  equipmentStats: { key: string; value: number }[] = [];
  modifiers: { modifier: { id: string }; skill?: { id: string } }[] = [];
  conditionalModifiers: unknown[] = [];
  equipRequirements: unknown[] = [];
  ammoType: number | undefined;
  validSlots: { id: string; allowQuantity: boolean }[] = [];

  constructor(parts: Record<string, unknown>) {
    Object.assign(this, parts);
  }
}

class FakeWeaponItem extends FakeEquipmentItem {
  attackType = 'magic';
  ammoTypeRequired: number | undefined;

  // Field initializers run after `super()`, so the base class's `Object.assign`
  // is overwritten by the declarations above unless it is repeated here. The
  // same trap `combat-style-gear.test.ts` documents; getting it wrong made
  // every fake weapon read as needing no ammunition.
  constructor(parts: Record<string, unknown>) {
    super(parts);
    Object.assign(this, parts);
  }
}

function slot(id: string, allowQuantity = false) {
  return { id, allowQuantity };
}

/** A weapon: `melvorF:Staff_of_Air`, a two-handed magic staff. */
const STAFF = new FakeWeaponItem({
  id: 'melvorF:Staff_of_Air',
  name: 'Staff of Air',
  attackType: 'magic',
  equipmentStats: [{ key: 'magicAttackBonus', value: 10 }],
  validSlots: [slot('melvorD:Weapon')],
});

/** Armour that plainly contributes: a real `magicDefenceBonus`. */
const ROBES = new FakeEquipmentItem({
  id: 'melvorF:Fire_Acolyte_Wizard_Robes',
  name: 'Fire Acolyte Wizard Robes',
  equipmentStats: [{ key: 'magicDefenceBonus', value: 2 }],
  validSlots: [slot('melvorD:Platebody')],
});

/** `melvorD:Leather_Gloves`: `meleeDefenceBonus: 1` — one stat is enough. */
const GLOVES = new FakeEquipmentItem({
  id: 'melvorD:Leather_Gloves',
  name: 'Leather Gloves',
  equipmentStats: [{ key: 'meleeDefenceBonus', value: 1 }],
  validSlots: [slot('melvorD:Gloves')],
});

/** `melvorD:Bronze_Arrows`: `rangedStrengthBonus: 7`, `ammoType: Arrows`. */
const ARROWS = new FakeEquipmentItem({
  id: 'melvorD:Bronze_Arrows',
  name: 'Bronze Arrows',
  equipmentStats: [{ key: 'rangedStrengthBonus', value: 7 }],
  ammoType: 0,
  validSlots: [slot('melvorD:Quiver', true)],
});

/**
 * `melvorF:Thievers_Cape`: no equipment stats, three Thieving modifiers.
 *
 * `currencyGain` and `skillXP` are scoped `melvorD:Thieving` in the data;
 * `thievingStealth` carries no scope at all, which is why the rule needs an
 * explicit name for it and not only the game's `ModifierValue.skill`.
 */
const CAPE = new FakeEquipmentItem({
  id: 'melvorF:Thievers_Cape',
  name: "Thiever's Cape",
  equipmentStats: [],
  modifiers: [
    { modifier: { id: 'melvorD:thievingStealth' } },
    { modifier: { id: 'melvorD:currencyGain' }, skill: { id: 'melvorD:Thieving' } },
    { modifier: { id: 'melvorD:skillXP' }, skill: { id: 'melvorD:Thieving' } },
  ],
  validSlots: [slot('melvorD:Cape')],
});

/** `melvorF:Jeweled_Necklace`: no stats, one unscoped `currencyGain`. */
const NECKLACE = new FakeEquipmentItem({
  id: 'melvorF:Jeweled_Necklace',
  name: 'Jeweled Necklace',
  equipmentStats: [],
  modifiers: [{ modifier: { id: 'melvorD:currencyGain' } }],
  // Valid in two slots in the real data, which is why the stash is keyed by
  // slot rather than by item.
  validSlots: [slot('melvorD:Amulet'), slot('melvorD:Passive')],
});

/**
 * `melvorF:Summoning_Familiar_Ent`: a *skilling* familiar.
 *
 * `equipmentStats: []`, `additionalPrimaryProductChance` scoped to Woodcutting,
 * `consumesOn: [{ type: 'WoodcuttingAction' }]`. It would pass every test the
 * Cape passes — which is exactly why the Summon slots are excluded by name.
 */
const ENT = new FakeEquipmentItem({
  id: 'melvorF:Summoning_Familiar_Ent',
  name: 'Ent',
  equipmentStats: [],
  modifiers: [
    {
      modifier: { id: 'melvorD:additionalPrimaryProductChance' },
      skill: { id: 'melvorD:Woodcutting' },
    },
  ],
  validSlots: [slot('melvorD:Summon1', true)],
});

/** `melvorAoD:Basic_Barrier_Gem`: no stats, one unscoped `flatBarrierDamage`. */
const GEM = new FakeEquipmentItem({
  id: 'melvorAoD:Basic_Barrier_Gem',
  name: 'Basic Barrier Gem',
  equipmentStats: [],
  modifiers: [{ modifier: { id: 'melvorD:flatBarrierDamage' } }],
  validSlots: [slot('melvorD:Gem')],
});

const EMPTY = new FakeEquipmentItem({ id: 'melvorD:Empty_Equipment', name: '' });

const ALL_ITEMS = [STAFF, ROBES, GLOVES, ARROWS, CAPE, NECKLACE, ENT, GEM];

/**
 * A character whose equipment and bank actually move.
 *
 * Equipping and unequipping transfer between the two, because the assertion
 * that matters most — the Cape is in the bank while the fight runs and back on
 * the character after it — is only meaningful if something is keeping the two
 * sides consistent.
 */
class FakeCharacter {
  selectedEquipmentSet = 0;
  readonly equipment: {
    equippedItems: Record<
      string,
      { item: FakeEquipmentItem; emptyItem: FakeEquipmentItem; quantity: number }
    >;
    getItemInSlot: (slotId: string) => FakeEquipmentItem;
  };
  readonly bank = new Map<FakeEquipmentItem, number>();

  constructor(worn: Record<string, [FakeEquipmentItem, number]>) {
    const equippedItems: Record<
      string,
      { item: FakeEquipmentItem; emptyItem: FakeEquipmentItem; quantity: number }
    > = {};
    for (const slotId of [
      'melvorD:Helmet',
      'melvorD:Platebody',
      'melvorD:Weapon',
      'melvorD:Amulet',
      'melvorD:Gloves',
      'melvorD:Quiver',
      'melvorD:Cape',
      'melvorD:Summon1',
      'melvorD:Gem',
    ]) {
      const entry = worn[slotId];
      equippedItems[slotId] =
        entry === undefined
          ? { item: EMPTY, emptyItem: EMPTY, quantity: 0 }
          : { item: entry[0], emptyItem: EMPTY, quantity: entry[1] };
    }

    this.equipment = {
      equippedItems,
      getItemInSlot: (slotId) => equippedItems[slotId]?.item ?? EMPTY,
    };
  }

  /** Mirrors the game: the item leaves the slot and lands in the bank. */
  unequipItem(_set: number, target: { id: string }): void {
    const equipped = this.equipment.equippedItems[target.id];
    if (equipped === undefined || equipped.item === EMPTY) return;
    this.bank.set(equipped.item, (this.bank.get(equipped.item) ?? 0) + equipped.quantity);
    equipped.item = EMPTY;
    equipped.quantity = 0;
  }

  /** And back the other way, taking the quantity the caller asked for. */
  equipItem(
    item: FakeEquipmentItem,
    _set: number,
    target: { id: string },
    quantity: number,
  ): boolean {
    const held = this.bank.get(item) ?? 0;
    if (held <= 0) return false;
    const taken = Math.min(held, quantity);
    this.bank.set(item, held - taken);
    if ((this.bank.get(item) ?? 0) <= 0) this.bank.delete(item);
    const equipped = this.equipment.equippedItems[target.id];
    if (equipped === undefined) return false;
    equipped.item = item;
    equipped.quantity = taken;
    return true;
  }

  wearing(slotId: string): string | null {
    const equipped = this.equipment.equippedItems[slotId];
    return equipped === undefined || equipped.item === EMPTY ? null : equipped.item.id;
  }
}

let player: FakeCharacter;
const never = (): boolean => false;

function install(worn: Record<string, [FakeEquipmentItem, number]>): void {
  player = new FakeCharacter(worn);
  globals.EquipmentItem = FakeEquipmentItem;
  globals.WeaponItem = FakeWeaponItem;
  globals.game = {
    combat: { player, isActive: false },
    equipmentSlots: { getObjectByID: (id: string) => ({ id, allowQuantity: true }) },
    items: {
      equipment: {
        getObjectByID: (id: string) => ALL_ITEMS.find((item) => item.id === id),
      },
    },
    bank: {
      getQty: (item: FakeEquipmentItem) => player.bank.get(item) ?? 0,
      occupiedSlots: 10,
      maximumSlots: 40,
    },
    checkRequirements: () => true,
  };
}

beforeEach(() => {
  // The act ledger is module-level and reports a run of identical successes as
  // a loop. Twenty-two tests stripping the same two slots is exactly that shape
  // and is not a finding, so each test starts from a clean ledger.
  resetActLedger();
  forgetStashedValuables();
  install({
    'melvorD:Platebody': [ROBES, 1],
    'melvorD:Weapon': [STAFF, 1],
    'melvorD:Amulet': [NECKLACE, 1],
    'melvorD:Gloves': [GLOVES, 1],
    'melvorD:Quiver': [ARROWS, 981],
    'melvorD:Cape': [CAPE, 1],
    'melvorD:Summon1': [ENT, 137],
    'melvorD:Gem': [GEM, 1],
  });
});

afterEach(() => {
  forgetStashedValuables();
  globals.game = undefined;
  globals.EquipmentItem = undefined;
  globals.WeaponItem = undefined;
});

describe('what a fight can and cannot use', () => {
  it('calls the Thiever’s Cape inert despite an unscoped modifier', () => {
    // `thievingStealth` carries no skill scope in the data, so the game's own
    // `ModifierValue.skill` cannot place it and the explicit table must.
    expect(
      whyInertInFight({
        slotId: 'melvorD:Cape',
        equipmentStats: [],
        modifiers: [
          { id: 'melvorD:thievingStealth', skillId: null },
          { id: 'melvorD:currencyGain', skillId: 'melvorD:Thieving' },
        ],
        conditionalModifiers: 0,
      }),
    ).not.toBeNull();
  });

  it('keeps anything with a single non-zero equipment stat', () => {
    // Leather Gloves are `meleeDefenceBonus: 1`. One point of defence is still
    // a contribution, and this is the clause that keeps armour on.
    expect(
      whyInertInFight({
        slotId: 'melvorD:Gloves',
        equipmentStats: [{ key: 'meleeDefenceBonus', value: 1 }],
        modifiers: [],
        conditionalModifiers: 0,
      }),
    ).toBeNull();
  });

  it('keeps an item whose modifier it cannot place', () => {
    // `flatBarrierDamage` is unscoped and unnamed: unknown is not inert. It is
    // also in the Gem slot, so it takes two mistakes to strip it.
    expect(
      whyInertInFight({
        slotId: 'melvorD:Amulet',
        equipmentStats: [],
        modifiers: [{ id: 'melvorD:flatBarrierDamage', skillId: null }],
        conditionalModifiers: 0,
      }),
    ).toBeNull();
  });

  it('keeps an item whose modifier the game scoped to a combat skill', () => {
    expect(
      whyInertInFight({
        slotId: 'melvorD:Cape',
        equipmentStats: [],
        modifiers: [{ id: 'melvorD:skillXP', skillId: 'melvorD:Defence' }],
        conditionalModifiers: 0,
      }),
    ).toBeNull();
  });

  it('keeps an item carrying a conditional modifier', () => {
    // A conditional carries a condition this code cannot evaluate, so its
    // worth is unknown rather than zero.
    expect(
      whyInertInFight({
        slotId: 'melvorD:Cape',
        equipmentStats: [],
        modifiers: [],
        conditionalModifiers: 1,
      }),
    ).toBeNull();
  });

  it('never judges the weapon, summon, gem or consumable slots', () => {
    for (const slotId of [
      'melvorD:Weapon',
      'melvorD:Summon1',
      'melvorD:Summon2',
      'melvorD:Gem',
      'melvorD:Consumable',
    ]) {
      expect(
        whyInertInFight({
          slotId,
          equipmentStats: [],
          modifiers: [],
          conditionalModifiers: 0,
        }),
      ).toBeNull();
    }
  });
});

describe('ammunition the weapon cannot fire', () => {
  it('calls the quiver dead weight for a weapon that reads none', () => {
    // A Staff of Air: `ammoTypeRequired` is absent, and the shipped
    // `Player.attack` breaks out before touching the quiver.
    expect(whyQuiverIsDeadWeight(undefined, 0)).not.toBeNull();
  });

  it('calls it dead weight when the types disagree', () => {
    // Arrows (0) loaded behind a crossbow needing Bolts (1).
    expect(whyQuiverIsDeadWeight(1, 0)).not.toBeNull();
  });

  it('leaves ammunition the weapon actually fires', () => {
    expect(whyQuiverIsDeadWeight(0, 0)).toBeNull();
  });
});

describe('stripping before a fight', () => {
  it('names exactly the Cape, the Necklace and the unfirable arrows', () => {
    const strippable = readStrippableValuables()
      .map((entry) => entry.slotId)
      .sort();

    expect(strippable).toEqual(['melvorD:Amulet', 'melvorD:Cape', 'melvorD:Quiver']);
  });

  it('takes the Cape and the Necklace off and puts them in the bank', () => {
    const result = stashValuablesForCombat(never);

    expect(result.ok).toBe(true);
    expect(player.wearing('melvorD:Cape')).toBeNull();
    expect(player.wearing('melvorD:Amulet')).toBeNull();
    expect(player.bank.get(CAPE)).toBe(1);
    expect(player.bank.get(NECKLACE)).toBe(1);
  });

  it('leaves the weapon and the armour alone', () => {
    stashValuablesForCombat(never);

    expect(player.wearing('melvorD:Weapon')).toBe(STAFF.id);
    expect(player.wearing('melvorD:Platebody')).toBe(ROBES.id);
    expect(player.wearing('melvorD:Gloves')).toBe(GLOVES.id);
  });

  it('does not strip a Summon', () => {
    // The Ent passes every content test the Cape passes — no equipment stats,
    // one Woodcutting-scoped modifier. Only the slot exclusion keeps it on, and
    // it is what stops a reflex quietly breaking a synergy pair.
    stashValuablesForCombat(never);

    expect(player.wearing('melvorD:Summon1')).toBe(ENT.id);
  });

  it('does not strip the Barrier Gem', () => {
    stashValuablesForCombat(never);

    expect(player.wearing('melvorD:Gem')).toBe(GEM.id);
  });

  it('refuses when there is nothing worth taking off', () => {
    install({ 'melvorD:Weapon': [STAFF, 1], 'melvorD:Platebody': [ROBES, 1] });

    const result = stashValuablesForCombat(never);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('precondition');
  });
});

describe('when the strip is allowed to happen', () => {
  it('leaves the Thiever’s Cape on outside a fight', () => {
    // The reason the condition is `inCombat` and not "fails a combat test".
    // The Cape is 25 Stealth and +10% Thieving GP; taking it off whenever it
    // scores nothing in combat would quietly cost the income this run lives on.
    expect(
      stripValuablesForFight({ inCombat: false, strippable: 3 }, () => {
        throw new Error('stripped outside a fight');
      }),
    ).toBeNull();
  });

  it('strips once a fight is running', () => {
    const outcome = stripValuablesForFight(
      { inCombat: true, strippable: readStrippableValuables().length },
      () => stashValuablesForCombat(never),
    );

    expect(outcome?.name).toBe('reflex.stripValuables');
    expect(player.wearing('melvorD:Cape')).toBeNull();
    expect(player.wearing('melvorD:Amulet')).toBeNull();
  });

  it('does nothing on a character wearing nothing spare', () => {
    // No call at all, rather than a call that refuses: a reflex that fires
    // every tick for a normal condition is how two real diagnostics here have
    // already been buried.
    expect(
      stripValuablesForFight({ inCombat: true, strippable: 0 }, () => {
        throw new Error('stripped with nothing to strip');
      }),
    ).toBeNull();
  });
});

describe('putting it back', () => {
  it('restores every stripped slot', () => {
    stashValuablesForCombat(never);
    const result = restoreStashedValuables(never);

    expect(result.ok).toBe(true);
    expect(player.wearing('melvorD:Cape')).toBe(CAPE.id);
    expect(player.wearing('melvorD:Amulet')).toBe(NECKLACE.id);
    expect(player.wearing('melvorD:Quiver')).toBe(ARROWS.id);
    expect(hasStashedValuables()).toBe(false);
  });

  it('restores the whole ammunition stack, not one arrow', () => {
    // The quantity bug that once left a fight with an empty quiver and 1,259
    // arrows in the bank. `equipQuantity` is what answers it; this pins that
    // the restore goes through the same path.
    stashValuablesForCombat(never);
    restoreStashedValuables(never);

    expect(player.equipment.equippedItems['melvorD:Quiver']?.quantity).toBe(981);
  });

  it('restores after a fight that ended in death', () => {
    // The ending the whole feature exists for. Nothing here observes a death
    // directly: `applyDeathPenalty` leaves the character alive at 20% health
    // and combat over, so "not in combat with a stash outstanding" is the same
    // observation for a death, an abort and a victory — which is the point.
    stashValuablesForCombat(never);
    expect(player.wearing('melvorD:Cape')).toBeNull();

    const outcome = restoreValuablesAfterCombat(
      { inCombat: false, hasStashedValuables: hasStashedValuables() },
      () => restoreStashedValuables(never),
    );

    expect(outcome?.name).toBe('reflex.restoreValuables');
    expect(outcome?.result.ok).toBe(true);
    expect(player.wearing('melvorD:Cape')).toBe(CAPE.id);
  });

  it('waits until the fight is over', () => {
    stashValuablesForCombat(never);

    expect(
      restoreValuablesAfterCombat({ inCombat: true, hasStashedValuables: true }, () => {
        throw new Error('restored mid-fight');
      }),
    ).toBeNull();
  });

  it('does nothing when nothing was stripped', () => {
    expect(
      restoreValuablesAfterCombat({ inCombat: false, hasStashedValuables: false }, () => {
        throw new Error('restored with an empty stash');
      }),
    ).toBeNull();
  });

  it('leaves a slot something else has since claimed', () => {
    // The operator's game. If a slot was refilled while the fight ran, putting
    // the old item back would make this the third tier fighting over one slot
    // — the shape that produced forty verified equips a minute for forty
    // minutes.
    stashValuablesForCombat(never);
    player.bank.set(GLOVES, 1);
    player.equipItem(GLOVES, 0, { id: 'melvorD:Amulet' }, 1);

    restoreStashedValuables(never);

    expect(player.wearing('melvorD:Amulet')).toBe(GLOVES.id);
    expect(player.bank.get(NECKLACE)).toBe(1);
    expect(hasStashedValuables()).toBe(false);
  });

  it('gives up on an item the bank no longer holds rather than retrying forever', () => {
    stashValuablesForCombat(never);
    player.bank.delete(CAPE);

    const result = restoreStashedValuables(never);

    expect(result.ok).toBe(true);
    expect(hasStashedValuables()).toBe(false);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import {
  ammoTypeName,
  readRefillableAmmo,
  readUnusableCombatStyles,
} from '../src/adapter/equipment.js';
import { installFakeGame } from './fixtures.js';

/**
 * A combat style that cannot be started, and nothing saying so.
 *
 * The character banked 1,620 Adamant Arrows, 344 Rune Arrows, 170 Dragon
 * Arrows and three tiers of crossbow while its `ranged-20` goal read 3/20, and
 * the whole candidate list offered exactly one thing to wear: a Steel Scimitar.
 * `readEquipCandidates` gates every item on `game.checkRequirements` and, when
 * that fails, does a bare `continue` -- so the level that refused each crossbow
 * was computed and discarded one line from where it was needed, and the only
 * way left to learn it was to reach it.
 *
 * These tests pin what the reader is willing to say. It names the refusal and
 * the requirement behind it; it does not propose a route, because proposing one
 * from a bank list is how a fabricated `requires:` came to block the Abyssal
 * goal for a reason that did not exist.
 */

const uninstalls: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  const globals = globalThis as Record<string, unknown>;
  globals.EquipmentItem = undefined;
  globals.WeaponItem = undefined;
});

/** A skill-level requirement in the shape `describeRequirements` reads. */
function needsLevel(skill: string, level: number, met: boolean) {
  return { type: 'SkillLevel', skill: { name: skill }, level, isMet: () => met };
}

class FakeEquipmentItem {
  id = '';
  name = '';
  equipRequirements: ReturnType<typeof needsLevel>[] = [];
  ammoType: number | undefined;

  constructor(parts: Record<string, unknown>) {
    Object.assign(this, parts);
  }
}

class FakeWeaponItem extends FakeEquipmentItem {
  attackType = 'melee';
  ammoTypeRequired: number | undefined;

  // Field initializers run *after* `super()`, so the base class's
  // `Object.assign` is overwritten by the declarations above and every fake
  // crossbow reads as melee with no ammunition. Assigning again is the fix, and
  // the bug it caused looked exactly like the reader misclassifying weapons.
  constructor(parts: Record<string, unknown>) {
    super(parts);
    Object.assign(this, parts);
  }
}

/**
 * Installs a bank and a fighting stance.
 *
 * `checkRequirements` is the real gate the adapter calls, so the fake answers
 * it the way the game does -- every requirement's own `isMet` -- rather than
 * with a flag the test sets. A stub that returned a boolean directly would let
 * the label and the gate disagree, which is exactly the bug being fixed.
 */
function installGame(
  banked: { item: FakeEquipmentItem; quantity: number }[],
  attackType: string,
  equippedWeapon: FakeEquipmentItem | null = null,
): void {
  const globals = globalThis as Record<string, unknown>;
  globals.EquipmentItem = FakeEquipmentItem;
  globals.WeaponItem = FakeWeaponItem;

  uninstalls.push(
    installFakeGame({
      checkRequirements: (requirements: { isMet: () => boolean }[]) =>
        requirements.every((requirement) => requirement.isMet()),
      bank: { items: new Map(banked.map((entry) => [entry.item.id, entry])) },
      combat: {
        player: {
          attackType,
          equipment: { getItemInSlot: () => equippedWeapon },
        },
      },
    }),
  );
}

const RANGED_40 = needsLevel('Ranged', 40, false);
const RANGED_30 = needsLevel('Ranged', 30, false);

const runeCrossbow = new FakeWeaponItem({
  id: 'melvorF:Rune_Crossbow',
  name: 'Rune Crossbow',
  attackType: 'ranged',
  ammoTypeRequired: 1,
  equipRequirements: [RANGED_40],
});
const adamantCrossbow = new FakeWeaponItem({
  id: 'melvorF:Adamant_Crossbow',
  name: 'Adamant Crossbow',
  attackType: 'ranged',
  ammoTypeRequired: 1,
  equipRequirements: [RANGED_30],
});
const adamantArrows = new FakeEquipmentItem({
  id: 'melvorD:Adamant_Arrows',
  name: 'Adamant Arrows',
  ammoType: 0,
  equipRequirements: [RANGED_30],
});
const shortbow = new FakeWeaponItem({
  id: 'melvorD:Normal_Shortbow',
  name: 'Normal Shortbow',
  attackType: 'ranged',
  ammoTypeRequired: 0,
  equipRequirements: [],
});

describe('readUnusableCombatStyles', () => {
  it('names the level each owned weapon is refused for', () => {
    // The line that did not exist. "Ranged 3/20" and a bank full of crossbows
    // was the entire visible state, and the levels below were only reachable by
    // levelling into them.
    installGame(
      [
        { item: runeCrossbow, quantity: 10 },
        { item: adamantCrossbow, quantity: 7 },
      ],
      'magic',
    );

    const [line] = readUnusableCombatStyles().filter((entry) => entry.label.startsWith('ranged:'));

    expect(line?.label).toContain('none of the 2 ranged weapon(s) owned can be equipped');
    expect(line?.label).toContain('10x Rune Crossbow needs Ranged 40');
    expect(line?.label).toContain('7x Adamant Crossbow needs Ranged 30');
  });

  it('says a crossbow fires Bolts when only arrows are banked', () => {
    // The second half of the same wall, and the one no stack count can show:
    // 1,620 arrows in the bank reads as "stocked" to anything that counts
    // items, and not one of them fits a crossbow.
    installGame(
      [
        { item: runeCrossbow, quantity: 10 },
        { item: adamantArrows, quantity: 1_620 },
      ],
      'magic',
    );

    const ranged = readUnusableCombatStyles().find((entry) => entry.label.startsWith('ranged:'));

    expect(ranged?.label).toContain('no Bolts are held at all');
  });

  it('reports an equippable weapon whose ammunition is held but refused', () => {
    // The trap this reader exists to make visible: the weapon passes, the bank
    // is full of the right *class* of ammunition, and the quiver still cannot
    // be loaded. Nothing about the item count says so.
    installGame(
      [
        { item: shortbow, quantity: 1 },
        { item: adamantArrows, quantity: 1_620 },
      ],
      'magic',
    );

    const line = readUnusableCombatStyles().find((entry) => entry.label.startsWith('ranged:'));

    expect(line?.label).toContain('Normal Shortbow can be equipped');
    expect(line?.label).toContain('1620x Adamant Arrows needs Ranged 30');
  });

  it('says nothing about a style with an equippable weapon and loadable ammunition', () => {
    const bronzeArrows = new FakeEquipmentItem({
      id: 'melvorD:Bronze_Arrows',
      name: 'Bronze Arrows',
      ammoType: 0,
      equipRequirements: [],
    });
    installGame(
      [
        { item: shortbow, quantity: 1 },
        { item: bronzeArrows, quantity: 500 },
      ],
      'magic',
    );

    expect(readUnusableCombatStyles().some((entry) => entry.label.startsWith('ranged:'))).toBe(
      false,
    );
  });

  it('distinguishes owning nothing from owning something refused', () => {
    // Two states that were indistinguishable from outside and want opposite
    // responses: one is answered by levelling, the other by acquiring a weapon.
    installGame([{ item: runeCrossbow, quantity: 10 }], 'magic');

    const melee = readUnusableCombatStyles().find((entry) => entry.label.startsWith('melee:'));

    expect(melee?.label).toContain('no melee weapon is owned');
  });

  it('leaves the style being fought in alone', () => {
    // `player.attackType` is derived from the equipped weapon, so the style in
    // use is usable by definition and a line about it would be false.
    installGame([{ item: runeCrossbow, quantity: 10 }], 'ranged');

    expect(readUnusableCombatStyles().some((entry) => entry.label.startsWith('ranged:'))).toBe(
      false,
    );
  });
});

describe('readRefillableAmmo', () => {
  it('refuses ammunition the character cannot equip', () => {
    // `equipItem` gates on the same `equipRequirements`, so a stack behind a
    // level would fail every retry the reflex spends on it. Null is the honest
    // answer -- no refill exists -- and it is what makes the reflex leave a
    // fight it cannot win rather than stand in it firing nothing.
    installGame([{ item: adamantArrows, quantity: 1_620 }], 'ranged', shortbow);

    expect(readRefillableAmmo()).toBeNull();
  });

  it('still offers ammunition that passes the same gate', () => {
    const bronzeArrows = new FakeEquipmentItem({
      id: 'melvorD:Bronze_Arrows',
      name: 'Bronze Arrows',
      ammoType: 0,
      equipRequirements: [],
    });
    installGame(
      [
        { item: adamantArrows, quantity: 1_620 },
        { item: bronzeArrows, quantity: 500 },
      ],
      'ranged',
      shortbow,
    );

    expect(readRefillableAmmo()).toEqual({ itemId: 'melvorD:Bronze_Arrows', quantity: 500 });
  });
});

describe('ammoTypeName', () => {
  it('names the numeric enum the dump and the labels both carry', () => {
    // A row reading `1` answers nothing about whether a crossbow can fire what
    // is in the bank, which is the entire question the equipment section exists
    // for. enums.d.ts:2983-2991.
    expect(ammoTypeName(0)).toBe('Arrows');
    expect(ammoTypeName(1)).toBe('Bolts');
  });

  it('keeps "no ammunition class" distinct from the class named None', () => {
    // A platebody has no `ammoType` at all; an item may be explicitly typed
    // None. Collapsing the first into the second claims the game said something
    // it did not.
    expect(ammoTypeName(undefined)).toBe('');
    expect(ammoTypeName(4)).toBe('None');
  });
});

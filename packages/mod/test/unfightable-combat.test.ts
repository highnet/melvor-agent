import { afterEach, describe, expect, it } from 'vitest';
import { readUnfightableCombat } from '../src/adapter/blocked.js';
import { readCannotAttackReason } from '../src/adapter/combat.js';
import { installFakeGame } from './fixtures.js';

/**
 * A fight offered at full price while the selected spell cannot be cast.
 *
 * Every combat goal was blocked for an evening and nothing in the candidate
 * list said so. Both Fight Leech objectives died the same way:
 *
 *     abandoning objective; the game refuses it in this state:
 *       Wind Strike is selected but the bank cannot pay for it (needs 1x Mind Rune)
 *
 * A Staff of Air equipped, a Magic attack spell selected, zero Mind Runes
 * banked -- while the list offered `221. Fight Leech (Wet Forest, combat level
 * 20) — 200 HP (defence 10), ~84 kills/h, ~16,744 damage/h` as fully available.
 * Grepping the entire candidate text for "Wind Strike" or "Mind Rune" returned
 * nothing. The executor's refusal was correct and legible; the candidate was
 * the lie.
 *
 * These tests drive the real readers against hand-written fakes, so the
 * refusal and the offer are answered by the same code and cannot drift back
 * apart. Every one of them was checked against the change reverted: with
 * `readCannotAttackReason` back on raw `runesRequired` and quiver quantity, and
 * `readUnfightableCombat` absent, the file does not compile and each assertion
 * below fails on its own once the pieces are restored one at a time.
 */

const uninstalls: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  const globals = globalThis as Record<string, unknown>;
  globals.WeaponItem = undefined;
});

/** The bare shape `getRuneCosts` and `getQty` pass around. item.d.ts:142-145. */
interface FakeItem {
  id: string;
  name: string;
  ammoType?: number;
}

const MIND_RUNE: FakeItem = { id: 'melvorD:Mind_Rune', name: 'Mind Rune' };
const AIR_RUNE: FakeItem = { id: 'melvorD:Air_Rune', name: 'Air Rune' };

/** `WeaponItem`, the class `ammoTypeRequired` lives on. item.d.ts:304-308. */
class FakeWeaponItem {
  name = '';
  ammoTypeRequired: number | undefined;

  // Field initializers run after the constructor body's implicit start, so the
  // assign has to come last or every fake weapon reads as unnamed with no
  // ammunition requirement -- the trap `combat-style-gear.test.ts` already
  // documents for its own fakes.
  constructor(parts: Record<string, unknown>) {
    Object.assign(this, parts);
  }
}

const STAFF_OF_AIR = new FakeWeaponItem({ name: 'Staff of Air' });
const ADAMANT_CROSSBOW = new FakeWeaponItem({ name: 'Adamant Crossbow', ammoTypeRequired: 1 });
const SLINGSHOT = new FakeWeaponItem({ name: 'Slingshot', ammoTypeRequired: 4 });

const BRONZE_ARROWS: FakeItem = { id: 'melvorD:Bronze_Arrows', name: 'Bronze Arrows', ammoType: 0 };
const BRONZE_BOLTS: FakeItem = { id: 'melvorD:Bronze_Bolts', name: 'Bronze Bolts', ammoType: 1 };
const EMPTY_EQUIPMENT: FakeItem = { id: 'melvorD:Empty_Equipment', name: '' };

interface Stance {
  attackType: string;
  weapon?: FakeWeaponItem;
  /** The selected attack spell, and what the game bills for casting it. */
  spell?: { name: string; costs: { item: FakeItem; quantity: number }[] };
  quiver?: { item: FakeItem; quantity: number };
  /** Bank stock, by item id. */
  banked?: Record<string, number>;
  /** Recipes per skill, so producers can be named. */
  recipes?: Record<string, { id: string; name: string; product: { id: string } }[]>;
}

/**
 * Installs a fighting stance.
 *
 * `getRuneCosts` is stubbed as a function rather than by copying
 * `spell.runesRequired` into it, because the two are genuinely different: the
 * shipped `Player.getRuneCosts` swaps in `runesRequiredAlt` for combination
 * runes and subtracts the runes the equipped staff provides. A fake that
 * returned the raw list would let the reader pass while reading the wrong
 * field, which is precisely the drift this file is meant to catch.
 */
function installStance(stance: Stance): void {
  const globals = globalThis as Record<string, unknown>;
  globals.WeaponItem = FakeWeaponItem;

  const banked = stance.banked ?? {};
  const recipes = stance.recipes ?? {};

  uninstalls.push(
    installFakeGame({
      bank: { getQty: (item: FakeItem) => banked[item.id] ?? 0 },
      skills: {
        getObjectByID: (skillId: string) =>
          recipes[skillId] === undefined
            ? undefined
            : { name: skillId.split(':')[1], actions: { allObjects: recipes[skillId] } },
      },
      combat: {
        player: {
          attackType: stance.attackType,
          spellSelection: { attack: stance.spell },
          getRuneCosts: (spell: { costs: { item: FakeItem; quantity: number }[] }) => spell.costs,
          equipment: {
            getItemInSlot: (slotId: string) =>
              slotId === 'melvorD:Weapon' ? stance.weapon : undefined,
            equippedItems: {
              'melvorD:Quiver': {
                item: stance.quiver?.item ?? EMPTY_EQUIPMENT,
                quantity: stance.quiver?.quantity ?? 0,
                emptyItem: EMPTY_EQUIPMENT,
              },
            },
          },
        },
      },
    }),
  );
}

/** Runecrafting as the character actually has it: the recipe that makes the rune. */
const RUNECRAFTING = {
  'melvorD:Runecrafting': [
    {
      id: 'melvorF:Mind_Rune',
      name: 'Mind Rune',
      product: { id: 'melvorD:Mind_Rune' },
    },
  ],
};

describe('a magic fight the bank cannot pay for', () => {
  it('is blocked with a reason naming the missing rune', () => {
    installStance({
      attackType: 'magic',
      weapon: STAFF_OF_AIR,
      spell: { name: 'Wind Strike', costs: [{ item: MIND_RUNE, quantity: 1 }] },
      banked: { 'melvorD:Air_Rune': 253 },
      recipes: RUNECRAFTING,
    });

    const [entry] = readUnfightableCombat(221);

    expect(entry).toBeDefined();
    // The executor's own words, verbatim -- this is the line the journal
    // carried all evening and the candidate list never did.
    expect(entry?.label).toContain(
      'Wind Strike is selected but the bank cannot pay for it (needs 1x Mind Rune)',
    );
    // And the producer, the way `Magic: Superheat II — Earth Rune from
    // Runecrafting: Earth Rune` has named one for months. A shortfall is a
    // fact; a shortfall with a producer is a move.
    expect(entry?.label).toContain('Mind Rune from Runecrafting: Mind Rune');
    // How much was withheld, because "no fight can be taken" and "one fight
    // cannot be taken" are different propositions.
    expect(entry?.label).toContain('221');
  });

  it('reports the shortfall as a number, not only inside the sentence', () => {
    // A figure that exists only in prose is readable by a planning session and
    // invisible at 3am; the renderer prints `missing` as "Mind Rune 0/1".
    installStance({
      attackType: 'magic',
      weapon: STAFF_OF_AIR,
      spell: { name: 'Wind Strike', costs: [{ item: MIND_RUNE, quantity: 1 }] },
      recipes: RUNECRAFTING,
    });

    expect(readUnfightableCombat(221)[0]?.missing).toEqual([
      { itemId: 'melvorD:Mind_Rune', name: 'Mind Rune', need: 1, have: 0 },
    ]);
  });

  it('outranks the ordinary combat lines', () => {
    // Around twenty low-severity lines compete for twelve slots. "You cannot
    // fight this one yet" is progression context; this is the only line
    // standing between five combat goals and silence.
    installStance({
      attackType: 'magic',
      weapon: STAFF_OF_AIR,
      spell: { name: 'Wind Strike', costs: [{ item: MIND_RUNE, quantity: 1 }] },
    });

    expect(readUnfightableCombat(221)[0]?.severity).toBe('high');
  });

  it('says nothing at all once the runes are in the bank', () => {
    // The other half, and the half that makes this a guard rather than a wall:
    // a plan is running right now to craft Mind Runes, and the moment it lands
    // every fight has to come back.
    installStance({
      attackType: 'magic',
      weapon: STAFF_OF_AIR,
      spell: { name: 'Wind Strike', costs: [{ item: MIND_RUNE, quantity: 1 }] },
      banked: { 'melvorD:Mind_Rune': 523 },
      recipes: RUNECRAFTING,
    });

    expect(readCannotAttackReason()).toBeNull();
    expect(readUnfightableCombat(221)).toEqual([]);
  });

  it('bills what the game bills, not what the spell lists', () => {
    // `Player.getRuneCosts` subtracts the runes the equipped staff provides. A
    // Staff of Air makes Wind Strike's Air Rune free, so a bank holding only
    // Mind Runes can still cast it -- and reading `runesRequired` directly
    // would withhold every fight for a rune nobody has to pay.
    installStance({
      attackType: 'magic',
      weapon: STAFF_OF_AIR,
      // What the game bills once the staff is accounted for: no Air Rune.
      spell: { name: 'Wind Strike', costs: [{ item: MIND_RUNE, quantity: 1 }] },
      banked: { 'melvorD:Mind_Rune': 10, 'melvorD:Air_Rune': 0 },
    });

    expect(readCannotAttackReason()).toBeNull();
  });

  it('blocks when no spell is selected at all', () => {
    installStance({ attackType: 'magic', weapon: STAFF_OF_AIR });

    expect(readCannotAttackReason()?.detail).toBe(
      'the weapon is a staff but no attack spell is selected, so no attack can be cast',
    );
    expect(readUnfightableCombat(221)).toHaveLength(1);
  });
});

describe('a ranged fight with the wrong ammunition', () => {
  it('is blocked when the quiver holds a type the weapon cannot fire', () => {
    // The game's own test is `weapon.ammoTypeRequired !== quiver.ammoType`
    // (shipped v1.3.1, `Player.attack`), answered with TOASTS_WRONG_AMMO.
    // Counting quantity alone let 981 Bronze Arrows arm a crossbow that fires
    // bolts -- full quiver, zero damage, indistinguishable from a fight about
    // to produce something.
    installStance({
      attackType: 'ranged',
      weapon: ADAMANT_CROSSBOW,
      quiver: { item: BRONZE_ARROWS, quantity: 981 },
    });

    expect(readCannotAttackReason()?.detail).toBe(
      'the quiver holds Bronze Arrows but Adamant Crossbow needs Bolts, so no attack can land',
    );
  });

  it('is blocked when the quiver is empty, and names what the weapon fires', () => {
    installStance({ attackType: 'ranged', weapon: ADAMANT_CROSSBOW });

    expect(readCannotAttackReason()?.detail).toBe(
      'the quiver is empty and Adamant Crossbow needs Bolts, so no attack can land',
    );
  });

  it('is offered normally when the loaded type matches', () => {
    installStance({
      attackType: 'ranged',
      weapon: ADAMANT_CROSSBOW,
      quiver: { item: BRONZE_BOLTS, quantity: 400 },
    });

    expect(readCannotAttackReason()).toBeNull();
    expect(readUnfightableCombat(221)).toEqual([]);
  });

  it('is offered with an empty quiver when the weapon needs no ammunition', () => {
    // `if (weapon.ammoTypeRequired === 4) break;` -- the game never looks at
    // the quiver for a Slingshot, and four ranged weapons in the dump are of
    // that kind. A guard that withholds every fight must not invent the last
    // one, so this is the case that keeps it from becoming a wall.
    installStance({ attackType: 'ranged', weapon: SLINGSHOT });

    expect(readCannotAttackReason()).toBeNull();
  });
});

describe('a melee fight', () => {
  it('is never withheld for runes or ammunition', () => {
    // Melee needs neither, and the empty quiver beside it is not its problem.
    // Withholding here would be the trap this project keeps paying for: a
    // guard that leaves the agent no combat at all.
    installStance({ attackType: 'melee', weapon: new FakeWeaponItem({ name: 'Steel Scimitar' }) });

    expect(readCannotAttackReason()).toBeNull();
    expect(readUnfightableCombat(221)).toEqual([]);
  });
});

describe('when nothing produces the missing item', () => {
  it('states the shortfall and invents no producer', () => {
    // A monster drop or a shop purchase has no recipe, and a fabricated
    // producer is worse than an entry that only says what is missing.
    installStance({
      attackType: 'magic',
      weapon: STAFF_OF_AIR,
      spell: { name: 'Water Strike', costs: [{ item: AIR_RUNE, quantity: 1 }] },
      recipes: {},
    });

    const label = readUnfightableCombat(221)[0]?.label ?? '';
    expect(label).toContain('needs 1x Air Rune');
    expect(label).not.toContain(' from ');
  });
});

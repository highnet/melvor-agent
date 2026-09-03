import { afterEach, describe, expect, it } from 'vitest';
import { dominatesEquipmentStats, readGearUpgrades } from '../src/adapter/equipment.js';
import { installFakeGame } from './fixtures.js';

/**
 * The weapon slot two tiers of the agent both wanted.
 *
 * Measured live on 2026-09-03, from the mod's own log. `equipment.equip ok —
 * "melvorF:Staff_of_Air" -> "melvorD:Steel_Scimitar"` repeated at intervals of
 * 2,986-3,002ms for forty minutes, each line followed about half a second later
 * by `reflex.upgradeGear fired`. Three things identify the two halves:
 *
 * - 3,000ms is `POLICY_INTERVAL_MS`, not the 1,000ms reflex throttle, and only
 *   the objective executor emits an `adapter` line for an action;
 * - every one of those lines reads `before: Staff_of_Air`, so the staff was
 *   back in the slot before each policy tick;
 * - the journal holds the objective that was asking: `equip_item`,
 *   `melvorD:Steel_Scimitar` into `melvorD:Weapon`, `successWhen: []`, aborted
 *   on its three-minute budget -- and the swapping stops within half a second
 *   of that objective being replaced, not when anything about the gear changed.
 *
 * So nothing in the game reverted anything, and every `ok` was truthful. The
 * objective put the scimitar on every 3s and this reader handed the reflex the
 * displaced staff back as an "upgrade" on the next 1s tick.
 *
 * Two defects made that possible and each is tested below. The tests drive the
 * real `readGearUpgrades` against fakes rather than restating its filters,
 * because the bug was precisely that one filter did not exist.
 */

const uninstalls: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  const globals = globalThis as Record<string, unknown>;
  globals.EquipmentItem = undefined;
  globals.WeaponItem = undefined;
});

const WEAPON = 'melvorD:Weapon';

/**
 * Real Melvor numbers, because the margin is what the bug turned on.
 *
 * A Staff of Air swings every 3,000ms -- the live snapshot's `attackInterval`
 * with one equipped says so -- and a Steel Scimitar every 2,400ms. Summed
 * blindly those dwarf every bonus on either item, so the old `statScore` made
 * the staff worth 1.24x the scimitar: over the reflex's 1.2 margin in one
 * direction and under it in the other, which is exactly the one-sided swap the
 * log shows.
 */
const STAFF_STATS = [
  { key: 'attackSpeed', value: 3000 },
  { key: 'magicAttackBonus', value: 10 },
];
const SCIMITAR_STATS = [
  { key: 'attackSpeed', value: 2400 },
  { key: 'stabAttackBonus', value: 4 },
  { key: 'slashAttackBonus', value: 8 },
  { key: 'blockAttackBonus', value: 1 },
  { key: 'meleeStrengthBonus', value: 9 },
];

class FakeWeapon {
  id: string;
  name: string;
  attackType: string;
  equipmentStats: { key: string; value: number }[];
  validSlots = [{ id: WEAPON }];
  equipRequirements: unknown[] = [];
  modifiers: unknown[] = [];
  conditionalModifiers: unknown[] = [];

  constructor(
    id: string,
    name: string,
    attackType: string,
    equipmentStats: { key: string; value: number }[],
  ) {
    this.id = id;
    this.name = name;
    this.attackType = attackType;
    this.equipmentStats = equipmentStats;
  }
}

const STAFF = new FakeWeapon('melvorF:Staff_of_Air', 'Staff of Air', 'magic', STAFF_STATS);
const SCIMITAR = new FakeWeapon(
  'melvorD:Steel_Scimitar',
  'Steel Scimitar',
  'melee',
  SCIMITAR_STATS,
);

/**
 * @param worn - The weapon in the slot, which also fixes `player.attackType`:
 *               the game derives the style from the weapon, and that is why the
 *               two ends of this swap disagreed about which one penalised the
 *               style in use.
 * @param banked - What the bank offers.
 */
function installGame(worn: FakeWeapon, banked: FakeWeapon[]): void {
  const globals = globalThis as Record<string, unknown>;
  globals.EquipmentItem = FakeWeapon;
  globals.WeaponItem = FakeWeapon;

  const emptyItem = { id: 'melvorD:Empty_Equipment' };

  uninstalls.push(
    installFakeGame({
      activeAction: undefined,
      checkRequirements: () => true,
      bank: { items: new Map(banked.map((item) => [item.id, { item, quantity: 1 }])) },
      items: {
        equipment: {
          getObjectByID: (id: string) => [STAFF, SCIMITAR].find((item) => item.id === id),
        },
      },
      combat: {
        player: {
          attackType: worn.attackType,
          equipment: {
            equippedItems: new Proxy(
              {},
              {
                get: (_target, slotId) =>
                  slotId === WEAPON
                    ? { item: worn, emptyItem, quantity: 1 }
                    : { item: emptyItem, emptyItem, quantity: 0 },
              },
            ),
          },
        },
      },
    }),
  );
}

describe('readGearUpgrades and a weapon of a different attack type', () => {
  it('does not offer the melee weapon to a character fighting with magic', () => {
    // The half the objective was fighting. `readEquipCandidates` already treats
    // this as a strategy choice and hands it to the planner labelled as one;
    // this reader feeds a reflex that acts without asking, and had no notion of
    // a style switch at all.
    installGame(STAFF, [SCIMITAR]);

    expect(readGearUpgrades().replacement).toEqual([]);
  });

  it('does not offer the magic weapon back to a character now holding melee', () => {
    // The half the reflex was doing, and the direction that actually fired: on
    // the old stat sum the staff scored 3,010 against the scimitar's 2,422, a
    // gain of 1.24 over the reflex's 1.2 margin. Excluding style switches
    // settles the loop from either end, so whichever weapon the planner chose
    // is the one that stays on.
    installGame(SCIMITAR, [STAFF]);

    expect(readGearUpgrades().replacement).toEqual([]);
  });

  it('still offers a better weapon of the same attack type', () => {
    // The exclusion must not turn into "never replace a weapon". A faster
    // scimitar with strictly better bonuses is an upgrade by any reading.
    const better = new FakeWeapon('melvorD:Mithril_Scimitar', 'Mithril Scimitar', 'melee', [
      { key: 'attackSpeed', value: 2400 },
      { key: 'stabAttackBonus', value: 14 },
      { key: 'slashAttackBonus', value: 22 },
      { key: 'blockAttackBonus', value: 6 },
      { key: 'meleeStrengthBonus', value: 20 },
    ]);
    installGame(SCIMITAR, [better]);

    expect(readGearUpgrades().replacement.map((entry) => entry.itemId)).toEqual([
      'melvorD:Mithril_Scimitar',
    ]);
  });
});

describe('attack speed is a cost, not a bonus', () => {
  it('does not make a slower weapon of the same style score higher', () => {
    // With `attackSpeed` in the sum, a weapon that takes 25% longer to swing
    // read as a 25% upgrade -- and 25% clears the reflex's 1.2 margin, so the
    // reflex acted on it. Same attack type here, so the style-switch rule above
    // is not what produces the answer: this is the sum, on its own.
    const slow = new FakeWeapon('melvorD:Iron_Battleaxe', 'Iron Battleaxe', 'melee', [
      { key: 'attackSpeed', value: 3000 },
      { key: 'slashAttackBonus', value: 5 },
    ]);
    installGame(SCIMITAR, [slow]);

    expect(readGearUpgrades().replacement).toEqual([]);
  });

  it('is compared in its own direction by the key-by-key test', () => {
    // `dominatesEquipmentStats` treats a smaller value as worse for every other
    // key. Left alone it would have said a 3,000ms weapon dominates a 2,400ms
    // one -- the same inversion as the sum, one function along.
    expect(
      dominatesEquipmentStats(
        [{ key: 'attackSpeed', value: 3000 }],
        [{ key: 'attackSpeed', value: 2400 }],
      ),
    ).toBe(false);
    expect(
      dominatesEquipmentStats(
        [{ key: 'attackSpeed', value: 2400 }],
        [{ key: 'attackSpeed', value: 3000 }],
      ),
    ).toBe(true);
  });
});

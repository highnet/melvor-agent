import { afterEach, describe, expect, it } from 'vitest';
import {
  bearsModifiers,
  dominatesEquipmentStats,
  readGearUpgrades,
  skillScopedModifiers,
  unambiguousModifierUpgrade,
} from '../src/adapter/equipment.js';
import { installFakeGame } from './fixtures.js';

/**
 * A skilling outfit's whole value is invisible to a stat sum.
 *
 * `statScore` adds up `equipmentStats`; an outfit has none, so it scores zero
 * and can never beat anything already in its slot. Township's entire payoff is
 * the outfits its levels unlock, and they were being earned and never worn.
 *
 * The fix is deliberately not a modifier score. A weight on a modifier is a
 * judgement about what the run is doing — +5% Mining mastery XP is everything
 * to a miner and nothing to a fisher — and the last time this file put a number
 * on a comparison it could not make, a Steel Platebody outscored an archer's
 * kit and left the character unable to land a shot for twenty minutes. So the
 * only case acted on is the one with nothing on the other side of the trade,
 * and these tests are mostly about what is still *refused*.
 */

const uninstalls: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  const globals = globalThis as Record<string, unknown>;
  globals.EquipmentItem = undefined;
  globals.WeaponItem = undefined;
});

const MINING = 'melvorD:Mining';
const FISHING = 'melvorD:Fishing';

describe('skillScopedModifiers', () => {
  const modifiers = [{ skill: { id: MINING } }, { skill: { id: MINING } }, {}];

  it('counts only modifiers the game itself scoped to the skill being trained', () => {
    expect(skillScopedModifiers(modifiers, MINING)).toBe(2);
  });

  it('counts none for a different skill — the same item, a different run', () => {
    expect(skillScopedModifiers(modifiers, FISHING)).toBe(0);
  });

  it('counts none with no skill running, which is the case in combat', () => {
    // `game.activeAction` is undefined in a fight, and that is the right answer:
    // no non-combat skill is running, so no skilling modifier is unambiguous.
    expect(skillScopedModifiers(modifiers, null)).toBe(0);
  });
});

describe('bearsModifiers', () => {
  it('counts conditional modifiers, which carry an isNegative flag we cannot evaluate', () => {
    expect(bearsModifiers({ conditionalModifiers: [{}] })).toBe(true);
  });

  it('is false for plain gear, the only kind this file will displace', () => {
    expect(bearsModifiers({ modifiers: [], conditionalModifiers: [] })).toBe(false);
  });
});

describe('dominatesEquipmentStats', () => {
  it('rejects a swap where a single stat gets worse, whatever the total says', () => {
    // The platebody shape, in miniature: a large gain on one key and a loss on
    // the key actually being used. A sum says yes; this says no.
    expect(
      dominatesEquipmentStats(
        [
          { key: 'meleeDefenceBonus', value: 50 },
          { key: 'rangedAttackBonus', value: -8 },
        ],
        [{ key: 'rangedAttackBonus', value: 0 }],
      ),
    ).toBe(false);
  });

  it('accepts a swap where no stat gets worse', () => {
    expect(
      dominatesEquipmentStats(
        [{ key: 'meleeDefenceBonus', value: 4 }],
        [{ key: 'meleeDefenceBonus', value: 4 }],
      ),
    ).toBe(true);
  });

  it('treats a key only the candidate has as a comparison against zero', () => {
    expect(dominatesEquipmentStats([{ key: 'magicDefenceBonus', value: -1 }], [])).toBe(false);
  });
});

describe('unambiguousModifierUpgrade', () => {
  const outfit = {
    modifiers: [{ skill: { id: MINING } }],
    equipmentStats: [] as { key: string; value: number }[],
  };

  it('is true against an empty slot — there is nothing to lose', () => {
    expect(unambiguousModifierUpgrade(outfit, undefined, MINING)).toBe(true);
  });

  it('is false when the modifiers belong to a skill the run is not training', () => {
    expect(unambiguousModifierUpgrade(outfit, undefined, FISHING)).toBe(false);
  });

  it('refuses to displace gear whose own modifiers nothing here can price', () => {
    // This is the line the brief draws, and it is the one worth holding: a swap
    // that gives up an unpriceable modifier is a judgement, not arithmetic.
    expect(
      unambiguousModifierUpgrade(outfit, { modifiers: [{}], equipmentStats: [] }, MINING),
    ).toBe(false);
  });

  it('refuses when the outfit gives up an equipment stat', () => {
    expect(
      unambiguousModifierUpgrade(
        outfit,
        { equipmentStats: [{ key: 'meleeDefenceBonus', value: 12 }] },
        MINING,
      ),
    ).toBe(false);
  });

  it('accepts a plain worn item it strictly dominates', () => {
    expect(
      unambiguousModifierUpgrade(
        { ...outfit, equipmentStats: [{ key: 'meleeDefenceBonus', value: 3 }] },
        { modifiers: [], conditionalModifiers: [], equipmentStats: [] },
        MINING,
      ),
    ).toBe(true);
  });
});

/** Minimal stand-ins for the game classes the readers narrow on. */
class FakeEquipmentItem {
  id = '';
  name = '';
  validSlots: { id: string; emptyName?: string }[] = [];
  equipRequirements: unknown[] = [];
  equipmentStats: { key: string; value: number }[] = [];
  modifiers?: { skill?: { id: string } }[];
  conditionalModifiers: unknown[] = [];

  constructor(parts: Partial<FakeEquipmentItem>) {
    Object.assign(this, parts);
  }
}

function installGame(items: FakeEquipmentItem[], activeSkillId: string | null): void {
  const globals = globalThis as Record<string, unknown>;
  globals.EquipmentItem = FakeEquipmentItem;
  globals.WeaponItem = class {};

  uninstalls.push(
    installFakeGame({
      activeAction: activeSkillId === null ? undefined : { id: activeSkillId },
      checkRequirements: () => true,
      bank: { items: new Map(items.map((item) => [item.id, { item, quantity: 1 }])) },
      items: { equipment: { getObjectByID: () => undefined } },
      combat: {
        player: {
          attackType: 'melee',
          equipment: {
            // Every slot empty: the case the fill reflex acts on.
            equippedItems: new Proxy(
              {},
              {
                get: (_target, slotId) => {
                  const empty = { id: `${String(slotId)}:empty` };
                  return { item: empty, emptyItem: empty, quantity: 0 };
                },
              },
            ),
          },
        },
      },
    }),
  );
}

describe('readGearUpgrades orders empty slots by relevance', () => {
  const plain = new FakeEquipmentItem({
    id: 'melvorD:Steel_Platebody',
    name: 'Steel Platebody',
    validSlots: [{ id: 'melvorD:Platebody' }],
    equipmentStats: [{ key: 'meleeDefenceBonus', value: 40 }],
  });
  const outfit = new FakeEquipmentItem({
    id: 'melvorF:Mining_Body',
    name: "Miner's Body",
    validSlots: [{ id: 'melvorD:Platebody' }],
    modifiers: [{ skill: { id: MINING } }],
  });

  it('puts gear scoped to the skill being trained at the head of the list', () => {
    // The list had no order at all, so the reflex — which takes the head — filled
    // the slot in bank order. Once something is in the slot, an outfit with no
    // equipment stats can never displace it, so bank order decided permanently.
    installGame([plain, outfit], MINING);

    expect(readGearUpgrades().emptySlot.map((entry) => entry.itemId)).toEqual([
      'melvorF:Mining_Body',
      'melvorD:Steel_Platebody',
    ]);
  });

  it('leaves bank order alone when the run is training something else', () => {
    installGame([plain, outfit], FISHING);

    expect(readGearUpgrades().emptySlot.map((entry) => entry.itemId)).toEqual([
      'melvorD:Steel_Platebody',
      'melvorF:Mining_Body',
    ]);
  });
});

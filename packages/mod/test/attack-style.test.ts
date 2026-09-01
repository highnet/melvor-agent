import { describe, expect, it } from 'vitest';
import { attackBonusFor, penalisesAttackStyle } from '../src/adapter/equipment.js';
import { removePenalisingGear } from '../src/runtime/combat-reflex.js';

// A (G) Steel Platebody: strong melee defence, negative ranged attack.
const platebody = [
  { key: 'meleeDefenceBonus', value: 62 },
  { key: 'rangedDefenceBonus', value: 58 },
  { key: 'rangedAttackBonus', value: -12 },
  { key: 'magicAttackBonus', value: -30 },
];

const shortbow = [
  { key: 'rangedAttackBonus', value: 8 },
  { key: 'rangedStrengthBonus', value: 0 },
];

describe('gear against the style in use', () => {
  it('rejects melee armour for an archer', () => {
    // The live failure: this was equipped as "free survivability" into an empty
    // torso slot, and the character then could not land a shot — full health,
    // no kills, across two monsters in two areas, for twenty minutes.
    expect(penalisesAttackStyle(platebody, 'ranged')).toBe(true);
  });

  it('accepts the same armour for a melee fighter', () => {
    // Nothing is wrong with the platebody. It is wrong for a bow.
    expect(penalisesAttackStyle(platebody, 'melee')).toBe(false);
  });

  it('accepts a bow for an archer', () => {
    expect(penalisesAttackStyle(shortbow, 'ranged')).toBe(false);
  });

  it('rejects it for a mage too, which is a separate penalty', () => {
    expect(penalisesAttackStyle(platebody, 'magic')).toBe(true);
  });

  it('sums the three melee attack keys rather than reading one', () => {
    // The game splits melee attack into stab, slash and block; reading only one
    // would misjudge every melee weapon.
    const scimitar = [
      { key: 'stabAttackBonus', value: 4 },
      { key: 'slashAttackBonus', value: 14 },
      { key: 'blockAttackBonus', value: 1 },
    ];

    expect(attackBonusFor(scimitar, 'melee')).toBe(19);
  });

  it('ignores stats belonging to other styles', () => {
    expect(attackBonusFor(platebody, 'ranged')).toBe(-12);
  });
});

describe('taking penalising gear off', () => {
  const ok = () => ({ ok: true }) as never;
  const worn = [{ slotId: 'melvorD:Platebody', itemName: '(G) Steel Platebody' }];

  it('removes gear that is working against the current style', () => {
    const removed: string[] = [];
    removePenalisingGear({ inCombat: false, penalising: worn }, (slotId) => {
      removed.push(slotId);
      return ok();
    });

    expect(removed).toEqual(['melvorD:Platebody']);
  });

  it('waits until the fight is over', () => {
    // Stripping armour mid-fight is how a character with no Auto Eat dies, and
    // the penalty has already cost whatever this fight was going to cost.
    expect(removePenalisingGear({ inCombat: true, penalising: worn }, () => ok())).toBeNull();
  });

  it('does nothing when the gear is appropriate', () => {
    expect(removePenalisingGear({ inCombat: false, penalising: [] }, () => ok())).toBeNull();
  });
});

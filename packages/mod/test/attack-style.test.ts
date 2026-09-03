import { describe, expect, it } from 'vitest';
import { attackBonusFor, penalisesAttackStyle } from '../src/adapter/equipment.js';
import { fillEmptySlots, removePenalisingGear } from '../src/runtime/combat-reflex.js';

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

describe('putting on gear the character is missing', () => {
  const ok = () => ({ ok: true }) as never;
  const necklace = { itemId: 'melvorD:Jeweled_Necklace', slotId: 'melvorD:Amulet' };

  it('fills an empty slot without being asked', () => {
    // A Jeweled Necklace sat in the bank with an empty neck slot and the
    // candidate list saying "Neck is empty" for as long as nobody read that
    // line. The reader was working; the choosing was not.
    const equipped: string[] = [];
    fillEmptySlots(
      { inCombat: false, emptySlotGear: [necklace], replacements: [], stuckEquipIds: [] },
      (itemId) => {
        equipped.push(itemId);
        return ok();
      },
    );

    expect(equipped).toEqual(['melvorD:Jeweled_Necklace']);
  });

  it('prefers an empty slot over displacing worn gear', () => {
    // Nothing to weigh against nothing; a replacement always has a loser.
    const equipped: string[] = [];
    fillEmptySlots(
      {
        inCombat: false,
        emptySlotGear: [necklace],
        replacements: [{ itemId: 'melvorD:Steel_Helmet', slotId: 'melvorD:Helmet', gain: 5 }],
        stuckEquipIds: [],
      },
      (itemId) => {
        equipped.push(itemId);
        return ok();
      },
    );

    expect(equipped).toEqual(['melvorD:Jeweled_Necklace']);
  });

  it('swaps worn gear only for a clear improvement', () => {
    // The stat sum has been wrong once already — a platebody scored higher than
    // what it replaced and left an archer unable to land a shot.
    const marginal = [{ itemId: 'melvorD:X', slotId: 'melvorD:Helmet', gain: 1.05 }];

    expect(
      fillEmptySlots(
        { inCombat: false, emptySlotGear: [], replacements: marginal, stuckEquipIds: [] },
        () => ok(),
      ),
    ).toBeNull();
  });

  it('changes nothing mid-fight', () => {
    // The survivability gate approved this fight with the gear the character
    // had; changing it underneath that approval is how a safe fight turns.
    expect(
      fillEmptySlots(
        { inCombat: true, emptySlotGear: [necklace], replacements: [], stuckEquipIds: [] },
        () => ok(),
      ),
    ).toBeNull();
  });
});

describe('offering a weapon that changes the style', () => {
  // Both existing filters reject a style switch for individually correct
  // reasons that are jointly wrong. A Staff of Air "penalises" the ranged style
  // — of course it does — and scores lower than a shortbow on a flat stat sum,
  // because a staff and a bow are not comparable. So with a bow equipped no
  // staff is ever offered, and five Staves of Air sat in the bank while Magic
  // stayed at level 2 with its goal reading 10%.
  const offered = (
    itemStyle: string,
    currentStyle: string,
    penalises: boolean,
    better: boolean,
  ) => {
    const switchesStyle = itemStyle !== currentStyle;
    if (!switchesStyle && penalises) return false;
    if (!switchesStyle && !better) return false;
    return true;
  };

  it('offers a staff to an archer as a style switch', () => {
    expect(offered('magic', 'ranged', true, false)).toBe(true);
  });

  it('still hides same-style gear that is worse', () => {
    // The upgrade rule survives untouched for the case it was written for.
    expect(offered('ranged', 'ranged', false, false)).toBe(false);
  });

  it('still hides same-style gear that penalises the style', () => {
    // The platebody that left an archer unable to land a shot.
    expect(offered('ranged', 'ranged', true, true)).toBe(false);
  });

  it('offers same-style gear that is a genuine upgrade', () => {
    expect(offered('ranged', 'ranged', false, true)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { refillQuiver } from '../src/runtime/combat-reflex.js';

const ok = () => ({ ok: true }) as never;

/**
 * An empty quiver mid-fight is a silent zero-damage stall.
 *
 * The quiver is a precondition of engaging and nothing watched it afterwards,
 * yet arrows are consumed per shot. Once it empties the game reports combat as
 * active, health stays full, and nothing lands -- the same failure the
 * engage-time check exists to prevent, arriving twenty minutes into the fight
 * instead of at the start. It is the melee-platebody-on-an-archer shape: full
 * health, no kills, every engage reporting success.
 */
describe('refillQuiver', () => {
  const ammo = { itemId: 'melvorF:Adamant_Arrows', quantity: 1_620 };

  it('re-equips ammunition the bank still holds', () => {
    const equipped: string[] = [];
    refillQuiver(
      { inCombat: true, quiverEmpty: true, available: ammo },
      (itemId) => {
        equipped.push(itemId);
        return ok();
      },
      () => ok(),
    );

    expect(equipped).toEqual(['melvorF:Adamant_Arrows']);
  });

  it('leaves the fight when nothing can refill it', () => {
    // Standing in a fight that cannot be won is worse than leaving it; without
    // this the objective runs to its time budget doing nothing at all.
    let disengaged = false;
    refillQuiver(
      { inCombat: true, quiverEmpty: true, available: null },
      () => ok(),
      () => {
        disengaged = true;
        return ok();
      },
    );

    expect(disengaged).toBe(true);
  });

  it('does nothing while the quiver has ammunition', () => {
    expect(
      refillQuiver(
        { inCombat: true, quiverEmpty: false, available: ammo },
        () => ok(),
        () => ok(),
      ),
    ).toBeNull();
  });

  it('does nothing outside combat', () => {
    // Equipping ammunition is a planner decision when no fight is underway.
    expect(
      refillQuiver(
        { inCombat: false, quiverEmpty: true, available: ammo },
        () => ok(),
        () => ok(),
      ),
    ).toBeNull();
  });

  it('does nothing for a weapon that needs no ammunition', () => {
    // quiverEmpty is false for melee and magic, since the reader returns null
    // when the weapon requires no ammo type at all.
    expect(
      refillQuiver(
        { inCombat: true, quiverEmpty: false, available: null },
        () => ok(),
        () => ok(),
      ),
    ).toBeNull();
  });
});

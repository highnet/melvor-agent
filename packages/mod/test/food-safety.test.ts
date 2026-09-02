import { describe, expect, it } from 'vitest';
import { cookWhenFoodLow, stopWhenStarving } from '../src/runtime/combat-reflex.js';

const ok = () => ({ ok: true }) as never;

/**
 * Owning Auto Eat is not the same as having food.
 *
 * `hasAutoEat` reads `autoEatThreshold > 0` -- ownership, not capability. On
 * that alone every food guard switched itself off, so a character that had
 * bought the upgrade and run its larder to zero had no eating, no cooking, no
 * starvation stop and no warning: the exact configuration that killed this one,
 * minus the single guard that noticed.
 *
 * This is not hypothetical for this run. Auto Eat is what it is currently
 * saving a million GP toward, so the purchase would have re-armed a death it
 * has already died twice.
 */
describe('Auto Eat does not disable the food guards when there is no food', () => {
  it('still cooks when Auto Eat is owned but the larder is empty', () => {
    const cooked: string[] = [];
    cookWhenFoodLow({ meals: 0, hasAutoEat: true, idleCategoryIds: ['melvorD:Fire'] }, (id) => {
      cooked.push(id);
      return ok();
    });

    expect(cooked).toEqual(['melvorD:Fire']);
  });

  it('leaves cooking alone when Auto Eat is owned and fed', () => {
    // The case the guard was written for: Auto Eat plus a stocked bank needs
    // no intervention, and cooking would take a slot for nothing.
    expect(
      cookWhenFoodLow({ meals: 500, hasAutoEat: true, idleCategoryIds: ['melvorD:Fire'] }, () =>
        ok(),
      ),
    ).toBeNull();
  });

  it('still stops a damaging activity when Auto Eat has nothing to eat', () => {
    const stopped: string[] = [];
    stopWhenStarving(
      {
        meals: 0,
        hasAutoEat: true,
        hitpoints: 40,
        maxHitpoints: 150,
        damagingSkillId: 'melvorD:Thieving',
      },
      (skillId) => {
        stopped.push(skillId);
        return ok();
      },
    );

    expect(stopped).toEqual(['melvorD:Thieving']);
  });

  it('does not stop a healthy Auto Eat character with food banked', () => {
    expect(
      stopWhenStarving(
        {
          meals: 200,
          hasAutoEat: true,
          hitpoints: 120,
          maxHitpoints: 150,
          damagingSkillId: 'melvorD:Thieving',
        },
        () => ok(),
      ),
    ).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import {
  collectStockpiledFood,
  cookWhenFoodLow,
  stopWhenStarving,
} from '../src/runtime/combat-reflex.js';

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

/**
 * Passive cooking leaves its output in a stockpile that nothing collected.
 *
 * `readMealCount` counts the bank and the equipped slot, and the cooking reflex
 * fires on that count -- so the agent cooked, the count did not move, and it
 * cooked again, indefinitely, while the meals it had already made sat
 * uncollected. The starvation death in mechanical form: a character surrounded
 * by food it had cooked and could not reach.
 */
describe('collecting passive-cooking output', () => {
  it('collects the fullest stockpile first', () => {
    // One collection per pass, so it goes where the most food is waiting.
    const collected: string[] = [];
    collectStockpiledFood(
      {
        stockpiled: [
          { categoryId: 'melvorD:Fire', quantity: 3 },
          { categoryId: 'melvorD:Furnace', quantity: 41 },
        ],
      },
      (categoryId) => {
        collected.push(categoryId);
        return ok();
      },
    );

    expect(collected).toEqual(['melvorD:Furnace']);
  });

  it('does nothing when every stockpile is empty', () => {
    // The normal case, and it must stay silent rather than reporting a no-op
    // on every tick.
    const outcome = collectStockpiledFood({ stockpiled: [] }, () => ok());

    expect(outcome).toBeNull();
  });
});

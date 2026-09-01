import { describe, expect, it } from 'vitest';
import { cookWhenFoodLow, stopWhenStarving } from '../src/runtime/combat-reflex.js';

const ok = () => ({ ok: true }) as never;

/**
 * The character starved to death with sixteen Raw Beef and nineteen Raw Shrimp
 * in the bank and Cooking at 22. Every ingredient was present; nothing turned
 * them into food, and nothing stopped the activity that was spending health.
 *
 * An hour earlier I looked at exactly this shortfall and decided it should be
 * *reported* rather than acted on, reasoning that restocking is a real plan and
 * a reflex would send the agent off fishing mid-objective. Both halves were
 * wrong: the asymmetry (a detour costs minutes, running out costs the
 * character) and the premise — passive cooking does not take the action slot at
 * all, which its own candidate label says out loud.
 */
describe('cooking before the reserve runs out', () => {
  const state = (meals: number, categories: string[] = ['melvorD:Fire']) => ({
    meals,
    hasAutoEat: false,
    idleCategoryIds: categories,
  });

  it('starts cooking while there is still a reserve to protect', () => {
    const cooked: string[] = [];
    cookWhenFoodLow(state(10), (id) => {
      cooked.push(id);
      return ok();
    });

    expect(cooked).toEqual(['melvorD:Fire']);
  });

  it('leaves a healthy reserve alone', () => {
    expect(cookWhenFoodLow(state(200), () => ok())).toBeNull();
  });

  it('does nothing when Auto Eat feeds from the bank directly', () => {
    expect(
      cookWhenFoodLow({ meals: 0, hasAutoEat: true, idleCategoryIds: ['x'] }, () => ok()),
    ).toBeNull();
  });

  it('does nothing when every cooker is already busy', () => {
    expect(cookWhenFoodLow(state(0, []), () => ok())).toBeNull();
  });
});

describe('stopping when there is nothing left to eat', () => {
  const starving = (hp: number, meals = 0) => ({
    meals,
    hasAutoEat: false,
    hitpoints: hp,
    maxHitpoints: 150,
    damagingSkillId: 'melvorD:Thieving',
  });

  it('stops the damaging skill once health is falling with no food', () => {
    // The line whose absence killed this character: it kept pickpocketing at 37
    // health and then at none.
    const stopped: string[] = [];
    stopWhenStarving(starving(37), (id) => {
      stopped.push(id);
      return ok();
    });

    expect(stopped).toEqual(['melvorD:Thieving']);
  });

  it('does not stop a healthy character merely because the bank is empty', () => {
    // Not in danger yet, and stopping would cost the run for nothing.
    expect(stopWhenStarving(starving(140), () => ok())).toBeNull();
  });

  it('does not stop while food remains', () => {
    expect(stopWhenStarving(starving(37, 5), () => ok())).toBeNull();
  });

  it('leaves non-damaging work running', () => {
    expect(stopWhenStarving({ ...starving(20), damagingSkillId: null }, () => ok())).toBeNull();
  });
});

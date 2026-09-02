import { ARM_CRITICAL_HP_FRACTION, checkArmHealth } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';

/**
 * Arming automatically after offline progression resolved.
 *
 * `onInterfaceReady` fires *after* up to 24 hours have been applied to the
 * character with no reflex loaded, and the arming guards checked the realm, the
 * allowlist and the dump's freshness — every one of them about configuration,
 * none about the character. A run that died mid-Thieving during a reload armed
 * and carried on, because nothing in the path could tell that boot from a
 * healthy one.
 */
const healthy = {
  hpFraction: 1,
  meals: 40,
  hasAutoEat: false,
  deathCount: 3,
  deathCountBefore: 3,
};

describe('automatic arm health gate', () => {
  it('allows a boot that looks like every other boot', () => {
    expect(checkArmHealth(healthy)).toBeNull();
  });

  it('refuses when the death counter rose while nothing was watching', () => {
    const refusal = checkArmHealth({ ...healthy, deathCount: 4 });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('death counter');
  });

  it('does not read a character history as deaths that just happened', () => {
    // First boot: there is no previous reading, so forty lifetime deaths are
    // forty deaths from before the agent existed.
    expect(checkArmHealth({ ...healthy, deathCount: 40, deathCountBefore: null })).toBeNull();
  });

  it('refuses below the fraction the policy tier would abort at', () => {
    const refusal = checkArmHealth({ ...healthy, hpFraction: ARM_CRITICAL_HP_FRACTION - 0.01 });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('hitpoints');
  });

  it('allows exactly at the floor, which is where the policy tier still runs', () => {
    expect(checkArmHealth({ ...healthy, hpFraction: ARM_CRITICAL_HP_FRACTION })).toBeNull();
  });

  it('refuses with no food and no Auto Eat', () => {
    // The mechanical form of the starvation death: nothing can heal, so the
    // starvation stop is the only thing left and it fires by losing.
    const refusal = checkArmHealth({ ...healthy, meals: 0 });
    expect(refusal).not.toBeNull();
    expect(refusal).toContain('Auto Eat');
  });

  it('allows no food when Auto Eat is owned, which feeds from the bank', () => {
    expect(checkArmHealth({ ...healthy, meals: 0, hasAutoEat: true })).toBeNull();
  });

  it('reports the death first when several things are wrong', () => {
    // A death explains the empty food and the low HP; the other two would send
    // the operator to the wrong question.
    const refusal = checkArmHealth({
      ...healthy,
      hpFraction: 0.05,
      meals: 0,
      deathCount: 4,
    });
    expect(refusal).toContain('death counter');
  });
});

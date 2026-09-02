/**
 * Whether it is safe to arm *automatically*, given what offline progression
 * left behind.
 *
 * Arming on boot runs from `onInterfaceReady`, which fires after offline
 * progress has resolved — so by the time this is asked, up to 24 hours have
 * already been applied to the character with none of the reflexes loaded. The
 * existing guards check the realm, the character allowlist and the dump's
 * freshness: every one of them is about *configuration*, and none of them looks
 * at what actually happened to the character while nothing was watching.
 *
 * That gap has a worked example in this repo's history. A character died during
 * a reload, mid-Thieving, holding 99 cooked Seahorse: Melvor replayed the
 * elapsed time from the save and landed every hit before the mod existed. The
 * agent's response on the other side was to arm and carry on, because nothing
 * in the arming path could tell a healthy boot from that one.
 *
 * Blocking is the right answer rather than a warning, and only for the
 * automatic path. An operator arming by hand is present and can judge; nobody
 * is present for the boot path, which is exactly why it needs a floor.
 */

export interface ArmHealth {
  /** Current hitpoints over max, 0..1. */
  hpFraction: number;
  /** Meals across the bank and the equipped slot. */
  meals: number;
  /** Whether Auto Eat is owned, which feeds from the bank with no reflex. */
  hasAutoEat: boolean;
  /** The game's lifetime death counter, now. */
  deathCount: number;
  /** The counter as of the last run, or null when this is the first boot. */
  deathCountBefore: number | null;
}

/**
 * Below this share of max HP, arming unattended is starting a run already
 * losing. Matches the policy tier's critical floor, deliberately: a fraction
 * the agent would abort an objective at is not one it should begin at.
 */
export const ARM_CRITICAL_HP_FRACTION = 0.25;

/**
 * Reasons not to arm without a person watching.
 *
 * @returns An operator-readable refusal, or null when the boot looks survivable.
 */
export function checkArmHealth(health: ArmHealth): string | null {
  if (health.deathCountBefore !== null && health.deathCount > health.deathCountBefore) {
    const died = health.deathCount - health.deathCountBefore;
    return `the death counter rose by ${died} since the last run — the character died while nothing was watching, most likely during offline progression. Arm by hand once you have looked at what killed it.`;
  }

  if (health.hpFraction < ARM_CRITICAL_HP_FRACTION) {
    return `hitpoints are at ${Math.round(health.hpFraction * 100)}% of maximum, below the ${Math.round(
      ARM_CRITICAL_HP_FRACTION * 100,
    )}% floor the policy tier aborts at; offline progress left the character in a state it would refuse to continue from`;
  }

  if (health.meals <= 0 && !health.hasAutoEat) {
    return 'there is no food anywhere and no Auto Eat, so nothing can heal the character — the eat reflex has nothing to spend and the starvation stop is the only thing left';
  }

  return null;
}

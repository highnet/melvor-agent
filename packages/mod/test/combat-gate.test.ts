import type { CombatGateInputs } from '@melvor-agent/shared';
import { combatGateInputsSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { assessSurvivability, normaliseFraction } from '../src/policy/combat-gate.js';
import { MANUAL_EAT_THRESHOLD } from '../src/runtime/combat-reflex.js';

/**
 * The gate decides whether the agent is allowed to risk dying, so it is tested
 * as a safety property rather than for coverage: every test below asks "does it
 * refuse when it should", and the few that assert `safe` exist only to prove it
 * is not refusing everything unconditionally.
 */

/** A comfortably survivable fight. Each test degrades one input from here. */
function inputs(overrides: Partial<CombatGateInputs> = {}): CombatGateInputs {
  return combatGateInputsSchema.parse({
    targetId: 'melvorD:Chicken',
    targetName: 'Chicken',
    isDungeon: false,
    playerMaxHitpoints: 1000,
    playerDamageReductionPercent: 20,
    autoEatThresholdFraction: 0.4,
    autoEatHpLimitFraction: 0.8,
    autoEatEfficiencyFraction: 1,
    foodHealPerItem: 200,
    foodQuantity: 500,
    enemyMaxHit: 50,
    enemyAttackIntervalMs: 3000,
    enemyHitChance: 0.8,
    intendedSessionMinutes: 30,
    ...overrides,
  });
}

describe('assessSurvivability — the safe baseline', () => {
  it('permits a fight that clears every check', () => {
    const verdict = assessSurvivability(inputs());
    expect(verdict.safe).toBe(true);
    expect(verdict.refusals).toEqual([]);
  });

  it('shows its workings so a dry run is inspectable', () => {
    const verdict = assessSurvivability(inputs());
    // 50 max hit at 20% resistance.
    expect(verdict.workings.effectiveEnemyMaxHit).toBeCloseTo(40);
    // 40% of 1000 HP, times the 0.6 comfort factor.
    expect(verdict.workings.oneShotCeiling).toBeCloseTo(240);
  });
});

describe('assessSurvivability — one-shot protection', () => {
  it('refuses when the enemy can hit past the auto-eat trigger', () => {
    // 700 raw, 560 after reduction, well above the 240 ceiling.
    const verdict = assessSurvivability(inputs({ enemyMaxHit: 700 }));
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals.map((r) => r.reason)).toContain('can_be_one_shot');
  });

  it('refuses a hit that lands exactly on the auto-eat trigger', () => {
    // 400 = exactly 40% of max HP. Auto eat fires *at* the threshold, so a hit
    // this size leaves it no turn to react — "comfortably below" is the rule.
    const verdict = assessSurvivability(
      inputs({ enemyMaxHit: 500, playerDamageReductionPercent: 20 }),
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals.map((r) => r.reason)).toContain('can_be_one_shot');
  });

  it('accounts for resistance rather than using the raw max hit', () => {
    // 300 raw would breach the 240 ceiling; 80% resistance brings it to 60.
    const verdict = assessSurvivability(
      inputs({ enemyMaxHit: 300, playerDamageReductionPercent: 80 }),
    );
    expect(verdict.workings.effectiveEnemyMaxHit).toBeCloseTo(60);
    expect(verdict.refusals.map((r) => r.reason)).not.toContain('can_be_one_shot');
  });

  it('does not let 100% resistance produce negative damage', () => {
    const verdict = assessSurvivability(inputs({ playerDamageReductionPercent: 150 }));
    expect(verdict.workings.effectiveEnemyMaxHit).toBe(0);
  });
});

describe('assessSurvivability — sustain', () => {
  it('allows a manageable fight without Auto Eat, the way a human plays', () => {
    // Auto Eat costs 1,000,000 GP — dozens of hours of early income. Refusing
    // every fight until then walls off the whole combat half of the game, so
    // the reflex eats instead and the gate judges that on its merits.
    const verdict = assessSurvivability(
      inputs({ autoEatThresholdFraction: 0, autoEatHpLimitFraction: 0, enemyMaxHit: 20 }),
    );
    expect(verdict.safe).toBe(true);
  });

  it('holds eating by hand to a harder standard than Auto Eat', () => {
    // The reflex looks once a second, so a fast enemy lands free hits between
    // checks. The same fight that Auto Eat sustains can be lethal without it,
    // and the gate must say so rather than treating them as equivalent.
    // A fast, light hitter: Auto Eat triggers on every incoming attack and
    // keeps up comfortably, while a once-a-second reflex heals half as often.
    const fastEnemy = {
      enemyAttackIntervalMs: 500,
      enemyMaxHit: 100,
      foodHealPerItem: 120,
      foodQuantity: 5000,
      intendedSessionMinutes: 5,
    };

    const withAutoEat = assessSurvivability(inputs(fastEnemy));
    const byHand = assessSurvivability(
      inputs({ ...fastEnemy, autoEatThresholdFraction: 0, autoEatHpLimitFraction: 0 }),
    );

    expect(withAutoEat.safe).toBe(true);
    expect(byHand.safe).toBe(false);
    expect(byHand.refusals.map((r) => r.reason)).toContain('insufficient_healing_throughput');
  });

  it('still refuses a one-shot when eating by hand', () => {
    // Nothing about eating manually survives a hit that lands before the reflex
    // can react at all.
    const verdict = assessSurvivability(
      inputs({ autoEatThresholdFraction: 0, autoEatHpLimitFraction: 0, enemyMaxHit: 900 }),
    );
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals.map((r) => r.reason)).toContain('can_be_one_shot');
  });

  it('refuses with no food equipped', () => {
    const verdict = assessSurvivability(inputs({ foodQuantity: 0 }));
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals.map((r) => r.reason)).toContain('no_food_equipped');
  });

  it('refuses food that heals nothing', () => {
    const verdict = assessSurvivability(inputs({ foodHealPerItem: 0 }));
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals.map((r) => r.reason)).toContain('no_food_equipped');
  });

  it('refuses when food will not cover the intended session', () => {
    const verdict = assessSurvivability(inputs({ foodQuantity: 2, intendedSessionMinutes: 600 }));
    expect(verdict.safe).toBe(false);
    expect(verdict.refusals.map((r) => r.reason)).toContain('insufficient_food_stock');
  });

  it('requires a longer session to be covered by more food', () => {
    const short = assessSurvivability(inputs({ intendedSessionMinutes: 10 }));
    const long = assessSurvivability(inputs({ intendedSessionMinutes: 100_000 }));
    expect(short.safe).toBe(true);
    expect(long.safe).toBe(false);
  });
});

describe('assessSurvivability — refusal completeness', () => {
  it('reports every failing check, not just the first', () => {
    // A dry run should show everything wrong at once rather than making the
    // operator fix one problem at a time to discover the next.
    const verdict = assessSurvivability(inputs({ foodQuantity: 0, enemyMaxHit: 5000 }));
    const reasons = verdict.refusals.map((r) => r.reason);
    expect(reasons).toContain('no_food_equipped');
    expect(reasons).toContain('can_be_one_shot');
    expect(verdict.refusals.length).toBeGreaterThanOrEqual(2);
  });

  it('is safe only when there are no refusals at all', () => {
    // Any nonzero death chance means refuse: `safe` must never be true
    // alongside a refusal.
    for (const override of [
      { foodQuantity: 0 },
      { enemyMaxHit: 9999 },
      { intendedSessionMinutes: 1_000_000 },
    ]) {
      const verdict = assessSurvivability(inputs(override));
      expect(verdict.safe).toBe(verdict.refusals.length === 0);
      expect(verdict.safe).toBe(false);
    }
  });
});

describe('normaliseFraction', () => {
  it('passes fractions through unchanged', () => {
    expect(normaliseFraction(0.4)).toBeCloseTo(0.4);
  });

  it('converts percentages, since the getters are undocumented', () => {
    // Getting this wrong by 100x in the unsafe direction would be catastrophic.
    // A real threshold is never above 100% of max HP, so >1 means percent.
    expect(normaliseFraction(40)).toBeCloseTo(0.4);
  });

  it('treats missing or nonsensical values as zero, which refuses', () => {
    expect(normaliseFraction(0)).toBe(0);
    expect(normaliseFraction(-1)).toBe(0);
    expect(normaliseFraction(Number.NaN)).toBe(0);
  });

  it('makes a lethal hit trip the one-shot check that a raw percentage would hide', () => {
    // The failure that matters: with a raw 40, the one-shot ceiling becomes
    // 40 * 1000 * 0.6 = 24000, so a 5000-damage hit sails under it. Normalised,
    // the ceiling is 240 and the same hit is correctly refused.
    const raw = assessSurvivability(inputs({ autoEatThresholdFraction: 40, enemyMaxHit: 5000 }));
    const normalised = assessSurvivability(
      inputs({ autoEatThresholdFraction: normaliseFraction(40), enemyMaxHit: 5000 }),
    );

    expect(raw.workings.oneShotCeiling).toBeGreaterThan(raw.workings.effectiveEnemyMaxHit);
    expect(raw.refusals.map((r) => r.reason)).not.toContain('can_be_one_shot');

    expect(normalised.workings.oneShotCeiling).toBeLessThan(
      normalised.workings.effectiveEnemyMaxHit,
    );
    expect(normalised.refusals.map((r) => r.reason)).toContain('can_be_one_shot');
  });
});

describe('the gate and the reflex agree', () => {
  it('uses the same manual-eat threshold the reflex acts on', () => {
    // The gate's arithmetic assumes the character eats at 60% HP. The reflex is
    // what makes that true. If they drift, the gate is doing sums about a
    // character that does not exist — and it would be the optimistic direction
    // that kills the character, so this is pinned rather than trusted.
    expect(MANUAL_EAT_THRESHOLD).toBe(0.6);
  });
});

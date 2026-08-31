import type { CombatGateInputs, CombatGateVerdict, GateRefusal } from '@melvor-agent/shared';

/**
 * Safety margin on the one-shot check.
 *
 * The brief asks for the enemy's max hit to be "comfortably" below the auto-eat
 * trigger, not merely below it. A hit that lands exactly on the threshold does
 * not leave auto eat a turn to react, and max hit is itself an upper bound that
 * special attacks and effects can exceed. 60% is the comfort.
 */
const ONE_SHOT_SAFETY_FACTOR = 0.6;

/**
 * Healing must outpace incoming damage by this much.
 *
 * Parity would mean surviving only if every roll is average, and combat is not
 * average — it is a sequence of rolls, some of which are the max hit.
 */
const HEALING_MARGIN = 1.5;

/** Food must cover the intended session with this much slack. */
const FOOD_MARGIN = 1.25;

/**
 * Decides whether combat is survivable.
 *
 * Deterministic and pure: this is the hard gate the planner gets no vote on.
 * Any nonzero death chance is a refusal, so every check is a conjunction and
 * the failure list is complete rather than short-circuited — a dry run should
 * show every reason at once, not force the operator to fix them one at a time.
 *
 * The two conditions from the brief, made precise:
 *
 * 1. **Cannot be one-shot.** The enemy's max hit, after damage reduction, must
 *    sit below `ONE_SHOT_SAFETY_FACTOR × autoEatThreshold × maxHP`. Auto eat
 *    fires *at* the threshold, so anything landing above it can take the player
 *    from healthy to dead without auto eat ever getting a turn.
 * 2. **Can sustain.** Auto-eat healing throughput must exceed incoming DPS with
 *    margin, and the equipped food must cover the intended session with margin.
 *
 * @param inputs - Numbers read from the game by the adapter.
 * @returns A verdict carrying its own workings, so a dry run is inspectable.
 */
export function assessSurvivability(inputs: CombatGateInputs): CombatGateVerdict {
  const refusals: { reason: GateRefusal; detail: string }[] = [];

  const damageMultiplier = Math.max(0, 1 - inputs.playerDamageReductionPercent / 100);
  const effectiveEnemyMaxHit = inputs.enemyMaxHit * damageMultiplier;

  const oneShotCeiling =
    inputs.autoEatThresholdFraction * inputs.playerMaxHitpoints * ONE_SHOT_SAFETY_FACTOR;

  // Expected damage per second, using hit chance so a low-accuracy enemy is not
  // over-penalised. The one-shot check above covers the worst case separately.
  const incomingDps =
    (effectiveEnemyMaxHit * inputs.enemyHitChance) / (inputs.enemyAttackIntervalMs / 1000);

  const healPerFood = inputs.foodHealPerItem * inputs.autoEatEfficiencyFraction;

  // Auto eat restores at most the band between its trigger threshold and its
  // HP limit, so a huge food item is wasted above that ceiling.
  const healBand = Math.max(
    0,
    (inputs.autoEatHpLimitFraction - inputs.autoEatThresholdFraction) * inputs.playerMaxHitpoints,
  );
  const effectiveHealPerEat = healBand > 0 ? Math.min(healPerFood, healBand) : healPerFood;

  const secondsPerAttack = inputs.enemyAttackIntervalMs / 1000;

  // The binding constraint is per enemy attack, not per second in aggregate:
  // auto eat gets at most one trigger between incoming hits, so healing has to
  // outpace damage on that cadence. Comparing aggregate rates would let a slow
  // enemy with a huge hit look sustainable when a single exchange is lethal.
  const healingThroughput = effectiveHealPerEat / secondsPerAttack;

  // How long the equipped food lasts at the rate combat consumes it.
  const eatsPerSecond =
    effectiveHealPerEat > 0 ? incomingDps / effectiveHealPerEat : Number.POSITIVE_INFINITY;
  const foodSecondsAvailable =
    eatsPerSecond > 0 && Number.isFinite(eatsPerSecond)
      ? inputs.foodQuantity / eatsPerSecond
      : Number.POSITIVE_INFINITY;

  const sessionSecondsRequired = inputs.intendedSessionMinutes * 60 * FOOD_MARGIN;

  if (inputs.autoEatThresholdFraction <= 0) {
    refusals.push({
      reason: 'no_auto_eat',
      detail: 'no Auto Eat owned; a single unlucky hit is unrecoverable',
    });
  }

  if (inputs.foodQuantity <= 0 || inputs.foodHealPerItem <= 0) {
    refusals.push({
      reason: 'no_food_equipped',
      detail: `food quantity ${inputs.foodQuantity}, heal per item ${inputs.foodHealPerItem}`,
    });
  }

  if (effectiveEnemyMaxHit >= oneShotCeiling) {
    refusals.push({
      reason: 'can_be_one_shot',
      detail:
        `enemy hits ${effectiveEnemyMaxHit.toFixed(1)} after ${inputs.playerDamageReductionPercent}% reduction, ` +
        `ceiling is ${oneShotCeiling.toFixed(1)} (${(ONE_SHOT_SAFETY_FACTOR * 100).toFixed(0)}% of the auto-eat trigger)`,
    });
  }

  if (incomingDps > 0 && healingThroughput < incomingDps * HEALING_MARGIN) {
    refusals.push({
      reason: 'insufficient_healing_throughput',
      detail: `healing ${healingThroughput.toFixed(1)}/s vs incoming ${incomingDps.toFixed(1)}/s, need ${HEALING_MARGIN}x`,
    });
  }

  if (foodSecondsAvailable < sessionSecondsRequired) {
    refusals.push({
      reason: 'insufficient_food_stock',
      detail:
        `food covers ${Math.round(foodSecondsAvailable)}s, ` +
        `session needs ${Math.round(sessionSecondsRequired)}s including ${FOOD_MARGIN}x margin`,
    });
  }

  return {
    safe: refusals.length === 0,
    refusals,
    workings: {
      effectiveEnemyMaxHit,
      oneShotCeiling,
      incomingDps,
      healingThroughput,
      foodSecondsAvailable: Number.isFinite(foodSecondsAvailable) ? foodSecondsAvailable : 0,
      sessionSecondsRequired,
    },
  };
}

/**
 * Normalises a value the game may express as either a fraction or a percent.
 *
 * The auto-eat getters are documented only by name, and whether
 * `autoEatThreshold` returns `40` or `0.4` is not stated anywhere in the
 * typings or the wiki. Getting this wrong by 100x in the unsafe direction would
 * be catastrophic, so anything above 1 is treated as a percentage. A real
 * threshold is never above 100% of max HP, which makes the heuristic safe in
 * both directions.
 *
 * Flagged in learnings/ as needing in-game confirmation.
 */
export function normaliseFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? value / 100 : value;
}

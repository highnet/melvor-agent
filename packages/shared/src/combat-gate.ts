import { z } from 'zod';

/**
 * Everything the survivability gate needs, read from the game.
 *
 * Separated from the assessment itself so the decision is a pure function of
 * numbers and can be tested exhaustively. The adapter's only job is to fill
 * this in honestly.
 */
export const combatGateInputsSchema = z.object({
  /** What we are proposing to fight. */
  targetId: z.string().min(1),
  targetName: z.string(),
  /** True when the target is a dungeon, in which case the numbers below must
   *  describe its *worst* monster, not its first. */
  isDungeon: z.boolean(),

  playerMaxHitpoints: z.number().positive(),
  /** Damage reduction as a percentage, e.g. 20 means 20%. */
  playerDamageReductionPercent: z.number().nonnegative(),

  /**
   * Fraction of max HP at which auto eat triggers, normalised to 0..1.
   * Zero means no Auto Eat is owned, which is an automatic refusal.
   */
  autoEatThresholdFraction: z.number().nonnegative(),
  /** Fraction of max HP that auto eat heals up to, normalised to 0..1. */
  autoEatHpLimitFraction: z.number().nonnegative(),
  /** Multiplier applied to food healing, normalised to 0..1 (1 = 100%). */
  autoEatEfficiencyFraction: z.number().nonnegative(),

  /** Healing from one item of the currently equipped food, before efficiency. */
  foodHealPerItem: z.number().nonnegative(),
  /** How many food items are equipped. */
  foodQuantity: z.number().int().nonnegative(),

  /** The worst single hit the enemy can land, before damage reduction. */
  enemyMaxHit: z.number().nonnegative(),
  /** Enemy attack interval in ms, used for incoming DPS. */
  enemyAttackIntervalMs: z.number().positive(),
  /** Enemy accuracy as a hit chance 0..1, used for expected incoming DPS. */
  enemyHitChance: z.number().min(0).max(1),

  /** How long the agent intends to keep fighting. Food must cover it. */
  intendedSessionMinutes: z.number().positive(),
});
export type CombatGateInputs = z.infer<typeof combatGateInputsSchema>;

export const gateRefusalSchema = z.enum([
  'no_auto_eat',
  'can_be_one_shot',
  'insufficient_healing_throughput',
  'insufficient_food_stock',
  'no_food_equipped',
  'abyssal_content',
  'missing_data',
]);
export type GateRefusal = z.infer<typeof gateRefusalSchema>;

export const combatGateVerdictSchema = z.object({
  safe: z.boolean(),
  /** Populated whenever `safe` is false. Every failing check, not just the first. */
  refusals: z.array(
    z.object({
      reason: gateRefusalSchema,
      detail: z.string(),
    }),
  ),
  /** The numbers behind the verdict, so a dry run is inspectable. */
  workings: z.object({
    effectiveEnemyMaxHit: z.number(),
    oneShotCeiling: z.number(),
    incomingDps: z.number(),
    healingThroughput: z.number(),
    foodSecondsAvailable: z.number(),
    sessionSecondsRequired: z.number(),
  }),
});
export type CombatGateVerdict = z.infer<typeof combatGateVerdictSchema>;

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
  /** The enemy's stats could not be read; zero must never read as harmless. */
  'unmeasurable',
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

/**
 * The combat skill levels of one character — a monster or the player.
 *
 * The point of this type is that both sides fill it in. Melvor gives a monster
 * `levels: Omit<CombatLevels, 'Prayer'>` (`monsters.d.ts:103`) and a character
 * `levels: CombatLevels` (`character.d.ts:101`) — the *same* record type, so
 * these six numbers mean the same thing on both sides and may be compared
 * directly.
 *
 * That is not true of `Monster.combatLevel` (`monsters.d.ts:102`) against
 * `Game.playerCombatLevel` (`game.d.ts:221`). Neither getter's formula appears
 * anywhere in the typings, and the observed ranges do not overlap: `data/dump.json`
 * holds 377 monsters whose combat levels run from 1 to 3,501,091, with a median
 * of 465, while a character with 99 in every combat skill is around 126. The
 * screen those two numbers used to drive refused roughly 84% of the game's
 * monsters to a maxed character and every dungeon outright.
 *
 * Prayer is omitted because monsters do not have it. Corruption is omitted
 * because `MonsterData.levels` marks it optional (`monsters.d.ts:22`), so a
 * monster that lacks it would read as zero rather than as absent.
 */
export const combatSkillLevelsSchema = z.object({
  attack: z.number().nonnegative(),
  strength: z.number().nonnegative(),
  defence: z.number().nonnegative(),
  hitpoints: z.number().nonnegative(),
  ranged: z.number().nonnegative(),
  magic: z.number().nonnegative(),
});
export type CombatSkillLevels = z.infer<typeof combatSkillLevelsSchema>;

/**
 * What the level screen needs, read from the game.
 *
 * Every monster of the target, not a summary: a dungeon is judged by its worst
 * inhabitant and the screen has to name which one that was, or its refusals are
 * unactionable.
 */
export const combatLevelScreenInputsSchema = z.object({
  targetId: z.string().min(1),
  targetName: z.string(),
  /** True when the target is a dungeon, which is screened more strictly. */
  isDungeon: z.boolean(),

  player: combatSkillLevelsSchema,
  /**
   * The weakest of the player's three equipment defence bonuses.
   *
   * Reported, never gating — see `screenByCombatSkillLevels`. `EquipmentStats`
   * carries `meleeDefenceBonus`, `rangedDefenceBonus` and `magicDefenceBonus`
   * (`character.d.ts:494-496`); the lowest is the one an enemy of the wrong
   * attack type finds.
   */
  playerDefenceBonus: z.number(),

  monsters: z
    .array(
      z.object({
        name: z.string(),
        levels: combatSkillLevelsSchema,
        /**
         * The highest of this monster's equipment damage bonuses, from
         * `Monster.equipmentStats` (`monsters.d.ts:104`). Reported, never gating.
         */
        strengthBonus: z.number(),
      }),
    )
    .min(1),

  /** Monsters of the target whose levels could not be read at all, by name. */
  unreadableMonsters: z.array(z.string()),
});
export type CombatLevelScreenInputs = z.infer<typeof combatLevelScreenInputsSchema>;

export const levelScreenRefusalSchema = z.enum([
  /** Levels could not be read on one side or the other. Never read as harmless. */
  'unmeasurable',
  /** The monster's offensive levels exceed what the character can stand up to. */
  'outmatched',
]);
export type LevelScreenRefusal = z.infer<typeof levelScreenRefusalSchema>;

export const combatLevelScreenVerdictSchema = z.object({
  ok: z.boolean(),
  refusals: z.array(
    z.object({
      reason: levelScreenRefusalSchema,
      detail: z.string(),
    }),
  ),
  /**
   * What this screen knows it cannot see.
   *
   * A permit from a heuristic is not a proof of safety, and the previous screen
   * presented itself as one. These strings are carried into the journal so a
   * pass is legible as "nothing here looks lethal" rather than "this is safe".
   */
  uncertainties: z.array(z.string()),
  /** The numbers behind the verdict, so a refusal can be argued with. */
  workings: z.object({
    hardestMonsterName: z.string(),
    monsterOffensiveLevel: z.number(),
    monsterHitpointsLevel: z.number(),
    playerDefensiveLevel: z.number(),
    playerOffensiveLevel: z.number(),
    allowance: z.number(),
    ceiling: z.number(),
  }),
  /** One line fit for a log or a refusal message. */
  detail: z.string(),
});
export type CombatLevelScreenVerdict = z.infer<typeof combatLevelScreenVerdictSchema>;

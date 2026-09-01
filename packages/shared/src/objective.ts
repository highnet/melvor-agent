import { z } from 'zod';
import { gameIdSchema } from './snapshot.js';

/**
 * The set of things the agent can actually do.
 *
 * This enum is the capability contract. A planner response naming a kind with
 * no registered policy executor is rejected before its params are parsed — so
 * "the planner must never emit an action the policy layer couldn't perform"
 * is a runtime assertion, not a convention.
 *
 */
export const objectiveKindSchema = z.enum([
  'gather_resource',
  'sell_items',
  'buy_shop_upgrade',
  'fight_monster',
  'tend_farm',
  'equip_item',
  'equip_food',
  'spend_mastery',
  'set_attack_style',
  'toggle_prayer',
  'use_potion',
  'new_slayer_task',
  'run_dungeon',
  'select_spell',
  'build_township',
  'repair_township',
  'survey_hex',
  'excavate_dig_site',
  'toggle_curse',
  'toggle_aurora',
  'toggle_bank_lock',
  'select_level_cap',
  'select_dig_map',
  'select_dig_tool',
  'run_golbin_raid',
  'build_obstacle',
  'upgrade_constellation',
  'unlock_skill_node',
  'change_equipment_set',
  'compost_plot',
  'passive_cook',
  'restore_town_health',
  'upgrade_item',
  'select_worship',
  'make_paper',
  'claim_township_task',
  'claim_casual_task',
  'start_combat_event',
  'choose_event_passive',
  'convert_to_township',
  'bury_bones',
]);
export type ObjectiveKind = z.infer<typeof objectiveKindSchema>;

/** Params are a discriminated union keyed by the same `kind`. */
export const objectiveParamsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('gather_resource'),
    /** Skill to run, e.g. `melvorD:Woodcutting`. */
    skillId: gameIdSchema,
    /** The recipe/node within that skill, e.g. a `WoodcuttingTree` id. */
    recipeId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('buy_shop_upgrade'),
    purchaseId: gameIdSchema,
    quantity: z.number().int().positive(),
    /** Never spend below this. The floor is the objective's, not a global. */
    gpFloor: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal('tend_farm'),
    /**
     * Seed to replant with. Optional: when absent the agent harvests but does
     * not replant, which is the right behaviour when seeds have run out.
     */
    seedRecipeId: gameIdSchema.optional(),
  }),
  z.object({
    kind: z.literal('fight_monster'),
    monsterId: gameIdSchema,
    areaId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('equip_item'),
    itemId: gameIdSchema,
    /** Explicit slot; the item's first valid slot is used when absent. */
    slotId: gameIdSchema.optional(),
  }),
  z.object({
    kind: z.literal('equip_food'),
    itemId: gameIdSchema,
    quantity: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('spend_mastery'),
    skillId: gameIdSchema,
    actionId: gameIdSchema,
    levels: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('set_attack_style'),
    /** `melee`, `ranged` or `magic`. */
    attackTypeId: z.enum(['melee', 'ranged', 'magic']),
    styleId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('toggle_prayer'),
    prayerId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('use_potion'),
    itemId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('new_slayer_task'),
    categoryId: gameIdSchema,
    /** Paying Slayer Coins rerolls; free selection is the default. */
    payWithCoins: z.boolean(),
  }),
  z.object({
    kind: z.literal('run_dungeon'),
    dungeonId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('select_spell'),
    spellId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('build_township'),
    buildingId: gameIdSchema,
    /** Which biome it goes in; a building's cost and effect both depend on it. */
    biomeId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('repair_township'),
    buildingId: gameIdSchema,
    biomeId: gameIdSchema,
  }),
  z.object({
    /**
     * Survey the best hex available.
     *
     * Deliberately parameterless: hexes have no ids, and which one is worth
     * surveying depends on where the player is standing right now. Naming one
     * in a plan would be stale by the time it ran.
     */
    kind: z.literal('survey_hex'),
  }),
  z.object({
    kind: z.literal('excavate_dig_site'),
    digSiteId: gameIdSchema,
  }),
  z.object({
    /** Maps are held per dig site and identified by index — the game's model. */
    kind: z.literal('select_dig_map'),
    digSiteId: gameIdSchema,
    mapIndex: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('select_dig_tool'),
    digSiteId: gameIdSchema,
    toolId: gameIdSchema,
  }),
  z.object({
    /**
     * A raid makes no progress on its own — it stops at each choice and waits —
     * so this objective is answered repeatedly rather than started once.
     */
    kind: z.literal('run_golbin_raid'),
    difficulty: z.enum(['easy', 'medium', 'hard']),
  }),
  z.object({
    /** The obstacle's own category decides its slot, so none is passed. */
    kind: z.literal('build_obstacle'),
    obstacleId: gameIdSchema,
  }),
  z.object({
    /** Stardust has no other use, so unspent stardust is progress not collected. */
    kind: z.literal('upgrade_constellation'),
    constellationId: gameIdSchema,
    modifierKind: z.enum(['standard', 'unique']),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('unlock_skill_node'),
    skillId: gameIdSchema,
    treeId: gameIdSchema,
    nodeId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('change_equipment_set'),
    setIndex: z.number().int().nonnegative(),
  }),
  z.object({
    /** Compost stops crops dying, which an unattended agent cannot notice. */
    kind: z.literal('compost_plot'),
    plotId: gameIdSchema,
    compostId: gameIdSchema,
    amount: z.number().int().positive(),
  }),
  z.object({
    /** The only genuinely parallel production: it runs behind everything else. */
    kind: z.literal('passive_cook'),
    categoryId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('restore_town_health'),
    resourceId: gameIdSchema,
    amount: z.number().int().positive(),
  }),
  z.object({
    /**
     * Named by its result: `ItemUpgrade` has no id, so the upgraded item is the
     * only stable name the pair has.
     */
    kind: z.literal('upgrade_item'),
    upgradedItemId: gameIdSchema,
    quantity: z.number().int().positive(),
    /**
     * Downgrades destroy the better item for a refund. Nothing that enumerates
     * candidates proposes one, so this has to be asked for deliberately —
     * defaulting to allowed would turn a typo into a loss.
     */
    allowDowngrade: z.boolean().default(false),
  }),
  z.object({
    /** Free the first time; 50M GP and every worship building to change later. */
    kind: z.literal('select_worship'),
    worshipId: gameIdSchema,
  }),
  z.object({
    /** Paper makes maps, and maps are what make dig sites excavatable. */
    kind: z.literal('make_paper'),
    recipeId: gameIdSchema,
  }),
  z.object({
    /** The work is already done; the reward waits until someone claims it. */
    kind: z.literal('claim_township_task'),
    taskId: gameIdSchema,
  }),
  z.object({
    /** Unclaimed casual tasks hold one of five slots and block the next one. */
    kind: z.literal('claim_casual_task'),
    taskId: gameIdSchema,
  }),
  z.object({
    /** The end-game gauntlet: stages of slayer areas ending in a final boss. */
    kind: z.literal('start_combat_event'),
    eventId: gameIdSchema,
  }),
  z.object({
    /**
     * Answers the choice an event stops on. Parameterless by default: the
     * offered passives are rolled at the moment of the stage, so naming one in
     * advance would be naming something that does not exist yet.
     */
    kind: z.literal('choose_event_passive'),
    passiveId: gameIdSchema.optional(),
  }),
  z.object({
    /** Bank items into town resources — how a new town gets anything at all. */
    kind: z.literal('convert_to_township'),
    itemId: gameIdSchema,
    resourceId: gameIdSchema,
    quantity: z.number().int().positive(),
  }),
  z.object({
    /** The only source of Prayer XP and the points prayers spend. */
    kind: z.literal('bury_bones'),
    itemId: gameIdSchema,
    quantity: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('toggle_curse'),
    curseId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('toggle_aurora'),
    auroraId: gameIdSchema,
  }),
  z.object({
    /** Locking is the agent's own guard rail against its one destructive verb. */
    kind: z.literal('toggle_bank_lock'),
    itemId: gameIdSchema,
  }),
  z.object({
    /**
     * A permanent choice: the raised cap cannot be moved afterwards. Named by
     * skill rather than by index so a stale plan cannot raise the cap of
     * whichever skill happens to be offered third.
     */
    kind: z.literal('select_level_cap'),
    capIncreaseId: gameIdSchema,
    skillId: gameIdSchema,
  }),
  z.object({
    kind: z.literal('sell_items'),
    /**
     * Exactly one item id. Deliberately not a list or a filter: selling is the
     * first capability that destroys something, and a bad plan should be able
     * to lose one stack, never a bank.
     */
    itemId: gameIdSchema,
    /** Leave this many in the bank. Lets an objective bank surplus only. */
    keepQuantity: z.number().int().nonnegative(),
  }),
]);
export type ObjectiveParams = z.infer<typeof objectiveParamsSchema>;

/**
 * Machine-checkable completion test. Evaluated by the policy layer against a
 * snapshot; the planner only chooses among these, it does not author them.
 */
export const successCriterionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('skill_level_at_least'),
    skillId: gameIdSchema,
    level: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('item_qty_at_least'),
    itemId: gameIdSchema,
    qty: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('currency_at_least'),
    currencyId: gameIdSchema,
    amount: z.number().positive(),
  }),
]);
export type SuccessCriterion = z.infer<typeof successCriterionSchema>;

/**
 * Without abort conditions the agent grinds into a wall for six hours.
 * Every objective carries a budget; the policy layer enforces it, not the planner.
 */
export const abortConditionsSchema = z.object({
  gpBelow: z.number().nonnegative().optional(),
  deathsExceed: z.number().int().nonnegative().optional(),
  minutesExceed: z.number().positive(),
});
export type AbortConditions = z.infer<typeof abortConditionsSchema>;

export const objectiveSchema = z.object({
  id: z.string().min(1),
  kind: objectiveKindSchema,
  params: objectiveParamsSchema,
  /**
   * When the objective is done. May be empty for a one-shot action — buying,
   * equipping, toggling — where the executor decides completion and any
   * criterion an author invented would be either instantly true or never true.
   */
  successWhen: z.array(successCriterionSchema),
  abortWhen: abortConditionsSchema,
  expectedDurationMin: z.number().positive(),
  rationale: z.string(),
});
export type Objective = z.infer<typeof objectiveSchema>;

/**
 * An objective the mod has *proven it can execute right now*, with real numbers
 * attached from game data. The planner chooses among candidates and orders them;
 * it never invents one.
 */
export const candidateSchema = z.object({
  kind: objectiveKindSchema,
  params: objectiveParamsSchema,
  label: z.string(),
  /** Measured or computed from game data — never from the wiki. */
  xpPerHour: z.number().nonnegative().optional(),
  gpPerHour: z.number().nonnegative().optional(),
  /** Requirements that are currently met. Candidates with unmet ones are not emitted. */
  requiresLevel: z.number().int().nonnegative().optional(),
  available: z.literal(true),
});
export type Candidate = z.infer<typeof candidateSchema>;

/** Why the current objective ended. Feeds the journal and the next planning call. */
export const outcomeSchema = z.enum([
  'completed',
  'aborted_budget',
  'aborted_gp_floor',
  'aborted_deaths',
  'aborted_stuck',
  'aborted_operator',
  'failed_precondition',
]);
export type Outcome = z.infer<typeof outcomeSchema>;

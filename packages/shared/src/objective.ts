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
  'repair_all_township',
  'survey_hex',
  'create_dig_map',
  'excavate_dig_site',
  'toggle_curse',
  'toggle_aurora',
  'toggle_bank_lock',
  'select_level_cap',
  'select_dig_map',
  'travel_to_poi',
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
  'convert_from_township',
  'bury_bones',
  'open_item',
  'claim_mastery_token',
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
     * Repair every degraded building the town can pay for, in one go.
     *
     * Parameterless because the game's own call is: repairing building by
     * building is a per-building decision the agent had to make dozens of
     * times, and each one costs a policy tick while the whole town keeps
     * producing at reduced efficiency in between.
     */
    kind: z.literal('repair_all_township'),
  }),
  z.object({
    /**
     * Make a new map for a dig site.
     *
     * The missing half of Archaeology. Maps are consumable — each has charges —
     * and a dig site with none cannot be excavated at all, so when the last
     * map runs out the skill vanishes from the candidate list with nothing on
     * that list able to bring it back. The agent kept making paper and never
     * turned any of it into a dig.
     */
    kind: z.literal('create_dig_map'),
    digSiteId: gameIdSchema,
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
    /**
     * Travel to a surveyed but undiscovered Point of Interest.
     *
     * The game raises a modal asking this, which an unattended agent cannot
     * answer — and dig sites, and therefore Archaeology, are reached this way.
     */
    kind: z.literal('travel_to_poi'),
    poiId: gameIdSchema,
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
    /**
     * Town resources back into bank items.
     *
     * For goods the town alone can make — Herb Boxes above all, which carry
     * the herbs Herblore needs and which no skill the character has can
     * otherwise produce.
     */
    kind: z.literal('convert_from_township'),
    resourceId: gameIdSchema,
    itemId: gameIdSchema,
    quantity: z.number().int().positive(),
  }),
  z.object({
    /** The only source of Prayer XP and the points prayers spend. */
    kind: z.literal('bury_bones'),
    itemId: gameIdSchema,
    quantity: z.number().int().positive(),
  }),
  z.object({
    /** Bird nests and chests: the only source of some items, seeds included. */
    kind: z.literal('open_item'),
    itemId: gameIdSchema,
    quantity: z.number().int().positive(),
  }),
  z.object({
    /**
     * Mastery Tokens, which are not containers and were being offered for sale.
     *
     * A separate kind rather than folding into `open_item`, because the game
     * models them as a separate class with a separate claim call — and the
     * reason they were invisible was precisely an `instanceof OpenableItem`
     * check that excludes them.
     */
    kind: z.literal('claim_mastery_token'),
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

/**
 * An operator-stated currency goal the agent is allowed to sell towards.
 *
 * Deliberately *not* a {@link SuccessCriterion}. A criterion says when the
 * objective is finished, and every criterion has to hold for that — so adding
 * "and have a million GP" to a smelting objective would mean the objective
 * never completes. This says something different and narrower: while the run is
 * short of this number, converting surplus stock into it is authorised.
 *
 * It exists because nothing in the agent ever sold, and a GP goal therefore
 * could not be finished unattended. Measured live: GP frozen at exactly 555,142
 * for hours while the bank filled with Gold Bars, moving only when an operator
 * hand-issued a `Sell` objective four separate times — each of which also
 * consumed a plan step, so the plan had to be re-issued afterwards. Carrying the
 * target on the objective instead lets the reflex tier do it, which leaves the
 * running objective and its plan intact.
 *
 * The authorisation is bounded in three ways, all of which matter because a
 * sale cannot be undone at par:
 *
 * - It is **absent by default.** No target, no automatic sale toward one.
 * - The number is the operator's, from `GOALS.md`, not one this code invented.
 * - It **expires on success.** Once the currency reaches `amount` the
 *   authorisation is over, so the policy cannot walk on into liquidating a bank.
 *
 * `goalId` is carried so a sale can be explained by naming the goal that
 * licensed it rather than by pointing at a threshold.
 */
export const fundingTargetSchema = z.object({
  goalId: z.string().min(1),
  currencyId: gameIdSchema,
  amount: z.number().positive(),
});
export type FundingTarget = z.infer<typeof fundingTargetSchema>;

export const objectiveSchema = z.object({
  id: z.string().min(1),
  kind: objectiveKindSchema,
  params: objectiveParamsSchema,
  /**
   * A currency goal this objective is running in service of, when one is
   * stated. See {@link fundingTargetSchema}: an authorisation to sell surplus,
   * never a condition on finishing.
   */
  fundingTarget: fundingTargetSchema.optional(),
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
  /**
   * Whether `gpPerHour` is money received, rather than what output would fetch.
   *
   * The two mean different things and the field name cannot hold both. Thieving
   * and Item Alchemy pay coins directly; gathering and smithing produce *items*
   * whose value only becomes GP if something sells them, and nothing sells them
   * automatically until a stack is large enough to trip the liquidation reflex.
   *
   * Without the distinction a GP goal was reported as advanced by mining a gem
   * -- an hour of which moves the balance by exactly zero. The label had said so
   * in words the whole time; the data had not.
   */
  gpIsEarned: z.boolean().optional(),
  /**
   * How long the banked inputs sustain this action, in minutes.
   *
   * Absent when the action consumes nothing identifiable — a gathering skill is
   * limited by time, not by stock, and reporting a horizon there would be
   * inventing one. Absent is therefore "no limit", not "unknown".
   *
   * The figure has been computed since the Gold Bar chain ran the smelter dry,
   * and it only ever reached the label. So it was readable by a planning
   * session and invisible to the code that chooses when no session answers:
   * unattended, the stopgap adopted `Runecrafting: Smoke Rune` for a thirty
   * minute budget, crafted for three seconds, and was refused for missing
   * materials -- the same minute after doing it with Alt Magic's Item Alchemy.
   * Both labels said "inputs run out almost immediately".
   */
  sustainMinutes: z.number().nonnegative().optional(),
  /**
   * The item this candidate puts in the bank, and how fast.
   *
   * Absent where nothing identifiable is produced -- Thieving pays coins, a
   * purchase or an equip produces nothing -- so absent means "this is not a
   * producer", never "the rate is unknown".
   *
   * It exists because a stock target had no way to be sized. `rungFor` sizes a
   * *level* target against `xpPerHour` and the budget, and its whole argument
   * is that an objective which times out "teaches nothing"; a stock target
   * skipped that sizing entirely, so `untilQuantity: 10000` for Mind Runes was
   * accepted against a bank holding 1,347 Rune Essence and would have run its
   * full 90 minute abort producing about 5,000. `perHour` is the missing term:
   * with it and {@link sustainMinutes}, the budget ceiling and the materials
   * ceiling are both arithmetic.
   *
   * `perHour` is the expectation the candidate's own rate is built from --
   * `productYieldFor` times the same actions-per-hour the XP figure uses -- so
   * it carries the same mastery, doubling and landing-chance terms and cannot
   * drift from the label beside it.
   */
  produces: z
    .object({
      itemId: gameIdSchema,
      name: z.string(),
      perHour: z.number().nonnegative(),
    })
    .optional(),
  /**
   * A stock figure something else is short of, that this candidate produces.
   *
   * The agent has always computed exact stock requirements and spent them on
   * prose. `readBlockedOpportunities` emits a line reading `Magic: Superheat II
   * — Earth Rune from Runecrafting: Earth Rune — needs Earth Rune 1/3`: a
   * complete stock objective, naming a producer, an item and a number, that
   * nothing could consume as data. So every goal and every plan step came out
   * level-shaped, and "craft Mind Runes to Runecrafting 49" was set for a
   * problem whose real question was how many runes combat needed.
   *
   * This is that number, carried on the candidate that would produce it, ready
   * to pass to `untilQuantity`. It is a **suggestion and not a choice**: the
   * planner is told what is short and how the figure was derived (`why`), and
   * decides. Picking for the caller is the thing `rungFor` argues against.
   */
  suggestedStock: z
    .object({
      itemId: gameIdSchema,
      name: z.string(),
      /** An absolute bank target, matching `item_qty_at_least`, not a delta. */
      quantity: z.number().int().positive(),
      have: z.number().nonnegative(),
      /** How the figure was derived, so it can be argued with rather than trusted. */
      why: z.string(),
    })
    .optional(),
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

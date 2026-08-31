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
    kind: z.literal('fight_monster'),
    monsterId: gameIdSchema,
    areaId: gameIdSchema,
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
  successWhen: z.array(successCriterionSchema).min(1),
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

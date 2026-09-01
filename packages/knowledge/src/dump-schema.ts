import { z } from 'zod';

/**
 * The shape of `knowledge/dump.json`.
 *
 * The game's registries are the numeric source of truth: they are correct for
 * the exact installed version. The wiki is not, and is only ever used for what
 * the data does not encode. Where the two disagree, the data wins and the
 * discrepancy is logged to `knowledge/conflicts.md` — never silently resolved.
 */
export const knowledgeDumpSchema = z.object({
  /** Global `gameVersion` at capture, e.g. `"v1.3.1"`. */
  gameVersion: z.string().min(1),
  capturedAt: z.number().int().positive(),
  gamemodeId: z.string().min(1),

  realms: z.array(z.object({ id: z.string(), name: z.string() })),

  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isCombat: z.boolean(),
      hasMastery: z.boolean(),
    }),
  ),

  currencies: z.array(z.object({ id: z.string(), name: z.string() })),

  woodcuttingTrees: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number().int().nonnegative(),
      baseInterval: z.number().nonnegative(),
      baseExperience: z.number().nonnegative(),
      productId: z.string(),
      productName: z.string(),
      productSellsFor: z.number().nonnegative(),
      productSellsForCurrencyId: z.string(),
    }),
  ),

  /**
   * Thieving NPCs, with the level that gates each one.
   *
   * These carry the requirements that decide whether a whole skill chain is
   * reachable: Herblore waits on herb seeds, and herb seeds come off a specific
   * NPC. With only the *nearest* locked action reported anywhere, how far away
   * that NPC sat could not be seen without grinding toward it and watching.
   */
  /** The lowest Herblore recipes and exactly what each consumes. */
  herbloreRecipes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number().int().nonnegative(),
      costs: z.array(
        z.object({ itemId: z.string(), itemName: z.string(), quantity: z.number().int() }),
      ),
    }),
  ),

  /**
   * Summoning tablet recipes.
   *
   * `nonShardOptions` carries the "one of several secondaries" rule, which is
   * the part a planner cannot infer from a flat cost list and the reason
   * Summoning was previously reasoned about by guesswork.
   */
  summoningRecipes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number().int().nonnegative(),
      productId: z.string(),
      shardCosts: z.array(
        z.object({ itemId: z.string(), itemName: z.string(), quantity: z.number().int() }),
      ),
      nonShardOptions: z.array(z.object({ itemId: z.string(), itemName: z.string() })),
    }),
  ),

  /** Live farming plot state, including whether a growth timer actually exists. */
  farmingPlotStates: z.array(
    z.object({
      id: z.string(),
      rawState: z.number().int(),
      growthTimeSeconds: z.number(),
      compostLevel: z.number(),
      plantedRecipeId: z.string().nullable(),
      hasGrowthTimer: z.boolean(),
    }),
  ),

  /** Farming recipes, the level gating each, and what its seed costs. */
  farmingRecipes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number().int().nonnegative(),
      categoryId: z.string(),
      seedItemId: z.string(),
      seedCost: z.number().int().nonnegative(),
    }),
  ),

  /** Township biomes and whether the town has opened them. */
  townshipBiomes: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tier: z.number().int(),
      unlocked: z.boolean(),
      requirements: z.array(z.string()),
    }),
  ),

  /** Township buildings, the tier gating each, and the resources they produce. */
  townshipBuildings: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      tier: z.number().int(),
      biomes: z.array(z.string()),
      produces: z.array(z.string()),
    }),
  ),

  /** Items the Township will accept from the bank, and the resource each becomes. */
  townshipTradesToTown: z.array(
    z.object({
      resourceId: z.string(),
      resourceName: z.string(),
      itemId: z.string(),
      itemName: z.string(),
    }),
  ),

  /** Items the Township will trade back for its resources. */
  townshipTradesFromTown: z.array(
    z.object({
      resourceId: z.string(),
      resourceName: z.string(),
      itemId: z.string(),
      itemName: z.string(),
    }),
  ),

  /**
   * Containers and what they can yield.
   *
   * The bird nest is the only candidate source of herb seeds left once the
   * Thieving tables were checked and found to hold none, so what a nest can
   * actually drop decides whether Herblore is reachable at all.
   */
  openableItems: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      contents: z.array(z.string()),
    }),
  ),

  thievingNpcs: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number().int().nonnegative(),
      maxHit: z.number().nonnegative(),
      lootTable: z.array(z.string()),
    }),
  ),

  /**
   * Note the absence of `maxHit`. A `Monster` in the registry is data with no
   * computed max hit — only an instantiated `Enemy` has one. Recording a
   * plausible-looking number here would poison the combat gate, so the field
   * is omitted rather than approximated.
   */
  monsters: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      combatLevel: z.number().nonnegative(),
    }),
  ),

  dungeons: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      monsterIds: z.array(z.string()),
      realmId: z.string(),
    }),
  ),

  shopPurchases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      allowQuantityPurchase: z.boolean(),
    }),
  ),
});

export type KnowledgeDump = z.infer<typeof knowledgeDumpSchema>;

/** Why a dump was rejected. Rendered verbatim in the panel and the TUI. */
export type DumpStaleness =
  | { fresh: true }
  | { fresh: false; reason: 'missing'; detail: string }
  | { fresh: false; reason: 'version_mismatch'; detail: string }
  | { fresh: false; reason: 'malformed'; detail: string };

/**
 * Decides whether a dump may be trusted for the running game.
 *
 * A stale dump is worse than no dump: the planner would reason over numbers
 * that no longer describe the installed game. So automation refuses to arm
 * rather than degrading quietly.
 *
 * @param raw - Parsed JSON from `knowledge/dump.json`, or null when absent.
 * @param liveGameVersion - The running game's `gameVersion` global.
 * @returns Freshness, with an operator-readable reason when it fails.
 */
export function checkDumpFreshness(raw: unknown, liveGameVersion: string): DumpStaleness {
  if (raw === null || raw === undefined) {
    return { fresh: false, reason: 'missing', detail: 'no dump found; run pnpm knowledge:dump' };
  }

  const parsed = knowledgeDumpSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      fresh: false,
      reason: 'malformed',
      detail: parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    };
  }

  if (parsed.data.gameVersion !== liveGameVersion) {
    return {
      fresh: false,
      reason: 'version_mismatch',
      detail: `dump is for ${parsed.data.gameVersion}, game is ${liveGameVersion}; regenerate with pnpm knowledge:dump`,
    };
  }

  return { fresh: true };
}

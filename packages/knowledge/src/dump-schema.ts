import { z } from 'zod';

/**
 * A note on `.default()`, learned by defeating this file's own mechanism.
 *
 * A stored dump is regenerated when it fails to validate against this schema,
 * which is what keeps the reference from going stale across a game update. A
 * field declared with `.default()` never fails: the old dump validates, the
 * default is filled in, and nothing regenerates.
 *
 * Monster loot tables were added with `.default([])` for safety and were
 * therefore never captured — 377 monsters with every loot table empty, while
 * `summoningRecipes` and `skillRareDrops`, added the same day without
 * defaults, appeared immediately. The defensive-looking option was the one
 * that silently did nothing, and the section read as "no monster drops seeds"
 * rather than "this was never collected".
 *
 * Add new sections and fields as required. A dump that refuses to load is a
 * dump that regenerates; a dump that loads with holes is a dump that lies.
 */

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

  realms: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      unlocked: z.boolean(),
      requirements: z.array(z.string()),
    }),
  ),

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
   * Rare drops per skill — what a skill yields besides its product.
   *
   * The Herblore route depends on one of these: Farming needs seeds, seeds come
   * from Bird Nests, and which skill drops those was previously a matter of
   * recollection rather than record.
   */
  skillRareDrops: z.array(
    z.object({
      skillId: z.string(),
      skillName: z.string(),
      itemId: z.string(),
      itemName: z.string(),
      quantity: z.number().int(),
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
      /** The guaranteed drop, which the loot table does not include. */
      uniqueDrop: z.string(),
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
      /**
       * Percent chance the loot table rolls at all.
       *
       * Carried with the table because presence is not a rate: a seed on a
       * table that rolls one kill in fifty is not comparable to a Bird Nest,
       * and comparing them is the reason to have either.
       */
      lootChance: z.number().nonnegative(),
      lootTable: z.array(z.string()),
      /**
       * Sum of the table's weights, and each drop as `name:weight`.
       *
       * Without these `lootChance` is not a rate — it is the chance the table
       * rolls at all, and which item emerges is weight/totalWeight. Reading the
       * two as one produced "drops Garum Seeds at 100% loot chance", which
       * welded two true facts into a false one.
       */
      lootTotalWeight: z.number().nonnegative(),
      lootWeights: z.array(z.string()),
      bones: z.string(),
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

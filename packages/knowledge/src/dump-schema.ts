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
 *
 * The rule that follows from that, and the one this file now applies: a new
 * *section* is required, and new *fields* inside an existing row are
 * `.default()`ed. One required section is enough to make every stale dump fail
 * and regenerate — and the regeneration is what fills the defaulted fields in.
 * The defaults are then what they should be, a parser that survives a row the
 * game no longer describes, rather than a silent licence to keep a hollow dump.
 */

/**
 * One row of a drop table, quantities included.
 *
 * Drops were dumped as bare item names, which say a thing can come out and
 * nothing about how much or how often. A weight is only a rate against the
 * table's `totalWeight`, which every section carrying this records beside it.
 */
const dropSchema = z.object({
  itemId: z.string(),
  itemName: z.string(),
  minQuantity: z.number().nonnegative(),
  maxQuantity: z.number().nonnegative(),
  weight: z.number().nonnegative(),
});

/** A fixed currency payout. Coins are not items and appear in no loot table. */
const currencyQuantitySchema = z.object({
  currencyId: z.string(),
  currencyName: z.string(),
  quantity: z.number(),
});

/** A currency payout the game rolls between two bounds, as monsters do. */
const currencyRangeSchema = z.object({
  currencyId: z.string(),
  currencyName: z.string(),
  min: z.number(),
  max: z.number(),
});

/** An item quantity, in the shape `dumpItemCosts` produces. */
const itemQuantitySchema = z.object({
  itemId: z.string(),
  name: z.string(),
  quantity: z.number(),
});

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
   * Mining rocks, with the depletion terms that decide what mining pays.
   *
   * A rock holds `maxHP` swings and is then gone for `baseRespawnInterval`, so
   * a rate built from the swing alone overstates every rock that depletes —
   * Crystal advertised 120,000 GP/h against about 10,800 realised. None of
   * these numbers were dumped, so that correction had to be measured by hand.
   *
   * `hasPassiveRegen` marks the rocks that break the model by refilling on a
   * timer while nothing mines them; `passiveRegenInterval` is the skill-wide
   * rate they refill at, carried per row so a row answers on its own.
   */
  miningRocks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      level: z.number().int().nonnegative(),
      baseExperience: z.number().nonnegative(),
      /** Mastery-adjusted, from `getRockMaxHP` — not the static field. */
      maxHP: z.number().nonnegative(),
      baseRespawnInterval: z.number().nonnegative(),
      hasPassiveRegen: z.boolean(),
      passiveRegenInterval: z.number().nonnegative(),
      /** Ore per swing, which is not always one. */
      baseQuantity: z.number().nonnegative(),
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
      lootDrops: z.array(dropSchema).default([]),
      lootTotalWeight: z.number().nonnegative().default(0),
      /** The guaranteed drop, which the loot table does not include. */
      uniqueDrop: z.string(),
      uniqueDropQuantity: z.number().nonnegative().default(0),
      /**
       * What a pickpocket actually pays.
       *
       * Coins are not items, so they were in no loot table and in no section —
       * leaving the dump describing the agent's largest single income as
       * yielding nothing.
       */
      currencyDrops: z.array(currencyQuantitySchema).default([]),
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
      /**
       * Sum of the table's weights, and the table itself.
       *
       * Without these `lootChance` is not a rate — it is the chance the table
       * rolls at all, which item emerges is weight/totalWeight, and how many
       * emerge is min/max. Reading the first two as one produced "drops Garum
       * Seeds at 100% loot chance", which welded two true facts into a false
       * one; `lootDrops` replaces the parallel name and weight lists that
       * invited exactly that.
       */
      lootTotalWeight: z.number().nonnegative(),
      lootDrops: z.array(dropSchema).default([]),
      /** GP a kill pays, which no item table can show. A range, not a figure. */
      currencyDrops: z.array(currencyRangeSchema).default([]),
      bones: z.string(),
      /**
       * The stats behind the combat level.
       *
       * `combatLevel` blends offence and defence into one number and so cannot
       * answer whether a given monster is survivable for a given character.
       * These, with `attackType`, are the parts that can.
       */
      levels: z
        .object({
          hitpoints: z.number().nonnegative(),
          attack: z.number().nonnegative(),
          strength: z.number().nonnegative(),
          defence: z.number().nonnegative(),
          ranged: z.number().nonnegative(),
          magic: z.number().nonnegative(),
          corruption: z.number().nonnegative(),
        })
        .default({
          hitpoints: 0,
          attack: 0,
          strength: 0,
          defence: 0,
          ranged: 0,
          magic: 0,
          corruption: 0,
        }),
      attackType: z.string().default(''),
      isBoss: z.boolean().default(false),
      /** Whether a Slayer task can ever ask for this monster. */
      canSlayer: z.boolean().default(false),
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

  skillRecipes: z.array(
    z.object({
      skillId: z.string(),
      skillName: z.string(),
      baseInterval: z.number().nonnegative(),
      recipeId: z.string(),
      name: z.string(),
      level: z.number().nonnegative(),
      baseExperience: z.number().nonnegative(),
      baseAbyssalExperience: z.number().nonnegative().default(0),
      abyssalLevel: z.number().nonnegative().default(0),
      realmId: z.string().default(''),
      /**
       * The recipe's own interval, where it has one.
       *
       * `baseInterval` above is the skill's: 0 for Agility, whose obstacles
       * each time themselves, and a flat nominal 3,000ms for every Firemaking
       * log. A ranking built on the skill constant alone sorts logs by XP and
       * picks the slowest.
       */
      recipeInterval: z.number().nonnegative().default(0),
      /** Inputs consumed per action. Empty for Agility — see `buildCosts`. */
      itemCosts: z.array(itemQuantitySchema),
      /**
       * A one-time construction cost, not consumption.
       *
       * Agility obstacles are built once and then run; charging every lap the
       * price of construction is a profit figure wrong by however many laps the
       * course is run. Empty for every other skill.
       */
      buildCosts: z.array(itemQuantitySchema).default([]),
      /** The GP half of that one-time cost; most obstacles are built with coin. */
      buildCurrencyCosts: z.array(currencyQuantitySchema).default([]),
      runeCosts: z.array(itemQuantitySchema).default([]),
      fixedItemCosts: z.array(itemQuantitySchema).default([]),
      /**
       * What an action pays that is not a product item.
       *
       * An Agility obstacle has no product at all, so a section recording only
       * `product` had the whole skill yielding nothing.
       */
      currencyRewards: z.array(currencyQuantitySchema).default([]),
      itemRewards: z.array(itemQuantitySchema).default([]),
      productId: z.string(),
      productName: z.string(),
      baseQuantity: z.number(),
      productSellsFor: z.number().nonnegative(),
      productSellsForCurrencyId: z.string(),
    }),
  ),
  shopPurchases: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      allowQuantityPurchase: z.boolean(),
      gpCost: z.number().nonnegative(),
      costs: z.array(z.string()).default([]),
      owned: z.number().nonnegative(),
      atBuyLimit: z.boolean(),
      requirements: z.array(z.string()),
      effect: z.string().default(''),
    }),
  ),

  /**
   * Every item, flat and scalar-only.
   *
   * Sale value used to exist only where some recipe happened to produce the
   * item, so anything picked up rather than made was unpriced — and an unpriced
   * input reads as a free one, which is the wrong direction in every chain it
   * appears in. Scalar-only because this is thousands of rows and one nested
   * object per row is what makes a reference too large to read.
   */
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      type: z.string(),
      sellsFor: z.number().nonnegative(),
      sellsForCurrencyId: z.string(),
      /** Hitpoints restored, on food. Zero on everything that heals nothing. */
      healsFor: z.number().nonnegative(),
    }),
  ),

  /**
   * Sections that were cut, and by how much.
   *
   * Three sections used to be sliced with no record of it, which is how this
   * file came to report twelve Herblore recipes in one section and seventy-two
   * in another. Those slices are gone; this exists so that any cut still made
   * is a stated fact. An empty array means nothing was truncated.
   */
  truncations: z.array(
    z.object({
      section: z.string(),
      truncatedAt: z.number().int().nonnegative(),
      totalAvailable: z.number().int().nonnegative(),
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

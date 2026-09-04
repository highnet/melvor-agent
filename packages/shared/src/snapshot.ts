import { z } from 'zod';

/** Namespaced game id, e.g. `melvorD:Normal_Logs`. */
export const gameIdSchema = z.string().min(1);

export const skillStateSchema = z.object({
  id: gameIdSchema,
  name: z.string(),
  level: z.number().int().nonnegative(),
  xp: z.number().nonnegative(),
  /** Abyssal level/XP are absent outside Into the Abyss content. */
  abyssalLevel: z.number().int().nonnegative().optional(),
  abyssalXp: z.number().nonnegative().optional(),
  isActive: z.boolean(),
  /** Mastery pool XP, present only on skills that have mastery. */
  masteryPoolXp: z.number().nonnegative().optional(),
});
export type SkillState = z.infer<typeof skillStateSchema>;

export const bankEntrySchema = z.object({
  id: gameIdSchema,
  name: z.string(),
  qty: z.number().int().nonnegative(),
});

export const bankStateSchema = z.object({
  slotsUsed: z.number().int().nonnegative(),
  slotsMax: z.number().int().nonnegative(),
  items: z.array(bankEntrySchema),
});

export const equipmentSlotStateSchema = z.object({
  slot: z.string(),
  itemId: gameIdSchema.nullable(),
  itemName: z.string().nullable(),
  qty: z.number().int().nonnegative(),
});

export const foodSlotStateSchema = z.object({
  itemId: gameIdSchema.nullable(),
  itemName: z.string().nullable(),
  qty: z.number().int().nonnegative(),
  /** Healing per item, already modified. */
  healsFor: z.number().nonnegative(),
});

/**
 * Everything the combat gate will need in Phase 2, captured now so the schema
 * does not churn later. All three auto-eat values are getters over the modifier
 * table, so they already fold in shop upgrades, gear and expansions — never
 * hardcode them. See docs/api-notes.md §7.
 */
export const combatStateSchema = z.object({
  inCombat: z.boolean(),
  hitpoints: z.number().nonnegative(),
  maxHitpoints: z.number().nonnegative(),
  prayerPoints: z.number().nonnegative(),
  /** Fraction of max HP below which auto-eat fires. 0 means no auto-eat owned. */
  autoEatThreshold: z.number().nonnegative(),
  autoEatHPLimit: z.number().nonnegative(),
  autoEatEfficiency: z.number().nonnegative(),
  maxHit: z.number().nonnegative(),
  minHit: z.number().nonnegative(),
  accuracy: z.number().nonnegative(),
  attackInterval: z.number().nonnegative(),
  maxBarrier: z.number().nonnegative(),
  combatLevel: z.number().nonnegative(),
  food: z.array(foodSlotStateSchema),
  selectedEquipmentSet: z.number().int().nonnegative(),
  equipment: z.array(equipmentSlotStateSchema),
  /** Present only while an enemy is instantiated. */
  /**
   * Which food slot the game will actually eat from.
   *
   * Not the equipment set. A reflex that indexed food by
   * `selectedEquipmentSet` read an empty slot while 33 chickens healing 90 each
   * sat in the next one, concluded there was nothing to eat, and let the
   * character die.
   */
  selectedFoodSlot: z.number().int().nonnegative(),
  enemy: z
    .object({
      monsterId: gameIdSchema,
      name: z.string(),
      hitpoints: z.number().nonnegative(),
      maxHitpoints: z.number().nonnegative(),
      maxHit: z.number().nonnegative(),
    })
    .nullable(),
});

/**
 * Shop purchases the character owns, and how many.
 *
 * Only the owned ones. The shop holds 434 entries and 18 were owned when this
 * was added, so carrying the whole catalogue in every heartbeat would be 400
 * lines of `owned: 0` to answer a question about a handful of items.
 *
 * It exists because a goal that *buys* something could not be expressed. The
 * `auto-eat` goal read `currency melvorD:GP >= 1000000`, the agent funded it,
 * the buy reflex spent it on Auto Eat - Tier I, and the goal went from 89% to
 * 3% -- because paying is what empties the balance. Worse, `fundingTarget` is
 * documented as expiring on success, so an unreachable success meant the sell
 * authorisation never expired and the reflex kept converting stock toward a
 * million forever.
 *
 * Defaulted so a mod build older than the service still validates.
 */
export const shopPurchaseStateSchema = z.object({
  id: gameIdSchema,
  owned: z.number().int().nonnegative(),
});

export const activeActionStateSchema = z
  .object({
    id: gameIdSchema,
    name: z.string(),
    /** True while the game reports this action as actively ticking. */
    isActive: z.boolean(),
    /**
     * Which recipes are selected, e.g. the tree being cut.
     *
     * Without this the policy tier cannot tell Oak from Willow: it sees only
     * that Woodcutting is running, so an objective to switch trees idles
     * forever. Woodcutting is a list because it alone runs several at once.
     *
     * Defaulted so a mod build older than the service still validates.
     */
    recipeIds: z.array(gameIdSchema).default([]),
  })
  .nullable();

export const currencyStateSchema = z.object({
  id: gameIdSchema,
  name: z.string(),
  amount: z.number().nonnegative(),
});

/**
 * A complete, validated observation of the game at one instant.
 *
 * Snapshots are only ever taken while the game is in its online loop. Anything
 * captured mid offline-catch-up describes a character that is about to change
 * underneath us.
 */
export const farmPlotStateSchema = z.object({
  id: gameIdSchema,
  state: z.enum(['locked', 'empty', 'growing', 'grown', 'dead']),
  plantedRecipeId: gameIdSchema.nullable(),
  plantedName: z.string().nullable(),
  categoryId: gameIdSchema,
  /**
   * Whether a locked plot's requirements and costs are met right now.
   *
   * A plot must be bought before it can ever hold a crop, and every plot in a
   * fresh save is locked. Without this the farm reads as "no empty plots" and
   * Farming is unreachable for the life of the character.
   */
  canUnlock: z.boolean(),
  /**
   * Percent compost applied. Without it a crop has only a 50% chance to grow,
   * which is ruinous when seeds arrive a few at a time.
   */
  compostLevel: z.number(),
});
export type FarmPlot = z.infer<typeof farmPlotStateSchema>;

/**
 * The town, when it exists.
 *
 * Township is the one system whose state cannot be inferred from skills and the
 * bank: its resources, storage and health live entirely inside it. Storage is
 * the number that decides everything — a full town discards what it produces,
 * so it earns nothing per hour however many buildings it has.
 */
export const townshipStateSchema = z.object({
  created: z.literal(true),
  level: z.number().int().nonnegative(),
  population: z.number().nonnegative(),
  happiness: z.number(),
  education: z.number(),
  healthPercent: z.number(),
  storageUsed: z.number().nonnegative(),
  storageMax: z.number().nonnegative(),
  worship: z.string(),
  season: z.string().nullable(),
  resources: z.array(
    z.object({
      id: gameIdSchema,
      name: z.string(),
      amount: z.number(),
      cap: z.number(),
    }),
  ),
  /**
   * What the town actually pays per hour, and the two multipliers that set it.
   *
   * `happiness` above has been in this schema since it existed and nothing has
   * ever read it as anything but a number to print. It is a percentage bonus on
   * population; population times health percent is Township XP per tick and is
   * also what the town taxes into the character's GP. So zero happiness is a
   * foregone multiplier — the town is not decaying, it is running at 1.0x — and
   * the only way to say that to the code rather than to a reader is to carry the
   * rates themselves.
   *
   * Optional and nullish so a mod build older than the service still validates:
   * the mod only reloads with the game, so every field added here has to be
   * survivable by a snapshot that predates it.
   */
  economy: z
    .object({
      basePopulation: z.number(),
      population: z.number(),
      workingPopulation: z.number(),
      happiness: z.number(),
      health: z.number(),
      xpPerHour: z.number().nonnegative(),
      gpPerHour: z.number().nonnegative(),
      ticksPerHour: z.number().positive(),
      /**
       * Why `gpPerHour` is what it is.
       *
       * `Township.taxRate` is `min(BASE_TAX_RATE + townshipTaxPerCitizen, 80)`
       * and `BASE_TAX_RATE` is 0, so the rate is entirely a modifier supplied by
       * a building — there is no slider and nothing to set. A town with no such
       * building earns exactly zero GP however many citizens it has, and saying
       * so is the difference between a correct number and a useful one.
       *
       * Optional for the same reason the block around it is: a mod build older
       * than this field reports none.
       */
      tax: z
        .object({
          rate: z.number().nonnegative(),
          unbuiltSource: z
            .object({
              buildingId: gameIdSchema,
              name: z.string(),
              tier: z.number().int().positive(),
              perBuilding: z.number(),
              requiresTownshipLevel: z.number().nonnegative(),
              requiresPopulation: z.number().nonnegative(),
            })
            .nullable(),
        })
        .optional(),
      /** Set when the transcribed population formula disagreed with the game. */
      modelMismatch: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type TownshipState = z.infer<typeof townshipStateSchema>;

export const stateSnapshotSchema = z.object({
  /** Milliseconds since epoch, from the wall clock at capture. */
  capturedAt: z.number().int().positive(),
  /** Global `gameVersion`, e.g. "v1.3.1". Drives the stale-dump refusal. */
  gameVersion: z.string().min(1),
  characterName: z.string(),
  gamemodeId: gameIdSchema,
  currentRealmId: gameIdSchema,
  /** True while the game is resolving offline progress. Never act on this. */
  isOfflineLoop: z.boolean(),
  totalLevel: z.number().int().nonnegative(),
  completionPercent: z.number().nonnegative(),
  currencies: z.array(currencyStateSchema),
  skills: z.array(skillStateSchema),
  bank: bankStateSchema,
  activeAction: activeActionStateSchema,
  combat: combatStateSchema,
  /**
   * Farming plots. Present in the snapshot because farming is decided entirely
   * from state — which plots are grown, which are empty — and the policy tier
   * is pure, so it cannot read the game itself.
   */
  farm: z.array(farmPlotStateSchema),
  /**
   * Null until the town has been created, which is a one-time human decision.
   *
   * Defaulted rather than required so a mod build older than the service still
   * validates: the two halves are deployed independently — the service reloads
   * on save, the mod only when the game is reloaded — so every snapshot field
   * added from here on has to be optional or it breaks the running game.
   */
  township: townshipStateSchema.nullable().default(null),
  /** Owned shop purchases only; see {@link shopPurchaseStateSchema}. */
  shopPurchases: z.array(shopPurchaseStateSchema).default([]),
});
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

/** The one scalar quality metric: progress per real-time hour. */
export const qualitySampleSchema = z.object({
  at: z.number().int().positive(),
  totalLevel: z.number().int().nonnegative(),
  completionPercent: z.number().nonnegative(),
  gp: z.number().nonnegative(),
  /**
   * What was being done, and how far that skill had got.
   *
   * Without these a sample records that progress happened, not what produced
   * it -- so there was no way, even in principle, to say "Crystal advertised
   * 120,000 GP/h and delivered 10,800". Every rate error this session had to be
   * found by hand, one at a time, by an operator noticing a number looked
   * wrong.
   *
   * Optional because samples predate the fields and a sample missing them is
   * still a valid measure of total progress.
   */
  activeSkillId: z.string().optional(),
  activeSkillXp: z.number().nonnegative().optional(),
  /**
   * The recipe being worked, not just the skill.
   *
   * Matching a realised rate to a claim on skill alone compares against
   * whichever of that skill's candidates happens to be listed first. Live, that
   * reported Mining Rune Essence as "8% of the 111,429 xp/h advertised" when
   * Rune Essence advertises about 6,000 -- the measurement was right and the
   * claim it was held against belonged to a different recipe.
   */
  activeRecipeId: z.string().optional(),
});
export type QualitySample = z.infer<typeof qualitySampleSchema>;

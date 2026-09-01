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
});
export type StateSnapshot = z.infer<typeof stateSnapshotSchema>;

/** The one scalar quality metric: progress per real-time hour. */
export const qualitySampleSchema = z.object({
  at: z.number().int().positive(),
  totalLevel: z.number().int().nonnegative(),
  completionPercent: z.number().nonnegative(),
  gp: z.number().nonnegative(),
});
export type QualitySample = z.infer<typeof qualitySampleSchema>;

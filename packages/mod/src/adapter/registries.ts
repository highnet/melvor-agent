import type { KnowledgeDump } from '@melvor-agent/knowledge';
import {
  noteSwallowed,
  recordFallback,
  safeBoolean,
  safeList,
  safeNumber,
  safeText,
} from './safe.js';
import { gpCostOf } from './shop.js';

/**
 * Exports the game's own data registries.
 *
 * These registries are ground truth: they are correct for the exact installed
 * version, which the wiki is not. Everything numeric the planner ever sees
 * originates here. The dump is stamped with `gameVersion` so a game update
 * makes the staleness detectable rather than silent.
 *
 * Sections are added when a question could not be answered without them, and
 * not before: a dump nobody reads is just a large file that goes stale. The
 * item table is the one place that argument was made backwards — `game.items`
 * is thousands of entries, so it was left out, and every item the agent picked
 * up rather than produced then had no price at all.
 *
 * @returns A structured dump ready to be serialised to `knowledge/dump.json`.
 */
/**
 * Reading game data that may not be there, without inventing what is.
 *
 * A dump that throws produces nothing; a dump that guesses produces something
 * worse. These return a stated empty value so a missing field is visibly empty
 * rather than plausibly wrong — the distinction that made "no monster drops
 * seeds" indistinguishable from "monster drops were never dumped".
 *
 * The four helpers that used to live here are now `adapter/safe.ts`, shared
 * with the rest of the adapter and counting what they swallow. There were two
 * different `safeNumber`s in this codebase with different signatures, which is
 * how "the adapter reports its failures" became something a reader could
 * believe while about a hundred bare catches said nothing at all.
 */

/**
 * Cuts an oversized section to a limit, and says that it did.
 *
 * Three sections were sliced with a bare `.slice(0, n)` and no record of it,
 * which is how one file came to hold two disagreeing answers to the same
 * question: `herbloreRecipes` reported twelve recipes while `skillRecipes`
 * reported seventy-two for the same skill, and nothing in either said one had
 * been cut. A reader has no way to tell a short list from a truncated one.
 *
 * Those slices are gone. This remains for the one section that is genuinely
 * unbounded — every item in the game — so that a cap, if it ever bites, is a
 * recorded fact rather than a silent one.
 *
 * @param items - The full list.
 * @param limit - Maximum entries to keep.
 * @returns The kept entries, the count they were cut at (null when uncut), and
 *   how many there were to begin with.
 */
export function capSection<T>(
  items: readonly T[],
  limit: number,
): { items: T[]; truncatedAt: number | null; totalAvailable: number } {
  if (items.length <= limit) {
    return { items: [...items], truncatedAt: null, totalAvailable: items.length };
  }
  return { items: items.slice(0, limit), truncatedAt: limit, totalAvailable: items.length };
}

/**
 * How many items the flat item table will carry before it cuts.
 *
 * Chosen to sit above every item the base game and its expansions register, so
 * in practice it never bites; it exists so that a future content drop produces
 * a recorded truncation instead of a quietly shorter table.
 */
const ITEM_TABLE_LIMIT = 5000;

/**
 * Describes a requirement list without pretending to know every shape.
 *
 * Flattening an unrecognised requirement to its bare type name is what made
 * the Abyssal realm question unanswerable from the dump: `DungeonCompletion`
 * says a dungeon gates the content but not *which* dungeon, which is the only
 * part anyone needs. So the two shapes that actually gate progression are
 * spelled out, `isMet` is recorded so a satisfied gate is visibly satisfied,
 * and anything else still appears by type rather than being dropped.
 */
function safeRequirementTypes(read: () => readonly AnyRequirement[]): string[] {
  try {
    return read().map((requirement) => {
      const met = safeBoolean('registries.requirementIsMet', () => requirement.isMet(), false)
        ? ' (met)'
        : '';

      if (requirement.type === 'SkillLevel') {
        return `${requirement.skill.name} ${requirement.level}${met}`;
      }
      if (requirement.type === 'DungeonCompletion') {
        return `Complete ${requirement.dungeon.name} x${requirement.count}${met}`;
      }
      return `${requirement.type}${met}`;
    });
  } catch (error) {
    noteSwallowed('registries.safeRequirementTypes', error);
    return [];
  }
}

export function dumpRegistries(): KnowledgeDump {
  /**
   * Cuts made while building this dump.
   *
   * Filled in by the sections below as they evaluate, which is why
   * `truncations` is the *last* key of the returned literal — object literal
   * properties evaluate in source order, so anything placed after it would
   * report its cut into an array that has already been read.
   */
  const truncations: { section: string; truncatedAt: number; totalAvailable: number }[] = [];

  function take<T>(section: string, items: readonly T[], limit: number): T[] {
    const cut = capSection(items, limit);
    if (cut.truncatedAt !== null) {
      truncations.push({
        section,
        truncatedAt: cut.truncatedAt,
        totalAvailable: cut.totalAvailable,
      });
    }
    return cut.items;
  }

  return {
    gameVersion: gameVersion,
    capturedAt: Date.now(),
    gamemodeId: game.currentGamemode.id,
    // `isUnlocked` and `unlockRequirements` (realms.d.ts:15,23) are the whole
    // reason to dump realms at all: Corruption and Harvesting sit behind the
    // Abyssal realm, and without these two fields the dump could say the realm
    // exists but not one word about how to open it. Requirements are flattened
    // to their type names, matching how skill requirements are recorded below.
    realms: game.realms.allObjects.map((realm) => ({
      id: realm.id,
      name: realm.name,
      unlocked: safeBoolean('registries.realmIsUnlocked', () => realm.isUnlocked, false),
      requirements: safeRequirementTypes(() => realm.unlockRequirements),
    })),
    skills: game.skills.allObjects.map((skill) => ({
      id: skill.id,
      name: skill.name,
      isCombat: skill.isCombat,
      hasMastery: 'getMasteryPoolXP' in skill,
    })),
    currencies: game.currencies.allObjects.map((currency) => ({
      id: currency.id,
      name: currency.name,
    })),
    woodcuttingTrees: game.woodcutting.actions.allObjects.map((tree) => ({
      id: tree.id,
      name: tree.name,
      level: tree.level,
      baseInterval: tree.baseInterval,
      baseExperience: tree.baseExperience,
      productId: tree.product.id,
      productName: tree.product.name,
      productSellsFor: tree.product.sellsFor.quantity,
      productSellsForCurrencyId: tree.product.sellsFor.currency.id,
    })),
    // Mining rocks, with the numbers that decide what mining actually pays.
    //
    // A rock is not a tree: it holds a fixed amount of HP, one swing takes one
    // HP, and when it empties the rock is gone for `baseRespawnInterval`. Price
    // only the swing and Crystal advertises 120,000 GP/h against about 10,800
    // realised. The correction is arithmetic given `maxHP` and the respawn —
    // and because neither had ever been dumped, it had to be measured by hand
    // against a stopwatch instead.
    //
    // `maxHP` comes from `getRockMaxHP` (rockTicking.d.ts:180) rather than the
    // `maxHP` field, for the same reason `miningIntervalFor` uses it: mastery
    // raises how many swings a rock takes before it empties, so the field would
    // freeze every rock at its unmastered value and make the correction wrong
    // in a second way.
    //
    // `hasPassiveRegen` (:70) is the exception that breaks the whole model —
    // gem veins refill on a timer while nothing is mining them — and it is
    // useless without the rate that refill happens at, so the skill-wide
    // `passiveRegenInterval` (:108) is carried on each row to keep the row
    // self-contained. `baseQuantity` (:67) is ore per swing, which is not
    // always one and was silently assumed to be.
    miningRocks: (() => {
      try {
        return game.mining.actions.allObjects.map((rock) => ({
          id: rock.id,
          name: rock.name,
          level: rock.level,
          baseExperience: safeNumber('registries.1', () => rock.baseExperience, 0),
          maxHP: safeNumber('registries.2', () => game.mining.getRockMaxHP(rock), 0),
          baseRespawnInterval: safeNumber('registries.3', () => rock.baseRespawnInterval, 0),
          hasPassiveRegen: safeBoolean('registries.4', () => rock.hasPassiveRegen, false),
          passiveRegenInterval: safeNumber(
            'registries.5',
            () => game.mining.passiveRegenInterval,
            0,
          ),
          baseQuantity: safeNumber('registries.6', () => rock.baseQuantity, 1),
          productId: safeText('registries.7', () => rock.product.id),
          productName: safeText('registries.8', () => rock.product.name),
          productSellsFor: safeNumber('registries.9', () => rock.product.sellsFor.quantity, 0),
          productSellsForCurrencyId: safeText(
            'registries.10',
            () => rock.product.sellsFor.currency.id,
          ),
        }));
      } catch {
        return [];
      }
    })(),
    // Herblore recipes and their exact inputs.
    //
    // The only level-1 recipe, Bird Nest Potion I, was read off a screenshot as
    // "1 Herb + 2 seeds" from two small icons. Reading pictures is how five
    // conclusions went wrong today, and this one decides what the whole
    // Herblore chain actually needs, so it belongs in data.
    //
    // Dumped whole. It used to stop at twelve, so this section reported twelve
    // Herblore recipes while `skillRecipes` reported seventy-two for the same
    // skill — one file holding two answers to one question, with nothing saying
    // which of them had been cut. Duplicating the costs across two sections is
    // a far smaller problem than that.
    herbloreRecipes: (() => {
      try {
        return game.herblore.actions.allObjects.map((recipe) => ({
          id: recipe.id,
          name: recipe.name,
          level: recipe.level,
          costs: recipe.itemCosts.map((cost) => ({
            itemId: cost.item.id,
            itemName: cost.item.name,
            quantity: cost.quantity,
          })),
        }));
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
    })(),
    // Rare drops per skill — the things a skill yields that are not its
    // product.
    //
    // Added because the whole Herblore route rests on one of them. Farming is
    // blocked on seeds, seeds come from Bird Nests, and Bird Nests were
    // asserted to come from Woodcutting on recollection alone: the dump records
    // only each tree's primary product, so there was no way to check. The same
    // shape of gap as the Summoning recipes, and the same fix — dump it and
    // stop guessing.
    //
    // `chance` is left as the raw object the game holds rather than flattened,
    // because its shape varies by drop type and inventing a normalisation would
    // be exactly the guesswork this removes.
    //
    // Every drop of every skill, no longer six per skill and sixty overall.
    // Those two slices were invisible in the output, so a skill whose seventh
    // rare drop was the one being looked for read as a skill that does not drop
    // it — the same failure mode as an undumped section, with the added cost of
    // looking answered.
    skillRareDrops: (() => {
      const out: {
        skillId: string;
        skillName: string;
        itemId: string;
        itemName: string;
        quantity: number;
      }[] = [];
      try {
        for (const skill of game.skills.allObjects) {
          const drops = (skill as { rareDrops?: unknown }).rareDrops;
          if (!Array.isArray(drops)) continue;
          for (const drop of drops) {
            try {
              out.push({
                skillId: skill.id,
                skillName: skill.name,
                itemId: drop.item.id,
                itemName: drop.item.name,
                quantity: drop.quantity,
              });
            } catch (error) {
              noteSwallowed('registries.dumpRegistries', error);
              // A drop that cannot describe itself is skipped, not invented.
            }
          }
        }
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
      return out;
    })(),
    // Summoning tablet recipes.
    //
    // Added because the planner was reasoning about Summoning by guesswork: the
    // skill sits at level 1, never appears as a candidate, and nothing in the
    // dump said why. Buying 69 shards on an assumption did not unblock it, and
    // without the recipes there was no way to tell whether the missing piece
    // was the shard colour, the quantity, or the secondary.
    //
    // `nonShardItemCosts` is the part worth carrying: a familiar accepts one of
    // *several* secondaries, and that "one of" is exactly the shape a planner
    // cannot infer from a flat cost list.
    summoningRecipes: (() => {
      try {
        return game.summoning.actions.allObjects.map((recipe) => ({
          id: recipe.id,
          name: recipe.name,
          level: recipe.level,
          productId: recipe.product.id,
          shardCosts: recipe.itemCosts.map((cost) => ({
            itemId: cost.item.id,
            itemName: cost.item.name,
            quantity: cost.quantity,
          })),
          nonShardOptions: recipe.nonShardItemCosts.map((item) => ({
            itemId: item.id,
            itemName: item.name,
          })),
        }));
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
    })(),
    // Live plot state, as the raw enum the game holds.
    //
    // The harvest reflex has never once fired. Two plots have read "Growing:
    // Potato Seeds, Time Left: About 0 mins" for the best part of an hour,
    // including ten minutes with the game untouched, and still offer Destroy
    // rather than Harvest — so the crops are not reaching the grown state at
    // all. Whether that is the growth timer being lost across a mod reload or
    // something else is unresolved, and the string mapping the adapter uses
    // hides the raw value that would settle it.
    farmingPlotStates: (() => {
      try {
        return game.farming.plots.allObjects.map((plot) => ({
          id: plot.id,
          rawState: plot.state as number,
          growthTimeSeconds: plot.growthTime,
          compostLevel: plot.compostLevel,
          plantedRecipeId: plot.plantedRecipe?.id ?? null,
          hasGrowthTimer: game.farming.growthTimerMap.has(plot),
        }));
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
    })(),
    // Farming recipes with the level that gates each one.
    //
    // Which seeds a character can actually plant decides how fast Farming
    // moves, and Farming gates the Herb plot that Herblore needs. The seed
    // dropdown lists every allotment seed with its quantity whether or not the
    // level is met, so it cannot answer this — 32 Ancient Corn and 30 Ancient
    // Carrot sat in the bank looking plantable while the reflex, correctly,
    // ignored them.
    farmingRecipes: (() => {
      try {
        return game.farming.actions.allObjects.map((recipe) => ({
          id: recipe.id,
          name: recipe.name,
          level: recipe.level,
          categoryId: recipe.category.id,
          seedItemId: recipe.seedCost.item.id,
          seedCost: recipe.seedCost.quantity,
        }));
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
    })(),
    // Biomes and whether they are open yet.
    //
    // The Herb-producing building is tier 1, so nothing about it is far away —
    // it is simply confined to biomes the town has not unlocked. That makes the
    // biome, not the building, the thing standing between the town and
    // Herblore, and it was invisible until now.
    townshipBiomes: (() => {
      try {
        return game.township.biomes.allObjects.map((biome) => ({
          id: biome.id,
          name: biome.name,
          tier: biome.tier,
          unlocked: game.township.isBiomeUnlocked(biome),
          // A SkillLevel requirement is the interesting one and the only shape
          // worth spelling out; anything else is named by its type so an
          // unexpected gate is still visible rather than silently dropped.
          requirements: biome.requirements.map((requirement) =>
            requirement.type === 'SkillLevel'
              ? `${requirement.skill.name} ${requirement.level}`
              : requirement.type,
          ),
        }));
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
    })(),
    // Every Township building, with the tier that gates it and what it makes.
    //
    // The town produces no Herbs, which is what pins its health at 0% and what
    // Herblore is behind — and nothing in the agent's view said which building
    // would produce them or how far away it was. Tier decides the Township
    // level and population needed, so this answers "what has to happen for
    // Herblore" in one read.
    townshipBuildings: (() => {
      try {
        return game.township.buildings.allObjects.map((building) => ({
          id: building.id,
          name: building.name,
          tier: building.tier,
          biomes: building.biomes.map((biome) => biome.name),
          // Summed across biomes: the same building yields differently by
          // biome, and what matters here is only whether it makes the resource.
          produces: [
            ...new Set(
              [...building.provides.values()].flatMap((provides) =>
                [...provides.resources.entries()]
                  .filter(([, amount]) => amount > 0)
                  .map(([resource]) => resource.name),
              ),
            ),
          ],
        }));
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
    })(),
    // What the town will accept from the bank.
    //
    // The mirror of the trade-back list, and the one that matters when the town
    // is short: it is short of Wood while the character holds 1,412 Normal
    // Logs, and nothing said whether those two facts connect.
    townshipTradesToTown: (() => {
      try {
        return game.township.resources.allObjects.flatMap((resource) =>
          game.township.getResourceItemConversionsToTownship(resource).map((conversion) => ({
            resourceId: resource.id,
            resourceName: resource.name,
            itemId: conversion.item.id,
            itemName: conversion.item.name,
          })),
        );
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        return [];
      }
    })(),
    // What the town will trade back for its resources.
    //
    // `readTraderCandidates` deliberately offers only the bank-to-town
    // direction, on the grounds that a town needs its resources more than the
    // bank needs another log. That is right for logs and wrong for anything the
    // town can produce that nothing else can — and Herb Boxes, which hold
    // finished herbs, decide whether Herblore is reachable without Farming.
    townshipTradesFromTown: (() => {
      try {
        return game.township.resources.allObjects.flatMap((resource) =>
          game.township.getResourceItemConversionsFromTownship(resource).map((conversion) => ({
            resourceId: resource.id,
            resourceName: resource.name,
            itemId: conversion.item.id,
            itemName: conversion.item.name,
          })),
        );
      } catch (error) {
        noteSwallowed('registries.dumpRegistries', error);
        // A save with no town reports nothing rather than failing the dump.
        return [];
      }
    })(),
    // What is actually inside a container. Herblore is the last untrained skill
    // in scope and needs a herb seed; every guess so far about where those come
    // from has been wrong, and a drop table settles it in one read instead of
    // hours of farming toward a source that may not exist.
    openableItems: game.items.allObjects
      .filter((item): item is OpenableItem => item instanceof OpenableItem)
      .map((item) => ({
        id: item.id,
        name: item.name,
        contents: item.dropTable.drops.map((drop) => drop.item.name),
      })),
    // Thieving NPCs carry the level gates that decide whether a whole skill
    // chain is reachable. Herblore waits on herb seeds, herb seeds come off a
    // specific NPC, and with only the *nearest* locked action reported there
    // was no way to see how far away that NPC was without grinding toward it
    // and watching. A level in a dump answers it in one read.
    thievingNpcs: game.thieving.actions.allObjects.map((npc) => ({
      id: npc.id,
      name: npc.name,
      level: npc.level,
      maxHit: npc.maxHit,
      // Names replaced by the table the game actually rolls. A list of names
      // says a drop is possible and nothing else: not how many come out, and
      // not how often against the rest of the table.
      lootDrops: dumpDropTable(npc.lootTable.drops),
      lootTotalWeight: safeNumber('registries.11', () => npc.lootTable.totalWeight, 0),
      // The guaranteed drop, which the table does not include and which was
      // invisible for the same reason monster loot was.
      uniqueDrop: safeText('registries.12', () => npc.uniqueDrop?.item.name ?? ''),
      uniqueDropQuantity: safeNumber('registries.13', () => npc.uniqueDrop?.quantity ?? 0, 0),
      // Coins are not items, so they are in no loot table and were in no
      // section — which left the dump describing the agent's largest single
      // income as yielding nothing at all. `currencyDrops` (thieving2.d.ts:36)
      // is where a pickpocket's actual pay lives.
      currencyDrops: dumpCurrencyQuantities(npc.currencyDrops),
    })),
    monsters: game.monsters.allObjects.map((monster) => ({
      id: monster.id,
      name: monster.name,
      combatLevel: monster.combatLevel,
      // Deliberately absent: maxHit. A Monster in the registry is data with no
      // computed max hit — only an instantiated Enemy has one. Dumping a
      // plausible-looking number here would poison the Phase 2 combat gate.
      //
      // Loot, by contrast, was absent for no reason at all. Thieving NPCs have
      // had their drop tables dumped since the section was written, and the
      // question "what drops the seed Farming is blocked on" could be answered
      // for Thieving and not for combat — so the answer for combat was "the
      // data is not there", which reads exactly like "nothing drops it".
      //
      // `lootChance` is carried alongside the table because presence is not a
      // rate: a seed on a table that rolls one kill in fifty is not comparable
      // to a Bird Nest, and comparing them was the entire point of asking.
      lootChance: safeNumber('registries.14', () => monster.lootChance, 0),
      // The table itself, because `lootChance` alone is not a rate and reading
      // it as one produced a wrong claim within minutes of the table being
      // dumped: "Golbin drops Garum Seeds at 100% loot chance" is two facts
      // welded into a falsehood. `lootChance` is the chance the table rolls *at
      // all*; which item comes out is then weight/totalWeight, and how many
      // come out is min/max. A seed on a 1-in-40 slot of a table that always
      // rolls is not a seed every kill.
      //
      // This replaces the parallel `lootTable`/`lootWeights` name lists. The
      // same table split across two string arrays is how the two halves came to
      // be read separately in the first place, and neither carried a quantity.
      lootTotalWeight: safeNumber('registries.15', () => monster.lootTable.totalWeight, 0),
      lootDrops: dumpDropTable(monster.lootTable.drops),
      // What a kill pays in coin. The dump priced every fight at the sale value
      // of its items and nothing else, so a monster that drops GP and no items
      // read as worth killing for exactly zero. `currencyDrops`
      // (monsters.d.ts:112) is a min/max range, not a fixed amount.
      currencyDrops: dumpCurrencyRange(monster.currencyDrops),
      bones: safeText('registries.16', () => monster.bones?.item.name ?? ''),
      // Stats, so a fight can be assessed as something other than one number.
      //
      // `combatLevel` alone cannot say whether a monster is dangerous to *this*
      // character: it blends offence and defence into a single figure, and the
      // question that actually matters — can we out-damage its Hitpoints before
      // its attack type beats our gear — needs the parts. `levels`
      // (monsters.d.ts:103) and `attackType` (:106) are the game's own answers.
      //
      // Still deliberately absent: maxHit, for the reason stated above. Levels
      // are stored data; a max hit is computed on an instantiated Enemy, and
      // reconstructing one here would be an invention dressed as a reading.
      levels: {
        hitpoints: safeNumber('registries.17', () => monster.levels.Hitpoints, 0),
        attack: safeNumber('registries.18', () => monster.levels.Attack, 0),
        strength: safeNumber('registries.19', () => monster.levels.Strength, 0),
        defence: safeNumber('registries.20', () => monster.levels.Defence, 0),
        ranged: safeNumber('registries.21', () => monster.levels.Ranged, 0),
        magic: safeNumber('registries.22', () => monster.levels.Magic, 0),
        corruption: safeNumber('registries.23', () => monster.levels.Corruption, 0),
      },
      attackType: safeText('registries.24', () => monster.attackType),
      // A boss cannot be farmed the way a normal monster can, and a monster
      // that `canSlayer` (:118) is the only kind a Slayer task can ever ask
      // for — which is exactly the join an accepted task needs to become a
      // fight candidate.
      isBoss: safeBoolean('registries.25', () => monster.isBoss, false),
      canSlayer: safeBoolean('registries.26', () => monster.canSlayer, false),
    })),
    dungeons: game.dungeons.allObjects.map((dungeon) => ({
      id: dungeon.id,
      name: dungeon.name,
      monsterIds: dungeon.monsters.map((monster) => monster.id),
      realmId: dungeon.realm.id,
    })),
    // Cost, ownership and gate, not just the name.
    //
    // Without these the dump can list eleven pickaxes and settle nothing: the
    // candidate list only ever shows *affordable* purchases, so a tool missing
    // from it might be already owned or might be ten times our GP, and those
    // want opposite responses. The same silence around realms produced an
    // invented prerequisite an hour earlier. Requirements are flattened the way
    // realm and biome requirements are.
    skillRecipes: dumpSkillRecipes(),
    shopPurchases: game.shop.purchases.allObjects.map((purchase) => ({
      id: purchase.id,
      name: purchase.name,
      allowQuantityPurchase: purchase.allowQuantityPurchase,
      gpCost: safeNumber('registries.purchaseGpCost', () => gpCostOf(purchase), 0),
      // 143 purchases priced in another currency dumped gpCost 0, which reads
      // as free. The full cost list says what they actually take.
      costs: safeList('registries.purchaseCosts', () =>
        game.shop
          .getPurchaseCosts(purchase, 1)
          .getCurrencyQuantityArray()
          .map((entry) => `${entry.quantity} ${entry.currency.name}`),
      ),
      owned: safeNumber('registries.purchaseCount', () => game.shop.getPurchaseCount(purchase), 0),
      atBuyLimit: safeBoolean(
        'registries.purchaseAtBuyLimit',
        () => game.shop.isPurchaseAtBuyLimit(purchase),
        false,
      ),
      requirements: safeRequirementTypes(() => purchase.purchaseRequirements),
      // What the purchase actually does, in the game's own words.
      //
      // Without it the dump can price an upgrade and say nothing about whether
      // it is worth the price. Asked why the agent had not bought the 200,000
      // GP Adamant Pickaxe, the payback could only be bracketed -- 11 hours at
      // a 30% interval cut, 39 at 10% -- because nothing recorded which it is.
      // `describePlain` (statProvider.d.ts:34) is the game's own summary of the
      // modifiers a purchase grants.
      effect: safeText(
        'registries.purchaseEffect',
        () => purchase.contains.stats?.describePlain() ?? '',
      ),
    })),
    // Every item, flat.
    //
    // Sale value existed only where some recipe happened to produce the item,
    // so anything the agent picked up rather than made — a drop, a container's
    // contents, a shop good, a bone — was unpriced, and an unpriced input
    // defaults to zero in exactly the wrong direction: Leather armour read as
    // 90,000 GP/h until the 100 GP the Leather costs was found by hand.
    //
    // Scalar-only and deliberately so. This is thousands of rows; one nested
    // object per row is what makes a reference too large to read. `category`
    // and `type` (item.d.ts:43-44) are the game's own grouping, `sellsFor`
    // (:58) is a currency quantity so the currency is named rather than
    // assumed, and `healsFor` (:264) is on FoodItem alone — zero everywhere
    // else, which is the honest reading for an item that heals nothing.
    items: take('items', game.items.allObjects, ITEM_TABLE_LIMIT).map((item) => ({
      id: item.id,
      name: item.name,
      category: safeText('registries.27', () => item.category),
      type: safeText('registries.28', () => item.type),
      sellsFor: safeNumber('registries.29', () => item.sellsFor.quantity, 0),
      sellsForCurrencyId: safeText('registries.30', () => item.sellsFor.currency.id),
      healsFor: safeNumber(
        'registries.31',
        () => (item instanceof FoodItem ? item.healsFor : 0),
        0,
      ),
    })),
    // Last, and it has to stay last: see the declaration above.
    truncations,
  };
}

/**
 * Every skill recipe with its inputs, its output and what that output sells for.
 *
 * The section that makes a production chain arithmetic rather than a guess.
 * Asked whether smithing platebodies beats mining gems, this repo could not
 * answer: the dump had no smithing, mining, crafting, fishing, cooking,
 * fletching or runecrafting section at all, and `sellsFor` appeared on exactly
 * thirty-four items -- the woodcutting logs. Not one multi-step chain in the
 * game could be scored, so every ranking defaulted to the single action with
 * the biggest advertised number, which is how an inflated Crystal rate went
 * unchallenged for an afternoon.
 *
 * Deliberately one generic pass over `game.skills` rather than nine bespoke
 * sections. The shapes are already shared -- `BasicSkillRecipe` gives level and
 * XP, `ArtisanSkillRecipe` adds `itemCosts` (artisanSkill.d.ts:82), and
 * `SingleProductArtisanSkillRecipe` adds `product` and `baseQuantity`
 * (:110-111) -- so a per-skill dumper would be nine copies of one function,
 * and the tenth skill would be forgotten.
 *
 * Costs and products are both recorded because a chain needs both ends: the
 * value of a platebody is meaningless without the five bars it consumes, and
 * the bars are meaningless without the ore. `baseInterval` is the skill's, not
 * the recipe's, and is the honest thing available -- see `miningIntervalFor`
 * for why even that understates the real cost of a depleting resource.
 *
 * Three skills do not fit the single-product shape, and forcing them into it is
 * what left 131 rows with a blank `productId` and a `productSellsFor` of 0 --
 * reading exactly like an Agility obstacle, which genuinely produces no item.
 * Each gets a field that says what the thing actually is rather than a product
 * id that says something false:
 *
 * - Alt Magic produces `AltMagicProductionID | AnyItem` -- an item on some
 *   spells and a currency sentinel on others -- and pays a `productionRatio` of
 *   it. It also charges a `specialCost` naming a *class* of item, which no
 *   cost list can hold. `altMagicProduction`, `altMagicSpecialCost`.
 * - Herblore makes four potions off one ingredient list, gated by mastery
 *   tier. Four tiers are not one product. `tieredProducts`.
 * - Firemaking's products are chance-gated, and its input is the log it burns
 *   rather than an `itemCosts` entry. `chanceProducts`, and the log recorded
 *   as the cost it is.
 */
function dumpSkillRecipes(): {
  skillId: string;
  skillName: string;
  baseInterval: number;
  recipeId: string;
  name: string;
  level: number;
  baseExperience: number;
  baseAbyssalExperience: number;
  abyssalLevel: number;
  realmId: string;
  recipeInterval: number;
  itemCosts: { itemId: string; name: string; quantity: number }[];
  buildCosts: { itemId: string; name: string; quantity: number }[];
  buildCurrencyCosts: { currencyId: string; currencyName: string; quantity: number }[];
  runeCosts: { itemId: string; name: string; quantity: number }[];
  fixedItemCosts: { itemId: string; name: string; quantity: number }[];
  currencyRewards: { currencyId: string; currencyName: string; quantity: number }[];
  itemRewards: { itemId: string; name: string; quantity: number }[];
  productId: string;
  productName: string;
  baseQuantity: number;
  productSellsFor: number;
  productSellsForCurrencyId: string;
  tieredProducts: TieredProduct[];
  chanceProducts: ChanceProduct[];
  altMagicProduction: AltMagicProduction | null;
  altMagicSpecialCost: AltMagicSpecialCost | null;
}[] {
  const out: ReturnType<typeof dumpSkillRecipes> = [];

  for (const skill of game.skills.allObjects) {
    const withActions = skill as unknown as {
      actions?: { allObjects: unknown[] };
      baseInterval?: number;
    };

    let recipes: unknown[];
    try {
      recipes = withActions.actions?.allObjects ?? [];
    } catch (error) {
      noteSwallowed('registries.dumpSkillRecipes', error);
      continue;
    }

    const baseInterval = safeNumber(
      'registries.skillBaseInterval',
      () => withActions.baseInterval ?? 0,
      0,
    );

    // Agility is the one skill whose `itemCosts` are not consumption.
    //
    // `BaseAgilityObject.itemCosts` (agility.d.ts:23) is what building an
    // obstacle costs once; the obstacle is then run for as long as it stands.
    // Recorded as `itemCosts` — a field this file documents as "inputs a recipe
    // consumes" — it charges every lap the price of construction, which is a
    // profit calculation wrong by however many laps the course is run.
    //
    // Identified by object identity against `game.agility` rather than by id
    // string or class name, because that cannot be wrong about which skill it
    // matched.
    const costsAreOneTime = (skill as unknown) === (game.agility as unknown);

    // Three skills store their product, and two of them their cost, under names
    // the generic pass above does not read, so 131 rows dumped an empty
    // `productId` and a `productSellsFor` of 0 — indistinguishable from a
    // recipe that genuinely yields nothing, which is what an Agility obstacle
    // is. Each is matched by object identity against the skill on `game` rather
    // than by id string: `melvorD:AltMagic` is not a registered id and looking
    // Alt Magic up under it returned undefined for the life of this repo.
    const isAltMagic = (skill as unknown) === (game.altMagic as unknown);
    const isHerblore = (skill as unknown) === (game.herblore as unknown);
    const isFiremaking = (skill as unknown) === (game.firemaking as unknown);

    // `Herblore.tierMasteryLevels` (herblore.d.ts:78) is static, and read off
    // the live instance's constructor rather than off a global `Herblore` so it
    // cannot resolve to a different class than the one the recipes came from.
    const tierMasteryLevels = isHerblore
      ? safeList(
          'registries.herbloreTierMasteryLevels',
          () =>
            (skill.constructor as unknown as { tierMasteryLevels?: number[] }).tierMasteryLevels ??
            [],
        )
      : [];

    for (const raw of recipes) {
      const recipe = raw as {
        id?: string;
        name?: string;
        level?: number;
        baseExperience?: number;
        baseAbyssalExperience?: number;
        abyssalLevel?: number;
        realm?: { id: string };
        itemCosts?: { item: { id: string; name: string }; quantity: number }[];
        runesRequired?: { item: { id: string; name: string }; quantity: number }[];
        fixedItemCosts?: { item: { id: string; name: string }; quantity: number }[];
        baseInterval?: number;
        currencyCosts?: { currency: { id: string; name: string }; quantity: number }[];
        currencyRewards?: { currency: { id: string; name: string }; quantity: number }[];
        itemRewards?: { item: { id: string; name: string }; quantity: number }[];
        product?: {
          id: string;
          name: string;
          sellsFor?: { quantity: number; currency: { id: string } };
        };
        baseQuantity?: number;
        // The three shapes `product` cannot hold. Optional on this type because
        // one loop walks every skill's recipes; each is undefined on all but
        // the one skill that has it, which is what the dumpers below check.
        potions?: readonly (ProductItem & {
          tier?: number;
          charges?: number;
          action?: { id: string; name: string };
        })[];
        log?: { id: string; name: string };
        primaryProducts?: readonly ProductItem[];
        secondaryProducts?: readonly ProductItem[];
        produces?: unknown;
        productionRatio?: number;
        specialCost?: { type?: unknown; quantity?: number; currency?: { id: string } };
      };

      try {
        if (recipe.id === undefined) continue;

        out.push({
          skillId: skill.id,
          skillName: skill.name,
          baseInterval,
          recipeId: recipe.id,
          name: safeText('registries.recipeName', () => recipe.name ?? ''),
          level: safeNumber('registries.recipeLevel', () => recipe.level ?? 0, 0),
          baseExperience: safeNumber(
            'registries.recipeBaseExperience',
            () => recipe.baseExperience ?? 0,
            0,
          ),
          // Into the Abyss content earns on a separate track, so 384 recipes
          // dumped `baseExperience: 0` and were indistinguishable from a
          // reachable level-1 action that pays nothing.
          baseAbyssalExperience: safeNumber(
            'registries.32',
            () => recipe.baseAbyssalExperience ?? 0,
            0,
          ),
          abyssalLevel: safeNumber('registries.33', () => recipe.abyssalLevel ?? 0, 0),
          realmId: safeText('registries.34', () => recipe.realm?.id ?? ''),
          // The recipe's own interval where it has one, which several skills
          // do: an Agility obstacle and a Firemaking log both time themselves,
          // and the skill-level `baseInterval` above is 0 for the first and a
          // flat nominal 3,000ms for every log of the second. A rate built on
          // the skill constant alone ranks logs by XP and picks the slowest.
          // `AgilityObstacle.baseInterval` is agility.d.ts:72.
          recipeInterval: safeNumber('registries.35', () => recipe.baseInterval ?? 0, 0),
          // Firemaking's input is the log itself, on `FiremakingLog.log`, and it
          // has no `itemCosts` at all — so all 33 logs dumped as free, which
          // makes burning read as pure profit beside every chain that pays for
          // its materials. See `dumpBurntLog` for why the quantity is 1.
          itemCosts: costsAreOneTime
            ? []
            : isFiremaking
              ? dumpBurntLog(recipe.log)
              : dumpItemCosts(recipe.itemCosts),
          // A one-time build cost, kept apart from consumption so no arithmetic
          // can mistake one for the other. Empty for every skill but Agility.
          buildCosts: costsAreOneTime ? dumpItemCosts(recipe.itemCosts) : [],
          // Most obstacles are built with GP rather than items
          // (`BaseAgilityObject.currencyCosts`, agility.d.ts:24) — Cargo Net
          // costs no items at all — so recording only the item half would leave
          // the usual build cost at zero, which reads as free.
          buildCurrencyCosts: costsAreOneTime ? dumpCurrencyQuantities(recipe.currencyCosts) : [],
          // Alt Magic prices its casts in runes, not itemCosts, so a spell
          // dumped without them looks free -- and when the candidate list then
          // withheld every spell, the dump could not say whether the cause was
          // a missing rune or a bug. `runesRequired` is on BaseSpell
          // (spells.d.ts:24); `fixedItemCosts` is the Alt Magic equivalent of
          // itemCosts (altMagic.d.ts:57).
          runeCosts: dumpItemCosts(recipe.runesRequired),
          fixedItemCosts: dumpItemCosts(recipe.fixedItemCosts),
          // What an obstacle pays per lap. An Agility obstacle has no product
          // item at all, so with only `product` recorded the entire skill read
          // as producing nothing — while `currencyRewards` (agility.d.ts:75)
          // and `itemRewards` (:76) are the whole of what it yields.
          currencyRewards: dumpCurrencyQuantities(recipe.currencyRewards),
          itemRewards: dumpItemCosts(recipe.itemRewards),
          productId: safeText('registries.36', () => recipe.product?.id ?? ''),
          productName: safeText('registries.37', () => recipe.product?.name ?? ''),
          baseQuantity: safeNumber('registries.38', () => recipe.baseQuantity ?? 1, 1),
          productSellsFor: safeNumber(
            'registries.39',
            () => recipe.product?.sellsFor?.quantity ?? 0,
            0,
          ),
          productSellsForCurrencyId: safeText(
            'registries.40',
            () => recipe.product?.sellsFor?.currency.id ?? '',
          ),
          // A Herblore recipe makes four potions, not one, and which one a cast
          // produces is decided by mastery. Empty for every other skill, so a
          // row with a blank `productId` and an empty list here is a recipe
          // that really does produce no item.
          tieredProducts: isHerblore ? dumpTieredProducts(recipe.potions, tierMasteryLevels) : [],
          // A Firemaking drop is chance-gated, so it is not the guaranteed
          // product `productId` would claim it is.
          chanceProducts: isFiremaking
            ? dumpChanceProducts(recipe, game.firemaking as unknown as ChanceProductSkill)
            : [],
          // An Alt Magic spell produces either a real item or a currency
          // sentinel, and pays a `productionRatio` of it either way.
          altMagicProduction: isAltMagic
            ? dumpAltMagicProduction(recipe.produces, recipe.productionRatio)
            : null,
          altMagicSpecialCost: isAltMagic ? dumpAltMagicSpecialCost(recipe.specialCost) : null,
        });
      } catch (error) {
        noteSwallowed('registries.dumpSkillRecipes', error);
        // A recipe that will not describe itself is skipped rather than
        // half-recorded: a partial row reads as a real one downstream.
      }
    }
  }

  return out;
}

/**
 * A drop table, with the quantities the game actually rolls.
 *
 * Every drop in this dump used to be a bare item name, so the table said what
 * *can* come out and never how much — and a table read as one-item-per-roll
 * understates any drop that rolls in bundles. `DropTableElement` carries
 * `minQuantity`, `maxQuantity` and `weight` together (utils.d.ts:424-428);
 * splitting them across sections is what let "Golbin drops Garum Seeds at 100%
 * loot chance" be assembled out of true parts, so they are kept together here.
 *
 * The weight is only a rate alongside the table's `totalWeight`, which every
 * caller of this records next to it.
 */
function dumpDropTable(drops: readonly DropTableElement[] | undefined): {
  itemId: string;
  itemName: string;
  minQuantity: number;
  maxQuantity: number;
  weight: number;
}[] {
  try {
    return (drops ?? []).map((drop) => ({
      itemId: drop.item.id,
      itemName: drop.item.name,
      minQuantity: drop.minQuantity,
      maxQuantity: drop.maxQuantity,
      weight: drop.weight,
    }));
  } catch {
    return [];
  }
}

/**
 * Currency amounts, as the game states them.
 *
 * The agent's largest single income is Thieving, and the dump described it as
 * yielding nothing: coins are not items, so they appear in no loot table and
 * were in no section. `ThievingNPC.currencyDrops` (thieving2.d.ts:36) is a flat
 * `CurrencyQuantity`; `Monster.currencyDrops` (monsters.d.ts:112) is a range,
 * and is dumped by `dumpCurrencyRange` instead.
 *
 * Typed structurally rather than as `CurrencyQuantity` so the generic recipe
 * dumper, which describes its rows by shape, can hand its `currencyRewards`
 * to the same function.
 */
function dumpCurrencyQuantities(
  drops: readonly { currency: { id: string; name: string }; quantity: number }[] | undefined,
): { currencyId: string; currencyName: string; quantity: number }[] {
  try {
    return (drops ?? []).map((drop) => ({
      currencyId: drop.currency.id,
      currencyName: drop.currency.name,
      quantity: drop.quantity,
    }));
  } catch {
    return [];
  }
}

/** A monster's currency drops, which are a min/max range rather than a fixed amount. */
function dumpCurrencyRange(
  drops: readonly CurrencyDrop[] | undefined,
): { currencyId: string; currencyName: string; min: number; max: number }[] {
  try {
    return (drops ?? []).map((drop) => ({
      currencyId: drop.currency.id,
      currencyName: drop.currency.name,
      min: drop.min,
      max: drop.max,
    }));
  } catch {
    return [];
  }
}

/** Inputs a recipe consumes, empty for a gathering action that consumes none. */
function dumpItemCosts(
  costs: { item: { id: string; name: string }; quantity: number }[] | undefined,
): { itemId: string; name: string; quantity: number }[] {
  try {
    return (costs ?? []).map((cost) => ({
      itemId: cost.item.id,
      name: cost.item.name,
      quantity: cost.quantity,
    }));
  } catch (error) {
    noteSwallowed('registries.dumpItemCosts', error);
    return [];
  }
}

/**
 * An item as the dump prices it: what it is, and what it is worth.
 *
 * Shared by the three product shapes below because an unpriced product is the
 * same failure as an unpriced input — it defaults to zero, and zero is the
 * wrong direction in every chain it appears in.
 */
interface PricedItem {
  itemId: string;
  name: string;
  sellsFor: number;
  sellsForCurrencyId: string;
}

/** The item shape these dumpers read: an id, a name, and a sale price. */
type ProductItem = {
  id: string;
  name: string;
  sellsFor?: { quantity: number; currency: { id: string } };
};

/** Reads the four scalars above off one item, naming its own failures. */
function priceItem(item: ProductItem): PricedItem {
  return {
    itemId: item.id,
    name: safeText('registries.productItemName', () => item.name),
    sellsFor: safeNumber('registries.productItemSellsFor', () => item.sellsFor?.quantity ?? 0, 0),
    sellsForCurrencyId: safeText(
      'registries.productItemCurrency',
      () => item.sellsFor?.currency.id ?? '',
    ),
  };
}

/**
 * One tier of a Herblore recipe's potion.
 *
 * A Herblore recipe is not a recipe for *a* potion. `HerbloreRecipe.potions` is
 * `[PotionItem, PotionItem, PotionItem, PotionItem]` (herblore.d.ts:9) — four
 * items of ascending strength off one ingredient list, and which one a cast
 * produces is decided by mastery, not by the recipe. Flattening that to a
 * single `productId` would have to pick a tier, and any pick is wrong about the
 * other three; picking none is what left all 72 rows blank.
 */
interface TieredProduct extends PricedItem {
  /** `PotionItem.tier` (item.d.ts:373), a `HerbloreTier` of 0..3. */
  tier: number;
  /**
   * The mastery level that unlocks this tier.
   *
   * `Herblore.tierMasteryLevels` (herblore.d.ts:78) indexed by tier. Without it
   * the four rows read as four things obtainable now when three of them are
   * gated — the same overstatement as offering a locked recipe as a candidate.
   */
  masteryLevelRequired: number;
  /** `PotionItem.charges` (item.d.ts:370): actions one potion covers. */
  charges: number;
  /** `PotionItem.action` (item.d.ts:372) — the skill action it applies to. */
  actionId: string;
  actionName: string;
}

/**
 * The four potions a Herblore recipe can make, with the gate on each.
 *
 * @param potions - `HerbloreRecipe.potions`, or undefined for any other skill.
 * @param tierMasteryLevels - `Herblore.tierMasteryLevels`; a tier with no entry
 *   records 0, which reads as ungated rather than as a level invented here.
 * @returns One row per tier, in tier order.
 */
export function dumpTieredProducts(
  potions:
    | readonly (ProductItem & {
        tier?: number;
        charges?: number;
        action?: { id: string; name: string };
      })[]
    | undefined,
  tierMasteryLevels: readonly number[],
): TieredProduct[] {
  if (potions === undefined || potions === null) return [];

  const out: TieredProduct[] = [];
  for (const [index, potion] of potions.entries()) {
    try {
      // `tier` is read off the potion rather than taken from the array index:
      // the two agree today, and if they ever stop agreeing the item's own
      // answer is the one `tierMasteryLevels` is indexed by.
      const tier = safeNumber('registries.potionTier', () => potion.tier ?? index, index);
      out.push({
        ...priceItem(potion),
        tier,
        masteryLevelRequired: safeNumber(
          'registries.potionTierMastery',
          () => tierMasteryLevels[tier] ?? 0,
          0,
        ),
        charges: safeNumber('registries.potionCharges', () => potion.charges ?? 0, 0),
        actionId: safeText('registries.potionActionId', () => potion.action?.id ?? ''),
        actionName: safeText('registries.potionActionName', () => potion.action?.name ?? ''),
      });
    } catch (error) {
      noteSwallowed('registries.dumpTieredProducts', error);
      // One unreadable tier is dropped; the other three are still true.
    }
  }
  return out;
}

/**
 * A product that only sometimes appears.
 *
 * Firemaking's yield is not the log — the log is what burns. `FiremakingLog`
 * carries `primaryProducts` (firemakingTicks.d.ts:37) and `secondaryProducts`
 * (:39), and `Firemaking.getPrimaryProductInfo` (:149) /
 * `getSecondaryProductInfo` (:156) say what each pays *and how often*. Recorded
 * as a plain product the chance term vanishes, and a drop landing one burn in
 * twenty prices identically to one landing every time — the overstatement
 * `productChanceFor` already exists to stop for Cooking and Fishing.
 */
interface ChanceProduct extends PricedItem {
  /** Which of the two lists this came from; they roll independently. */
  role: 'primary' | 'secondary';
  /**
   * The game's own chance figure, recorded verbatim.
   *
   * `FiremakingProduct.chance` (firemakingTicks.d.ts:62) comes from
   * `ItemChanceData.chance` (item.d.ts:162), and neither states its units. It is
   * not normalised here because a conversion made on a guess is indelible: a
   * consumer that divides by 100 can be corrected later, a dump that already
   * divided cannot be told apart from one that did not.
   */
  chance: number;
  quantity: number;
}

/** The skill-side accessors `dumpChanceProducts` needs, and nothing else. */
interface ChanceProductSkill {
  getPrimaryProductInfo?: (item: object, action: object) => { chance: number; quantity: number };
  getSecondaryProductInfo?: (item: object, action: object) => { chance: number; quantity: number };
  defaultPrimaryProducts?: readonly ProductItem[];
  defaultSecondaryProducts?: readonly ProductItem[];
}

/**
 * Every product a Firemaking log can yield, with the odds on each.
 *
 * `getPrimaryProductInfo` takes the item *and* the log, so unlike
 * `Firemaking.actionInterval` it answers while nothing is selected — which is
 * the only state this dumper ever runs in.
 *
 * @param log - The recipe, for its two product lists and to pass back to the
 *   accessors. Undefined for any recipe that is not a Firemaking log.
 * @param skill - The Firemaking skill instance.
 * @returns Primary products then secondary ones, each tagged with its role.
 */
export function dumpChanceProducts(
  log:
    | { primaryProducts?: readonly ProductItem[]; secondaryProducts?: readonly ProductItem[] }
    | undefined,
  skill: ChanceProductSkill,
): ChanceProduct[] {
  if (log === undefined || log === null) return [];

  const out: ChanceProduct[] = [];

  const collect = (
    role: 'primary' | 'secondary',
    listed: readonly ProductItem[] | undefined,
    fallback: readonly ProductItem[] | undefined,
    read: ((item: object, action: object) => { chance: number; quantity: number }) | undefined,
  ): void => {
    // A log naming no products of its own takes the skill's, which the typings
    // describe as "the default primary products logs should have"
    // (firemakingTicks.d.ts:117-120). Consulted only when the log's own list is
    // empty, so the two can never be counted together.
    const items = listed !== undefined && listed.length > 0 ? listed : (fallback ?? []);

    for (const item of items) {
      try {
        const info = read?.(item, log as object);
        out.push({
          ...priceItem(item),
          role,
          chance: safeNumber(`registries.firemaking.${role}Chance`, () => info?.chance, 0),
          quantity: safeNumber(`registries.firemaking.${role}Quantity`, () => info?.quantity, 0),
        });
      } catch (error) {
        noteSwallowed('registries.dumpChanceProducts', error);
        // A product that will not describe itself is dropped rather than
        // recorded at chance zero, which reads as "this never drops".
      }
    }
  };

  collect(
    'primary',
    log.primaryProducts,
    skill.defaultPrimaryProducts,
    skill.getPrimaryProductInfo?.bind(skill),
  );
  collect(
    'secondary',
    log.secondaryProducts,
    skill.defaultSecondaryProducts,
    skill.getSecondaryProductInfo?.bind(skill),
  );

  return out;
}

/**
 * `AltMagicProductionID`, spelled out as literals.
 *
 * The enum is a plain `declare enum` (altMagic.d.ts:28-37), so the runtime
 * bundle may carry no value for it and `AltMagicProductionID.GP` can be
 * `undefined` at the moment this runs. `candidates.ts` already writes the two it
 * needs as bare `-1` and `-2` for exactly that reason; this is the same
 * decision applied to all eight, with the numbers taken from the declaration
 * rather than from memory.
 */
const ALT_MAGIC_PRODUCTION_NAMES = new Map<number, string>([
  [-1, 'GP'],
  [-2, 'Bar'],
  [-3, 'RandomGem'],
  [-4, 'RandomSuperiorGem'],
  [-5, 'PerfectFood'],
  [-6, 'RandomShards'],
  [-7, 'MagicXP'],
  [-8, 'AbyssalMagicXP'],
]);

/** `AltMagicConsumptionID`, spelled out for the same reason (altMagic.d.ts:19-27). */
const ALT_MAGIC_CONSUMPTION_NAMES = new Map<number, string>([
  [-1, 'AnyItem'],
  [-2, 'JunkItem'],
  [-3, 'BarIngredientsWithCoal'],
  [-4, 'BarIngredientsWithoutCoal'],
  [-5, 'None'],
  [-6, 'AnySuperiorGem'],
  [-7, 'AnyNormalFood'],
]);

/**
 * What an Alt Magic spell produces.
 *
 * `AltMagicSpell.produces` (altMagic.d.ts:75) is `AltMagicProductionID | AnyItem`:
 * sometimes a real item, and sometimes a sentinel standing for a whole class of
 * outcome — GP, whichever bar the Superheat selection names, a random gem. A
 * dumper looking only for `product` found neither, so all 26 spells recorded a
 * blank product and read as producing nothing at all.
 *
 * `kind` is the sentinel's name, or `Item` when the spell names one, so the two
 * cases are told apart by a stated value rather than by whether `itemId`
 * happens to be empty.
 */
interface AltMagicProduction extends PricedItem {
  kind: string;
  /**
   * `AltMagicSpell.productionRatio` (altMagic.d.ts:76).
   *
   * The multiplier `getAlchemyGP` (:162) takes, and the reason a spell's payout
   * cannot be read off the produced item alone.
   */
  productionRatio: number;
}

/**
 * The product side of an Alt Magic spell, or null for any other skill.
 *
 * @param produces - `AltMagicSpell.produces`; undefined on a non-spell.
 * @param productionRatio - `AltMagicSpell.productionRatio`.
 * @returns The production shape, or null when the recipe is not a spell.
 */
export function dumpAltMagicProduction(
  produces: unknown,
  productionRatio: number | undefined,
): AltMagicProduction | null {
  if (produces === undefined || produces === null) return null;

  const ratio = safeNumber('registries.altMagicProductionRatio', () => productionRatio ?? 1, 1);

  if (typeof produces === 'number') {
    const kind = ALT_MAGIC_PRODUCTION_NAMES.get(produces);
    if (kind === undefined) {
      // A sentinel this file has never heard of is recorded by its number
      // rather than dropped: a spell missing from the section is the failure
      // this whole change exists to end, and a new production id is a game
      // update, which is precisely when someone needs to see it.
      recordFallback('registries.altMagicProduces', `unknown production id ${produces}`);
    }
    return {
      kind: kind ?? `Unknown(${produces})`,
      itemId: '',
      name: '',
      sellsFor: 0,
      sellsForCurrencyId: '',
      productionRatio: ratio,
    };
  }

  return { ...priceItem(produces as ProductItem), kind: 'Item', productionRatio: ratio };
}

/**
 * A cost expressed as a class of item rather than as an item.
 *
 * `AltMagicSpell.specialCost` (altMagic.d.ts:74) is what makes Item Alchemy and
 * Superheat castable at all: `type` is an `AltMagicConsumptionID` naming a
 * *category* — any item, any junk item, a Smithing recipe's ingredients — and
 * `quantity` is how many of it a cast destroys. No item list can hold that, so
 * `itemCosts` and `fixedItemCosts` both record nothing and the spell reads as
 * costing only its runes. The executor already branches on this field to decide
 * what to feed a spell; the dump could not say it existed.
 */
interface AltMagicSpecialCost {
  /** The `AltMagicConsumptionID` name, or `Unknown(n)` for an unmapped one. */
  consumes: string;
  quantity: number;
  /**
   * `AltMagicSpecialCost.currency` (altMagic.d.ts:46), when present.
   *
   * Documented on the data side as restricting consumption to items that sell
   * for that currency (altMagic.d.ts:40-41), so it narrows the category rather
   * than pricing it.
   */
  currencyId: string;
}

/**
 * The special-cost half of an Alt Magic spell, or null when it has none.
 *
 * A quantity of zero is a spell that consumes no item — the executor's own test
 * for whether a selection is needed. It is recorded rather than flattened to
 * null so that "consumes nothing" stays distinguishable from "this row is not a
 * spell", which is the distinction the blank rows destroyed.
 *
 * @param specialCost - `AltMagicSpell.specialCost`; undefined on a non-spell.
 * @returns The cost class and quantity, or null when the recipe is not a spell.
 */
export function dumpAltMagicSpecialCost(
  specialCost: { type?: unknown; quantity?: number; currency?: { id: string } } | undefined,
): AltMagicSpecialCost | null {
  if (specialCost === undefined || specialCost === null) return null;

  const type = specialCost.type;
  let consumes = '';
  if (typeof type === 'number') {
    const name = ALT_MAGIC_CONSUMPTION_NAMES.get(type);
    if (name === undefined) {
      recordFallback('registries.altMagicConsumes', `unknown consumption id ${type}`);
    }
    consumes = name ?? `Unknown(${type})`;
  }

  return {
    consumes,
    quantity: safeNumber('registries.altMagicSpecialCostQty', () => specialCost.quantity ?? 0, 0),
    currencyId: safeText(
      'registries.altMagicSpecialCostCurrency',
      () => specialCost.currency?.id ?? '',
    ),
  };
}

/**
 * The one log a burn consumes.
 *
 * `FiremakingLog.log` (firemakingTicks.d.ts:34) is a bare `AnyItem`, not an
 * item/quantity pair, so a burn consumes exactly one of it — one is the only
 * reading the field admits, not a number chosen here. Recorded as an ordinary
 * `itemCosts` entry because that is what it is: left out, every log is a free
 * input and Firemaking prices as pure profit against chains that pay for their
 * materials.
 *
 * The game's own `getCurrentRecipeCosts()` (firemakingTicks.d.ts:138) would be
 * authoritative and is useless here — it prices the *selected* recipe, and this
 * dumper runs with nothing selected. `candidates.ts` reads `log` directly for
 * the same reason.
 *
 * @param log - `FiremakingLog.log`; undefined for any other recipe.
 * @returns A one-entry cost list, or empty when there is no log.
 */
export function dumpBurntLog(
  log: { id: string; name: string } | undefined,
): { itemId: string; name: string; quantity: number }[] {
  if (log === undefined || log === null) return [];
  return [
    { itemId: log.id, name: safeText('registries.firemakingLogName', () => log.name), quantity: 1 },
  ];
}

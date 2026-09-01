import type { KnowledgeDump } from '@melvor-agent/knowledge';

/**
 * Exports the game's own data registries.
 *
 * These registries are ground truth: they are correct for the exact installed
 * version, which the wiki is not. Everything numeric the planner ever sees
 * originates here. The dump is stamped with `gameVersion` so a game update
 * makes the staleness detectable rather than silent.
 *
 * Only the slices Phase 1 and the Phase 2 combat gate need are exported. This
 * is deliberate: `game.items` alone is thousands of entries, and a dump nobody
 * reads is just a large file that goes stale.
 *
 * @returns A structured dump ready to be serialised to `knowledge/dump.json`.
 */
export function dumpRegistries(): KnowledgeDump {
  return {
    gameVersion: gameVersion,
    capturedAt: Date.now(),
    gamemodeId: game.currentGamemode.id,
    realms: game.realms.allObjects.map((realm) => ({
      id: realm.id,
      name: realm.name,
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
    // Herblore recipes and their exact inputs.
    //
    // The only level-1 recipe, Bird Nest Potion I, was read off a screenshot as
    // "1 Herb + 2 seeds" from two small icons. Reading pictures is how five
    // conclusions went wrong today, and this one decides what the whole
    // Herblore chain actually needs, so it belongs in data.
    herbloreRecipes: (() => {
      try {
        return game.herblore.actions.allObjects.slice(0, 12).map((recipe) => ({
          id: recipe.id,
          name: recipe.name,
          level: recipe.level,
          costs: recipe.itemCosts.map((cost) => ({
            itemId: cost.item.id,
            itemName: cost.item.name,
            quantity: cost.quantity,
          })),
        }));
      } catch {
        return [];
      }
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
        return game.summoning.actions.allObjects.slice(0, 20).map((recipe) => ({
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
      } catch {
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
      } catch {
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
      } catch {
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
      } catch {
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
      } catch {
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
      } catch {
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
      } catch {
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
      lootTable: npc.lootTable.drops.map((drop) => drop.item.name),
    })),
    monsters: game.monsters.allObjects.map((monster) => ({
      id: monster.id,
      name: monster.name,
      combatLevel: monster.combatLevel,
      // Deliberately absent: maxHit. A Monster in the registry is data with no
      // computed max hit — only an instantiated Enemy has one. Dumping a
      // plausible-looking number here would poison the Phase 2 combat gate.
    })),
    dungeons: game.dungeons.allObjects.map((dungeon) => ({
      id: dungeon.id,
      name: dungeon.name,
      monsterIds: dungeon.monsters.map((monster) => monster.id),
      realmId: dungeon.realm.id,
    })),
    shopPurchases: game.shop.purchases.allObjects.map((purchase) => ({
      id: purchase.id,
      name: purchase.name,
      allowQuantityPurchase: purchase.allowQuantityPurchase,
    })),
  };
}

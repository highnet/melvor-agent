import type { KnowledgeDump } from '@melvor-agent/knowledge';
import { gpCostOf } from './shop.js';

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
/**
 * Reading game data that may not be there, without inventing what is.
 *
 * A dump that throws produces nothing; a dump that guesses produces something
 * worse. These return a stated empty value so a missing field is visibly empty
 * rather than plausibly wrong — the distinction that made "no monster drops
 * seeds" indistinguishable from "monster drops were never dumped".
 */
function safeNumber(read: () => number, fallback: number): number {
  try {
    const value = read();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function safeText(read: () => string): string {
  try {
    return read();
  } catch {
    return '';
  }
}

function safeList(read: () => string[]): string[] {
  try {
    return read();
  } catch {
    return [];
  }
}

function safeBoolean(read: () => boolean, fallback: boolean): boolean {
  try {
    return read();
  } catch {
    return fallback;
  }
}

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
      const met = safeBoolean(() => requirement.isMet(), false) ? ' (met)' : '';

      if (requirement.type === 'SkillLevel') {
        return `${requirement.skill.name} ${requirement.level}${met}`;
      }
      if (requirement.type === 'DungeonCompletion') {
        return `Complete ${requirement.dungeon.name} x${requirement.count}${met}`;
      }
      return `${requirement.type}${met}`;
    });
  } catch {
    return [];
  }
}

export function dumpRegistries(): KnowledgeDump {
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
      unlocked: safeBoolean(() => realm.isUnlocked, false),
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
          for (const drop of drops.slice(0, 6)) {
            try {
              out.push({
                skillId: skill.id,
                skillName: skill.name,
                itemId: drop.item.id,
                itemName: drop.item.name,
                quantity: drop.quantity,
              });
            } catch {
              // A drop that cannot describe itself is skipped, not invented.
            }
          }
        }
      } catch {
        return [];
      }
      return out.slice(0, 60);
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
      // The guaranteed drop, which the table does not include and which was
      // invisible for the same reason monster loot was.
      uniqueDrop: safeText(() => npc.uniqueDrop?.item.name ?? ''),
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
      lootChance: safeNumber(() => monster.lootChance, 0),
      lootTable: safeList(() => monster.lootTable.drops.map((drop) => drop.item.name)),
      // Weights, because `lootChance` alone is not a rate and reading it as one
      // produced a wrong claim within minutes of the table being dumped:
      // "Golbin drops Garum Seeds at 100% loot chance" is two facts welded into
      // a falsehood. `lootChance` is the chance the table rolls *at all*; which
      // item comes out is then weight/totalWeight. A seed on a 1-in-40 slot of
      // a table that always rolls is not a seed every kill.
      //
      // With these, seeds-per-kill is arithmetic instead of a guess, which is
      // the whole difference between choosing a fight and hoping about one.
      lootTotalWeight: safeNumber(() => monster.lootTable.totalWeight, 0),
      lootWeights: safeList(() =>
        monster.lootTable.drops.map((drop) => `${drop.item.name}:${drop.weight}`),
      ),
      bones: safeText(() => monster.bones?.item.name ?? ''),
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
    shopPurchases: game.shop.purchases.allObjects.map((purchase) => ({
      id: purchase.id,
      name: purchase.name,
      allowQuantityPurchase: purchase.allowQuantityPurchase,
      gpCost: safeNumber(() => gpCostOf(purchase), 0),
      owned: safeNumber(() => game.shop.getPurchaseCount(purchase), 0),
      atBuyLimit: safeBoolean(() => game.shop.isPurchaseAtBuyLimit(purchase), false),
      requirements: safeRequirementTypes(() => purchase.purchaseRequirements),
    })),
  };
}

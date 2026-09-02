import { readActiveRecipeIds } from './active.js';
import { readFarmPlots } from './farming.js';
import { noteSwallowed } from './safe.js';
import type { ActiveActionState, SkillState, StateSnapshot } from './surface.js';
import { readTownshipSummary } from './township.js';

/**
 * Raw read of the game's online-loop flag.
 *
 * Underscore-prefixed and therefore fragile, which is why it is read in exactly
 * one place. It is corroborating evidence only — authoritative offline state is
 * tracked from the `offlineLoopEntered` / `offlineLoopExited` events, because
 * those are a documented part of `GameEvents` and this field is not.
 *
 * @returns True when the game reports it is processing the online loop.
 */
export function readIsInOnlineLoop(): boolean {
  return game._isInOnlineLoop;
}

/** The global `gameVersion`, e.g. `"v1.3.1"`. Drives the stale-dump refusal. */
export function readGameVersion(): string {
  return gameVersion;
}

/** Name of the currently loaded character, for the save allowlist guard. */
export function readCharacterName(): string {
  return game.characterName;
}

/** Total skill level, summed from the skills themselves rather than inferred. */
export function readTotalLevel(): number {
  return game.skills.allObjects.reduce((sum, skill) => sum + skill.level, 0);
}

/** Overall completion percentage across every category. */
export function readCompletionPercent(): number {
  return game.completion.totalProgressTrue;
}

/** Amount of a currency by namespaced id, or 0 when it is not registered. */
export function readCurrency(currencyId: string): number {
  return game.currencies.getObjectByID(currencyId)?.amount ?? 0;
}

/**
 * Whether a skill is currently ticking.
 *
 * `isActive` lives on the `ActiveAction` interface, not on `Skill`, so only
 * skills that can be run directly have it. Anything else is inactive by
 * definition rather than by omission.
 */
function readSkillActive(skill: AnySkill): boolean {
  const candidate = skill as AnySkill & Partial<Pick<ActiveAction, 'isActive'>>;
  return candidate.isActive ?? false;
}

function readMasteryPoolXp(skill: AnySkill): number | undefined {
  // Only SkillWithMastery exposes this, and it is keyed by realm.
  const candidate = skill as AnySkill & {
    getMasteryPoolXP?: (realm: Realm) => number;
  };
  if (typeof candidate.getMasteryPoolXP !== 'function') return undefined;
  return candidate.getMasteryPoolXP(game.currentRealm);
}

function readSkill(skill: AnySkill): SkillState {
  const masteryPoolXp = readMasteryPoolXp(skill);
  return {
    id: skill.id,
    name: skill.name,
    level: skill.level,
    xp: skill.xp,
    isActive: readSkillActive(skill),
    // Abyssal values exist on every skill but only mean anything in Into the
    // Abyss content, so they are emitted only when nonzero.
    ...(skill.abyssalLevel > 0
      ? { abyssalLevel: skill.abyssalLevel, abyssalXp: skill.abyssalXP }
      : {}),
    ...(masteryPoolXp === undefined ? {} : { masteryPoolXp }),
  };
}

function readActiveAction(): ActiveActionState {
  const action = game.activeAction;
  if (action === undefined) return null;
  return {
    id: action.id,
    name: action.name,
    isActive: action.isActive,
    recipeIds: readActiveRecipeIds(),
  };
}

/**
 * Builds a complete observation of the game.
 *
 * Must not be called while offline progress is resolving — the character is mid
 * catch-up and about to change underneath the snapshot. The runtime enforces
 * this; this function does not guard, so that it stays pure and cheap.
 *
 * @returns An unvalidated snapshot. The runtime parses it against the zod schema
 *          before anything downstream may use it.
 */
export function readSnapshot(): StateSnapshot {
  const manager = game.combat;
  const player = manager.player;
  const enemy = manager.enemy;

  return {
    capturedAt: Date.now(),
    gameVersion: readGameVersion(),
    characterName: readCharacterName(),
    gamemodeId: game.currentGamemode.id,
    currentRealmId: game.currentRealm.id,
    isOfflineLoop: !readIsInOnlineLoop(),
    totalLevel: readTotalLevel(),
    completionPercent: readCompletionPercent(),
    currencies: game.currencies.allObjects.map((currency) => ({
      id: currency.id,
      name: currency.name,
      amount: currency.amount,
    })),
    skills: game.skills.allObjects.map(readSkill),
    bank: {
      slotsUsed: game.bank.occupiedSlots,
      slotsMax: game.bank.maximumSlots,
      items: [...game.bank.items.values()].map((entry) => ({
        id: entry.item.id,
        name: entry.item.name,
        qty: entry.quantity,
      })),
    },
    activeAction: readActiveAction(),
    farm: readFarmPlots(),
    township: readTownshipSummary(),
    combat: {
      inCombat: manager.isActive,
      hitpoints: player.hitpoints,
      maxHitpoints: player.stats.maxHitpoints,
      prayerPoints: player.prayerPoints,
      // All three fold in shop upgrades, gear and expansions already, because
      // they are getters over the modifier table. Never hardcode them.
      autoEatThreshold: player.autoEatThreshold,
      autoEatHPLimit: player.autoEatHPLimit,
      autoEatEfficiency: player.autoEatEfficiency,
      maxHit: player.stats.maxHit,
      minHit: player.stats.minHit,
      accuracy: player.stats.accuracy,
      attackInterval: player.stats.attackInterval,
      maxBarrier: player.stats.maxBarrier,
      combatLevel: game.playerCombatLevel,
      food: player.food.slots.map((slot) => {
        const isEmpty = slot.item === game.emptyFoodItem;
        return {
          itemId: isEmpty ? null : slot.item.id,
          itemName: isEmpty ? null : slot.item.name,
          qty: slot.quantity,
          healsFor: isEmpty ? 0 : player.getFoodHealing(slot.item),
        };
      }),
      selectedEquipmentSet: player.selectedEquipmentSet,
      // The food slot the game eats from, which is not the equipment set.
      selectedFoodSlot: player.food.selectedSlot,
      equipment: Object.values(player.equipment.equippedItems).map((equipped) => {
        const isEmpty = equipped.item === equipped.emptyItem;
        return {
          slot: equipped.slot.id,
          itemId: isEmpty ? null : equipped.item.id,
          itemName: isEmpty ? null : equipped.item.name,
          qty: equipped.quantity,
        };
      }),
      // A Monster in the registry is data with no computed maxHit; only an
      // instantiated Enemy has one. So this is populated only mid-fight.
      enemy:
        enemy.monster === undefined || !manager.fightInProgress
          ? null
          : {
              monsterId: enemy.monster.id,
              name: enemy.monster.name,
              hitpoints: enemy.hitpoints,
              maxHitpoints: enemy.stats.maxHitpoints,
              maxHit: enemy.stats.maxHit,
            },
    },
  };
}

/**
 * How many times this character has died, ever.
 *
 * The agent had no death detection at all. `deathsSinceStart` was only ever
 * assigned zero -- never incremented -- so `abortWhen.deathsExceed` could not
 * fire, the `death` replan trigger was never sent, and the run that died
 * overnight carried on as though nothing had happened. Nothing in the codebase
 * knew the difference between a character that was working and one that was
 * dead.
 *
 * Read as a statistic rather than an event because there is no death event in
 * `GameEvents` to subscribe to, and patching `Player.processDeath` would be a
 * guess about what the mod loader permits. A counter that only ever rises needs
 * no such assumption: compare it against the last reading and any increase is a
 * death, including one that happened during offline progression while the mod
 * was not loaded -- which is precisely how this character died last time.
 *
 * The literal 4 is `CombatStats.Deaths` (statistics.d.ts:420). It is spelled out
 * because that is a plain `declare enum`, so the runtime bundle may carry no
 * value for it; citing the line is honest where importing would be fragile.
 */
export function readDeathCount(): number {
  try {
    const deaths = game.stats.Combat.get(4);
    return Number.isFinite(deaths) ? deaths : 0;
  } catch (error) {
    noteSwallowed('readers.readDeathCount', error);
    // A character whose stats cannot be read is reported as never having died,
    // which fails toward acting rather than toward a spurious emergency stop.
    return 0;
  }
}

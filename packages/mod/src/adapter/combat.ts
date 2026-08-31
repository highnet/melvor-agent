import type { ActionResult, CombatGateInputs } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';

/** Stats measured from a probe enemy, plus the damage type they arrive as. */
interface ProbedStats {
  maxHit: number;
  attackIntervalMs: number;
  hitChance: number;
  /** Which resistance applies. v1.3 replaced flat damage reduction with these. */
  damageType: DamageType;
}

/** What engaging claims to change. */
export interface CombatProjection {
  inCombat: boolean;
  areaId: string | null;
  monsterId: string | null;
}

function project(): CombatProjection {
  const manager = game.combat;
  return {
    inCombat: manager.isActive,
    areaId: manager.selectedArea?.id ?? null,
    monsterId: manager.enemy.monster?.id ?? null,
  };
}

/**
 * Computes a monster's real max hit without fighting it.
 *
 * A `Monster` in the registry is *data*: it has levels and equipment stats but
 * no computed max hit, because max hit lives on `Character` and depends on
 * damage type, combat triangle and modifiers. The only honest way to get the
 * number is to instantiate an `Enemy`, hand it the monster, and let the game's
 * own code compute the stats — the same approach Combat Simulator Reloaded
 * takes, and the reason it never reimplements damage formulas.
 *
 * The probe is a throwaway `Enemy` bound to the live manager. It is never
 * ticked, rendered or attached to combat; only `setStatsFromMonster` and
 * `computeCombatStats` are called on it.
 *
 * **Unverified in-game.** Constructing an `Enemy` may have side effects the
 * typings do not describe. Until this has been watched in a real session, the
 * gate defaults to advisory (dry-run) mode — see `assessTarget`.
 *
 * @param monster - The monster to measure.
 * @returns Its max hit and attack interval, or null if the probe failed.
 */
function probeMonsterStats(monster: Monster): ProbedStats | null {
  try {
    const probe = new Enemy(game.combat, game);
    probe.setNewMonster(monster);
    probe.setStatsFromMonster(monster);
    probe.computeCombatStats();

    return {
      maxHit: probe.stats.maxHit,
      attackIntervalMs: probe.stats.attackInterval,
      // hitChance is a percentage on the stats object; the gate wants 0..1.
      hitChance: Math.min(1, Math.max(0, probe.stats.hitChance / 100)),
      damageType: probe.damageType,
    };
  } catch {
    // A failed probe means we cannot prove survivability, which is a refusal —
    // never an assumption that it is fine.
    return null;
  }
}

/**
 * Worst-case monster stats for a target.
 *
 * For a dungeon this walks every monster in it and keeps the highest max hit.
 * The brief is explicit that a dungeon must be judged by its worst monster, not
 * its first: dying on floor nine is exactly as expensive as dying on floor one.
 */
function worstCaseStats(monsters: readonly Monster[]): ProbedStats | null {
  let worst: ProbedStats | null = null;

  for (const monster of monsters) {
    const stats = probeMonsterStats(monster);
    // One unmeasurable monster makes the whole dungeon unmeasurable. Skipping
    // it would silently judge the dungeon by the monsters that happened to work.
    if (stats === null) return null;
    if (worst === null || stats.maxHit > worst.maxHit) worst = stats;
  }

  return worst;
}

/**
 * Assembles the inputs for the survivability gate.
 *
 * Reads only; makes no decision. The decision is `assessSurvivability`, which is
 * pure and lives in the policy tier so it can be tested exhaustively.
 *
 * @param targetId - A monster id or a dungeon id.
 * @param intendedSessionMinutes - How long the agent means to keep fighting.
 * @returns Gate inputs, or a reason they could not be gathered.
 */
export function readCombatGateInputs(
  targetId: string,
  intendedSessionMinutes: number,
): { ok: true; inputs: CombatGateInputs } | { ok: false; detail: string } {
  const dungeon = game.dungeons.getObjectByID(targetId);
  const monster = game.monsters.getObjectByID(targetId);

  if (dungeon === undefined && monster === undefined) {
    return { ok: false, detail: `no monster or dungeon registered as ${targetId}` };
  }

  const realmId = dungeon?.realm.id ?? game.currentRealm.id;
  if (isRefusedRealm(realmId)) {
    return { ok: false, detail: `target is in refused realm ${realmId}` };
  }

  const stats =
    dungeon !== undefined
      ? worstCaseStats(dungeon.monsters)
      : probeMonsterStats(monster as Monster);

  if (stats === null) {
    return { ok: false, detail: `could not compute enemy stats for ${targetId}` };
  }

  const player = game.combat.player;
  const food = player.food.currentSlot;
  const isEmptyFood = food.item === game.emptyFoodItem;

  return {
    ok: true,
    inputs: {
      targetId,
      targetName: dungeon?.name ?? (monster as Monster).name,
      isDungeon: dungeon !== undefined,
      playerMaxHitpoints: player.stats.maxHitpoints,
      // `EquipmentStats.damageReduction` is deprecated: v1.3 replaced flat
      // reduction with per-damage-type resistances, so the applicable number
      // depends on what this specific enemy hits with.
      playerDamageReductionPercent: player.stats.getResistance(stats.damageType),
      autoEatThresholdFraction: player.autoEatThreshold,
      autoEatHpLimitFraction: player.autoEatHPLimit,
      autoEatEfficiencyFraction: player.autoEatEfficiency,
      foodHealPerItem: isEmptyFood ? 0 : player.getFoodHealing(food.item),
      foodQuantity: isEmptyFood ? 0 : food.quantity,
      enemyMaxHit: stats.maxHit,
      enemyAttackIntervalMs: stats.attackIntervalMs,
      enemyHitChance: stats.hitChance,
      intendedSessionMinutes,
    },
  };
}

/**
 * Engages a monster in an area.
 *
 * Callers must have already cleared the survivability gate; this function does
 * not run it. That split is deliberate — the gate is pure and testable, and
 * mixing it into the action would make it untestable and easy to bypass. The
 * runtime is the only caller and it refuses to reach here without a verdict.
 *
 * @param monsterId - The monster to fight.
 * @param areaId - The area it lives in.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that combat started against that monster.
 */
export function engageMonster(
  monsterId: string,
  areaId: string,
  isSuspended: () => boolean,
): ActionResult<CombatProjection> {
  const monster = game.monsters.getObjectByID(monsterId);
  if (monster === undefined) {
    return fail('combat.engage', 'precondition', `no monster registered as ${monsterId}`);
  }

  const area = game.combatAreas.getObjectByID(areaId) ?? game.slayerAreas.getObjectByID(areaId);
  if (area === undefined) {
    return fail(
      'combat.engage',
      'precondition',
      `no combat or slayer area registered as ${areaId}`,
    );
  }

  return act(
    {
      name: 'combat.engage',
      observe: project,
      precondition: () => {
        if (isRefusedRealm(area.realm.id)) {
          return `area ${areaId} is in refused realm ${area.realm.id}`;
        }
        if (!game.checkRequirements(area.entryRequirements, false)) {
          return `entry requirements not met for ${areaId}`;
        }
        if (game.combat.isActive) return 'already in combat';
        const active = game.activeAction;
        if (active !== undefined) return `another action is running: ${active.id}`;
        return null;
      },
      perform: () => game.combat.selectMonster(monster, area),
      changed: (_before, after) => after.inCombat && after.monsterId === monsterId,
    },
    isSuspended,
  );
}

/**
 * Stops combat.
 *
 * Combat cannot be exited cleanly mid-fight, so this is called at a kill
 * boundary by the runtime backup monitor rather than the instant a floor is
 * crossed — taking the gap early is the whole point of that monitor.
 *
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that combat ended.
 */
export function disengageCombat(isSuspended: () => boolean): ActionResult<CombatProjection> {
  return act(
    {
      name: 'combat.disengage',
      observe: project,
      precondition: () => (game.combat.isActive ? null : 'not in combat'),
      perform: () => game.combat.stop(),
      changed: (before, after) => before.inCombat && !after.inCombat,
    },
    isSuspended,
  );
}

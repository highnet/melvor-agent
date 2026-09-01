import type { ActionResult, Candidate, CombatGateInputs } from '@melvor-agent/shared';
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
 * **Verified in-game, and it does not work.** The monster attaches correctly and
 * its equipment stats are present, but the game's own `computeCombatStats`
 * yields `NaN` for a detached enemy: the calculation depends on combat context
 * a probe outside combat does not have. This is why Combat Simulator Reloaded
 * reimplements the damage formulas rather than borrowing them.
 *
 * Reimplementing them here is exactly what the brief forbids, so the probe is
 * kept for the case where it does work and {@link screenByCombatLevel} covers
 * the case where it does not. A failed probe returns null, and null means
 * refuse — the untested path fails closed.
 *
 * @param monster - The monster to measure.
 * @returns Its max hit and attack interval, or null if the probe failed.
 */
function probeMonsterStats(monster: Monster): ProbedStats | null {
  try {
    const probe = new Enemy(game.combat, game);
    probe.setNewMonster(monster);

    // Verified live: the monster attaches and its equipment stats are present,
    // but `computeCombatStats` still yields NaN outside combat.
    probe.setStatsFromMonster(monster);
    probe.initializeForCombat();
    probe.computeCombatStats();

    // A probe that still computes nothing has failed, not found a harmless
    // monster. Refusing on this is what keeps the gate failing closed — and the
    // numbers go into the reason, because "could not compute" without them sent
    // me guessing at the cause twice.
    // `> 0` rather than `!== 0`: NaN fails this comparison, which is the point.
    if (!(probe.stats.maxHit > 0) || !(probe.stats.attackInterval > 0)) {
      lastProbeFailure = `${monster.id}: the game computed max hit ${probe.stats.maxHit}`;
      return null;
    }

    return {
      maxHit: probe.stats.maxHit,
      attackIntervalMs: probe.stats.attackInterval,
      // hitChance is a percentage on the stats object; the gate wants 0..1.
      hitChance: Math.min(1, Math.max(0, probe.stats.hitChance / 100)),
      damageType: probe.damageType,
    };
  } catch (error) {
    // A failed probe means we cannot prove survivability, which is a refusal —
    // never an assumption that it is fine.
    lastProbeFailure = `${monster.id} threw: ${String(error)}`;
    return null;
  }
}

/**
 * Why the last probe failed.
 *
 * Module-level rather than returned, because the probe is called from inside a
 * reduce over every monster in a dungeon and threading a reason through all of
 * that would obscure the code for a diagnostic. It exists because "could not
 * compute enemy stats" told me nothing twice in a row.
 */
let lastProbeFailure = '';

/** The reason the most recent probe failed, for error messages. */
export function readLastProbeFailure(): string {
  return lastProbeFailure;
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
/**
 * A conservative screen using only data the game states plainly.
 *
 * Used when the probe cannot measure, which outside combat is always. It makes
 * no attempt to predict damage — predicting it would mean reimplementing the
 * game's formulas, which is how a safety check quietly becomes fiction. It only
 * asks the question a human answers by glancing at a monster: is this thing
 * obviously out of my league?
 *
 * Deliberately strict. Screening out a fight the character could have won costs
 * some XP; screening in one it cannot costs the run. The real judgement happens
 * a second later against the live enemy, whose stats the game computes for
 * real — see `verifyLiveEngagement`.
 */
/**
 * A target's combat level, for the screen.
 *
 * A dungeon is rated by its hardest monster, the same way the gate judges it:
 * a dungeon cannot be left partway, so its worst fight is the one that decides.
 */
export function readTargetCombatLevel(targetId: string): number | null {
  try {
    const monster = game.monsters.getObjectByID(targetId);
    if (monster !== undefined) return monster.combatLevel;

    const dungeon = game.dungeons.getObjectByID(targetId);
    if (dungeon === undefined) return null;

    let hardest = 0;
    for (const inhabitant of dungeon.monsters) {
      hardest = Math.max(hardest, inhabitant.combatLevel);
    }
    return hardest > 0 ? hardest : null;
  } catch {
    return null;
  }
}

export function screenByCombatLevel(monsterCombatLevel: number): { ok: boolean; detail: string } {
  const playerLevel = playerCombatLevel();

  if (playerLevel <= 0) {
    return { ok: false, detail: 'player combat level unavailable' };
  }

  // Half the player's combat level, floored at 1 so a fresh character can still
  // fight a Chicken. A human starting out fights things well below themselves,
  // and this agent has no gear and no Auto Eat.
  const ceiling = Math.max(1, Math.floor(playerLevel / 2));

  if (monsterCombatLevel > ceiling) {
    return {
      ok: false,
      detail: `combat level ${monsterCombatLevel} is above the screen ceiling ${ceiling} (half of the character's ${playerLevel}); the game cannot compute enemy stats outside combat, so this is the conservative screen`,
    };
  }

  return { ok: true, detail: `combat level ${monsterCombatLevel} within ceiling ${ceiling}` };
}

/** The character's combat level, from the game's own calculation. */
function playerCombatLevel(): number {
  try {
    // Lives on Game, not on Player — the same place the snapshot reads it.
    return game.playerCombatLevel;
  } catch {
    return 0;
  }
}

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
    return {
      ok: false,
      detail: `could not compute enemy stats for ${targetId} (${readLastProbeFailure()})`,
    };
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

/**
 * Starts a dungeon.
 *
 * Dungeons are a large slice of the game's content and rewards, and they were
 * unreachable: the survivability gate already knew how to measure one — walking
 * every monster and keeping the worst — but nothing could actually enter it.
 *
 * Judged by its *worst* monster, not its first, which is why the gate does that
 * walk. Dying on floor nine costs exactly as much as dying on floor one, and a
 * dungeon cannot be left partway without losing the run.
 *
 * Callers must have cleared the gate. As with {@link engageMonster}, this does
 * not run it: the gate is pure and testable, and mixing it in here would make
 * it both untestable and easy to bypass.
 *
 * @param dungeonId - Namespaced `Dungeon` id.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function startDungeon(
  dungeonId: string,
  isSuspended: () => boolean,
): ActionResult<CombatProjection> {
  const dungeon = game.dungeons.getObjectByID(dungeonId);
  if (dungeon === undefined) {
    return fail('combat.startDungeon', 'precondition', `no dungeon registered as ${dungeonId}`);
  }

  return act(
    {
      name: 'combat.startDungeon',
      observe: project,
      precondition: () => {
        if (isRefusedRealm(dungeon.realm.id)) {
          return `dungeon ${dungeonId} is in refused realm ${dungeon.realm.id}`;
        }
        if (!game.checkRequirements(dungeon.entryRequirements, false)) {
          return `entry requirements not met for ${dungeonId}`;
        }
        if (game.combat.isActive) return 'already in combat';
        const active = game.activeAction;
        if (active !== undefined) return `another action is running: ${active.id}`;
        return null;
      },
      perform: () => game.combat.selectDungeon(dungeon),
      changed: (_before, after) => after.inCombat,
    },
    isSuspended,
  );
}

/**
 * Selects the attack spell for Magic combat.
 *
 * Without this the agent cannot fight with Magic at all — the spell is a
 * separate selection from the attack style, and an unset one means the
 * character falls back to melee regardless of gear.
 *
 * `selectAttackSpell` returns `void` and silently refuses when the Magic level
 * or the runes are missing, so the selection is observed either side.
 */
export function selectAttackSpell(
  spellId: string,
  isSuspended: () => boolean,
): ActionResult<{ spellId: string | null }> {
  const spell = game.attackSpells.getObjectByID(spellId);
  if (spell === undefined) {
    return fail('combat.selectSpell', 'precondition', `no attack spell ${spellId}`);
  }

  const player = game.combat.player;
  const projectSpell = (): { spellId: string | null } => ({
    spellId: player.spellSelection.attack?.id ?? null,
  });

  return act(
    {
      name: 'combat.selectSpell',
      observe: projectSpell,
      precondition: () => {
        if (game.combat.isActive) return 'in combat; refusing to change spell';
        // `game.altMagic` is the Alt Magic *skill*, not combat Magic; the
        // combat one is only reachable through the skill registry.
        const magicLevel = game.skills.getObjectByID('melvorD:Magic')?.level ?? 0;
        if (spell.level > magicLevel) {
          return `${spellId} needs Magic ${spell.level}, have ${magicLevel}`;
        }
        return null;
      },
      perform: () => player.selectAttackSpell(spell, false),
      changed: (_before, after) => after.spellId === spellId,
    },
    isSuspended,
  );
}

// --- enumeration -----------------------------------------------------------

/** A fight the agent could plausibly take, before the survivability gate. */
export interface CombatTarget {
  kind: 'fight_monster' | 'run_dungeon';
  id: string;
  /** Set for monsters; dungeons are entered by id alone. */
  areaId?: string;
  name: string;
  areaName: string;
  combatLevel: number;
}

/** Monsters per area offered to the planner. */
const MONSTERS_PER_AREA = 3;

/**
 * Enumerates the fights that are currently *enterable*.
 *
 * Deliberately not the same question as "survivable": entry requirements are a
 * game rule, survivability is our own judgement, and the gate owns the second
 * one. Mixing them here would put the safety decision in two places.
 *
 * Areas hold up to dozens of monsters and the game has hundreds in total, so
 * each area contributes only its easiest few. The planner picks among real
 * options; it does not need every option.
 */
export function readCombatTargets(): CombatTarget[] {
  const targets: CombatTarget[] = [];

  const areas = [...game.combatAreas.allObjects, ...game.slayerAreas.allObjects];
  for (const area of areas) {
    if (isRefusedRealm(area.realm.id)) continue;
    if (!game.checkRequirements(area.entryRequirements, false)) continue;

    const byLevel = [...area.monsters].sort((a, b) => combatLevelOf(a) - combatLevelOf(b));
    for (const monster of byLevel.slice(0, MONSTERS_PER_AREA)) {
      targets.push({
        kind: 'fight_monster',
        id: monster.id,
        areaId: area.id,
        name: monster.name,
        areaName: area.name,
        combatLevel: combatLevelOf(monster),
      });
    }
  }

  for (const dungeon of game.dungeons.allObjects) {
    if (isRefusedRealm(dungeon.realm.id)) continue;
    if (!game.checkRequirements(dungeon.entryRequirements, false)) continue;

    // A dungeon is judged by its hardest monster, because it cannot be left
    // partway: the boss is what the run has to survive.
    const hardest = [...dungeon.monsters].reduce(
      (worst, monster) => (combatLevelOf(monster) > combatLevelOf(worst) ? monster : worst),
      dungeon.monsters[0],
    );
    if (hardest === undefined) continue;

    targets.push({
      kind: 'run_dungeon',
      id: dungeon.id,
      name: dungeon.name,
      areaName: dungeon.name,
      combatLevel: combatLevelOf(hardest),
    });
  }

  return targets;
}

/** `combatLevel` is a getter that can throw on malformed modded monsters. */
function combatLevelOf(monster: Monster | undefined): number {
  if (monster === undefined) return Number.POSITIVE_INFINITY;
  try {
    const level = monster.combatLevel;
    return Number.isFinite(level) ? level : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Attack spells the character can currently cast.
 *
 * Gated on the runes actually being in the bank, not just on the Magic level:
 * a spell without runes is selected happily and then does nothing, which is the
 * worst failure mode available — silent, and only visible as zero XP an hour
 * later.
 */
export function readSpellCandidates(): Candidate[] {
  const magicLevel = game.skills.getObjectByID('melvorD:Magic')?.level ?? 0;
  const selected = game.combat.player.spellSelection.attack?.id ?? null;
  const candidates: Candidate[] = [];

  for (const spell of game.attackSpells.allObjects) {
    if (spell.id === selected) continue;
    if (spell.level > magicLevel) continue;

    const runes = spell.runesRequired;
    const missing = runes.filter((rune) => game.bank.getQty(rune.item) < rune.quantity);
    if (missing.length > 0) continue;

    candidates.push({
      kind: 'select_spell',
      params: { kind: 'select_spell', spellId: spell.id },
      label: `Cast ${spell.name} (Magic ${spell.level}, runes in bank)`,
      available: true,
    });
  }

  return candidates;
}

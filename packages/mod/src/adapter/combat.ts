import type {
  ActionResult,
  Candidate,
  CombatGateInputs,
  CombatLevelScreenInputs,
  CombatSkillLevels,
} from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';
import { killValueFor } from './pricing.js';
import { readFightRate } from './rates.js';
import { noteSwallowed, safeValue } from './safe.js';

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
 * kept for the case where it does work and the level screen — inputs from
 * {@link readCombatLevelScreenInputs}, judgement in `screenByCombatSkillLevels`
 * — covers the case where it does not, which in practice is every case. A
 * failed probe returns null, and null means fall back to the screen, never
 * "assume it is fine".
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
 * Combat skill levels off any character, monster or player.
 *
 * `Monster.levels` is `Omit<CombatLevels, 'Prayer'>` (`monsters.d.ts:103`) and
 * `Character.levels` is `CombatLevels` (`character.d.ts:101`), so one reader
 * serves both — which is the whole point of screening on these numbers rather
 * than on `combatLevel`.
 *
 * Corruption is deliberately not read: `MonsterData.levels` marks it optional
 * (`monsters.d.ts:22`), so a monster without it would read as zero and be
 * indistinguishable from one that has it at zero.
 */
function readSkillLevels(levels: Omit<CombatLevels, 'Prayer'>): CombatSkillLevels {
  return {
    attack: numberOrZero(levels.Attack),
    strength: numberOrZero(levels.Strength),
    defence: numberOrZero(levels.Defence),
    hitpoints: numberOrZero(levels.Hitpoints),
    ranged: numberOrZero(levels.Ranged),
    magic: numberOrZero(levels.Magic),
  };
}

/** Undefined and NaN both mean "not read"; the screen refuses on an all-zero record. */
function numberOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Equipment stat keys that make a monster hit harder. */
const DAMAGE_BONUS_KEYS = new Set([
  'meleeStrengthBonus',
  'rangedStrengthBonus',
  'magicDamageBonus',
]);

/**
 * The largest damage bonus on a monster's equipment.
 *
 * `Monster.equipmentStats` is `AnyEquipStat[]` (`monsters.d.ts:104`) — a list of
 * `{ key, value }` pairs whose keys are `EquipStatKey` or the damage-typed
 * `resistance` / `summoningMaxhit` (`character.d.ts:445-479`), not the
 * `EquipmentStats` object a `Character` carries. So it is filtered by key
 * rather than read by field.
 *
 * Reported by the screen, never gated on: see `screenByCombatSkillLevels`.
 */
function readMonsterDamageBonus(monster: Monster): number {
  let best = 0;
  for (const stat of monster.equipmentStats) {
    if (DAMAGE_BONUS_KEYS.has(stat.key)) best = Math.max(best, numberOrZero(stat.value));
  }
  return best;
}

/**
 * Assembles the inputs for the level screen.
 *
 * Reads only. The judgement is `screenByCombatSkillLevels`, which is pure and
 * lives in the policy tier so it can be tested without a game.
 *
 * Every monster of a dungeon is carried through rather than summarised here:
 * the screen judges a target by its worst inhabitant and has to be able to name
 * which one that was, or its refusals are unarguable.
 *
 * A monster whose levels throw is recorded by name in `unreadableMonsters`
 * rather than skipped. Skipping would judge a dungeon by the monsters that
 * happened to read, which is the same failure as judging it by its first.
 *
 * @param targetId - A monster id or a dungeon id.
 * @returns Screen inputs, or null when the target is not registered at all.
 */
export function readCombatLevelScreenInputs(targetId: string): CombatLevelScreenInputs | null {
  const monster = game.monsters.getObjectByID(targetId);
  const dungeon = monster === undefined ? game.dungeons.getObjectByID(targetId) : undefined;

  const inhabitants = monster !== undefined ? [monster] : (dungeon?.monsters ?? []);
  if (inhabitants.length === 0) return null;

  const monsters: CombatLevelScreenInputs['monsters'] = [];
  const unreadableMonsters: string[] = [];

  for (const inhabitant of inhabitants) {
    try {
      monsters.push({
        name: inhabitant.name,
        levels: readSkillLevels(inhabitant.levels),
        strengthBonus: readMonsterDamageBonus(inhabitant),
      });
    } catch (error) {
      unreadableMonsters.push(`${inhabitant.id} (${String(error)})`);
    }
  }

  // A target every one of whose monsters failed to read still has to reach the
  // screen, because the screen is where "unmeasurable" becomes a refusal with a
  // reason attached. An empty list cannot express that, so a placeholder does.
  if (monsters.length === 0) {
    monsters.push({
      name: dungeon?.name ?? targetId,
      levels: { attack: 0, strength: 0, defence: 0, hitpoints: 0, ranged: 0, magic: 0 },
      strengthBonus: 0,
    });
  }

  const player = game.combat.player;
  const equipment = player.equipmentStats;

  return {
    targetId,
    targetName: dungeon?.name ?? monster?.name ?? targetId,
    isDungeon: dungeon !== undefined,
    player: readSkillLevels(player.levels),
    // The weakest of the three, because an enemy of the wrong attack type finds
    // it and the screen must not be flattered by the two it does not attack.
    playerDefenceBonus: Math.min(
      numberOrZero(equipment.meleeDefenceBonus),
      numberOrZero(equipment.rangedDefenceBonus),
      numberOrZero(equipment.magicDefenceBonus),
    ),
    monsters,
    unreadableMonsters,
  };
}

/**
 * The player's hitpoints, read live.
 *
 * The eat reflex was taking these from the snapshot, which refreshes only when
 * the mod reports. Two consequences, and the second is the serious one: it
 * retried an eat it had already done — "already at full hitpoints; eating would
 * waste the item" — and, in the other direction, it could read a healthy figure
 * for a character that had since been hurt, and decline to eat at all.
 *
 * The whole point of the reflex tier is reacting faster than a planning cycle,
 * which it cannot do from a number a planning cycle produced.
 */
export function readPlayerHitpoints(): { hitpoints: number; maxHitpoints: number } {
  const player = game.combat.player;

  return { hitpoints: player.hitpoints, maxHitpoints: player.stats.maxHitpoints };
}

/**
 * Assembles the inputs for the survivability gate.
 *
 * Reads only; makes no decision. The decision is `assessSurvivability`, which is
 * pure and lives in the policy tier so it can be tested exhaustively.
 *
 * Outside combat this always fails, because {@link probeMonsterStats} always
 * fails: the game's own `computeCombatStats` yields NaN for a detached enemy.
 * {@link readCombatLevelScreenInputs} is what actually runs before a fight.
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

/** The slot ranged ammunition occupies; see `EquipmentSlotIDs` in the typings. */
const QUIVER_SLOT_ID = 'melvorD:Quiver';

/**
 * Why this fight cannot be fought, or null if it can.
 *
 * Two ways to walk into a fight unable to throw a punch, and the agent found
 * both in one session. Ranged with an empty quiver; magic with a staff but no
 * spell selected. Each produced the same picture: engage succeeds, the state
 * reads "Doing: Combat", health stays full, and nothing else moves — no kills,
 * no XP, no runes spent — for as long as anyone leaves it.
 *
 * Nothing lied in either case. Engaging genuinely succeeded, because the
 * evidence for engaging is deliberately "the game committed to this fight"
 * rather than "punches have been thrown" — the enemy spawns a tick later, and
 * requiring `isActive` once reported every successful engage as a no-op. A
 * fight that can never start looks exactly like one that is about to. That gap
 * is what a precondition is for, and the general lesson is that *being able to
 * attack* is state, as much as health or ammunition, and nothing was checking
 * it.
 */
function cannotAttackRefusal(): string | null {
  const player = game.combat.player;

  if (player.attackType === 'ranged') {
    const quiver = player.equipment.equippedItems[QUIVER_SLOT_ID];
    const held = quiver === undefined || quiver.item === quiver.emptyItem ? 0 : quiver.quantity;
    if (held <= 0) {
      return 'the quiver is empty and the equipped weapon is ranged, so no attack can land';
    }
  }

  if (player.attackType === 'magic') {
    // Equipping a staff is only half of arming a mage. The other half — a
    // selected spell, and runes to pay for it — has no slot and no inventory
    // entry, so it is invisible in every projection the agent takes.
    const spell = player.spellSelection.attack;
    if (spell === undefined) {
      return 'the weapon is a staff but no attack spell is selected, so no attack can be cast';
    }

    // Checking only that a spell is *selected* was the wrong half of the
    // question, and it would have missed the failure it was written for. Wind
    // Strike was selected the whole time; what was missing were the Mind Runes
    // it spends, sold earlier as spare change. A selected spell with no runes
    // is exactly as unfireable as no spell at all, and just as quiet.
    const missing = spell.runesRequired.filter(
      (rune) => game.bank.getQty(rune.item) < rune.quantity,
    );
    if (missing.length > 0) {
      const names = missing.map((rune) => `${rune.quantity}x ${rune.item.name}`).join(', ');
      return `${spell.name} is selected but the bank cannot pay for it (needs ${names})`;
    }
  }

  return null;
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
        const cannotAttack = cannotAttackRefusal();
        if (cannotAttack !== null) return cannotAttack;
        const active = game.activeAction;
        if (active !== undefined) return `another action is running: ${active.id}`;
        return null;
      },
      perform: () => game.combat.selectMonster(monster, area),
      // Combat does not become active within the same instant the call
      // returns: the enemy spawns on a later tick. So the evidence taken is
      // that the game has committed to this fight — the area is selected and
      // this monster is the enemy — rather than that punches have been thrown.
      // Requiring `isActive` here reported every successful engage as a
      // no-op, and five of those abandoned the objective.
      changed: (_before, after) =>
        after.areaId === areaId && (after.inCombat || after.monsterId === monsterId),
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
        const cannotAttack = cannotAttackRefusal();
        if (cannotAttack !== null) return cannotAttack;
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
  /**
   * The highest skill level this fight's entry requirements ask for.
   *
   * Always a requirement the character already meets -- an area that fails
   * `checkRequirements` is not enumerated at all -- so this is stated rather
   * than gating, exactly as `requiresLevel` is for every other candidate. It
   * exists because a fight with no level on it reads as free, and "free" sorts
   * a Chicken level with a Slayer-gated area.
   */
  requiresLevel?: number | undefined;
  /** Kills still owed on the active Slayer task, when this is that monster. */
  slayerKillsLeft?: number;
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

  // First, and deduplicated against the general sweep below.
  //
  // Taking a Slayer task blocks every future task until it is finished, and
  // nothing turned the assigned monster into a fight. So the agent could take a
  // task, close the only door Slayer XP comes through, and have no candidate
  // that opens it again -- a self-inflicted deadlock built out of two features
  // that each worked.
  //
  // Prepending rather than annotating in place: the assigned monster is usually
  // not among the three easiest in its area, so it was frequently not emitted
  // at all.
  const assigned = readSlayerTaskTarget();
  if (assigned !== null) targets.push(assigned);

  const areas = [...game.combatAreas.allObjects, ...game.slayerAreas.allObjects];
  for (const area of areas) {
    if (isRefusedRealm(area.realm.id)) continue;
    if (!game.checkRequirements(area.entryRequirements, false)) continue;

    const byLevel = [...area.monsters].sort((a, b) => combatLevelOf(a) - combatLevelOf(b));
    for (const monster of byLevel.slice(0, MONSTERS_PER_AREA)) {
      if (monster.id === assigned?.id) continue;
      targets.push({
        kind: 'fight_monster',
        id: monster.id,
        areaId: area.id,
        name: monster.name,
        areaName: area.name,
        combatLevel: combatLevelOf(monster),
        requiresLevel: levelRequirementOf(area.entryRequirements),
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
      requiresLevel: levelRequirementOf(dungeon.entryRequirements),
    });
  }

  return targets;
}

/**
 * The monster an accepted Slayer task is asking for.
 *
 * The missing half of Slayer. `newSlayerTask` takes a task and
 * `readSlayerCandidates` then correctly returns nothing while one is active --
 * taking another discards the kills already made -- so an accepted task removed
 * every Slayer candidate and put none back. The task's own monster
 * (slayer.d.ts:106) was the one thing that could have advanced it, and nothing
 * read it.
 *
 * The area is resolved rather than assumed: `SlayerTask` names a monster and not
 * a place, while `engageMonster` needs both. Slayer areas are searched first,
 * then ordinary combat areas that set `allowSlayerKills` — the game's own flag
 * for "kills here count toward a Slayer task" (combatAreas.d.ts:353). Tasks are
 * assigned by combat level rather than by area, so a low-level task monster
 * genuinely can live outside a Slayer area, and searching only one registry
 * would have reproduced the same dead end one level down.
 *
 * Enterability is checked here, not left to the engage call, because a candidate
 * is by definition something the mod has proven it can execute now. A task whose
 * area is gated is a real situation and it belongs in the blocked list rather
 * than in a candidate that refuses every time it is chosen.
 *
 * @returns The assigned fight, or null when no task is active or it cannot be reached.
 */
export function readSlayerTaskTarget(): CombatTarget | null {
  try {
    const task = game.combat.slayerTask;
    if (!task.active) return null;

    const monster = task.monster;
    if (monster === undefined) return null;

    const reachable = (candidate: CombatArea): boolean =>
      candidate.monsters.includes(monster) &&
      !isRefusedRealm(candidate.realm.id) &&
      game.checkRequirements(candidate.entryRequirements, false);

    const area =
      game.slayerAreas.allObjects.find(reachable) ??
      game.combatAreas.allObjects.find(
        (candidate) => candidate.allowSlayerKills && reachable(candidate),
      );
    if (area === undefined) return null;

    return {
      kind: 'fight_monster',
      id: monster.id,
      areaId: area.id,
      name: monster.name,
      areaName: area.name,
      combatLevel: combatLevelOf(monster),
      requiresLevel: levelRequirementOf(area.entryRequirements),
      // Zero would be indistinguishable from "not a task monster" downstream,
      // and a task with no kills left is one the game has already finished.
      slayerKillsLeft: Math.max(1, task.killsLeft),
    };
  } catch {
    // A task that cannot describe itself is not a candidate; the blocked list
    // still explains why Slayer is offering nothing.
    return null;
  }
}

/**
 * The highest skill level a set of entry requirements asks for.
 *
 * `AnyRequirement` is a union (requirements.d.ts:371); only
 * `SkillLevelRequirement` carries a level, and it identifies itself with a
 * literal `type` of `'SkillLevel'` alongside `skill` and `level`
 * (requirements.d.ts:52-56). Everything else -- a dungeon completion, an item
 * held -- is deliberately ignored rather than flattened into a number, because
 * a fake level would be worse than an absent one.
 *
 * @returns The level, or undefined when nothing asks for one.
 */
function levelRequirementOf(requirements: readonly AnyRequirement[]): number | undefined {
  try {
    let highest = 0;
    for (const requirement of requirements) {
      if (requirement.type !== 'SkillLevel') continue;
      highest = Math.max(highest, numberOrZero(requirement.level));
    }
    return highest > 0 ? highest : undefined;
  } catch (error) {
    noteSwallowed('combat.levelRequirementOf', error);
    return undefined;
  }
}

// --- pricing ---------------------------------------------------------------

/** A fight priced: the numbers that separate one monster from another. */
export interface FightPricing {
  /** Appended to the candidate's label. Empty when nothing could be priced. */
  note: string;
  /**
   * GP the kills pay straight into the balance over an hour.
   *
   * Coins only. What the drops would fetch is named in {@link note} instead,
   * because an hour of banking gems moves the balance by exactly zero and the
   * candidate's `gpIsEarned` flag exists to keep those two claims apart.
   */
  gpPerHour: number;
}

/**
 * Prices one monster fight.
 *
 * The join between {@link readFightRate}, which says how fast kills come, and
 * `killValueFor`, which says what a kill is worth. Neither belongs here: rate
 * maths lives in `rates.ts` and value maths in `pricing.ts`, and this only
 * turns them into a line a planner can read.
 *
 * Runs *after* the survivability gate and the level screen, never instead of
 * them. Pricing a fight is not a route to taking it: an unsurvivable monster is
 * refused before this is ever called, and a priced number must never be
 * mistakable for a permit. That ordering is enforced by the caller, which
 * builds a blocked entry and moves on before reaching this.
 *
 * @param monsterId - The monster to price.
 * @returns Its rate and worth, or null when a term could not be read.
 */
export function readFightPricing(monsterId: string): FightPricing | null {
  const monster = game.monsters.getObjectByID(monsterId);
  if (monster === undefined) return null;

  const rate = readFightRate(monster);
  if (rate === null) return null;

  const value = killValueFor(monster);
  const parts = [
    `${Math.round(rate.hitpoints).toLocaleString()} HP (defence ${rate.defenceLevel})`,
    // "~" throughout, because every attack is assumed to land: the hit chance
    // against a specific monster cannot be read outside combat. See the note on
    // FightRate for why the Defence level above is the correction axis.
    `~${round(rate.killsPerHour)} kills/h`,
    `~${round(rate.damagePerHour)} damage/h${describeTrainedSkills()}`,
  ];

  if (value.bones !== null) {
    // Prayer has exactly one input and this is it, so a fight that supplies it
    // is a different offer from one that does not -- and `prayer-20` is open.
    const each = value.bones.quantity === 1 ? '' : `${value.bones.quantity}x `;
    parts.push(`${each}${value.bones.name} every kill`);
  }

  const lootPerHour = value.lootGpPerKill * rate.killsPerHour;
  if (lootPerHour > 0) parts.push(`drops worth ~${round(lootPerHour)} gp/h if sold`);

  return {
    note: ` — ${parts.join(', ')}`,
    gpPerHour: value.gpPerKill * rate.killsPerHour,
  };
}

/**
 * How long one run of a dungeon takes, and what it is worth.
 *
 * A dungeon is every one of its monsters in sequence, so it is priced as the
 * sum rather than by its hardest inhabitant -- the hardest one decides whether
 * the run is *survivable*, which is a different question and already answered
 * by the gate. Reporting only the boss would have priced a twenty-monster
 * dungeon as one fight.
 *
 * One unpriceable monster abandons the whole figure, for the same reason
 * `worstCaseStats` refuses a dungeon with one unmeasurable monster: a total
 * over the monsters that happened to read is not a total.
 */
export function readDungeonPricing(dungeonId: string): FightPricing | null {
  const dungeon = game.dungeons.getObjectByID(dungeonId);
  if (dungeon === undefined || dungeon.monsters.length === 0) return null;

  let seconds = 0;
  let damage = 0;
  let gp = 0;
  let loot = 0;

  for (const monster of dungeon.monsters) {
    const rate = readFightRate(monster);
    if (rate === null) return null;

    const value = killValueFor(monster);
    seconds += rate.secondsPerKill;
    damage += rate.hitpoints;
    gp += value.gpPerKill;
    loot += value.lootGpPerKill;
  }

  if (!(seconds > 0)) return null;
  const runsPerHour = 3600 / seconds;

  const parts = [
    `${dungeon.monsters.length} monsters, ${Math.round(damage).toLocaleString()} HP in total`,
    `~${Math.round(seconds / 60)} min per run`,
    `~${round(damage * runsPerHour)} damage/h${describeTrainedSkills()}`,
  ];
  if (loot > 0) parts.push(`drops worth ~${round(loot * runsPerHour)} gp/h if sold`);

  return { note: ` — ${parts.join(', ')}`, gpPerHour: gp * runsPerHour };
}

/** Rounded and grouped, the way every other rate on the board is written. */
function round(value: number): string {
  return Math.round(value).toLocaleString();
}

/**
 * Which skills the damage will actually land in.
 *
 * `Player.getExperienceGainSkills()` (player.d.ts:426) is the game's own answer
 * for the selected attack style, so nothing has to be inferred from a weapon or
 * a style name. It is worth naming on every fight because the style is the
 * single lever on four open goals -- `ranged-20`, `defence-20`, `hp-40` and
 * Attack 40 for `first-dungeon` -- and a damage rate with no destination cannot
 * tell the planner whether a fight advances any of them.
 */
function describeTrainedSkills(): string {
  const skills = safeValue('combat.experienceGainSkills', () =>
    game.combat.player.getExperienceGainSkills(),
  );
  if (skills === undefined || skills.length === 0) return '';

  return ` into ${skills.map((skill) => skill.name).join(' and ')}`;
}

/** `combatLevel` is a getter that can throw on malformed modded monsters. */
function combatLevelOf(monster: Monster | undefined): number {
  if (monster === undefined) return Number.POSITIVE_INFINITY;
  try {
    const level = monster.combatLevel;
    return Number.isFinite(level) ? level : Number.POSITIVE_INFINITY;
  } catch (error) {
    noteSwallowed('combat.combatLevelOf', error);
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

// --- loot ------------------------------------------------------------------

/** What collecting loot claims to change. */
export interface LootProjection {
  pending: number;
  bankSlotsUsed: number;
}

/**
 * Collects everything in the combat loot container.
 *
 * Kills drop into a container that holds a fixed number of stacks and then
 * starts *discarding* — the game tracks what was lost in `lostLoot`. Nothing
 * announces this: the fight looks healthy, the XP keeps coming, and every drop
 * silently evaporates. An agent fighting unattended for hours would collect
 * nothing at all, which makes combat pure XP and no materials.
 *
 * That matters beyond the items: bones feed Prayer, hides feed Crafting, and
 * the Township tasks ask for monster drops by name.
 */
export function collectLoot(isSuspended: () => boolean): ActionResult<LootProjection> {
  const project = (): LootProjection => ({
    pending: game.combat.loot.drops.length,
    bankSlotsUsed: game.bank.occupiedSlots,
  });

  return act(
    {
      name: 'combat.loot',
      observe: project,
      precondition: () => {
        if (game.combat.loot.drops.length === 0) return 'nothing to loot';
        if (game.bank.occupiedSlots >= game.bank.maximumSlots) {
          // Looting into a full bank drops the items instead of banking them,
          // which is worse than leaving them in the container where they at
          // least remain until it overflows.
          return 'bank is full; looting now would discard the drops';
        }
        return null;
      },
      perform: () => game.combat.loot.lootAll(),
      changed: (before, after) => after.pending < before.pending,
    },
    isSuspended,
  );
}

/** How many stacks may sit in the container before drops start being lost. */
const LOOT_COLLECT_THRESHOLD = 4;

/** Whether loot is worth collecting now. */
export function shouldCollectLoot(): boolean {
  try {
    const loot = game.combat.loot;
    return loot.drops.length >= Math.min(LOOT_COLLECT_THRESHOLD, loot.maxLoot);
  } catch (error) {
    noteSwallowed('combat.shouldCollectLoot', error);
    return false;
  }
}

/**
 * Runes that an attack spell the character could cast actually requires.
 *
 * Selling these is how Magic became unreachable. A bank-clearing pass sold all
 * 81 Mind Runes with the note "not the runes Township wants" — true, and beside
 * the point: the basic strike spells take a Mind Rune as catalyst alongside the
 * elemental one, so the stack that looked like spare change was half of every
 * castable spell. The failure surfaced much later and in a completely different
 * place: a staff equipped, 821 Air Runes banked, and a fight that could not
 * land a cast.
 *
 * Deliberately restricted to spells within the character's Magic level. Runes
 * for spells decades away are genuinely surplus, and a guard that protects
 * everything protects nothing — the bank filling up has stalled this agent
 * repeatedly, and selling is the planner's lever for that.
 */
export function readSpellRuneIds(): Set<string> {
  const runes = new Set<string>();
  const magicLevel = game.skills.getObjectByID('melvorD:Magic')?.level ?? 0;

  try {
    for (const spell of game.attackSpells.allObjects) {
      if (spell.level > magicLevel) continue;
      for (const rune of spell.runesRequired) runes.add(rune.item.id);
    }
  } catch (error) {
    noteSwallowed('combat.readSpellRuneIds', error);
    // Failing to protect a rune beats failing to build the sell list at all.
  }

  return runes;
}

/**
 * What a monster drops that the agent is currently short of.
 *
 * Dumping monster loot made it knowable; this makes it *reachable*. Knowing
 * that Bob the Farmer drops Potato Seeds is only useful if something connects
 * "Farming is blocked on this item" to "here is a fight that produces it" —
 * otherwise every fight candidate reads identically and the planner picks by
 * combat level, which is a proxy for danger, not for value.
 *
 * The comparison is against items the agent already knows it wants: what an
 * open Township task is asking for, and seeds it holds too few of to plant.
 * Deliberately not "everything in the bank is low" — a note attached to every
 * monster is the same as no note at all.
 *
 * @param wanted - Item ids the agent is short of.
 * @returns Names of wanted items this monster drops, empty when none.
 */
export function readMonsterDropsOfInterest(
  monsterId: string,
  wanted: ReadonlySet<string>,
): string[] {
  if (wanted.size === 0) return [];

  try {
    const monster = game.monsters.getObjectByID(monsterId);
    if (monster === undefined) return [];

    const names: string[] = [];
    for (const drop of monster.lootTable.drops) {
      if (wanted.has(drop.item.id)) names.push(drop.item.name);
    }

    const bones = monster.bones?.item;
    if (bones !== undefined && wanted.has(bones.id)) names.push(bones.name);

    return names;
  } catch (error) {
    noteSwallowed('combat.readMonsterDropsOfInterest', error);
    // A monster whose table cannot be read is not annotated, rather than
    // annotated wrongly.
    return [];
  }
}

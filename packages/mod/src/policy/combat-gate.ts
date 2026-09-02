import type {
  CombatGateInputs,
  CombatGateVerdict,
  CombatLevelScreenInputs,
  CombatLevelScreenVerdict,
  CombatSkillLevels,
  GateRefusal,
  LevelScreenRefusal,
} from '@melvor-agent/shared';

/**
 * Safety margin on the one-shot check.
 *
 * The brief asks for the enemy's max hit to be "comfortably" below the auto-eat
 * trigger, not merely below it. A hit that lands exactly on the threshold does
 * not leave auto eat a turn to react, and max hit is itself an upper bound that
 * special attacks and effects can exceed. 60% is the comfort.
 */
const ONE_SHOT_SAFETY_FACTOR = 0.6;

/**
 * Healing must outpace incoming damage by this much.
 *
 * Parity would mean surviving only if every roll is average, and combat is not
 * average — it is a sequence of rolls, some of which are the max hit.
 */
const HEALING_MARGIN = 1.5;

/** Food must cover the intended session with this much slack. */
const FOOD_MARGIN = 1.25;

/**
 * Decides whether combat is survivable.
 *
 * Deterministic and pure: this is the hard gate the planner gets no vote on.
 * Any nonzero death chance is a refusal, so every check is a conjunction and
 * the failure list is complete rather than short-circuited — a dry run should
 * show every reason at once, not force the operator to fix them one at a time.
 *
 * The two conditions from the brief, made precise:
 *
 * 1. **Cannot be one-shot.** The enemy's max hit, after damage reduction, must
 *    sit below `ONE_SHOT_SAFETY_FACTOR × autoEatThreshold × maxHP`. Auto eat
 *    fires *at* the threshold, so anything landing above it can take the player
 *    from healthy to dead without auto eat ever getting a turn.
 * 2. **Can sustain.** Auto-eat healing throughput must exceed incoming DPS with
 *    margin, and the equipped food must cover the intended session with margin.
 *
 * @param inputs - Numbers read from the game by the adapter.
 * @returns A verdict carrying its own workings, so a dry run is inspectable.
 */
/**
 * Where the manual-eat reflex triggers, as a fraction of max HP.
 *
 * Must match {@link MANUAL_EAT_THRESHOLD} in the reflex. The gate promises the
 * character will eat at this point; the reflex is what keeps that promise, and
 * a mismatch would make the gate's arithmetic describe a character that does
 * not exist.
 */
const MANUAL_EAT_THRESHOLD_FRACTION = 0.6;

/** How often reflexes run. Bounds how fast the character can eat by hand. */
const REFLEX_INTERVAL_SECONDS = 1;

export function assessSurvivability(inputs: CombatGateInputs): CombatGateVerdict {
  const refusals: { reason: GateRefusal; detail: string }[] = [];

  const damageMultiplier = Math.max(0, 1 - inputs.playerDamageReductionPercent / 100);
  const effectiveEnemyMaxHit = inputs.enemyMaxHit * damageMultiplier;

  // Without Auto Eat the character still eats — a reflex does it, the way a
  // human clicks food. It is worse in two specific ways, and both are modelled
  // rather than waved away: it triggers at a fixed fraction of max HP, and it
  // only looks once a second, so a fast enemy lands free hits between checks.
  const hasAutoEat = inputs.autoEatThresholdFraction > 0;
  const eatThresholdFraction = hasAutoEat
    ? inputs.autoEatThresholdFraction
    : MANUAL_EAT_THRESHOLD_FRACTION;
  const eatEfficiency = hasAutoEat ? inputs.autoEatEfficiencyFraction : 1;

  const oneShotCeiling = eatThresholdFraction * inputs.playerMaxHitpoints * ONE_SHOT_SAFETY_FACTOR;

  // Expected damage per second, using hit chance so a low-accuracy enemy is not
  // over-penalised. The one-shot check above covers the worst case separately.
  const incomingDps =
    (effectiveEnemyMaxHit * inputs.enemyHitChance) / (inputs.enemyAttackIntervalMs / 1000);

  const healPerFood = inputs.foodHealPerItem * eatEfficiency;

  // Auto eat restores at most the band between its trigger threshold and its
  // HP limit, so a huge food item is wasted above that ceiling.
  // Auto eat tops up to its HP limit; eating by hand restores one item's worth
  // and no more, so there is no band to cap it against.
  const healBand = hasAutoEat
    ? Math.max(
        0,
        (inputs.autoEatHpLimitFraction - inputs.autoEatThresholdFraction) *
          inputs.playerMaxHitpoints,
      )
    : 0;
  const effectiveHealPerEat = healBand > 0 ? Math.min(healPerFood, healBand) : healPerFood;

  const secondsPerAttack = inputs.enemyAttackIntervalMs / 1000;

  // The binding constraint is per enemy attack, not per second in aggregate:
  // auto eat gets at most one trigger between incoming hits, so healing has to
  // outpace damage on that cadence. Comparing aggregate rates would let a slow
  // enemy with a huge hit look sustainable when a single exchange is lethal.
  // Auto eat gets one trigger between incoming hits. The reflex gets one per
  // tick, so against anything faster than the tick it is the tick that binds —
  // which is exactly why fighting without Auto Eat is harder, not merely
  // slower.
  const secondsPerEat = hasAutoEat
    ? secondsPerAttack
    : Math.max(secondsPerAttack, REFLEX_INTERVAL_SECONDS);
  const healingThroughput = effectiveHealPerEat / secondsPerEat;

  // How long the equipped food lasts at the rate combat consumes it.
  const eatsPerSecond =
    effectiveHealPerEat > 0 ? incomingDps / effectiveHealPerEat : Number.POSITIVE_INFINITY;
  const foodSecondsAvailable =
    eatsPerSecond > 0 && Number.isFinite(eatsPerSecond)
      ? inputs.foodQuantity / eatsPerSecond
      : Number.POSITIVE_INFINITY;

  const sessionSecondsRequired = inputs.intendedSessionMinutes * 60 * FOOD_MARGIN;

  // An enemy that appears to hit for nothing, or never to attack, has not been
  // measured — it has failed to be measured. Zero reads as harmless through
  // every check below (nothing to survive, no damage to out-heal), so without
  // this the gate approves the hardest content in the game for a level 3
  // character. Unmeasurable must mean refused, never safe.
  if (inputs.enemyMaxHit <= 0 || inputs.enemyAttackIntervalMs <= 0) {
    refusals.push({
      reason: 'unmeasurable',
      detail:
        `enemy stats did not measure (max hit ${inputs.enemyMaxHit}, ` +
        `attack interval ${inputs.enemyAttackIntervalMs}ms); refusing rather than assuming it is harmless`,
    });
  }

  if (inputs.foodQuantity <= 0 || inputs.foodHealPerItem <= 0) {
    refusals.push({
      reason: 'no_food_equipped',
      detail: `food quantity ${inputs.foodQuantity}, heal per item ${inputs.foodHealPerItem}`,
    });
  }

  if (effectiveEnemyMaxHit >= oneShotCeiling) {
    refusals.push({
      reason: 'can_be_one_shot',
      detail:
        `enemy hits ${effectiveEnemyMaxHit.toFixed(1)} after ${inputs.playerDamageReductionPercent}% reduction, ` +
        `ceiling is ${oneShotCeiling.toFixed(1)} (${(ONE_SHOT_SAFETY_FACTOR * 100).toFixed(0)}% of the auto-eat trigger)`,
    });
  }

  if (incomingDps > 0 && healingThroughput < incomingDps * HEALING_MARGIN) {
    refusals.push({
      reason: 'insufficient_healing_throughput',
      detail: `healing ${healingThroughput.toFixed(1)}/s vs incoming ${incomingDps.toFixed(1)}/s, need ${HEALING_MARGIN}x`,
    });
  }

  if (foodSecondsAvailable < sessionSecondsRequired) {
    refusals.push({
      reason: 'insufficient_food_stock',
      detail:
        `food covers ${Math.round(foodSecondsAvailable)}s, ` +
        `session needs ${Math.round(sessionSecondsRequired)}s including ${FOOD_MARGIN}x margin`,
    });
  }

  return {
    safe: refusals.length === 0,
    refusals,
    workings: {
      effectiveEnemyMaxHit,
      oneShotCeiling,
      incomingDps,
      healingThroughput,
      foodSecondsAvailable: Number.isFinite(foodSecondsAvailable) ? foodSecondsAvailable : 0,
      sessionSecondsRequired,
    },
  };
}

/**
 * Normalises a value the game may express as either a fraction or a percent.
 *
 * The auto-eat getters are documented only by name, and whether
 * `autoEatThreshold` returns `40` or `0.4` is not stated anywhere in the
 * typings or the wiki. Getting this wrong by 100x in the unsafe direction would
 * be catastrophic, so anything above 1 is treated as a percentage. A real
 * threshold is never above 100% of max HP, which makes the heuristic safe in
 * both directions.
 *
 * Flagged in learnings/ as needing in-game confirmation.
 */
export function normaliseFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? value / 100 : value;
}

// --- the level screen ------------------------------------------------------

/**
 * How far a single monster's offensive levels may exceed the character's
 * defensive ones before the fight is refused.
 *
 * Above parity, because a fight that is merely uphill is how combat skills are
 * trained, and against a single monster the screen is not the last word:
 * `abandonIfOutmatched` reads the enemy's real max hit a tick after the fight
 * starts and disengages if it is too big. The screen only has to catch what is
 * plainly out of reach.
 */
const MONSTER_LEVEL_ALLOWANCE = 1.5;

/**
 * The same allowance for a dungeon, and it is parity rather than 1.5.
 *
 * Stricter because the live backstop does not apply: abandoning a Melvor
 * dungeon partway restarts it from the beginning, so `abandonIfOutmatched`
 * firing on floor nine costs the whole run rather than saving it. A dungeon is
 * a commitment, and this screen is the last point at which it can be declined
 * cheaply.
 */
const DUNGEON_LEVEL_ALLOWANCE = 1.0;

/**
 * How far a monster's Hitpoints level may exceed the character's best offensive
 * level before the fight is flagged as possibly unwinnable.
 *
 * A note, never a refusal. Failing to *kill* something is not lethal — it is an
 * hour of runes and no drops, which is the Golbin failure in
 * `learnings/README.md`, and the honest answer to that is a counter that does
 * not move rather than a threshold invented here.
 */
const STALL_RATIO = 5;

/**
 * Screens a fight by comparing combat skill levels on both sides.
 *
 * This replaces a screen that compared `Monster.combatLevel` with
 * `Game.playerCombatLevel` and required the monster to be at most half the
 * player. Those are not one scale — see `combatSkillLevelsSchema` in
 * `@melvor-agent/shared` — and the arithmetic made every dungeon in the game
 * unreachable by construction: "Into the Abyss", whose hardest monster is
 * combat level 626, would have needed a player combat level of 1,252, which no
 * character can reach. A gate that refuses everything and a gate that refuses
 * nothing are equally useless, and that one was the former while presenting
 * itself as a safety feature.
 *
 * What is compared here is like with like. `Monster.levels`
 * (`monsters.d.ts:103`) and `Character.levels` (`character.d.ts:101`) are the
 * same `CombatLevels` record, so the monster's best offensive level and the
 * character's defensive levels are numbers of the same kind. No part of the
 * game's damage formulas is reimplemented, because doing that is how a safety
 * check quietly becomes fiction.
 *
 * What it cannot do is prove survivability, and it says so rather than
 * implying otherwise: `uncertainties` carries what the screen is blind to, so a
 * pass reads as "nothing here looks lethal" and not as "this is safe".
 * Equipment bonuses are reported for the same reason — they are real numbers on
 * comparable keys, but no threshold for them can be calibrated from the
 * typings or from `data/dump.json`, which captures neither monster levels nor
 * monster equipment stats, and an uncalibrated threshold is precisely the
 * defect this change exists to remove.
 *
 * Pure, so the whole judgement is testable without a game.
 *
 * @param inputs - Levels and equipment bonuses read by the adapter.
 * @returns The verdict, its workings, and what it could not see.
 */
export function screenByCombatSkillLevels(
  inputs: CombatLevelScreenInputs,
): CombatLevelScreenVerdict {
  const refusals: { reason: LevelScreenRefusal; detail: string }[] = [];
  const uncertainties: string[] = [];

  // The worst monster decides, for a dungeon and a single target alike. Judging
  // a dungeon by its first inhabitant is how a character dies on floor nine to
  // something the entrance gave no sign of.
  let hardest = inputs.monsters[0];
  let monsterOffensiveLevel = -1;
  let monsterHitpointsLevel = 0;
  let worstStrengthBonus = 0;

  for (const monster of inputs.monsters) {
    const offence = offensiveLevel(monster.levels);
    if (offence > monsterOffensiveLevel) {
      hardest = monster;
      monsterOffensiveLevel = offence;
    }
    monsterHitpointsLevel = Math.max(monsterHitpointsLevel, monster.levels.hitpoints);
    worstStrengthBonus = Math.max(worstStrengthBonus, monster.strengthBonus);
  }
  monsterOffensiveLevel = Math.max(0, monsterOffensiveLevel);

  const playerOffensiveLevel = offensiveLevel(inputs.player);

  // Defence keeps hits from landing; Hitpoints decides how many can land before
  // the character dies. Neither alone is what stands up to a monster, so the
  // screen uses their mean. That is our heuristic, stated as one — not a claim
  // about how Melvor computes anything, because Melvor does not say.
  const playerDefensiveLevel = (inputs.player.defence + inputs.player.hitpoints) / 2;

  const allowance = inputs.isDungeon ? DUNGEON_LEVEL_ALLOWANCE : MONSTER_LEVEL_ALLOWANCE;
  // Floored at 1 so a level-1 monster is never refused. Refusing a Chicken to a
  // character with levels in the teens is not caution, it is noise, and noise
  // is what made the previous screen ignorable.
  const ceiling = Math.max(1, playerDefensiveLevel * allowance);

  if (inputs.unreadableMonsters.length > 0) {
    refusals.push({
      reason: 'unmeasurable',
      detail: `could not read combat levels for ${inputs.unreadableMonsters.join(', ')}; one unmeasurable monster makes the whole target unmeasurable, and unmeasurable is refused rather than assumed harmless`,
    });
  }

  // All zeroes is the shape an unread record takes, and zero sails through
  // every comparison below as "harmless". A real character always has
  // Hitpoints, so zero on both defensive skills means the read failed.
  if (playerDefensiveLevel <= 0) {
    refusals.push({
      reason: 'unmeasurable',
      detail:
        "the character's Defence and Hitpoints levels both read 0, which is a failed read rather than a real character",
    });
  }

  if (monsterOffensiveLevel > ceiling) {
    refusals.push({
      reason: 'outmatched',
      detail:
        `${hardest?.name ?? inputs.targetName} attacks at combat skill level ${monsterOffensiveLevel} ` +
        `against Defence ${inputs.player.defence} / Hitpoints ${inputs.player.hitpoints} ` +
        `(ceiling ${ceiling.toFixed(1)}, ${allowance}x the mean of those two` +
        `${inputs.isDungeon ? '; held at parity because a dungeon cannot be abandoned without restarting it' : ''})`,
    });
  }

  uncertainties.push(
    'levels only: this screen models no equipment, special attack, passive or combat-triangle effect, so it can be wrong in both directions',
  );

  // Both numbers are real and comparable — an `EquipmentStats` key against
  // `EquipmentStats` keys — and neither has a threshold anyone can defend from
  // the available data, so they are printed rather than enforced.
  uncertainties.push(
    `equipment, ungated: the hardest monster's best damage bonus is ${worstStrengthBonus}, the character's weakest defence bonus is ${inputs.playerDefenceBonus}`,
  );

  if (monsterHitpointsLevel > Math.max(playerOffensiveLevel, 1) * STALL_RATIO) {
    uncertainties.push(
      `possibly unwinnable rather than lethal: Hitpoints level ${monsterHitpointsLevel} against the character's best offensive level ${playerOffensiveLevel}. Check that kills and drops actually accrue`,
    );
  }

  if (inputs.isDungeon) {
    uncertainties.push(
      'a dungeon cannot be left partway — abandoning restarts it — so the mid-fight backstop cannot rescue this one',
    );
  }

  const ok = refusals.length === 0;

  return {
    ok,
    refusals,
    uncertainties,
    workings: {
      hardestMonsterName: hardest?.name ?? '',
      monsterOffensiveLevel,
      monsterHitpointsLevel,
      playerDefensiveLevel,
      playerOffensiveLevel,
      allowance,
      ceiling,
    },
    detail: ok
      ? `${inputs.targetName}: hardest attacker ${hardest?.name ?? 'unknown'} at combat skill level ${monsterOffensiveLevel}, within the ceiling of ${ceiling.toFixed(1)}. Screened on levels only, not proven survivable`
      : refusals.map((refusal) => refusal.detail).join('; '),
  };
}

/**
 * The level a character actually attacks with.
 *
 * The maximum of the four offensive skills rather than the one matching its
 * attack type, because `MonsterData.attackType` may be the literal `'random'`
 * (`monsters.d.ts:26`): a monster that picks its style per fight has to be
 * screened against its best one.
 */
function offensiveLevel(levels: CombatSkillLevels): number {
  return Math.max(levels.attack, levels.strength, levels.ranged, levels.magic);
}

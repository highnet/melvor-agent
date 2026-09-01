import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';

/**
 * The management actions a human performs constantly and an agent could not.
 *
 * Everything here is a *decision applied to state* rather than an activity that
 * runs for an hour — spending a mastery pool, switching attack style, turning a
 * prayer on, drinking a potion. They take a second each and they compound, which
 * is exactly the category the brief singles out as the reason this project
 * exists: the game gives away the idle hours for free, so the value is in the
 * transitions between them.
 *
 * Mastery pool spending is the clearest case. Pool XP accrues automatically and
 * converts into mastery levels for nothing, so an agent that never spends it
 * leaves free progression on the table indefinitely.
 */

// --- mastery pool ----------------------------------------------------------

/** What spending the pool claims to change. */
export interface MasteryProjection {
  actionId: string;
  masteryLevel: number;
  poolXp: number;
}

/**
 * Spends mastery pool XP to raise an action's mastery level.
 *
 * Free progression: the pool fills on its own as the skill is trained, and
 * converting it costs nothing but the pool itself. A human does this whenever
 * they glance at the screen; an agent that cannot leaves it accumulating
 * forever.
 *
 * @param skillId - Skill owning the action.
 * @param actionId - The mastery action to level.
 * @param levels - How many levels to buy.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function spendMasteryPool(
  skillId: string,
  actionId: string,
  levels: number,
  isSuspended: () => boolean,
): ActionResult<MasteryProjection> {
  const skill = game.skills.getObjectByID(skillId) as
    | (AnySkill & {
        actions?: { getObjectByID(id: string): unknown };
        getMasteryLevel?: (action: object) => number;
        getMasteryPoolXP?: (realm: Realm) => number;
        levelUpMasteryWithPoolXP?: (action: object, levels: number) => void;
      })
    | undefined;

  if (skill === undefined) return fail('mastery.spend', 'precondition', `no skill ${skillId}`);
  if (typeof skill.levelUpMasteryWithPoolXP !== 'function') {
    return fail('mastery.spend', 'precondition', `${skillId} has no mastery pool`);
  }

  const action = skill.actions?.getObjectByID(actionId);
  if (action === undefined || action === null) {
    return fail('mastery.spend', 'precondition', `no action ${actionId} in ${skillId}`);
  }

  const project = (): MasteryProjection => ({
    actionId,
    masteryLevel: skill.getMasteryLevel?.(action) ?? 0,
    poolXp: skill.getMasteryPoolXP?.(game.currentRealm) ?? 0,
  });

  return act(
    {
      name: 'mastery.spend',
      observe: project,
      precondition: () => {
        if (!Number.isInteger(levels) || levels <= 0) {
          return `levels must be a positive integer, got ${levels}`;
        }
        if (project().poolXp <= 0) return `${skillId} mastery pool is empty`;
        return null;
      },
      perform: () => skill.levelUpMasteryWithPoolXP?.(action, levels),
      // The pool must fall *and* the level rise. A level rise alone would mean
      // ordinary training paid for it, not the pool.
      changed: (before, after) =>
        after.masteryLevel > before.masteryLevel && after.poolXp < before.poolXp,
    },
    isSuspended,
  );
}

/** Skills whose mastery pool has XP worth spending. */
export function readMasteryCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const skill of game.skills.allObjects) {
    const withMastery = skill as AnySkill & {
      getMasteryPoolXP?: (realm: Realm) => number;
      actions?: { allObjects: { id: string; name: string }[] };
      getMasteryLevel?: (action: object) => number;
      levelUpMasteryWithPoolXP?: unknown;
    };

    if (typeof withMastery.levelUpMasteryWithPoolXP !== 'function') continue;

    let poolXp = 0;
    try {
      poolXp = withMastery.getMasteryPoolXP?.(game.currentRealm) ?? 0;
    } catch {
      continue;
    }
    if (poolXp <= 0) continue;

    // Offer the least-mastered action: pool XP buys the most levels there, and
    // early mastery levels are where the bonuses actually bite.
    const actions = withMastery.actions?.allObjects ?? [];
    let lowest: { id: string; name: string } | undefined;
    let lowestLevel = Number.POSITIVE_INFINITY;

    for (const action of actions) {
      try {
        const level = withMastery.getMasteryLevel?.(action) ?? 0;
        if (level > 0 && level < lowestLevel) {
          lowestLevel = level;
          lowest = action;
        }
      } catch {
        // A mastery level that cannot be read is not a candidate.
      }
    }

    if (lowest === undefined) continue;

    candidates.push({
      kind: 'spend_mastery',
      params: { kind: 'spend_mastery', skillId: skill.id, actionId: lowest.id, levels: 1 },
      label: `Spend ${skill.name} mastery pool on ${lowest.name} (level ${lowestLevel}, ${Math.round(poolXp)} pool XP)`,
      available: true,
    });
  }

  return candidates;
}

// --- combat setup ----------------------------------------------------------

/**
 * Sets the attack style for a combat type.
 *
 * Which style is active decides which combat skill receives XP, so leaving it
 * on the default silently funnels everything into one skill. A human changes it
 * deliberately; without this the agent cannot train Defence at all.
 *
 * @param attackTypeId - `melee`, `ranged` or `magic`.
 * @param styleId - Namespaced `AttackStyle` id valid for that type.
 */
export function setAttackStyle(
  attackTypeId: string,
  styleId: string,
  isSuspended: () => boolean,
): ActionResult<{ styleId: string | undefined }> {
  const style = game.attackStyles.getObjectByID(styleId);
  if (style === undefined) {
    return fail('combat.setAttackStyle', 'precondition', `no attack style ${styleId}`);
  }
  if (attackTypeId !== 'melee' && attackTypeId !== 'ranged' && attackTypeId !== 'magic') {
    return fail('combat.setAttackStyle', 'precondition', `invalid attack type ${attackTypeId}`);
  }

  const player = game.combat.player;

  return act(
    {
      name: 'combat.setAttackStyle',
      observe: () => ({ styleId: player.attackStyle?.id }),
      precondition: () => {
        if (style.attackType !== attackTypeId) {
          return `${styleId} is a ${style.attackType} style, not ${attackTypeId}`;
        }
        if (game.combat.isActive) return 'in combat; refusing to change attack style';
        return null;
      },
      perform: () => player.setAttackStyle(attackTypeId, style),
      changed: (_before, after) => after.styleId === styleId,
    },
    isSuspended,
  );
}

/**
 * Turns a prayer on or off.
 *
 * `togglePrayer` returns `void`, and prayers silently refuse when the level
 * requirement is unmet, so the active set is observed either side.
 *
 * Deliberately not automatic: prayers drain prayer points, and points cost
 * bones. Leaving one on during idle training is a slow, invisible resource
 * leak, which is why this is an explicit decision rather than a reflex.
 */
export function togglePrayer(
  prayerId: string,
  isSuspended: () => boolean,
): ActionResult<{ active: string[] }> {
  const prayer = game.prayers.getObjectByID(prayerId);
  if (prayer === undefined) {
    return fail('combat.togglePrayer', 'precondition', `no prayer ${prayerId}`);
  }

  const player = game.combat.player;
  const project = (): { active: string[] } => ({
    active: [...player.activePrayers].map((active) => active.id).sort(),
  });

  return act(
    {
      name: 'combat.togglePrayer',
      observe: project,
      precondition: () =>
        player.prayerPoints <= 0 && !player.activePrayers.has(prayer)
          ? 'no prayer points; activating would do nothing'
          : null,
      perform: () => player.togglePrayer(prayer),
      changed: (before, after) => before.active.join() !== after.active.join(),
    },
    isSuspended,
  );
}

/**
 * Drinks a potion for the current activity.
 *
 * Potions are consumable and time-limited, so this is a decision with a cost
 * rather than a free buff — worth it before a long run of the thing it boosts,
 * wasteful otherwise.
 */
export function usePotion(
  itemId: string,
  isSuspended: () => boolean,
): ActionResult<{ potionId: string | null; charges: number }> {
  const item = game.items.potions.getObjectByID(itemId);
  if (item === undefined) return fail('potion.use', 'precondition', `no potion ${itemId}`);

  const project = (): { potionId: string | null; charges: number } => {
    const active = game.potions.activePotions.get(item.action);
    return {
      potionId: active?.item.id ?? null,
      charges: active?.charges ?? 0,
    };
  };

  return act(
    {
      name: 'potion.use',
      observe: project,
      precondition: () => (game.bank.getQty(item) <= 0 ? `bank holds no ${itemId}` : null),
      perform: () => game.potions.usePotion(item),
      changed: (before, after) =>
        after.potionId === itemId && (before.potionId !== itemId || after.charges > before.charges),
    },
    isSuspended,
  );
}

// --- slayer ----------------------------------------------------------------

/**
 * Takes a new Slayer task.
 *
 * Slayer is a progression system a human drives by hand: take a task, kill it,
 * take another. Without this the agent can fight monsters but can never earn
 * Slayer XP or the coins that unlock its shop.
 *
 * @param categoryId - Task difficulty category.
 * @param payWithCoins - Whether to pay Slayer Coins to reroll. Defaults to free.
 */
export function newSlayerTask(
  categoryId: string,
  payWithCoins: boolean,
  isSuspended: () => boolean,
): ActionResult<{ monsterId: string | null; remaining: number }> {
  // The category registry lives on the task itself, not on Game.
  const task = game.combat.slayerTask;
  const category = task.categories.getObjectByID(categoryId);
  if (category === undefined) {
    return fail('slayer.newTask', 'precondition', `no slayer category ${categoryId}`);
  }
  const project = (): { monsterId: string | null; remaining: number } => ({
    monsterId: task.monster?.id ?? null,
    remaining: task.killsLeft,
  });

  return act(
    {
      name: 'slayer.newTask',
      observe: project,
      // `render: false` — the agent is not looking at the screen, and rendering
      // a menu it never opens is wasted work on every task.
      perform: () => task.selectTask(category, payWithCoins, false),
      changed: (before, after) => after.monsterId !== null && after.monsterId !== before.monsterId,
    },
    isSuspended,
  );
}

/**
 * Slayer tasks the character could take.
 *
 * The capability to take one existed all along and nothing ever offered it, so
 * the planner could not choose Slayer at all — a whole progression system
 * present in the contract and unreachable in play.
 *
 * Only offered when no task is running: taking one mid-task discards the kills
 * already made, which is a real loss rather than a fresh start. Categories the
 * character cannot enter are left out, and the level requirement is stated so a
 * blocked one reads as a target rather than an absence.
 */
export function readSlayerCandidates(): Candidate[] {
  const task = game.combat.slayerTask;
  if (task.active) return [];

  // Slayer means fighting, and fighting without food is how a character dies
  // unattended — the same gate Thieving needed.
  if (game.combat.player.food.currentSlot.quantity <= 0) return [];

  const slayerLevel = game.skills.getObjectByID('melvorD:Slayer')?.level ?? 1;
  const candidates: Candidate[] = [];

  for (const category of task.categories.allObjects) {
    try {
      if (isRefusedRealm(category.realm.id)) continue;
      if (category.level > slayerLevel) continue;

      candidates.push({
        kind: 'new_slayer_task',
        params: { kind: 'new_slayer_task', categoryId: category.id, payWithCoins: false },
        label: `Take a ${category.name} Slayer task (needs Slayer ${category.level}, have ${slayerLevel}) — Slayer XP comes only from killing the assigned monster`,
        available: true,
      });
    } catch {
      // A category that cannot describe itself is not a candidate.
    }
  }

  return candidates;
}

/**
 * Prayers worth turning on, and potions worth drinking.
 *
 * Both existed as capabilities that nothing offered. The character finished the
 * day with 506 prayer points and no way for the planner to spend them, which is
 * the same shape as bones sitting in the bank before burying existed.
 *
 * Prayers are only offered when there are points to pay for them and a fight to
 * spend them on: an active prayer drains points whether or not anything is
 * being fought, and points cost bones.
 */
export function readCombatSetupCandidates(): Candidate[] {
  const player = game.combat.player;
  const candidates: Candidate[] = [];

  if (player.prayerPoints > 0) {
    for (const prayer of game.prayers.allObjects) {
      try {
        if (player.activePrayers.has(prayer)) continue;
        if (isRefusedRealm(prayer.realm.id)) continue;
        // ActivePrayer has no requirements array; it gates on Prayer level.
        const prayerLevel = game.skills.getObjectByID('melvorD:Prayer')?.level ?? 1;
        if (prayer.level > prayerLevel) continue;

        candidates.push({
          kind: 'toggle_prayer',
          params: { kind: 'toggle_prayer', prayerId: prayer.id },
          label: `Activate ${prayer.name} — ${player.prayerPoints} prayer points held, and points drain only while it is on`,
          available: true,
        });
      } catch {
        // A prayer that cannot state its requirements is not a candidate.
      }
    }
  }

  for (const potion of game.items.potions.allObjects) {
    try {
      if (game.bank.getQty(potion) <= 0) continue;

      candidates.push({
        kind: 'use_potion',
        params: { kind: 'use_potion', itemId: potion.id },
        label: `Drink ${potion.name} — ${game.bank.getQty(potion)} held, and a potion left in the bank does nothing`,
        available: true,
      });
    } catch {
      // A potion that cannot be counted is not a candidate.
    }
  }

  // Attack styles decide which combat skill receives the XP, so leaving the
  // default silently funnels everything into one. Offered only out of combat,
  // which is also the only time the game allows the change.
  if (!game.combat.isActive) {
    const current = player.attackStyle?.id;
    // Only styles matching the equipped weapon: the game applies the style for
    // the weapon's attack type, so offering a Ranged style to a character
    // holding a dagger is offering something with no effect. Restricting this
    // to melee, as it was, made Ranged and Magic untrainable even with the
    // right weapon equipped.
    // `attackType` lives on WeaponItem, not on every EquipmentItem — an empty
    // slot holds the empty item, which has no attack type at all.
    const weapon = player.equipment.equippedItems['melvorD:Weapon']?.item;
    const weaponType = weapon instanceof WeaponItem ? weapon.attackType : undefined;

    for (const style of game.attackStyles.allObjects) {
      try {
        if (style.id === current) continue;
        if (weaponType !== undefined && style.attackType !== weaponType) continue;

        candidates.push({
          kind: 'set_attack_style',
          params: {
            kind: 'set_attack_style',
            attackTypeId: style.attackType,
            styleId: style.id,
          },
          label: `Fight with ${style.name} (${style.attackType}) — decides which combat skill the XP goes to`,
          available: true,
        });
      } catch {
        // A style that cannot describe itself is not a candidate.
      }
    }
  }

  return candidates;
}

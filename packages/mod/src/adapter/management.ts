import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';
import { noteSwallowed } from './safe.js';

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
    } catch (error) {
      noteSwallowed('management.readMasteryCandidates', error);
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
      } catch (error) {
        noteSwallowed('management.readMasteryCandidates', error);
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

/**
 * Turns automatic potion re-use on or off for one action.
 *
 * A potion is a fixed number of charges and then nothing. `usePotion` drinks
 * one, the charges tick away against whatever is running, and the buff ends
 * without a word — the skill carries on at the un-potioned rate, which looks
 * exactly like the potion never having been worth much. Over a long objective
 * the drink is a few minutes of benefit and hours of nothing.
 *
 * **On the polarity, which is the whole trap here.** `PotionManager` holds
 * `autoReuseActions: Set<Action>` and documents it as *"Actions for which
 * potions should **not** be automatically re-used"* (potionManager.d.ts:11) —
 * the set is a blocklist and its name reads like an allowlist. So the set is
 * never touched here. The single reading is `autoReusePotionsForAction`
 * (potionManager.d.ts:19), whose name asks the question in the same direction
 * this function's `enabled` answers it, and the action asserts that accessor's
 * own value either side of `toggleAutoReusePotion` (potionManager.d.ts:26).
 *
 * That framing is what makes a wrong guess cheap rather than silent. If the
 * accessor turned out to mean the opposite, this would toggle once, observe the
 * value it asked for, and stop — because the caller's precondition is that same
 * accessor. One reversible call, not a loop and not a loss.
 *
 * @param actionId - Namespaced id of the action the potion applies to.
 * @param enabled - The value `autoReusePotionsForAction` should read afterwards.
 */
export function setPotionAutoReuse(
  actionId: string,
  enabled: boolean,
  isSuspended: () => boolean,
): ActionResult<{ actionId: string; autoReuse: boolean }> {
  const action = game.actions.getObjectByID(actionId);
  if (action === undefined) {
    return fail('potion.setAutoReuse', 'precondition', `no action ${actionId}`);
  }

  const project = (): { actionId: string; autoReuse: boolean } => ({
    actionId,
    autoReuse: game.potions.autoReusePotionsForAction(action),
  });

  return act(
    {
      name: 'potion.setAutoReuse',
      observe: project,
      precondition: () =>
        game.potions.autoReusePotionsForAction(action) === enabled
          ? `auto re-use for ${actionId} is already ${enabled}`
          : null,
      perform: () => game.potions.toggleAutoReusePotion(action),
      changed: (_before, after) => after.autoReuse === enabled,
    },
    isSuspended,
  );
}

/** A potion that will lapse when its charges run out, with a replacement banked. */
export interface LapsingPotion {
  actionId: string;
  actionName: string;
  potionId: string;
  potionName: string;
  charges: number;
  held: number;
}

/**
 * Active potions that will lapse silently, and could be re-used instead.
 *
 * Deliberately restricted to potions that are *already active*. Turning
 * automatic re-use on spends another potion from the bank when the charges run
 * out, so this is not free — but it is not a fresh decision either: the planner
 * has already chosen this potion for this action, and letting the choice expire
 * halfway through the objective it was drunk for is not a decision anyone made.
 *
 * Restricted again to potions there are more of. Enabling re-use with an empty
 * bank changes nothing, and a candidate or reflex that fires on nothing is how
 * the reflex tier fills a journal with refusals.
 *
 * @returns Active potions that would lapse, with what is banked to replace them.
 */
export function readLapsingPotions(): LapsingPotion[] {
  const lapsing: LapsingPotion[] = [];

  try {
    for (const [action, active] of game.potions.activePotions) {
      try {
        if (game.potions.autoReusePotionsForAction(action)) continue;

        const held = game.bank.getQty(active.item);
        if (held <= 0) continue;

        lapsing.push({
          actionId: action.id,
          actionName: action.name,
          potionId: active.item.id,
          potionName: active.item.name,
          charges: active.charges,
          held,
        });
      } catch {
        // An action whose potion state cannot be read is left alone.
      }
    }
  } catch {
    // No active potions readable is reported as none lapsing, which fails
    // toward doing nothing.
    return [];
  }

  return lapsing;
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
    } catch (error) {
      noteSwallowed('management.readSlayerCandidates', error);
      // A category that cannot describe itself is not a candidate.
    }
  }

  return candidates;
}

/**
 * Prayers currently switched on.
 *
 * Read live rather than from the snapshot, which carries prayer points but not
 * the prayers spending them. Both prayer reflexes need it: one to know there is
 * something to drop, the other to know there is nothing to add to.
 */
export function readActivePrayerIds(): string[] {
  try {
    return [...game.combat.player.activePrayers].map((prayer) => prayer.id).sort();
  } catch {
    // An unreadable prayer set reports as empty, which stops the drop reflex
    // and lets the activation reflex try — the cheaper of the two mistakes,
    // since activation is refused by the adapter when it cannot be paid for.
    return [];
  }
}

/** A prayer that can be switched on now, and what it costs to run. */
export interface ActivatablePrayer {
  prayerId: string;
  name: string;
  /** Points spent per attack the player makes. */
  pointsPerPlayer: number;
  /** Points spent per attack the enemy makes. */
  pointsPerEnemy: number;
}

/**
 * Prayers the character can switch on right now, cheapest to run first.
 *
 * Prayer is the one skill in the game with no action of its own. Burying bones
 * grants points and no XP — verified live, 52 bones for zero XP — and the XP
 * comes only from *spending* those points during a fight. So a prayer being
 * active is not a buff decision, it is the entire training method, and Prayer 20
 * was unreachable by construction while nothing ever turned one on.
 *
 * Cheapest first is deliberate and is not about efficiency. The point is to
 * spend points steadily for as long as the bones last; an expensive prayer
 * empties the bar in a handful of swings and then the reflex that drops
 * unpayable prayers switches it off again.
 *
 * Two exclusions, both from the game's own data rather than from a name:
 *
 * - `useSoulPoints` prayers (prayer.d.ts:36) spend Soul Points, a different
 *   currency with a different source, so a check on prayer points says nothing
 *   about whether they can be paid for.
 * - `canUseWithDamageType` (prayer.d.ts:39) against the player's own damage type
 *   (character.d.ts:100), because a prayer the character cannot use is one the
 *   game silently refuses — the same shape as selecting a spell without runes.
 */
export function readActivatablePrayers(): ActivatablePrayer[] {
  const player = game.combat.player;
  const prayers: ActivatablePrayer[] = [];
  const prayerLevel = game.skills.getObjectByID('melvorD:Prayer')?.level ?? 1;

  for (const prayer of game.prayers.allObjects) {
    try {
      if (player.activePrayers.has(prayer)) continue;
      if (isRefusedRealm(prayer.realm.id)) continue;
      // ActivePrayer has no requirements array; it gates on Prayer level.
      if (prayer.level > prayerLevel) continue;
      if (prayer.useSoulPoints) continue;
      if (!prayer.canUseWithDamageType(player.damageType)) continue;

      prayers.push({
        prayerId: prayer.id,
        name: prayer.name,
        pointsPerPlayer: prayer.pointsPerPlayer,
        pointsPerEnemy: prayer.pointsPerEnemy,
      });
    } catch {
      // A prayer that cannot state its cost is not offered.
    }
  }

  return prayers.sort(
    (a, b) => a.pointsPerPlayer + a.pointsPerEnemy - (b.pointsPerPlayer + b.pointsPerEnemy),
  );
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
      } catch (error) {
        noteSwallowed('management.readCombatSetupCandidates', error);
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
    } catch (error) {
      noteSwallowed('management.readCombatSetupCandidates', error);
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
          label: `Fight with ${style.name} (${style.attackType}) — trains ${describeStyleTraining(style)}`,
          available: true,
        });
      } catch (error) {
        noteSwallowed('management.readCombatSetupCandidates', error);
        // A style that cannot describe itself is not a candidate.
      }
    }
  }

  return candidates;
}

/**
 * Why Slayer is offering nothing, or null when it is.
 *
 * {@link readSlayerCandidates} returns an empty array in three unrelated
 * situations — a task is already running, no food is equipped, or every
 * category is above the character's Slayer level — and an empty list looks
 * identical in all three. Slayer sat at level 1 for a whole session without the
 * agent or the operator ever being told which of those was true, and the answer
 * turned out to matter: no food equipped is a thing a reflex fixes in seconds,
 * while an active task means the work is to go and kill the assigned monster.
 *
 * The lesson is one this session kept relearning. An empty candidate list is
 * not self-explanatory, and the difference between "cannot" and "already done"
 * is invisible until something says which.
 */
export function readSlayerBlockedReason(): string | null {
  try {
    const task = game.combat.slayerTask;
    if (task.active) {
      const monster = task.monster?.name ?? 'the assigned monster';
      return `Slayer task already active — XP comes from killing ${monster}, not from taking another task`;
    }

    if (game.combat.player.food.currentSlot.quantity <= 0) {
      return 'Slayer needs food equipped, for the same reason Thieving does — an unattended fight without it is how a character dies';
    }

    const slayerLevel = game.skills.getObjectByID('melvorD:Slayer')?.level ?? 1;
    const cheapest = [...task.categories.allObjects]
      .filter((category) => !isRefusedRealm(category.realm.id))
      .reduce<number | null>(
        (lowest, category) =>
          lowest === null || category.level < lowest ? category.level : lowest,
        null,
      );

    if (cheapest !== null && cheapest > slayerLevel) {
      return `every Slayer category needs level ${cheapest}, and Slayer is ${slayerLevel}`;
    }

    return null;
  } catch (error) {
    return `Slayer state could not be read: ${String(error)}`;
  }
}

/**
 * Which skills an attack style actually trains, and in what proportion.
 *
 * The label used to say only that the choice "decides which combat skill the XP
 * goes to", without saying which -- so the planner was told a decision mattered
 * and given nothing to decide it with. That is the single lever on four of this
 * run's goals: Hitpoints 40, Defence 20, Ranged 20 and Magic 20 are each
 * reached, or not, by this selection.
 *
 * `AttackStyle.experienceGain` is the game's own answer (attackStyle.d.ts:11-14),
 * a list of skills with ratios, so nothing has to be inferred from the style's
 * name. The ratios are included because they are the whole point: a style that
 * splits between two skills is not the same offer as one that pours everything
 * into one.
 */
function describeStyleTraining(style: {
  experienceGain: { skill: { name: string }; ratio: number }[];
}): string {
  try {
    const shares = style.experienceGain.filter((gain) => gain.ratio > 0);
    if (shares.length === 0) return 'no skill the game will name';

    const total = shares.reduce((sum, gain) => sum + gain.ratio, 0);
    return shares
      .map((gain) =>
        total > 0 && shares.length > 1
          ? `${gain.skill.name} ${Math.round((gain.ratio / total) * 100)}%`
          : gain.skill.name,
      )
      .join(' and ');
  } catch (error) {
    noteSwallowed('management.describeStyleTraining', error);
    return 'a skill it will not name';
  }
}

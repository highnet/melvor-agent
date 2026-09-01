import type { ActionResult } from '@melvor-agent/shared';

/**
 * Mid-fight reactions.
 *
 * The policy tier runs every few seconds and the planner runs every few
 * minutes; a fight can be lost inside one of those gaps. This tier exists for
 * the handful of decisions a human makes *during* a fight without thinking:
 * put more food in the slot, drop a prayer that has nothing left to burn.
 *
 * Everything here is deterministic, cheap, and has a hard reason to be in the
 * tick loop rather than in the policy tier. Anything that can wait a few
 * seconds does not belong here — the tick loop runs on the game's schedule and
 * work added to it is paid for on every frame of every fight.
 */

/** Below this many items in the slot, top up. Auto-eat empties a slot fast. */
const FOOD_TOPUP_THRESHOLD = 5;

/** What one reflex pass did, for the journal. */
export interface ReflexOutcome {
  name: string;
  result: ActionResult<unknown>;
}

/**
 * Refills the food slot mid-fight from the bank.
 *
 * The single highest-value mid-fight action there is. Auto-eat consumes the
 * equipped slot and does *not* refill it, so a fight that started safe becomes
 * unsurvivable the moment the slot empties — the survivability gate proved the
 * fight winnable with food, and then the food quietly ran out.
 *
 * The policy tier's answer to an empty slot is to disengage, which is correct
 * as a floor but throws the fight away when the bank is full of the same food.
 * Topping up keeps the gate's original argument true instead of abandoning it.
 *
 * @param equipFood - The adapter's food equip, injected so this stays testable.
 * @returns What was done, or null when nothing needed doing.
 */
export function refillFood(
  state: {
    inCombat: boolean;
    equippedFoodId: string | null;
    equippedFoodQty: number;
    bankQuantityOf: (itemId: string) => number;
  },
  equipFood: (itemId: string, quantity: number) => ActionResult<unknown>,
): ReflexOutcome | null {
  if (!state.inCombat) return null;
  if (state.equippedFoodId === null) return null;
  if (state.equippedFoodQty >= FOOD_TOPUP_THRESHOLD) return null;

  const held = state.bankQuantityOf(state.equippedFoodId);
  if (held <= 0) return null;

  return {
    name: 'reflex.refillFood',
    result: equipFood(state.equippedFoodId, held),
  };
}

/**
 * Turns off prayers that can no longer be paid for.
 *
 * A prayer with no points does nothing but sit there looking active, and the
 * moment points arrive — a bone drop, a potion — it starts draining them again
 * on a fight the agent may not want it for. Switching it off is the honest
 * state, and it is reversible, which is why it is safe to do without asking.
 */
export function dropUnpayablePrayers(
  state: { inCombat: boolean; prayerPoints: number; activePrayerIds: readonly string[] },
  togglePrayer: (prayerId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  if (!state.inCombat) return null;
  if (state.prayerPoints > 0) return null;

  const first = state.activePrayerIds[0];
  if (first === undefined) return null;

  return {
    name: 'reflex.dropPrayer',
    result: togglePrayer(first),
  };
}

/**
 * How low HP may fall before the reflex eats, as a fraction of max.
 *
 * Higher than an auto-eat threshold on purpose. Auto-eat fires the instant the
 * threshold is crossed; this reflex only looks once a second, so it has to
 * leave room for whatever lands in between.
 */
export const MANUAL_EAT_THRESHOLD = 0.6;

/**
 * Eats when HP is low and Auto Eat is not doing it.
 *
 * This is how a human plays before owning Auto Eat, which costs 1,000,000 GP —
 * dozens of hours of early income. Without it the agent cannot fight anything
 * at all until then, so the entire combat half of the game, and every skill
 * that depends on it, stays out of reach for the whole early game.
 *
 * It is strictly worse than Auto Eat and the gate is told so: reflexes run once
 * a second, so a fast enemy gets free hits between checks. That is the honest
 * cost of playing without the upgrade, and it is the reason the threshold sits
 * well above where an auto-eater would trigger.
 *
 * Does nothing when Auto Eat is owned — two things eating the same slot would
 * waste food, and Auto Eat is better at it.
 *
 * @param eat - The adapter's eat call, injected so this stays testable.
 * @returns What was done, or null when nothing needed doing.
 */
export function eatWhenLow(
  state: {
    inCombat: boolean;
    hitpoints: number;
    maxHitpoints: number;
    equippedFoodQty: number;
    /** Auto-eat trigger as a fraction of max HP; 0 when not owned. */
    autoEatThresholdFraction: number;
  },
  eat: () => ActionResult<unknown>,
): ReflexOutcome | null {
  if (!state.inCombat) return null;
  if (state.equippedFoodQty <= 0) return null;
  if (state.autoEatThresholdFraction > 0) return null;
  if (state.maxHitpoints <= 0) return null;

  const fraction = state.hitpoints / state.maxHitpoints;
  if (fraction > MANUAL_EAT_THRESHOLD) return null;

  return { name: 'reflex.eatWhenLow', result: eat() };
}

/**
 * How much of max HP a single enemy hit may take before the fight is abandoned.
 *
 * The live counterpart to the pre-fight screen. Outside combat the game cannot
 * compute an enemy's stats, so the screen is a guess from combat level; once
 * the fight starts the game computes the real numbers, and this is where that
 * guess gets checked against them.
 */
const LIVE_MAX_HIT_FRACTION = 0.35;

/**
 * Abandons a fight the live enemy turns out to be too strong for.
 *
 * This is what makes a conservative screen safe rather than optimistic. The
 * screen admits it is guessing; this reads the enemy's actual max hit — which
 * the game computes properly once combat starts — and disengages within a tick
 * if a single hit could take more than a third of the character's health.
 *
 * A third, not a half: the character must survive not just one hit but the hit
 * that lands while the eat reflex is still a second away.
 */
export function abandonIfOutmatched(
  state: {
    inCombat: boolean;
    maxHitpoints: number;
    /** The live enemy's computed max hit, or null when unknown. */
    enemyMaxHit: number | null;
  },
  disengage: () => ActionResult<unknown>,
): ReflexOutcome | null {
  if (!state.inCombat) return null;
  if (state.maxHitpoints <= 0) return null;

  const enemyMaxHit = state.enemyMaxHit;
  // Unknown is not permission. But mid-fight it is also not proof of danger, and
  // disengaging on every unread stat would make combat impossible, so the HP
  // floor in the policy tier remains the backstop for that case.
  if (enemyMaxHit === null || !(enemyMaxHit > 0)) return null;

  if (enemyMaxHit < state.maxHitpoints * LIVE_MAX_HIT_FRACTION) return null;

  return { name: 'reflex.abandonIfOutmatched', result: disengage() };
}

/**
 * Empties the combat loot container before it starts discarding.
 *
 * A reflex rather than a decision: there is no judgement in it, the cost is a
 * single call, and the alternative is losing everything the fighting produced.
 * The container holds a fixed number of stacks and then silently drops the
 * rest, which an unattended agent would never notice.
 */
export function collectPendingLoot(
  state: { inCombat: boolean; hasLootWorthTaking: boolean },
  loot: () => ActionResult<unknown>,
): ReflexOutcome | null {
  if (!state.hasLootWorthTaking) return null;

  return { name: 'reflex.collectLoot', result: loot() };
}

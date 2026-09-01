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

/**
 * Below this many items in the slot, top up.
 *
 * Raised from five after watching it live: a failed pickpocket can take a
 * quarter of the character's health, so five meals is a couple of bad seconds,
 * not a buffer. The cost of topping up early is nothing — the food returns to
 * the bank untouched if it is not eaten — while the cost of being empty is the
 * eat reflex having nothing to work with, which is how this character died.
 */
const FOOD_TOPUP_THRESHOLD = 15;

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
    /** Food in the bank, best first, for when the slot is empty entirely. */
    bankedFood?: { itemId: string; quantity: number }[];
  },
  equipFood: (itemId: string, quantity: number) => ActionResult<unknown>,
): ReflexOutcome | null {
  // Not gated on combat: Thieving drains food too, and an empty slot is what
  // stops the eat reflex from working at all.
  if (state.equippedFoodQty >= FOOD_TOPUP_THRESHOLD && state.equippedFoodId !== null) {
    return null;
  }

  // An empty slot is the case that matters most and the one this reflex used to
  // ignore: it could only top up food already equipped. Live, Thieving emptied
  // the slot, the eat reflex had nothing to eat, and the character fell to 32
  // hitpoints of 120 before an operator noticed.
  if (state.equippedFoodId === null || state.equippedFoodQty <= 0) {
    const replacement = state.bankedFood?.find((entry) => entry.quantity > 0);
    if (replacement === undefined) return null;

    return {
      name: 'reflex.refillFood',
      result: equipFood(replacement.itemId, replacement.quantity),
    };
  }

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
 * **Not gated on combat.** Thieving damages the character on every failed
 * pickpocket, and it is not combat: gating this on `inCombat` meant nothing ate
 * during it. Observed live at 5 HP out of 110, one failure from death, after
 * the agent had been pickpocketing unattended for two minutes.
 *
 * @param eat - The adapter's eat call, injected so this stays testable.
 * @returns What was done, or null when nothing needed doing.
 */
export function eatWhenLow(
  state: {
    hitpoints: number;
    maxHitpoints: number;
    equippedFoodQty: number;
    /** Auto-eat trigger as a fraction of max HP; 0 when not owned. */
    autoEatThresholdFraction: number;
  },
  eat: () => ActionResult<unknown>,
): ReflexOutcome | null {
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

/**
 * Opens containers as they arrive.
 *
 * A reflex rather than a planner decision, for the same reason collecting loot
 * is: there is no judgement in it, nothing is spent, and the alternative is a
 * pile of unopened nests. The stopgap can do this too, but only while idle —
 * during a three-hour objective nothing else would, which is precisely the
 * stretch where a seed is most likely to arrive unnoticed.
 *
 * Refuses on a full bank, where the contents would be discarded outright: that
 * check lives in the adapter, which is why this passes the decision straight
 * through.
 */
export function openPendingContainers(
  state: { hasContainer: boolean },
  open: () => ActionResult<unknown>,
): ReflexOutcome | null {
  if (!state.hasContainer) return null;

  return { name: 'reflex.openContainers', result: open() };
}

/**
 * Harvests a grown or dead plot.
 *
 * Farming is passive — it never occupies the game's single action slot — so a
 * `tend_farm` objective spends a twenty-minute growth cycle returning `idle`
 * while the character does nothing else. That is precisely the wasted-transition
 * problem this project exists to remove, so tending belongs beside eating and
 * looting rather than in the objective tier.
 *
 * Harvest only. Replanting picks a seed, and choosing what to grow is a decision
 * the planner should keep — a reflex that silently spent the last herb seed on
 * an allotment would be making a real choice unasked.
 */
export function harvestReadyPlots(
  state: { readyPlotIds: readonly string[] },
  harvest: (plotId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  const plotId = state.readyPlotIds[0];
  if (plotId === undefined) return null;

  return { name: 'reflex.harvestPlot', result: harvest(plotId) };
}

/**
 * Plants an empty plot with a seed there is plenty of.
 *
 * The companion to harvesting, and free: an empty plot earns nothing, a
 * planted one grows in the background without touching the action slot. Two
 * plots sat empty through a whole Cartography objective because the agent had
 * moved on and nothing looked back at the farm.
 *
 * Only seeds there are enough of to actually plant are used, measured against
 * the recipe's own seed cost. Scarcity takes care of itself here: a seed cannot
 * be planted in the wrong category, so an allotment can never consume the herb
 * seed the Herblore chain is waiting on.
 */
export function plantEmptyPlots(
  state: {
    emptyPlotIds: readonly string[];
    /** Seeds held, richest first. Callers filter to what is plantable. */
    plentifulSeeds: readonly { recipeId: string; held: number; cost: number }[];
  },
  plant: (plotId: string, recipeId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  const plotId = state.emptyPlotIds[0];
  if (plotId === undefined) return null;

  // The game's own cost, not a guess. A plot takes three seeds, and the first
  // version of this asked for one — so it chose a seed it could not plant and
  // reported "need 3x Potato Seeds, hold 2" once a second.
  const seed = state.plentifulSeeds.find((entry) => entry.held >= entry.cost);
  if (seed === undefined) return null;

  return { name: 'reflex.plantPlot', result: plant(plotId, seed.recipeId) };
}

/**
 * Fraction of held GP a single automatic bank slot may cost.
 *
 * Set at a quarter first, to protect the Auto Eat fund from a reflex buying
 * space for more logs. That was the wrong shape of caution: slot prices climb
 * with each purchase, and the bank hit 52/52 holding 55,678 GP against a 15,885
 * slot — 28.5%, just over the line — so the guard sat and watched items be
 * discarded in order to protect a balance.
 *
 * A full bank is a *continuous* loss; savings are a stock. Paying once to stop
 * the loss beats defending the stock, and each purchase permanently adds a slot
 * so the situation recurs more slowly rather than looping. The cap still exists
 * to stop a near-broke character spending its last GP here.
 */
const BANK_SLOT_GP_FRACTION = 0.5;

/**
 * Buys a bank slot when the bank is completely full.
 *
 * A full bank does not stop a skill; it silently discards every new item type
 * while the action keeps running, so an unattended agent can dig for hours and
 * bank nothing. The candidate list already said so in plain words — "Bank is
 * FULL, any new item type is being discarded silently" — and nothing acted on
 * it, because saying it to a human who is not there is not a fix.
 *
 * Buying, never selling. Which stack is worth destroying is a judgement with no
 * undo, and the brief rules irreversible actions out; a slot is additive,
 * permanent, and cannot lose anything.
 */
export function expandBankWhenFull(
  state: {
    freeSlots: number;
    expansion: { purchaseId: string; gpCost: number; held: number } | null;
  },
  buy: (purchaseId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  // Only at zero. One slot left is tight, not lossy, and the planner may be
  // deliberately spending down to a floor.
  if (state.freeSlots > 0) return null;

  const expansion = state.expansion;
  if (expansion === null) return null;
  if (expansion.gpCost > expansion.held * BANK_SLOT_GP_FRACTION) return null;

  return { name: 'reflex.expandBank', result: buy(expansion.purchaseId) };
}

/**
 * Composts an empty plot before anything is planted in it.
 *
 * An uncomposted crop has a 50% chance to grow. The character reached this
 * point holding two potato seeds against a three-seed planting cost, so losing
 * half of what does get planted is the difference between Farming progressing
 * and Farming never moving at all — and Herblore sits behind Farming.
 *
 * Deliberately before planting rather than during growth: compost applied first
 * covers the whole cycle, and it is where the game's own plot UI offers it.
 * Compost is cheap and bought in bulk, so there is no scarcity judgement here
 * of the kind that keeps seed choice with the planner.
 */
export function compostBeforePlanting(
  state: {
    /** Empty plots not yet fully composted. */
    bareplotIds: readonly string[];
    compost: { itemId: string; held: number } | null;
  },
  apply: (plotId: string, compostId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  const plotId = state.bareplotIds[0];
  if (plotId === undefined) return null;

  const compost = state.compost;
  if (compost === null || compost.held <= 0) return null;

  return { name: 'reflex.compostPlot', result: apply(plotId, compost.itemId) };
}

/**
 * Buys a farming plot the moment one becomes affordable.
 *
 * The unlock already existed as a candidate and as a step inside `tend_farm`,
 * which means it only ever happened while a planner was watching. Unattended,
 * the character would reach Farming 5 holding the 10,000 GP for a Herb plot and
 * simply never buy it — and the Herb plot is the step Herblore, the last
 * untrained skill in scope, is waiting behind.
 *
 * Same reasoning as the bank slot: additive, permanent, and impossible to lose
 * anything by. `canUnlock` is the game's own answer, so affordability and the
 * level requirement are not second-guessed here.
 */
export function unlockAffordablePlots(
  state: { unlockablePlotIds: readonly string[] },
  unlock: (plotId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  const plotId = state.unlockablePlotIds[0];
  if (plotId === undefined) return null;

  return { name: 'reflex.unlockPlot', result: unlock(plotId) };
}

/**
 * Claims a Township task whose work is already finished.
 *
 * Free, additive and impossible to get wrong — the same shape as buying a bank
 * slot or opening a plot, and it belongs in the same tier for the same reason:
 * it only ever happened while a planner was watching.
 *
 * An unclaimed task also holds its slot, so the next one never starts. Township
 * XP is what gates the biome the Herb producer lives in, which makes this the
 * critical path rather than housekeeping.
 */
export function claimFinishedTasks(
  state: { claimable: readonly { kind: 'casual' | 'township'; taskId: string }[] },
  claim: (kind: 'casual' | 'township', taskId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  const task = state.claimable[0];
  if (task === undefined) return null;

  return { name: 'reflex.claimTask', result: claim(task.kind, task.taskId) };
}

/**
 * Fraction of held GP a single automatic upgrade may cost.
 *
 * Two percent is deliberately timid. The point is not to spend well — that is
 * the planner's job, with the whole shop in front of it — but to make "you
 * have 43,860 GP and no 50 GP axe" impossible. Anything this reflex buys is
 * rounding error against the balance; anything genuinely expensive stays a
 * decision.
 *
 * A consequence worth stating: a poor character buys nothing here, which is
 * correct. The upgrades stay on the candidate list and become affordable to the
 * reflex exactly when they stop being a real trade-off.
 */
const TRIVIAL_UPGRADE_GP_FRACTION = 0.02;

/**
 * Buys permanent upgrades that cost a rounding error against held GP.
 *
 * Cheapest first, one per tick. Buying an Iron Axe shortly before a Steel Axe
 * becomes affordable wastes 50 GP, and that is the right trade: the alternative
 * — reasoning about which tier to wait for — is how these went unbought for a
 * session in the first place.
 *
 * Restricted by its reader to upgrades granting no items, so this can neither
 * fill a bank slot nor guess a quantity. See {@link readCheapPermanentUpgrades}.
 */
export function buyTrivialUpgrades(
  state: {
    gp: number;
    upgrades: readonly { purchaseId: string; name: string; gpCost: number }[];
  },
  buy: (purchaseId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  const affordable = state.upgrades.find(
    (upgrade) =>
      upgrade.gpCost <= state.gp && upgrade.gpCost <= state.gp * TRIVIAL_UPGRADE_GP_FRACTION,
  );
  if (affordable === undefined) return null;

  return { name: 'reflex.buyUpgrade', result: buy(affordable.purchaseId) };
}

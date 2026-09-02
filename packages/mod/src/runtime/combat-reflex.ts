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

/**
 * How much better banked food must be before the slot is swapped.
 *
 * A quarter better, so a genuine upgrade goes in and two near-equal foods do
 * not trade places every tick. The slot is not free to change during a fight,
 * and churn there is worse than eating slightly weaker food.
 */
const FOOD_UPGRADE_MARGIN = 1.25;

/**
 * How much better worn gear must be beaten by before a reflex swaps it.
 *
 * A fifth, because the stat sum this compares is a blunt instrument: it added a
 * platebody's melee defence to its negative ranged attack and called the result
 * an upgrade for an archer. That specific failure is now filtered separately,
 * but the lesson stands — a margin means the sum has to be confidently right
 * rather than merely right, and anything closer stays a planner decision.
 */
const GEAR_UPGRADE_MARGIN = 1.2;

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
    /** Food in the bank, best-healing first. */
    bankedFood?: { itemId: string; quantity: number; heals: number }[];
    /** What the equipped food heals for, so a better one can be recognised. */
    equippedFoodHeals: number;
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

  // No upgrade attempt here, deliberately, and the reason is worth keeping.
  //
  // A previous version of this swapped to better banked food whenever it beat
  // what was equipped by a margin — reasonable on its face, since a character
  // that equipped Shrimp early otherwise eats Shrimp forever. It did not work:
  // a food slot already holding one item refuses a different one, so the call
  // changed nothing and the reflex made it again every four seconds. The slot
  // projection showed `Beef 8 -> Beef 8` while the bank held no Beef at all,
  // which is what gave it away.
  //
  // Upgrading properly means unequipping first, which is a second action and a
  // moment with no food equipped — during Thieving, that moment is exactly what
  // this reflex exists to prevent. So the upgrade stays where it is safe: the
  // empty-slot branch above already picks the best-healing food in the bank,
  // because readBankedFood sorts by healing. A character only eats weak food
  // until the slot next empties, and then it eats the best it has.

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
 *
 * **For a dungeon this is not a safety net.** Abandoning a Melvor dungeon
 * partway restarts it from the beginning, so firing here on floor nine saves
 * the character and loses the entire run — the cost the run was for. That is
 * why the pre-fight screen holds a dungeon to a stricter allowance than a
 * single monster (`DUNGEON_LEVEL_ALLOWANCE` in `policy/combat-gate.ts`): for a
 * dungeon, the screen is the only cheap refusal there is.
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
    /** Empty plots with the category each will accept. */
    emptyPlots: readonly { plotId: string; categoryId: string }[];
    /** Seeds held, richest first, with the category each belongs to. */
    plentifulSeeds: readonly {
      recipeId: string;
      categoryId: string;
      held: number;
      cost: number;
    }[];
  },
  plant: (plotId: string, recipeId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  // A plot and a seed have to match categories, and this used to consider only
  // the first empty plot.
  //
  // The adapter refuses a category mismatch, so once a Herb or Tree plot was
  // unlocked the first empty plot could be one no held seed fits -- and because
  // nothing looked past `[0]`, the reflex returned that same refusal forever
  // while allotment plots sat empty beside it. A guard starving its own
  // precondition, which this codebase has now paid for twice.
  //
  // Pairing rather than filtering: the first (plot, seed) whose categories
  // agree, so a blocked plot is stepped over instead of blocking the farm.
  for (const plot of state.emptyPlots) {
    // The game's own cost, not a guess. A plot takes three seeds, and the first
    // version of this asked for one — so it chose a seed it could not plant and
    // reported "need 3x Potato Seeds, hold 2" once a second.
    const seed = state.plentifulSeeds.find(
      (entry) => entry.categoryId === plot.categoryId && entry.held >= entry.cost,
    );
    if (seed === undefined) continue;

    return { name: 'reflex.plantPlot', result: plant(plot.plotId, seed.recipeId) };
  }

  return null;
}

/**
 * Slot cost as a fraction of held GP that is worth paying *before* anything is
 * being lost.
 *
 * The old rule fired only at zero free slots, on the reasoning that "one slot
 * left is tight, not lossy". That reasoning is wrong in one specific way, and
 * the session showed it: at zero, the loss has already started. Items were
 * being discarded while Mining ran, and the reflex was waiting for exactly the
 * moment that means the damage is underway.
 *
 * Reacting a few slots early costs GP; reacting at zero costs items that cannot
 * be recovered. So the threshold is graduated rather than moved: buy early when
 * a slot is small change, and hold out to the last moment when it is dear.
 */
const BANK_SLOT_CHEAP_FRACTION = 0.05;

/** Free slots at or below which a cheap slot is worth buying pre-emptively. */
const BANK_PRESSURE_SLOTS = 3;

/**
 * Buys a bank slot under pressure, earlier when the slot is cheap.
 *
 * A full bank does not stop a skill; it silently discards every new item type
 * while the action keeps running, so an unattended agent can dig for hours and
 * bank nothing. The candidate list already said so in plain words — "Bank is
 * FULL, any new item type is being discarded silently" — and nothing acted on
 * it, because saying it to a human who is not there is not a fix.
 *
 * Two thresholds, because the two situations are genuinely different:
 *
 * - At zero free slots the bank is losing continuously, and half of held GP is
 *   worth paying to stop it.
 * - At three or fewer, nothing is lost yet, so it is only worth pre-empting
 *   while the slot is small change. A character that is nearly broke, or one
 *   whose slot price has climbed into real money, waits for the emergency.
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
  if (state.freeSlots > BANK_PRESSURE_SLOTS) return null;

  const expansion = state.expansion;
  if (expansion === null) return null;

  // At zero free slots there is no cap at all beyond affordability, and that is
  // the whole lesson of a two-hour deadlock.
  //
  // The cap used to be half of held GP, to stop a near-broke character spending
  // its last coins on storage. That reasoning treats GP as the scarce thing. It
  // is not, once the bank is full: every gathering action is refused because
  // its output has nowhere to go, so income is exactly zero and the balance
  // being protected can never grow. The agent sat at 59/59 with 59,369 GP and a
  // slot priced at 33,068 — refused by 3,384 — and did nothing for two hours
  // while the price and the balance both stayed frozen.
  //
  // A savings floor is only meaningful if something can still earn. When
  // nothing can, spending 56% of the balance to restart a 120,000 GP/hour
  // operation is not a risk; declining it is.
  if (state.freeSlots <= 0) {
    if (expansion.gpCost > expansion.held) return null;
  } else if (expansion.gpCost > expansion.held * BANK_SLOT_CHEAP_FRACTION) {
    return null;
  }

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
 * Permanent upgrades are bought whenever they can be afforded.
 *
 * No fraction of balance, no ceiling. Both were tried and both were wrong in
 * the same way: they made the *better* upgrade the harder one to buy. A quarter
 * of held GP means requiring four times the price in hand, so the Mithril
 * Pickaxe at 50,000 demanded 200,000 and the Adamant behind it would have
 * demanded 800,000 -- the rule bit hardest exactly where the payoff was
 * largest. A ceiling did the same thing more bluntly.
 *
 * The operator's rule is simpler and better: it is either worth it or it is
 * not, and a long-term boost is worth it. That holds because of what these
 * purchases are. The reader offers only upgrades granting *no items* -- pure
 * permanent modifiers -- so each compounds across every hour that follows while
 * its cost is paid exactly once, the list is finite, and each entry is bought
 * at most once. The total drain is bounded by the shop rather than open-ended.
 *
 * Cheapest first, so the agent ladders up as it earns rather than lunging at
 * the dearest thing it can technically afford.
 *
 * The cost is real and worth stating: buying a 200,000 GP pickaxe while saving
 * for a 1,000,000 GP Auto Eat delays that purchase by about two and a half
 * hours at the current chain rate. Over a run measured in days that is the
 * right trade; over one measured in the next hour it is not. The planner can
 * still refuse by not arming the agent, and the goal file records which
 * purchase the run is actually saving for.
 */

/**
 * Buys permanent upgrades the character can comfortably afford.
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
  const affordable = state.upgrades.find((upgrade) => upgrade.gpCost <= state.gp);
  if (affordable === undefined) return null;

  return { name: 'reflex.buyUpgrade', result: buy(affordable.purchaseId) };
}

/**
 * Takes off gear that penalises the attack style in use.
 *
 * A reflex rather than an objective, because this is not a judgement. Wearing
 * something that makes your own attacks unable to land is a mistake to undo,
 * not a trade-off to weigh — the same shape as a full bank, where the only
 * question is how long the loss runs before someone notices.
 *
 * Here it ran twenty minutes. A Steel Platebody was equipped into an empty
 * torso slot for its defence, carrying a negative ranged attack bonus, and the
 * archer wearing it could not land a shot: full health, no kills, two monsters,
 * two areas, every engage reporting success. The candidate reader now refuses
 * to offer such gear, but that does nothing about a piece already worn.
 *
 * Only while not in combat. Stripping armour mid-fight is how a character with
 * no Auto Eat dies, and the penalty has already cost whatever this fight was
 * going to cost.
 */
export function removePenalisingGear(
  state: {
    inCombat: boolean;
    /** Worn items whose attack bonus is negative for the current style. */
    penalising: readonly { slotId: string; itemName: string }[];
  },
  unequip: (slotId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  if (state.inCombat) return null;

  const worst = state.penalising[0];
  if (worst === undefined) return null;

  return { name: 'reflex.removePenalisingGear', result: unequip(worst.slotId) };
}

/**
 * Claims Mastery Tokens sitting in the bank.
 *
 * The same shape as opening a container, and for the same reason: holding one
 * does literally nothing, claiming it pours a percentage into the skill's
 * mastery pool, and there is no judgement in between. A reflex rather than a
 * candidate because an efficiency the operator has to notice and choose is an
 * efficiency that will be missed — these sat in the bank all session, and the
 * sell reader was offering them as a stack to liquidate.
 *
 * Not gated on combat: claiming touches the bank, not the action slot.
 */
export function claimMasteryTokens(
  state: { tokens: readonly { itemId: string; quantity: number }[] },
  claim: (itemId: string, quantity: number) => ActionResult<unknown>,
): ReflexOutcome | null {
  const token = state.tokens[0];
  if (token === undefined || token.quantity <= 0) return null;

  return {
    name: 'reflex.claimMasteryToken',
    result: claim(token.itemId, token.quantity),
  };
}

/**
 * Fills empty equipment slots with gear already in the bank.
 *
 * A Jeweled Necklace sat in the bank with an empty neck slot and the candidate
 * list saying so plainly — "Equip Jeweled Necklace (Neck is empty)" — for as
 * long as nobody read that line. The reader was working; the choosing was not.
 *
 * An empty slot is the one gear decision with nothing on the other side. There
 * is no item being displaced, no stat trade to weigh, and the candidate reader
 * has already excluded anything that penalises the attack style in use, so
 * whatever it offers for an empty slot is strictly better than the nothing
 * currently there.
 *
 * Replacements stay with the planner. Swapping worn gear is a real comparison —
 * the platebody that made an archer unable to land a shot scored *higher* than
 * what it replaced — and that judgement is not one to make on a tick loop.
 */
export function fillEmptySlots(
  state: {
    inCombat: boolean;
    /** Candidates whose target slot is currently empty, best first. */
    emptySlotGear: readonly { itemId: string; slotId: string }[];
    /** Gear that beats what is worn, as a ratio of stat scores, best first. */
    replacements: readonly { itemId: string; slotId: string; gain: number }[];
  },
  equip: (itemId: string, slotId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  // Not mid-fight: the survivability gate approved this fight with the gear the
  // character had, and changing it underneath that approval is how a safe
  // fight becomes an unsafe one.
  if (state.inCombat) return null;

  const next = state.emptySlotGear[0];
  if (next !== undefined) {
    return { name: 'reflex.fillEmptySlot', result: equip(next.itemId, next.slotId) };
  }

  // Replacements, but only clear ones. Evaluating every new item is right;
  // acting on a hair's-breadth stat difference is not, because the stat sum has
  // already been wrong once — a Steel Platebody scored higher than what it
  // replaced and left an archer unable to land a shot. A margin means the sum
  // has to be confidently right, not merely right.
  const upgrade = state.replacements.find((entry) => entry.gain >= GEAR_UPGRADE_MARGIN);
  if (upgrade === undefined) return null;

  return { name: 'reflex.upgradeGear', result: equip(upgrade.itemId, upgrade.slotId) };
}

/**
 * How few meals may remain before cooking is started automatically.
 *
 * Higher than the point of danger, because cooking takes time and a reserve
 * that is already empty is a reserve that arrives too late.
 */
const COOK_WHEN_MEALS_BELOW = 40;

/**
 * Starts passive cooking when the food reserve is running down.
 *
 * The character starved to death with sixteen Raw Beef and nineteen Raw Shrimp
 * in the bank and Cooking at 22. Every ingredient was present; nothing turned
 * them into food.
 *
 * An hour before that I looked at exactly this and decided the shortfall should
 * be *reported* rather than acted on, reasoning that restocking is a real plan
 * — fish, then cook, then come back — and that a reflex would have the agent
 * abandoning objectives to go fishing. That reasoning had two holes. The
 * asymmetry is wrong: a detour costs minutes and running out costs the
 * character. And the premise is wrong, which is the part I should have checked
 * — passive cooking does not take the action slot at all. Its own candidate
 * label says so: "runs in the background of whatever else is happening".
 *
 * So there was never a trade-off to delegate. Cooking while Thieving is free,
 * and free things belong in reflexes.
 */
export function cookWhenFoodLow(
  state: {
    /** Meals across the bank and the equipped slot. */
    meals: number;
    /** True when Auto Eat is owned, which feeds from the bank directly. */
    hasAutoEat: boolean;
    /** Cooking categories idle and with a recipe selected, best first. */
    idleCategoryIds: readonly string[];
  },
  cook: (categoryId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  // Owning Auto Eat is not the same as having food.
  //
  // `hasAutoEat` reads `autoEatThreshold > 0` -- ownership, not capability. On
  // that alone every food guard in this file switched itself off, so a
  // character that had bought the upgrade and run its larder to zero had no
  // eating, no cooking, no starvation stop and no warning: precisely the
  // configuration that killed this one, minus the single guard that noticed.
  //
  // That is not a hypothetical for this run. Auto Eat is the goal it is
  // currently saving a million GP toward, so buying it would have re-armed the
  // death it has already died twice.
  if (state.hasAutoEat && state.meals > 0) return null;
  if (state.meals >= COOK_WHEN_MEALS_BELOW) return null;

  const category = state.idleCategoryIds[0];
  if (category === undefined) return null;

  return { name: 'reflex.cookFood', result: cook(category) };
}

/**
 * Stops a damaging activity when there is nothing left to eat.
 *
 * The last line, and the one whose absence killed this character. Thieving
 * damages on every failed pickpocket and combat damages continuously; with no
 * food and no Auto Eat, the eat reflex has nothing to spend and health only
 * goes one way. Nothing was watching for that, so the agent kept pickpocketing
 * at 37 health and then at none.
 *
 * Stopping is not a strategy and is not meant to be — it is refusing to keep
 * paying health for XP when the health cannot be bought back. The planner can
 * choose what to do next; this only ensures there is a character left to choose
 * for.
 */
export function stopWhenStarving(
  state: {
    /** Meals across the bank and the equipped slot. */
    meals: number;
    hasAutoEat: boolean;
    hitpoints: number;
    maxHitpoints: number;
    /** The skill currently holding the action slot, if it damages. */
    damagingSkillId: string | null;
    /** Whether a fight is in progress, which the action slot does not report. */
    inCombat: boolean;
  },
  stop: (
    damaging: { kind: 'combat' } | { kind: 'skill'; skillId: string },
  ) => ActionResult<unknown>,
): ReflexOutcome | null {
  // Ownership is not capability; see cookWhenFoodLow. An Auto Eat with nothing
  // to eat heals for nothing, and this is the guard that stops the activity.
  if (state.hasAutoEat && state.meals > 0) return null;
  if (state.maxHitpoints <= 0) return null;

  // Combat is a damage source the action slot never reports.
  //
  // `CombatManager` implements PassiveAction, not ActiveAction, so in a plain
  // fight `activeAction` is undefined and `damagingSkillId` resolved to null --
  // and this guard, written after a starvation death and described in its own
  // doc as covering combat, returned immediately every time. It was dead code
  // for one of the two damage sources it names.
  //
  // Stopping also has to branch. A combat id could not be passed to
  // stopGathering, which has no routine for combat and would have reported a
  // refusal rather than ending the fight.
  const damaging: { kind: 'combat' } | { kind: 'skill'; skillId: string } | null = state.inCombat
    ? { kind: 'combat' }
    : state.damagingSkillId === null
      ? null
      : { kind: 'skill', skillId: state.damagingSkillId };

  if (damaging === null) return null;

  const fraction = state.hitpoints / state.maxHitpoints;

  // Only once health has actually started falling. A full-health character with
  // no food is not in danger yet, and stopping it would cost the run for
  // nothing.
  if (state.meals <= 0) {
    return fraction > STARVING_HP_FRACTION
      ? null
      : { name: 'reflex.stopStarving', result: stop(damaging) };
  }

  // Meals in the bank are not the same as health restored, and this guard used
  // to treat them as interchangeable: `meals > 0` returned early, so the last
  // line of defence could never fire while any food existed anywhere. The
  // character died holding 99 cooked Seahorse.
  //
  // Eating happens from the *equipped* food slot, so banked food is only ever a
  // claim about what eatWhenLow should have been able to do. Health this far
  // down is the observation that it did not -- the slot was empty, the refill
  // was refused, the meals were the wrong item. Whatever the reason, the number
  // in the bank has already been contradicted by the character's actual health,
  // and at that point the reading to trust is the health.
  return fraction > CRITICAL_HP_FRACTION
    ? null
    : { name: 'reflex.stopStarving', result: stop(damaging) };
}

/** Health below which, with no food at all, a damaging activity is stopped. */
const STARVING_HP_FRACTION = 0.5;

/**
 * Health below which a damaging activity is stopped even though food is banked.
 *
 * Lower than the no-food threshold on purpose: dipping under half health with
 * meals available is normal play, and stopping there would cost the run. Under
 * a quarter is not normal -- it means the eating is not working, whatever the
 * bank says.
 */
const CRITICAL_HP_FRACTION = 0.25;

/**
 * Sells one cheap stack when the bank is full and no slot can be bought.
 *
 * The last resort, and the only place in this codebase that sells without being
 * told to. It exists because "buying, never selling" turned out to have a hole
 * exactly the size of a two-hour outage: bank at 59/59, a slot priced above
 * what the character could pay, every gathering action refused because its
 * output had nowhere to go, and therefore no way to ever earn the difference.
 *
 * The ordering carries the whole argument. {@link expandBankWhenFull} runs
 * first and now spends up to the entire balance, so this only fires when even
 * that failed — when buying is not merely expensive but impossible. At that
 * point the choice is not between selling and keeping; it is between selling
 * and never acting again, and a stack of Rusty Keys is not worth a stopped run.
 *
 * The stack is the cheapest one that survives every existing sell guard, so the
 * cost is the smallest available. Selling one and only one per pass, because a
 * single freed slot is enough to restart the loop and anything more is a
 * judgement nobody asked this reflex to make.
 */
export function sellToEscapeFullBank(
  state: {
    freeSlots: number;
    /** True when a slot could be bought; then this must not fire. */
    canBuySlot: boolean;
    expendable: { itemId: string; name: string; value: number } | null;
    quantityOf: (itemId: string) => number;
  },
  sell: (itemId: string, quantity: number) => ActionResult<unknown>,
): ReflexOutcome | null {
  if (state.freeSlots > 0) return null;
  // Buying is strictly better and runs first; never pre-empt it.
  if (state.canBuySlot) return null;

  const stack = state.expendable;
  if (stack === null) return null;

  const quantity = state.quantityOf(stack.itemId);
  if (quantity <= 0) return null;

  return { name: 'reflex.sellToEscape', result: sell(stack.itemId, quantity) };
}

/**
 * Repairs a degraded Township building.
 *
 * A reflex rather than a candidate, because there is no judgement in it. A
 * decaying building produces less every tick it stays decayed, the resources
 * that pay for the repair are generated passively by the town itself, and the
 * loss compounds while nobody is looking — which is precisely the shape of
 * thing that should never wait for a planning session.
 *
 * It was already offered as a candidate below 90% efficiency and never once
 * chosen in a full day of play. That is the same failure as the 50 GP axe and
 * the Mastery Tokens: surfacing a thing is not the same as doing it, and an
 * efficiency the operator has to notice is an efficiency that will be missed.
 *
 * Township matters more than its tick rate suggests. Its tasks pay GP, items
 * and Township XP, and Township level is what unlocks the skilling outfits —
 * permanent XP multipliers on every skill the run will train afterwards. A town
 * left to rot stalls all of that quietly.
 *
 * Affordability is the adapter's precondition, so a town that cannot pay simply
 * produces no candidate and this does nothing.
 */
export function repairDegradedBuildings(
  state: {
    /** Degraded buildings the town can afford to repair, worst first. */
    repairable: readonly { buildingId: string; biomeId: string; efficiency: number }[];
  },
  repair: (buildingId: string, biomeId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  // Sorted here rather than trusting the caller: "worst first" is a policy
  // decision, and this is the tier that can be tested without a live game.
  const worst = [...state.repairable].sort((a, b) => a.efficiency - b.efficiency)[0];
  if (worst === undefined) return null;

  return {
    name: 'reflex.repairTownship',
    result: repair(worst.buildingId, worst.biomeId),
  };
}

/**
 * Collects passive-cooking output that would otherwise never reach the bank.
 *
 * A reflex because it is free, additive and impossible to get wrong -- the same
 * shape as claiming a Mastery Token or a finished Township task. It is also the
 * missing half of a loop that could not otherwise close: passive cooking puts
 * food in a stockpile, `readMealCount` counts only the bank and the equipped
 * slot, and the cooking reflex fires on that count. So the agent cooked, the
 * count did not move, and it cooked again -- indefinitely, while the meals it
 * had already made sat uncollected.
 *
 * Ordered before the food reflexes for exactly that reason: collecting first
 * means the meal count they read is the true one, so they stop reacting to a
 * shortage that has already been cooked away.
 */
export function collectStockpiledFood(
  state: {
    /** Categories holding uncollected passive-cooking output. */
    stockpiled: readonly { categoryId: string; quantity: number }[];
  },
  collect: (categoryId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  // Fullest first: one collection per pass, spent where the most food is
  // waiting.
  const fullest = [...state.stockpiled].sort((a, b) => b.quantity - a.quantity)[0];
  if (fullest === undefined) return null;

  return { name: 'reflex.collectStockpile', result: collect(fullest.categoryId) };
}

/**
 * Sells the most valuable surplus stack once the bank starts filling.
 *
 * Gathering candidates advertise their worth "if sold, not GP earned", and
 * nothing sold. So the bank filled while GP stood still, and the only automatic
 * response was `sellToEscapeFullBank`, which fires at zero free slots and sells
 * the *cheapest* stack -- freeing a slot while realising as little value as
 * possible.
 *
 * The cost of that gap is measurable rather than theoretical. In one afternoon
 * the expansion reflex bought two bank slots at escalating prices, about 75,000
 * GP, because the bank kept reaching zero free slots; an operator was
 * separately selling stacks by hand every forty minutes to keep GP moving at
 * all. Paying an escalating price for space while holding sellable stock is a
 * bad trade made repeatedly.
 *
 * Acting on pressure rather than at zero is the point: at zero the loss has
 * already started, and the choice is between a discarded drop and a fire sale.
 * A slot or two of headroom means the sale can be the profitable one.
 *
 * Every guard comes from the reader (see readMostValuableExpendableStack), so
 * this cannot reach food, ammunition, seeds, spell runes, mastery tokens or
 * anything a task wants. One stack per pass, and only above a floor -- a
 * handful of low-value items is not worth an irreversible action.
 */
export function liquidateSurplus(
  state: {
    freeSlots: number;
    /** The most valuable stack that survives every sell guard, if any. */
    best: { itemId: string; name: string; value: number } | null;
  },
  sell: (itemId: string) => ActionResult<unknown>,
): ReflexOutcome | null {
  if (state.best === null) return null;

  // Two triggers, because bank pressure is not the only reason to sell.
  //
  // Pressure alone left roughly 216,000 GP of bars sitting in a bank with five
  // free slots while the run was short of GP for the one purchase it was saving
  // toward. The reflex was behaving exactly as written and the stock still went
  // unconverted, because "the bank is filling" and "this is worth money now"
  // are different facts and only the first was being asked.
  //
  // A large stack is surplus by definition: gathering advertises its worth *if
  // sold*, and an unsold pile earns nothing at all while it waits. So a stack
  // past the large threshold is converted regardless of space -- the same
  // reasoning as the upgrade cap, that idle value is not a saving.
  const underPressure = state.freeSlots <= LIQUIDATE_FREE_SLOTS;
  const worthConverting = state.best.value >= LIQUIDATE_LARGE_VALUE;
  if (!underPressure && !worthConverting) return null;

  if (state.best.value < LIQUIDATE_MIN_VALUE) return null;

  return { name: 'reflex.liquidateSurplus', result: sell(state.best.itemId) };
}

/**
 * Free slots at or below which surplus is sold.
 *
 * Deliberately above zero. At zero the bank is already discarding drops, and
 * the only sale available is whichever stack is cheapest to lose.
 */
const LIQUIDATE_FREE_SLOTS = 2;

/**
 * Stack value below which selling is not worth an irreversible action.
 *
 * Selling is the one thing here that cannot be undone, so it should not fire
 * for pocket change.
 */
const LIQUIDATE_MIN_VALUE = 5_000;

/**
 * Stack value at which surplus is converted even with space to spare.
 *
 * High on purpose. Selling is irreversible, so the bar for acting without the
 * excuse of bank pressure should be a stack nobody would seriously argue is
 * still needed -- not a judgement about what the run wants, which belongs to
 * the planner.
 */
const LIQUIDATE_LARGE_VALUE = 100_000;

/**
 * Refills an empty quiver, or ends the fight when nothing can refill it.
 *
 * The quiver is a precondition of engaging and nothing watches it afterwards,
 * yet arrows are consumed per shot. When it empties mid-fight the game reports
 * combat as active and health stays full while nothing lands -- exactly the
 * silent zero-damage stall the engage-time check exists to prevent, arriving
 * twenty minutes into the fight instead of at the start. It is the same shape
 * as the melee platebody on an archer: full health, no kills, every engage
 * reporting success.
 *
 * Disengaging when the bank is empty too is the important half. Refilling is
 * the good outcome, but standing in a fight that cannot be won is worse than
 * leaving it, and without this the objective runs to its time budget doing
 * nothing at all.
 */
export function refillQuiver(
  state: {
    inCombat: boolean;
    /** True only when a ranged weapon needs ammunition and the quiver is empty. */
    quiverEmpty: boolean;
    /** Ammunition in the bank the equipped weapon can fire, if any. */
    available: { itemId: string; quantity: number } | null;
  },
  equip: (itemId: string) => ActionResult<unknown>,
  disengage: () => ActionResult<unknown>,
): ReflexOutcome | null {
  if (!state.inCombat) return null;
  if (!state.quiverEmpty) return null;

  if (state.available === null) {
    return { name: 'reflex.quiverEmpty', result: disengage() };
  }

  return {
    name: 'reflex.refillQuiver',
    result: equip(state.available.itemId),
  };
}

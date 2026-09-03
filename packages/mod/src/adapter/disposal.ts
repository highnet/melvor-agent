import type { Candidate } from '@melvor-agent/shared';
import { spellCosts } from './affordability.js';
import { readMasteryTokenIds } from './bank.js';
import { readSpellRuneIds } from './combat.js';
import { readMealCount } from './equipment.js';
import { readAllSeedIds, readBarelyEnoughIngredientIds } from './farming.js';
import { gpValue } from './pricing.js';
import { ALT_MAGIC_ID, type RecipeLike } from './recipes.js';
import { noteSwallowed, safeList, safeNumber } from './safe.js';
import { readTaskWantedQuantities } from './township.js';

/**
 * What the agent is allowed to part with, and why it is not.
 *
 * Selling a stack and feeding one to an Alt Magic cast are the same act as far
 * as every scarcity guard is concerned -- a seed, a token, a task item or a
 * spell's own rune is no safer burned than sold -- so both paths filter on the
 * single ordered list in {@link saleExclusionReason}. Exactly one clause
 * differs between them, and it is marked where it appears.
 *
 * That is the whole reason this is one module. The two readers lived beside
 * each other in `candidates.ts` because a guard added for the shop has to
 * protect the spell in the same commit; splitting them apart would make it
 * possible for the sell list and the consume list to disagree, which is a
 * property the comments below were written to prevent.
 */

/**
 * Enumerates sellable surplus in the bank.
 *
 * Mirrors the refusals in {@link sellItem} exactly — locked items and
 * zero-value items are absent rather than offered and then rejected. A
 * candidate the adapter would refuse is a planner trap, not a choice.
 *
 * @returns One candidate per sellable stack, most valuable first.
 */
/**
 * Meals below which food stops being surplus and becomes the reserve.
 *
 * Matches COOK_WHEN_MEALS_BELOW in the reflex tier on purpose: one number
 * decides both when to cook more and when to stop selling it, so the two
 * cannot disagree about what "enough food" means.
 */
const FOOD_SELL_FLOOR = 40;

/** Whether an item is ammunition, and so must not be liquidated. */
function isAmmunition(item: AnyItem): boolean {
  try {
    return item instanceof EquipmentItem && item.ammoType !== undefined;
  } catch (error) {
    noteSwallowed('candidates.isAmmunition', error);
    return false;
  }
}

export function readSellCandidates(): Candidate[] {
  // Never offer to sell what an open Township task is asking for. Selling one
  // of those throws away a whole task cycle, and task cycles are the fastest
  // Township XP available — 500 Potatoes went for a few hundred GP an hour
  // before a task appeared wanting 100 of them.
  // And never the last of an ingredient. Two Garum Seeds — the only herb seeds
  // of the session and exactly one planting's worth — came within a drift
  // check of being sold in a batch aimed at Oak Logs.
  // And never a farming seed, at any level. Farming is the prerequisite for the
  // last untrained skill in scope, seeds are worth a few GP against a harvest's
  // XP, and the list was offering 32 Ancient Corn Seeds while Farming sat at 1.
  // And never a rune an attack spell in reach actually needs. All 81 Mind Runes
  // were sold as spare change; they were half of every castable spell, and
  // Magic was unreachable for the rest of the session.
  // And never a rune a reachable *Alt Magic* spell needs. The attack-spell
  // guard reads `game.attackSpells`, no attack spell wants a Nature Rune, and
  // Nature Rune is the input every castable Alt Magic spell has -- so the
  // cheapest-item rule fed 49 casts of Just Learning a Nature Rune apiece on
  // top of the one the spell already charged. See readAltMagicFuelIds.
  // And never a Mastery Token. They are not containers, so the open reader's
  // instanceof check never saw them, while this reader — filtering on nothing
  // of the sort — listed six Woodcutting tokens as a stack to liquidate. A
  // token held does nothing; a token sold is mastery XP set on fire.

  // And never food while the larder is thin.
  //
  // Every other scarce thing in this run got a guard -- seeds, spell runes,
  // mastery tokens, task items -- and the one resource whose absence has
  // actually killed this character, twice, had none. Worse, it is the resource
  // the automatic path selects: `sellToEscapeFullBank` liquidates the *cheapest*
  // stack it can find without asking a planner, and a pile of Raw Shrimp is
  // exactly what cheapest looks like. That is a single call from "the bank is
  // full" to "there is nothing to eat".
  //
  // Not an outright ban: surplus food is real value and a full larder should be
  // sellable. The line is the same reserve the cooking reflex defends, so the
  // two agree instead of one quietly undoing the other.

  return (
    [...game.bank.items.values()]
      .filter((entry) => saleExclusionReason(entry.item, entry.quantity) === null)
      // And never ammunition.
      //
      // The same omission as food, with the same automatic path selecting it:
      // an empty quiver makes every ranged fight refuse outright, and Ranged 20
      // is a stated goal fed by 1,259 self-made arrows. Identified by
      // `ammoType`, which item.d.ts:210 documents as "property exclusive to
      // ammo" -- a structural test rather than a match on the word "arrow",
      // which would miss bolts and javelins entirely.
      .filter((entry) => !isAmmunition(entry.item))
      .filter((entry) => gpValue(entry.item) > 0)
      .map((entry) => ({
        kind: 'sell_items' as const,
        params: {
          kind: 'sell_items' as const,
          itemId: entry.item.id,
          // Keep back what a task still wants and sell the rest, rather than
          // choosing between the whole stack and none of it.
          keepQuantity: readTaskWantedQuantities().get(entry.item.id) ?? 0,
        },
        label: `Sell ${entry.quantity}x ${entry.item.name}`,
        // Not a rate: this is the one-off value of clearing the stack. Left off
        // gpPerHour deliberately, since a sale has no duration to divide by.
        gpPerHour: 0,
        available: true as const,
      }))
      // Sorted by item id, which does not change, rather than by the label —
      // the label embeds the quantity, so "23x Raw Herring" becoming "29x"
      // re-sorted the entire list and every index after it moved.
      //
      // That made multi-step plans race the agent's own gathering: build a plan
      // from a listing, and by the time it is submitted the stacks have grown and
      // the indices point at different items. The drift guard caught each one, so
      // nothing wrong was ever done — but four plans in a row were refused, which
      // is a planner unable to plan.
      .sort((a, b) => a.params.itemId.localeCompare(b.params.itemId))
  );
}

/**
 * The least valuable stack that is safe to sell, for breaking a full-bank
 * deadlock and nothing else.
 *
 * This codebase has said "buying, never selling" since the bank reflex was
 * written, on the grounds that which stack is worth destroying is a judgement
 * with no undo. That held right up until the case it did not cover: a bank at
 * 59/59 with a slot priced above what the character could pay. Every gathering
 * action was refused because its output had nowhere to go, income was zero, the
 * price never moved, and the agent re-planned into the same wall for two hours.
 *
 * Buying stays the first answer and runs first. This exists only for the case
 * where buying is impossible, where the choice is not "sell or keep" but "sell
 * or stop playing".
 *
 * Every guard the sell list already applies is inherited by construction, since
 * this picks from `readSellCandidates`: task items, seeds, runes a castable
 * attack spell or a reachable Alt Magic spell needs, mastery tokens, the last of
 * a recipe ingredient and locked items are all excluded. The *cheapest* surviving stack is chosen, because the point
 * is to free one slot at the smallest cost rather than to raise money.
 */
export function readCheapestExpendableStack(): {
  itemId: string;
  name: string;
  value: number;
} | null {
  try {
    let cheapest: { itemId: string; name: string; value: number } | null = null;

    for (const option of readSellCandidates()) {
      const itemId = String((option.params as { itemId?: unknown }).itemId ?? '');
      const item = game.items.getObjectByID(itemId);
      if (item === undefined) continue;

      const value = gpValue(item) * game.bank.getQty(item);
      if (cheapest === null || value < cheapest.value) {
        cheapest = { itemId, name: item.name, value };
      }
    }

    return cheapest;
  } catch (error) {
    noteSwallowed('candidates.readCheapestExpendableStack', error);
    return null;
  }
}

/**
 * The most valuable stack the agent may safely sell.
 *
 * The counterpart to {@link readCheapestExpendableStack}, and the difference in
 * direction is the difference in purpose. That one exists to escape a full
 * bank, where the goal is to free a slot while destroying as little value as
 * possible. This one exists to *earn*, so it takes the stack worth the most.
 *
 * Both draw from the same `readSellCandidates` filter, which is what makes an
 * automatic sale defensible at all: task items, scarce ingredients, every
 * farming seed, attack-spell runes, the runes and fixed inputs a reachable Alt
 * Magic spell needs, mastery tokens, bank-locked items, food while the larder
 * is thin, and ammunition are all already excluded by construction. The
 * reflex inherits every one of those guards rather than restating them, so a
 * guard added for the planner's benefit protects the reflex too.
 */
export function readMostValuableExpendableStack(): {
  itemId: string;
  name: string;
  value: number;
} | null {
  try {
    let best: { itemId: string; name: string; value: number } | null = null;

    for (const option of readSellCandidates()) {
      const itemId = String((option.params as { itemId?: unknown }).itemId ?? '');
      const item = game.items.getObjectByID(itemId);
      if (item === undefined) continue;

      const value = gpValue(item) * game.bank.getQty(item);
      if (value <= 0) continue;
      if (best === null || value > best.value) {
        best = { itemId, name: item.name, value };
      }
    }

    return best;
  } catch (error) {
    noteSwallowed('candidates.readMostValuableExpendableStack', error);
    return null;
  }
}

/**
 * Which question the guards are being asked.
 *
 * `'sell'` is "should this stack be offered to the shop"; `'consume'` is "may
 * this stack be destroyed by an Alt Magic cast". Every scarcity guard answers
 * both identically -- a seed, a token, a task item or a spell's own rune is no
 * safer fed to a spell than sold -- so they stay one ordered list in one
 * function rather than two that can drift. Exactly one clause differs, and it
 * is marked where it appears.
 */
type DisposalPurpose = 'sell' | 'consume';

/**
 * Bank items an Alt Magic cast is allowed to destroy.
 *
 * The consumption-side twin of {@link readSellCandidates}, sharing its guard
 * chain rather than restating it: both filter on `saleExclusionReason`, so a
 * guard added for the shop protects the spell in the same commit.
 *
 * It exists because the two paths differ in exactly one respect. Selling an
 * item worth 0 GP is pointless, so the sell list drops it; *burning* one is the
 * whole idea, and that difference is what made this bug expensive. With every
 * worthless stack filtered out, the cheapest thing Just Learning could see was a
 * 1 GP Nature Rune -- the rune it spends -- while 4,770 unusable Arrow Shafts
 * sat next to it costing nothing to lose.
 *
 * Returns items rather than `Candidate`s because the caller ranks and selects;
 * a `Sell 4770x Arrow Shafts` label on a list nothing will sell was noise the
 * previous shape carried only because it was borrowing the sell reader.
 */
export function readConsumableItems(): AnyItem[] {
  try {
    return [...game.bank.items.values()]
      .filter((entry) => saleExclusionReason(entry.item, entry.quantity, 'consume') === null)
      .map((entry) => entry.item);
  } catch (error) {
    noteSwallowed('candidates.readConsumableItems', error);
    // An unreadable bank offers nothing, which refuses the cast. Refusing is
    // the recoverable direction; destroying the wrong stack is not.
    return [];
  }
}

/**
 * Why a stack may not be sold, or null when it may.
 *
 * One function so the sell list and the diagnostic that explains it cannot
 * disagree. That mattered: Gold and Silver Bars worth about 216,000 GP sat
 * unsellable and unexplained, and three separate investigations eliminated
 * guards one at a time from outside because nothing would say which one had
 * fired. A filter chain that only ever returns a boolean can refuse for a good
 * reason and a bad one identically, and the third time that costs an afternoon
 * it is cheaper to make it speak.
 */
function saleExclusionReason(
  item: AnyItem,
  held = 0,
  purpose: DisposalPurpose = 'sell',
): string | null {
  try {
    // Quantity, not identity. A future task wanting one Gold Bar should keep
    // one, not all 1,056 -- see readTaskWantedQuantities.
    const wanted = readTaskWantedQuantities().get(item.id) ?? 0;
    if (wanted > 0 && held <= wanted) {
      return `a Township task wants ${wanted} and only ${held} are held`;
    }
    if (readBarelyEnoughIngredientIds().has(item.id)) return 'it is the last of a recipe input';
    if (readAllSeedIds().has(item.id)) return 'it is a farming seed';
    if (readSpellRuneIds().has(item.id)) return 'a castable spell needs it';
    if (readAltMagicFuelIds().has(item.id)) return 'an Alt Magic spell in reach needs it';
    if (readMasteryTokenIds().has(item.id)) return 'it is a mastery token';
    if (game.bank.lockedItems.has(item)) return 'it is locked in the bank';
    if (isAmmunition(item)) return 'it is ammunition';
    if (item instanceof FoodItem && readMealCount() < FOOD_SELL_FLOOR) {
      return `it is food and the larder is below ${FOOD_SELL_FLOOR} meals`;
    }
    // The only guard that is about the *sale* rather than about the item, and
    // so the only one that does not carry over to consumption. A stack the shop
    // will not pay for is pointless to list and perfect to burn: 4,770 Arrow
    // Shafts sell for 0 GP each (dump: `melvorF:Arrow_Shafts`, sellsFor 0) and
    // GOALS.md has them down as dead weight with no recipe that can use them.
    // Applying it to both paths is what left Just Learning nothing worthless to
    // eat and sent it to the cheapest thing that *did* have a price -- a Nature
    // Rune at 1 GP, which is its own fuel.
    if (purpose === 'sell' && gpValue(item) <= 0) return 'it does not sell for GP';
    return null;
  } catch (error) {
    noteSwallowed('candidates.saleExclusionReason', error);
    // Unreadable means unsellable: refusing to sell is the recoverable error.
    return 'its sell guards could not be evaluated';
  }
}

/**
 * How far above the current Magic level a spell still counts as reachable.
 *
 * "Castable right now" is the rule `readSpellRuneIds` uses for attack spells,
 * and it is too narrow here: the point of casting Just Learning at all is to
 * stockpile toward Superheat II, which unlocks at Magic 25 (dump: `melvorF`
 * `SuperheatII`, level 25) and needs a Nature Rune per cast like almost every
 * spell below it. A rune sold at Magic 10 because the spell that wants it is at
 * 25 has to be re-crafted before the milestone it was being saved for.
 *
 * A band rather than "every spell in the game", because a guard that reserves
 * everything refuses everything: Superheat III (64), Item Alchemy III (76) and
 * Superheat V (110) between them name every rune in the base game, and honouring
 * those from Magic 1 would lock Air, Earth, Fire, Water, Spirit and Soul Runes
 * for the rest of the run in exchange for nothing the character can do.
 *
 * 25 is the smallest band that reaches Superheat II from a fresh Magic 1, which
 * is the case this exists for, and it is roughly a session's worth of levels
 * rather than a lifetime's -- Just Learning took Magic 2 to 10 in six minutes.
 * From Magic 1 it stops at Bone Offering (18) and Superheat II (25) and leaves
 * the 40-and-up spells unreserved, which is the "60 levels away must not lock a
 * rune forever" line drawn where it can be justified.
 */
const ALT_MAGIC_REACH_LEVELS = 25;

/**
 * Everything a reachable Alt Magic spell destroys on every cast.
 *
 * The hole this closes, measured live over 100 seconds of `Just Learning`:
 *
 * ```
 * Air Rune -49   Nature Rune -98   Rune Essence +49
 * ```
 *
 * 49 casts. One Nature and one Air went to the spell's rune cost, which is
 * correct; the *second* Nature Rune per cast was the item the spell consumed,
 * because `chooseSelection` picks the cheapest thing `readSellCandidates` will
 * part with and a Nature Rune sells for 1. A Nature Rune costs a Rune Essence
 * to craft, so the trade was 2 Nature + 1 Air in for 1 essence out -- a strict
 * loss, paid in the one rune that every castable Alt Magic spell requires.
 *
 * `readSpellRuneIds` did not catch it: it walks `game.attackSpells`, and Nature
 * Rune appears in no attack spell. The guard was never wrong about attack
 * spells, it simply did not know Alt Magic prices itself in runes too. Note the
 * hole is independent of which end of the ranking `chooseSelection` takes --
 * before today it took the *dearest* item and would have burned Topaz or an
 * Adamantite Bar instead.
 *
 * Reserved for the sell list *and* for consumption, because those are the same
 * act: the reason this reader hangs off `saleExclusionReason` rather than
 * standing beside it is that a spell must not be able to eat its own fuel while
 * the shop is forbidden to sell it.
 *
 * Costs come from {@link spellCosts}, which is where the `runesRequired` /
 * `runesRequiredAlt` pair (spells.d.ts:27-28, chosen by
 * `Player.useCombinationRunes`, player.d.ts:122) is already resolved. That also
 * folds in `fixedItemCosts` (altMagic.d.ts:72), deliberately: Rags to Riches II
 * burns a Coal Ore per cast, and feeding a spell the last of what it needs to
 * fire is the identical failure to feeding it its own runes. Separating the two
 * would need an `instanceof RuneItem` (item.d.ts:489), and this file has been
 * bitten three times by naming a game global that vitest does not define.
 *
 * `specialCost` (altMagic.d.ts:74) is *not* reserved, and must not be: it is the
 * selection itself, so reserving it would refuse every cast.
 */
function readAltMagicFuelIds(): Set<string> {
  const fuel = new Set<string>();

  const magicLevel = safeNumber(
    'candidates.altMagicFuelLevel',
    () => game.skills.getObjectByID(ALT_MAGIC_ID)?.level,
    0,
  );
  // A level that could not be read leaves the band at 0 + reach, which still
  // covers Just Learning and Superheat II. Silently reserving nothing is the
  // failure this whole function exists to stop.
  const reach = magicLevel + ALT_MAGIC_REACH_LEVELS;

  // `Game.altMagic` (game.d.ts:115) is an `AltMagic`, whose `actions` registry
  // holds its `AltMagicSpell`s -- the same list `genericSkillCandidates` walks.
  // Reached through `game.skills` rather than `game.altMagic` so that a save
  // without the skill is a missing entry rather than a TypeError.
  const spells = safeList('candidates.altMagicSpells', () => {
    const magic = game.skills.getObjectByID(ALT_MAGIC_ID) as
      | (AnySkill & { actions?: { allObjects: RecipeLike[] } })
      | undefined;
    return magic?.actions?.allObjects ?? [];
  });

  for (const spell of spells) {
    try {
      if (spell.level > reach) continue;
      for (const cost of spellCosts(spell) ?? []) fuel.add(cost.item.id);
    } catch (error) {
      noteSwallowed('candidates.altMagicFuelCosts', error);
      // One unreadable spell does not get to empty the guard; the rest of the
      // book still reserves what it needs.
    }
  }

  return fuel;
}

/**
 * Valuable stacks the agent is holding but refuses to sell, and why.
 *
 * The counterpart to the sell list rather than a duplicate of it. A stack worth
 * six figures that never appears as a candidate is indistinguishable, from
 * outside, from a stack the agent simply has not got to yet -- and that
 * ambiguity is what let 216,000 GP of bars sit through several planning passes
 * while the run was short of GP for Auto Eat.
 *
 * Only above a floor, and only the worst offenders, so this stays a diagnostic
 * rather than a second inventory listing.
 */
export function readUnsellableNotice(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  try {
    const held: { name: string; value: number; reason: string }[] = [];

    for (const entry of game.bank.items.values()) {
      const reason = saleExclusionReason(entry.item, entry.quantity);
      if (reason === null) continue;

      const value = gpValue(entry.item) * entry.quantity;
      if (value < UNSELLABLE_NOTICE_FLOOR) continue;

      held.push({ name: entry.item.name, value, reason });
    }

    return held
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map((stack) => ({
        label: `Holding ${stack.value.toLocaleString()} GP of ${stack.name} that will not be sold: ${stack.reason}.`,
        xpPerHour: 0,
        missing: [],
      }));
  } catch (error) {
    noteSwallowed('candidates.readUnsellableNotice', error);
    return [];
  }
}

/** GP value below which an unsellable stack is not worth mentioning. */
const UNSELLABLE_NOTICE_FLOOR = 20_000;

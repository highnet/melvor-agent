import { spellCosts } from './affordability.js';
import { ALT_MAGIC_ID, type RecipeLike } from './recipes.js';
import { noteSwallowed, safeNumber, safeValue } from './safe.js';

/**
 * What one action of a recipe is worth, and how long its inputs will last.
 *
 * Split out of `candidates.ts` so the enumerations there rank numbers this
 * module produces rather than computing them inline.
 *
 * Net, never gross. A production recipe *spends* to earn and the difference is
 * frequently the whole story -- leather armour looks like 90,000 GP/h gross and
 * is negative once the leather it burns is priced. A gross figure here would
 * not be an approximation, it would point the wrong way.
 */

/**
 * GP a single Alt Magic cast yields, net of the item it destroys.
 *
 * `getAlchemyGP` (altMagic.d.ts:142) is documented as "the modified GP to add
 * when casting alchemy spells", and `productionRatio` is the multiplier it
 * takes. The item consumed is subtracted because alchemy destroys it, and its
 * sale value is the alternative -- an alchemy that pays less than selling the
 * same item is not income, it is a slower way to sell.
 *
 * Returns null for any spell that is not an alchemy, so the caller falls
 * through to the ordinary product arithmetic.
 */
function alchemyGpPerCast(skill: AnySkill, recipe: RecipeLike): number | null {
  try {
    if (skill.id !== ALT_MAGIC_ID) return null;

    const spell = recipe as unknown as {
      produces?: unknown;
      productionRatio?: number;
      specialCost?: { quantity: number };
    };
    // The two ids are spelled out because AltMagicProductionID is a plain
    // `declare enum` (altMagic.d.ts:12-21), so the runtime bundle may carry no
    // value for it: -1 is GP, -2 is Bar.
    if ((spell.specialCost?.quantity ?? 0) <= 0) return null;

    // Superheat produces a bar, not currency, so the ordinary product path
    // finds nothing to price -- an AltMagicSpell has no `product` field -- and
    // the whole family read as worth zero. Its value is the bar it smelts, less
    // the ore that bar consumes, exactly as the furnace version is priced.
    if (spell.produces === -2) return superheatGpPerCast();
    if (spell.produces !== -1) return null;

    const magic = game.altMagic;
    let best = 0;
    for (const item of magic.getSpellItemSelection(recipe as never)) {
      const gp = magic.getAlchemyGP(item, spell.productionRatio ?? 1);
      const net = gp - gpValue(item);
      if (Number.isFinite(net) && net > best) best = net;
    }

    return best;
  } catch (error) {
    noteSwallowed('candidates.alchemyGpPerCast', error);
    return null;
  }
}

/**
 * Net GP of the best bar Superheat can currently smelt.
 *
 * Superheat consumes a Smithing recipe's ingredients and produces its bar
 * without occupying the furnace. Its worth is therefore the same margin the
 * furnace earns -- bar value less ore value -- and pricing it any other way
 * would make the two paths incomparable when the whole question is which to
 * use.
 *
 * The best *affordable* recipe, because an unaffordable one is not an option
 * this hour, and level-gated ones are not options at all.
 */
function superheatGpPerCast(): number {
  try {
    let best = 0;
    for (const recipe of game.smithing.actions.allObjects) {
      try {
        if (recipe.level > game.smithing.level) continue;
        if (!game.smithing.isMasteryActionUnlocked(recipe)) continue;

        const revenue = gpValue(recipe.product) * (recipe.baseQuantity ?? 1);
        if (revenue <= 0) continue;

        let spent = 0;
        for (const cost of recipe.itemCosts) spent += gpValue(cost.item) * cost.quantity;

        const net = revenue - spent;
        if (net > best) best = net;
      } catch (error) {
        noteSwallowed('candidates.superheatGpPerCast', error);
        // A recipe that will not price itself is not the best one.
      }
    }

    return best;
  } catch (error) {
    noteSwallowed('candidates.superheatGpPerCast', error);
    return 0;
  }
}

/**
 * What one action of a production recipe is worth, net of what it consumes.
 *
 * Artisan recipes reported no GP at all -- not zero, absent -- so Smithing,
 * Crafting, Fletching, Herblore, Runecrafting, Summoning, Cooking, Firemaking
 * and Alt Magic were invisible to any planner asked to raise money, and the
 * board showed only gathering and Thieving. The consequence was live and
 * expensive: Gold Topaz Ring sat available with its inputs banked while the
 * agent mined ore, and nothing on screen could say which was worth more.
 *
 * Net, not gross, because a production recipe *spends* to earn and the
 * difference is frequently the whole story. Leather armour looks like 90,000
 * GP/h gross and is negative once the leather it burns is priced; an Air
 * Battlestaff tops any list at over a million gross and loses six hundred
 * thousand an hour. A gross figure here would not be an approximation, it would
 * point the wrong way.
 *
 * Preservation reduces what is actually consumed (`getPreservationChance`,
 * skill.d.ts:458), so it is applied to the cost side. Where an input has no
 * sale value the cost term is zero, which understates -- an unpriced input is
 * not a free one, and that direction at least stays recoverable by measurement.
 */
export function netProductGpFor(skill: AnySkill, recipe: RecipeLike, yielded: number): number {
  try {
    // Alt Magic pays a currency rather than producing an item, so the generic
    // product arithmetic below scores it at zero -- which made the game's
    // dedicated turn-items-into-GP action invisible on a board being read to
    // answer "how do we earn money". Exactly the shape of the Thieving bug.
    const alchemy = alchemyGpPerCast(skill, recipe);
    if (alchemy !== null) return alchemy;

    const product = recipe.product as AnyItem | undefined;
    if (product === undefined) return 0;

    const revenue = gpValue(product) * yielded;
    if (revenue <= 0) return 0;

    const withPreservation = skill as AnySkill & {
      getPreservationChance?: (action: object) => number;
    };
    const preserved = Math.max(
      0,
      Math.min(1, (withPreservation.getPreservationChance?.(recipe) ?? 0) / 100),
    );

    let spent = 0;
    for (const cost of recipe.itemCosts ?? []) {
      spent += gpValue(cost.item) * cost.quantity * (1 - preserved);
    }

    return revenue - spent;
  } catch (error) {
    noteSwallowed('candidates.netProductGpFor', error);
    return 0;
  }
}

/**
 * GP value of one unit of a recipe's product.
 *
 * `sellsFor` is a `CurrencyQuantity`, and not every item sells for GP —
 * reporting a non-GP value as `gpPerHour` would quietly mislead the planner.
 */
export function gpValue(product: AnyItem): number {
  const sale = product.sellsFor;
  return sale.currency === game.gp ? sale.quantity : 0;
}

/** Names the input horizon when it is short enough to matter. */
export function describeSustain(recipe: RecipeLike, intervalMs: number): string {
  const minutes = sustainableMinutes(recipe, intervalMs);
  if (minutes === null) return '';
  if (minutes >= SUSTAIN_NOTICE_MINUTES) return '';

  return minutes < 1
    ? ' — inputs run out almost immediately'
    : ` — inputs last about ${Math.round(minutes)} min`;
}

/** Above this the stock is not the binding constraint and saying so is noise. */
const SUSTAIN_NOTICE_MINUTES = 60;

/**
 * How long a recipe's banked inputs will actually sustain it.
 *
 * `canAfford` asks only whether one action is possible, which is a different
 * question from whether an objective is. A recipe with five bars in the bank
 * advertises a full rate, runs for twenty seconds and then fails until the
 * failure limit abandons it -- and the planner that chose it had nothing on
 * screen suggesting it would.
 *
 * It cost two objectives today. Runecrafting's Acolyte Wizard Robes was the
 * highest-XP recipe on the board and aborted instantly, because it consumes
 * runes rather than the essence that was banked; and the Gold Bar chain
 * silently ran the smelter dry while the plan still read as healthy.
 *
 * Null when a recipe consumes nothing identifiable -- a gathering action is
 * limited by time, not by stock, and reporting a horizon there would be
 * inventing one.
 */
export function sustainableMinutes(recipe: RecipeLike, intervalMs: number): number | null {
  try {
    // Spells included: a spell's runes run out exactly as a recipe's bars do,
    // and the note exists because Acolyte Wizard Robes advertised the best rate
    // on the board and aborted in twenty seconds.
    const costs = recipe.itemCosts ?? spellCosts(recipe) ?? [];
    if (costs.length === 0) return null;
    if (intervalMs <= 0) return null;

    let actions = Number.POSITIVE_INFINITY;
    for (const cost of costs) {
      if (cost.quantity <= 0) continue;
      const held = game.bank.getQty(cost.item);
      actions = Math.min(actions, Math.floor(held / cost.quantity));
    }

    if (!Number.isFinite(actions)) return null;
    return (actions * intervalMs) / 60_000;
  } catch (error) {
    noteSwallowed('candidates.sustainableMinutes', error);
    return null;
  }
}

// --- combat ----------------------------------------------------------------

/** What one kill pays, split by whether the payment is already money. */
export interface KillValue {
  /**
   * Currency the kill drops straight into the balance.
   *
   * Kept apart from {@link lootGpPerKill} for the reason `gpIsEarned` exists on
   * a candidate: coins and items that *would* fetch coins are different claims,
   * and a GP goal was once reported as advanced by mining a gem, an hour of
   * which moves the balance by exactly zero.
   */
  gpPerKill: number;
  /** What the kill's items would fetch, if something sells them. */
  lootGpPerKill: number;
  /**
   * The bones a kill drops, which are the only thing Prayer is trained on.
   *
   * `Monster.bones` (monsters.d.ts:114) is optional and sits outside the loot
   * table, so it is neither rolled nor discounted by `lootChance` -- a monster
   * that has bones drops them every kill. Named rather than only counted,
   * because `prayer-20` is an open goal and nothing else advances it.
   */
  bones: { name: string; quantity: number } | null;
}

/**
 * What a monster is worth per kill.
 *
 * Every term comes from a stated field or a getter documented as an *average*.
 * That distinction is the whole care in this function: `DropTable` offers
 * `getDrop()` (utils.d.ts:541) and `getRawDrop()` (utils.d.ts:543), both
 * documented as rolling, and `getAverageDropValue()` (utils.d.ts:545),
 * documented as "the average currency value of a drop in this table". Pricing
 * an hour off either of the first two would repeat the
 * `modifyPrimaryProductQuantity` bug exactly -- a sample read as an estimate,
 * which had the board advertising rates that flipped by a factor of two between
 * two readings with no game state moving.
 *
 * `lootChance` (monsters.d.ts:110) is applied on top, because it is the chance
 * the table rolls *at all* and the average is conditional on it rolling.
 * Treating the two as one is how "drops Garum Seeds at 100% loot chance"
 * welded two true facts into a false one.
 */
export function killValueFor(monster: Monster): KillValue {
  const bones = safeValue('pricing.monsterBones', () => monster.bones);

  return {
    gpPerKill: currencyPerKill(monster),
    lootGpPerKill:
      lootValuePerKill(monster) + (bones === undefined ? 0 : gpValue(bones.item) * bones.quantity),
    bones: bones === undefined ? null : { name: bones.item.name, quantity: bones.quantity },
  };
}

/**
 * GP a kill pays directly.
 *
 * `Monster.currencyDrops` is `CurrencyDrop[]` (monsters.d.ts:112), each a
 * `{ currency, min, max }` (monsters.d.ts:12-16) -- a range the game rolls, so
 * the midpoint is the expectation. Non-GP currencies are skipped rather than
 * summed in: reporting Slayer Coins as `gpPerHour` would quietly mislead the
 * planner, the same reason {@link gpValue} checks the currency on `sellsFor`.
 */
function currencyPerKill(monster: Monster): number {
  try {
    let total = 0;
    for (const drop of monster.currencyDrops) {
      if (drop.currency !== game.gp) continue;
      total += (drop.min + drop.max) / 2;
    }
    return total;
  } catch (error) {
    noteSwallowed('pricing.currencyPerKill', error);
    return 0;
  }
}

/** Expected sale value of the loot table, discounted by the chance it rolls. */
function lootValuePerKill(monster: Monster): number {
  const chance = safeNumber('pricing.lootChance', () => monster.lootChance, 0) / 100;
  if (!(chance > 0)) return 0;

  const table = safeValue('pricing.lootTable', () => monster.lootTable);
  if (table === undefined) return 0;

  const average =
    safeValue('pricing.averageDropValue', () => table.getAverageDropValue().get(game.gp)) ??
    weightedTableValue(table);

  return Number.isFinite(average) && average > 0 ? average * Math.min(1, chance) : 0;
}

/**
 * The same average, computed from the table's own fields.
 *
 * Stands in when `getAverageDropValue` is missing or throws. Not a
 * reimplementation of a game formula -- it is arithmetic over four documented
 * numbers, `totalWeight` (utils.d.ts:531) and each element's `weight`,
 * `minQuantity` and `maxQuantity` (utils.d.ts:511-516) -- so an accessor rename
 * costs the rate its precision rather than costing every fight its rate.
 */
function weightedTableValue(table: DropTable): number {
  try {
    const total = table.totalWeight;
    if (!(total > 0)) return 0;

    let value = 0;
    for (const drop of table.drops) {
      value +=
        (drop.weight / total) * gpValue(drop.item) * ((drop.minQuantity + drop.maxQuantity) / 2);
    }
    return value;
  } catch (error) {
    noteSwallowed('pricing.weightedTableValue', error);
    return 0;
  }
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readShopGoalNotice } from '../src/adapter/blocked.js';
import { readMoneyBlockedUpgrades } from '../src/adapter/shop.js';

/**
 * The difference between "cannot afford it" and "cannot have it".
 *
 * `Rune Fishing Rod` cost 300,000 against a balance of 174,154 and its only
 * requirement, `Fishing 60`, was **met** — so 125,846 GP of work buys it, and
 * that is an objective. It was invisible: every shop reader filtered on
 * affordability, so the candidate list offered twenty consumables at 4 to 600
 * GP each and nothing else, while a permanent 5% cut to the interval of a skill
 * with fourteen hours of Township fishing queued sat unreachable in the shop.
 *
 * `Mahogany Cooking Fire` was equally unaffordable and is the opposite case:
 * its requirement is `Firemaking 55` against 32, so no amount of earning buys
 * it. Only the first is actionable, and a list that conflates them is a list
 * that sends the run after money it cannot spend.
 *
 * The real readers are driven against a hand-written shop. A mirror of the
 * filter order could not catch the bug this is written against, because the bug
 * would be *which* filter got applied.
 */

/** GP, held by identity — `Costs` keys currencies by object, not by id. */
const GP = { id: 'melvorD:GP', name: 'GP', amount: 174_154 };
const SLAYER_COINS = { id: 'melvorD:SlayerCoins', name: 'Slayer Coins', amount: 0 };

interface FakePurchase {
  id: string;
  name: string;
  contains: {
    items: { item: string; quantity: number }[];
    pet?: object;
    lootBox?: boolean;
    bankTab?: boolean;
    stats?: { modifiers?: { skill?: { id: string } }[]; describePlain(): string };
  };
  purchaseRequirements: { met: boolean }[];
  allowQuantityPurchase: boolean;
  /** GP price of one. Fixed here; escalation is `batchSizeFor`'s problem. */
  gp: number;
  /** A second currency the purchase also wants, if any. */
  slayerCoins?: number;
  /** Banked items the purchase also consumes, if any. */
  itemCosts?: { item: string; quantity: number }[];
  owned: number;
  atBuyLimit?: boolean;
}

function upgrade(
  id: string,
  name: string,
  gp: number,
  overrides: Partial<FakePurchase> = {},
): FakePurchase {
  return {
    id,
    name,
    contains: { items: [] },
    purchaseRequirements: [{ met: true }],
    allowQuantityPurchase: false,
    gp,
    owned: 0,
    ...overrides,
  };
}

/** Modifiers scoped to a skill, the way `contains.stats` reports them. */
function grants(skillIds: string[], text: string): NonNullable<FakePurchase['contains']['stats']> {
  return {
    modifiers: skillIds.map((id) => ({ skill: { id } })),
    describePlain: () => text,
  };
}

/**
 * The four purchases from the live session, plus the two shapes that are
 * unaffordable for reasons money does not fix.
 */
const ROD = upgrade('melvorD:Rune_Fishing_Rod', 'Rune Fishing Rod', 300_000, {
  contains: {
    items: [],
    stats: grants(['melvorD:Fishing'], '-5% Fishing Interval'),
  },
});

/** Requirement *unmet*. Firemaking 55 against 32; earning buys nothing here. */
const FIRE = upgrade('melvorD:Mahogany_Cooking_Fire', 'Mahogany Cooking Fire', 100_000, {
  purchaseRequirements: [{ met: false }],
  contains: { items: [], stats: grants(['melvorD:Cooking'], '+15% Cooking Success') },
});

/** Cheaper than the rod in GP, and blocked on a currency GP cannot become. */
const SLAYER_GEAR = upgrade('melvorD:Slayer_Helmet', 'Slayer Helmet', 10_000, {
  slayerCoins: 5_000,
});

/** Already owned. An upgrade in hand is not an opportunity. */
const OWNED = upgrade('melvorD:Iron_Axe', 'Iron Axe', 1_000_000, { owned: 1 });

/** Affordable now — a candidate, deliberately not a saving target. */
const CHEAP = upgrade('melvorD:Compost', 'Compost', 200);

/** Money-blocked, requirement met, and dearer than the rod. */
const GLOVES = upgrade('melvorD:Gem_Gloves', 'Gem Gloves', 500_000, {
  contains: { items: [], stats: grants(['melvorD:Mining'], '+1 Gem per Mining action') },
});

let uninstall = (): void => {};

function installShop(purchases: FakePurchase[], banked: Record<string, number> = {}): void {
  const previous = (globalThis as Record<string, unknown>).game;

  (globalThis as Record<string, unknown>).game = {
    gp: GP,
    bank: { getQty: (item: string): number => banked[item] ?? 0 },
    // The purchase carries whether each of its requirements is met; the game
    // answers for all of them at once, which is what `checkRequirements` does.
    checkRequirements: (requirements: { met: boolean }[]): boolean =>
      requirements.every((requirement) => requirement.met),
    shop: {
      purchases: { allObjects: purchases },
      getPurchaseCount: (purchase: FakePurchase): number => purchase.owned,
      isPurchaseAtBuyLimit: (purchase: FakePurchase): boolean => purchase.atBuyLimit === true,
      getPurchaseCosts: (purchase: FakePurchase, quantity: number) => ({
        // The game's own affordability answer, over every cost at once. It is
        // false for the expensive, the wrong-currency and the stock-blocked
        // alike, which is exactly why the reader cannot use it on its own.
        checkIfOwned: (): boolean =>
          purchase.gp * quantity <= GP.amount &&
          (purchase.slayerCoins ?? 0) * quantity <= SLAYER_COINS.amount &&
          (purchase.itemCosts ?? []).every(
            (cost) => (banked[cost.item] ?? 0) >= cost.quantity * quantity,
          ),
        getCurrencyQuantityArray: () => [
          { currency: GP, quantity: purchase.gp * quantity },
          ...(purchase.slayerCoins === undefined
            ? []
            : [{ currency: SLAYER_COINS, quantity: purchase.slayerCoins * quantity }]),
        ],
        getItemQuantityArray: () =>
          (purchase.itemCosts ?? []).map((cost) => ({
            item: cost.item,
            quantity: cost.quantity * quantity,
          })),
      }),
    },
  };

  uninstall = (): void => {
    (globalThis as Record<string, unknown>).game = previous;
  };
}

afterEach(() => {
  uninstall();
  GP.amount = 174_154;
  SLAYER_COINS.amount = 0;
});

/**
 * The same six purchases in three registry orders.
 *
 * A mutation survived a previous round here because registry order made "take
 * the last match" accidentally correct, so every ordering claim below is made
 * against all three. The rod is first, last and buried in turn.
 */
const ORDERS: [string, FakePurchase[]][] = [
  ['rod first', [ROD, FIRE, SLAYER_GEAR, OWNED, CHEAP, GLOVES]],
  ['rod last', [GLOVES, CHEAP, OWNED, SLAYER_GEAR, FIRE, ROD]],
  ['rod buried', [CHEAP, GLOVES, ROD, OWNED, FIRE, SLAYER_GEAR]],
];

describe('upgrades blocked only on money', () => {
  for (const [name, purchases] of ORDERS) {
    describe(name, () => {
      beforeEach(() => {
        installShop(purchases);
      });

      it('surfaces a met-requirement purchase the character cannot afford', () => {
        const rod = readMoneyBlockedUpgrades().find((entry) => entry.purchaseId === ROD.id);

        expect(rod).toBeDefined();
        expect(rod?.gpCost).toBe(300_000);
        // 300,000 against 174,154. The number an objective is sized from, and
        // the number the sell reflex caps itself with.
        expect(rod?.shortfall).toBe(125_846);
      });

      it('withholds a level-blocked purchase, however unaffordable it is', () => {
        // The distinction that makes the list actionable. Firemaking 55 against
        // 32 is not bought by earning, and offering it as a saving target sends
        // the run after money it cannot spend.
        expect(readMoneyBlockedUpgrades().map((entry) => entry.purchaseId)).not.toContain(FIRE.id);
      });

      it('withholds one blocked on a currency GP cannot become', () => {
        // 10,000 GP is affordable outright; the 5,000 Slayer Coins are not, and
        // `checkIfOwned` reports the same false for both reasons. Cheapest by
        // GP, so a reader that trusted price alone would fund this first.
        expect(readMoneyBlockedUpgrades().map((entry) => entry.purchaseId)).not.toContain(
          SLAYER_GEAR.id,
        );
      });

      it('withholds one already owned', () => {
        expect(readMoneyBlockedUpgrades().map((entry) => entry.purchaseId)).not.toContain(OWNED.id);
      });

      it('withholds one that is affordable now', () => {
        // Affordable is a *candidate*, and keeping "a candidate can be executed
        // right now" absolute is what makes choosing by index safe.
        expect(readMoneyBlockedUpgrades().map((entry) => entry.purchaseId)).not.toContain(CHEAP.id);
      });

      it('orders by shortfall, nearest first', () => {
        expect(readMoneyBlockedUpgrades().map((entry) => entry.purchaseId)).toEqual([
          ROD.id,
          GLOVES.id,
        ]);
      });

      it('names the skills the upgrade modifies, from the game', () => {
        const rod = readMoneyBlockedUpgrades().find((entry) => entry.purchaseId === ROD.id);

        expect(rod?.skillIds).toEqual(['melvorD:Fishing']);
        expect(rod?.effect).toBe('-5% Fishing Interval');
      });
    });
  }

  it('withholds one whose remaining cost is banked stock', () => {
    // Affordable in GP and short of the items it consumes. Earning does not
    // fill a bank, so this is not something to save toward either.
    installShop(
      [upgrade('melvorD:Kit', 'Kit', 1_000, { itemCosts: [{ item: 'bar', quantity: 5 }] })],
      {
        bar: 2,
      },
    );

    expect(readMoneyBlockedUpgrades()).toEqual([]);
  });

  it('offers it once the missing stock is banked and only the price is left', () => {
    installShop(
      [upgrade('melvorD:Kit', 'Kit', 900_000, { itemCosts: [{ item: 'bar', quantity: 5 }] })],
      { bar: 5 },
    );

    expect(readMoneyBlockedUpgrades().map((entry) => entry.purchaseId)).toEqual(['melvorD:Kit']);
  });

  it('stops offering it once the balance covers it', () => {
    // The authorisation this feeds expires on success, and it expires here
    // first: an upgrade that can simply be bought is not a thing to earn for.
    installShop([ROD]);
    GP.amount = 300_000;

    expect(readMoneyBlockedUpgrades()).toEqual([]);
  });
});

describe('the saving notice ranks by what the run is about to do', () => {
  for (const [name, purchases] of ORDERS) {
    it(`puts the upgrade the plan will use first (${name})`, () => {
      installShop(purchases);

      // Gem Gloves costs 500,000 against the rod's 300,000, so shortfall alone
      // ranks the rod above it. With 300 minutes of Mining queued and no
      // Fishing, the gloves are what the next five hours actually pay for.
      const notice = readShopGoalNotice(new Map([['melvorD:Mining', 300]]));

      expect(notice[0]?.label).toMatch(/Gem Gloves/);
      expect(notice[0]?.label).toMatch(/300 minutes/);
      expect(notice[1]?.label).toMatch(/Rune Fishing Rod/);
    });

    it(`falls back to the nearest shortfall when nothing is planned (${name})`, () => {
      installShop(purchases);

      const notice = readShopGoalNotice();

      expect(notice[0]?.label).toMatch(/Rune Fishing Rod/);
      // The half of the sentence that makes it actionable: requirement met, so
      // this is earnable rather than merely expensive.
      expect(notice[0]?.label).toMatch(/blocked purely on money/);
      expect(notice[0]?.label).toMatch(/125,846/);
    });

    it(`never lists a level-blocked purchase (${name})`, () => {
      installShop(purchases);

      // With Cooking heavily queued, a ranker that scored relevance without
      // first excluding the unreachable would lift Mahogany Cooking Fire to the
      // top of the saving list.
      const labels = readShopGoalNotice(new Map([['melvorD:Cooking', 600]]))
        .map((entry) => entry.label)
        .join(' ');

      expect(labels).not.toMatch(/Mahogany/);
    });
  }
});

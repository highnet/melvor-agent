import { describe, expect, it } from 'vitest';
import { buyShopUpgrade } from '../src/policy/buy.js';
import { isObjectiveComplete } from '../src/policy/criteria.js';
import { objective, snapshot } from './fixtures.js';

const BLACK_AXE = 'melvorD:Black_Axe';

function buyContext(successWhen: ReturnType<typeof objective>['successWhen'] = []) {
  const snap = snapshot();
  return {
    snapshot: snap,
    objective: objective({
      kind: 'buy_shop_upgrade',
      params: {
        kind: 'buy_shop_upgrade',
        purchaseId: BLACK_AXE,
        quantity: 1,
        gpFloor: 0,
      },
      successWhen,
    }),
    now: snap.capturedAt,
    objectiveStartedAt: snap.capturedAt,
    deathsSinceStart: 0,
  };
}

describe('one-shot objectives', () => {
  it('treats no criteria as "the executor decides", not as instantly done', () => {
    // Observed live: a purchase objective carried "have at least 1 GP", which
    // was already true, so the agent reported it complete without ever buying
    // anything and asked for a new plan. Vacuous truth is the wrong default
    // here — an empty list means no criterion applies, not that all of them do.
    expect(isObjectiveComplete(snapshot(), [])).toBe(false);
  });

  it('buys and finishes rather than re-buying every tick', () => {
    const decision = buyContext();
    expect(buyShopUpgrade(decision)).toEqual({
      kind: 'act',
      actions: [{ type: 'buy', purchaseId: BLACK_AXE, quantity: 1 }],
      reason: `buying 1x ${BLACK_AXE} with 10000 GP (floor 0)`,
      completeAfter: true,
    });
  });

  it('still honours real criteria when an objective states them', () => {
    const met = buyContext([{ type: 'currency_at_least', currencyId: 'melvorD:GP', amount: 500 }]);
    expect(buyShopUpgrade(met)).toMatchObject({ kind: 'complete' });
  });
});

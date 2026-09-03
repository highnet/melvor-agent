import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StateSnapshot } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { evaluateGoals, loadGoals } from '../src/goals.js';

async function goalsFrom(body: string) {
  const root = await mkdtemp(join(tmpdir(), 'melvor-goals-'));
  await writeFile(join(root, 'GOALS.md'), body, 'utf8');
  return loadGoals(root);
}

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    capturedAt: 1_700_000_000_000,
    gameVersion: 'v1.3.1',
    characterName: 'test',
    gamemodeId: 'melvorD:Standard',
    currentRealmId: 'melvorD:Melvor',
    isOfflineLoop: false,
    totalLevel: 98,
    completionPercent: 0.79,
    currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 2951 }],
    skills: [{ id: 'melvorD:Woodcutting', name: 'Woodcutting', level: 32, xp: 17_000 }],
    bank: { slotsUsed: 6, slotsMax: 20, items: [] },
    activeAction: null,
    farm: [],
    township: null,
    combat: {
      inCombat: false,
      hitpoints: 100,
      maxHitpoints: 100,
      prayerPoints: 0,
      autoEatThreshold: 0,
      autoEatHPLimit: 0,
      autoEatEfficiency: 0,
      maxHit: 10,
      minHit: 1,
      accuracy: 100,
      attackInterval: 2600,
      maxBarrier: 0,
      combatLevel: 12,
      food: [],
      selectedEquipmentSet: 0,
      selectedFoodSlot: 0,
      equipment: [],
      enemy: null,
    },
    ...overrides,
  } as StateSnapshot;
}

describe('goal annotations', () => {
  it('parses a condition containing >=', async () => {
    // The obvious character class for an annotation body is [^>], which can
    // never reach the closing --> because every condition contains >=. Every
    // goal then reported as unmeasurable, which looks exactly like goals
    // written without conditions — so the bug was invisible in the output.
    const goals = await goalsFrom('- Total level 500. <!-- done: total >= 500 -->');

    expect(goals).toHaveLength(1);
    expect(goals[0]?.done).toEqual({ type: 'total_level_at_least', level: 500 });
  });

  it('accepts annotations wrapped onto continuation lines', async () => {
    const goals = await goalsFrom(
      [
        '- Woodcutting 50 for the better log tiers. <!-- id: wc-50 -->',
        '  <!-- done: skill melvorD:Woodcutting >= 50 --> <!-- advances: melvorD:Woodcutting -->',
      ].join('\n'),
    );

    expect(goals).toHaveLength(1);
    expect(goals[0]).toMatchObject({
      id: 'wc-50',
      done: { type: 'skill_level_at_least', skillId: 'melvorD:Woodcutting', level: 50 },
      advancedBy: ['melvorD:Woodcutting'],
    });
  });

  it('measures progress and honours dependencies', async () => {
    const goals = await goalsFrom(
      [
        '- Reach 5,000 GP. <!-- id: early-gp --> <!-- done: currency melvorD:GP >= 5000 -->',
        '- Buy Auto Eat. <!-- id: auto-eat --> <!-- requires: early-gp -->',
        '  <!-- done: currency melvorD:GP >= 1000000 -->',
      ].join('\n'),
    );

    const statuses = evaluateGoals(goals, snapshot());

    // `progress` only exists on the `active` variant, so the state has to be
    // narrowed before it can be read: off the bare union it is `undefined`, and
    // `toBeCloseTo(undefined)` is not the assertion this test means to make.
    const first = statuses[0];
    expect(first).toMatchObject({ state: 'active' });
    if (first?.state !== 'active') throw new Error('expected an active goal');
    expect(first.progress).toBeCloseTo(2951 / 5000, 2);
    // Not merely "further away" — unreachable until the goal it names is done.
    expect(statuses[1]).toMatchObject({ state: 'blocked' });
  });

  it('reports a goal with no condition as unmeasurable rather than unfinished', async () => {
    const goals = await goalsFrom('- Have fun.');
    const statuses = evaluateGoals(goals, snapshot());

    expect(statuses[0]).toMatchObject({ state: 'active' });
    expect(statuses[0]?.detail).toMatch(/no measurable/i);
  });
});

/**
 * A goal that buys something.
 *
 * The failure these pin down happened live. `auto-eat` read
 * `currency melvorD:GP >= 1000000`; the agent funded it, the buy reflex spent
 * the money on Auto Eat - Tier I, and the goal fell from 89% to 3% — because
 * paying is what empties the balance. It could never complete, and
 * `fundingTarget` is documented as expiring on success, so the authorisation to
 * sell surplus never expired either.
 */
describe('a goal measured by owning a purchase', () => {
  const AUTO_EAT = 'melvorD:Auto_Eat_Tier_I';

  const buyGoal = [
    '- Buy Auto Eat - Tier I. <!-- id: auto-eat -->',
    `  <!-- done: shop ${AUTO_EAT} >= 1 --> <!-- advances: gp -->`,
  ].join('\n');

  it('parses the condition rather than leaving it unmeasurable', async () => {
    const goals = await goalsFrom(buyGoal);

    expect(goals[0]?.done).toEqual({
      type: 'shop_owned_at_least',
      purchaseId: AUTO_EAT,
      count: 1,
    });
  });

  it('reads done once owned, even with the balance spent', async () => {
    const goals = await goalsFrom(buyGoal);

    const [status] = evaluateGoals(
      goals,
      snapshot({
        // The exact shape after the live purchase: owned, and nearly broke.
        currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 5161 }],
        shopPurchases: [{ id: AUTO_EAT, owned: 1 }],
      }),
    );

    expect(status?.state).toBe('done');
  });

  it('stays active while unowned, however much money is banked', async () => {
    const goals = await goalsFrom(buyGoal);

    const [status] = evaluateGoals(
      goals,
      snapshot({
        currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 5_000_000 }],
        shopPurchases: [],
      }),
    );

    expect(status?.state).toBe('active');
    expect(status?.detail).toBe('0/1 owned');
  });

  it('survives a snapshot from a mod build predating the field', async () => {
    const goals = await goalsFrom(buyGoal);
    // `.default([])` is applied by parsing, and an older mod sends no field at
    // all. Reading it unguarded threw and took the whole evaluation down.
    const { shopPurchases: _omitted, ...older } = snapshot();

    const [status] = evaluateGoals(goals, older as StateSnapshot);

    expect(status?.state).toBe('active');
  });
});

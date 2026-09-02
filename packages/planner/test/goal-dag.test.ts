import type { Candidate, StateSnapshot } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { type Goal, evaluateGoals, goalsAdvancedBy } from '../src/goals.js';

/**
 * The goal DAG's three ways of saying nothing.
 *
 * Each one is silent in the output: a goal that is blocked forever looks like a
 * goal that is merely not ready, and a candidate that tags no goal looks like a
 * candidate that genuinely serves none. All three were found by asking why a
 * goal nobody had touched in days was still reported as waiting.
 */

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

function candidate(partial: Partial<Candidate> & Pick<Candidate, 'kind' | 'params'>): Candidate {
  return { label: 'x', available: true, ...partial } as Candidate;
}

describe('prerequisites that cannot be measured', () => {
  const prose: Goal = { id: 'settle-in', description: 'Get comfortable' };
  const dependent: Goal = {
    id: 'chop',
    description: 'Woodcutting 50',
    requires: ['settle-in'],
    done: { type: 'skill_level_at_least', skillId: 'melvorD:Woodcutting', level: 50 },
  };

  it('does not block a dependent on a goal that can never complete', () => {
    // The prerequisite has no `done:`, so it can never enter the done set and
    // the dependent was blocked for the life of the file — while the work it
    // waited on may well have been finished weeks ago.
    const statuses = evaluateGoals([prose, dependent], snapshot());

    expect(statuses.find((s) => s.goal.id === 'chop')?.state).toBe('active');
  });

  it('says which prerequisite it stepped over', () => {
    const chop = evaluateGoals([prose, dependent], snapshot()).find((s) => s.goal.id === 'chop');

    expect(chop?.detail).toContain('settle-in');
  });

  it('does not block on a prerequisite id that does not exist', () => {
    // A typo in `requires:` is the same failure with a worse cause.
    const typo: Goal = { ...dependent, requires: ['setle-in'] };

    expect(evaluateGoals([prose, typo], snapshot())[1]?.state).toBe('active');
  });

  it('still blocks on a measurable prerequisite that is unmet', () => {
    const measurable: Goal = {
      id: 'auto-eat',
      description: 'Own Auto Eat',
      done: { type: 'currency_at_least', currencyId: 'melvorD:GP', amount: 1_000_000 },
    };

    const statuses = evaluateGoals(
      [measurable, { ...dependent, requires: ['auto-eat'] }],
      snapshot(),
    );

    expect(statuses[1]?.state).toBe('blocked');
  });
});

describe('a goal with no completion condition', () => {
  it('respects its prerequisites', () => {
    // `requires` used to be skipped entirely for these: the no-`done` case
    // returned `active` before anything looked at it, so the goals whose intent
    // is vaguest — the ones most in need of ordering — were the only ones with
    // no ordering at all.
    const blocker: Goal = {
      id: 'auto-eat',
      description: 'Own Auto Eat',
      done: { type: 'currency_at_least', currencyId: 'melvorD:GP', amount: 1_000_000 },
    };
    const prose: Goal = { id: 'fight', description: 'Start fighting', requires: ['auto-eat'] };

    const statuses = evaluateGoals([blocker, prose], snapshot());

    expect(statuses[1]?.state).toBe('blocked');
  });
});

describe('what a candidate advances', () => {
  const active = (goal: Goal) => evaluateGoals([goal], snapshot());

  it('tags an item goal from the candidate that handles the item', () => {
    // An `item_qty_at_least` goal names an item, and matching only looked at
    // `skillId` — so a stock goal tagged nothing whatsoever and read as a goal
    // no action in the game could serve.
    const goal: Goal = {
      id: 'bones',
      description: 'Hold 200 bones',
      done: { type: 'item_qty_at_least', itemId: 'melvorD:Bones', qty: 200 },
    };

    const bury = candidate({
      kind: 'bury_bones',
      params: { kind: 'bury_bones', itemId: 'melvorD:Bones', quantity: 1 },
    });

    expect(goalsAdvancedBy(bury, active(goal))).toEqual(['bones']);
  });

  it('tags a combat goal from a fight that carries no skill id', () => {
    // A fight's params are a monster and an area; which skill it trains is the
    // attack style's business, so a skill-id match could never fire and every
    // combat goal was served by nothing.
    const goal: Goal = {
      id: 'attack-30',
      description: 'Attack 30',
      done: { type: 'skill_level_at_least', skillId: 'melvorD:Attack', level: 30 },
    };

    const fight = candidate({
      kind: 'fight_monster',
      params: { kind: 'fight_monster', monsterId: 'melvorD:Chicken', areaId: 'melvorD:Farmlands' },
    });

    expect(goalsAdvancedBy(fight, active(goal))).toEqual(['attack-30']);
  });

  it('still refuses to call unsold output earned GP', () => {
    // The distinction that made mining a gem stop "advancing" a GP goal. An
    // hour of it moves the balance by exactly zero.
    const goal: Goal = {
      id: 'gp',
      description: 'Save 50,000 GP',
      done: { type: 'currency_at_least', currencyId: 'melvorD:GP', amount: 50_000 },
    };

    const mine = candidate({
      kind: 'gather_resource',
      params: {
        kind: 'gather_resource',
        skillId: 'melvorD:Mining',
        recipeId: 'melvorD:Gold_Ore',
      },
      gpPerHour: 120_000,
      gpIsEarned: false,
    });

    expect(goalsAdvancedBy(mine, active(goal))).toEqual([]);
  });

  it('does not tag a skilling candidate as combat', () => {
    const goal: Goal = {
      id: 'attack-30',
      description: 'Attack 30',
      done: { type: 'skill_level_at_least', skillId: 'melvorD:Attack', level: 30 },
    };

    const chop = candidate({
      kind: 'gather_resource',
      params: {
        kind: 'gather_resource',
        skillId: 'melvorD:Woodcutting',
        recipeId: 'melvorD:Normal_Tree',
      },
    });

    expect(goalsAdvancedBy(chop, active(goal))).toEqual([]);
  });
});

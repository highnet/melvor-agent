import type { Candidate } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { goalsAdvancedBy } from '../src/goals.js';
import type { GoalStatus } from '../src/goals.js';

/**
 * A GP goal is advanced by money received, not by output that would fetch money.
 *
 * Gathering candidates say so in words -- "output worth N GP/h if sold, not GP
 * earned" -- and the data did not, so `gpPerHour > 0` tagged mining a gem as
 * advancing a GP goal. An hour of that moves the balance by exactly zero unless
 * something sells the ore, and nothing does until a stack is large enough to
 * trip the liquidation reflex.
 *
 * The consequence is worse than a mislabel: "advanced by" is what a planner
 * reads to decide it is already working on a goal, so the false tag actively
 * discourages doing the thing that would achieve it.
 */
const goal = (id: string, advancedBy: string[]): GoalStatus =>
  ({
    goal: { id, advancedBy, title: id },
    state: 'active',
  }) as unknown as GoalStatus;

const candidate = (over: Partial<Candidate>): Candidate =>
  ({
    kind: 'gather_resource',
    params: { kind: 'gather_resource', skillId: 'melvorD:Mining', recipeId: 'x' },
    label: 'x',
    available: true,
    ...over,
  }) as Candidate;

describe('GP goals need earned GP', () => {
  const goals = [goal('auto-eat', ['gp'])];

  it('is not advanced by output that would only fetch GP if sold', () => {
    expect(goalsAdvancedBy(candidate({ gpPerHour: 120_000 }), goals)).toEqual([]);
  });

  it('is advanced by an action that pays coins', () => {
    expect(goalsAdvancedBy(candidate({ gpPerHour: 82_950, gpIsEarned: true }), goals)).toEqual([
      'auto-eat',
    ]);
  });

  it('is not advanced by an earning action with no rate', () => {
    expect(goalsAdvancedBy(candidate({ gpPerHour: 0, gpIsEarned: true }), goals)).toEqual([]);
  });

  it('still tags a skill goal regardless of GP', () => {
    // The skill match is independent; this fix must not narrow it.
    expect(
      goalsAdvancedBy(candidate({ gpPerHour: 120_000 }), [goal('mining-60', ['melvorD:Mining'])]),
    ).toEqual(['mining-60']);
  });
});

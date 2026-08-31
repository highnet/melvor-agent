import { stateSnapshotSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { checkAbort, elapsedMinutes, isObjectiveComplete } from '../src/policy/criteria.js';
import { gatherResource } from '../src/policy/gather.js';
import { executorFor, isSupportedKind, supportedKinds } from '../src/policy/index.js';
import type { PolicyContext } from '../src/policy/types.js';
import { GP, NORMAL_LOGS, NORMAL_TREE, WOODCUTTING, objective, snapshot } from './fixtures.js';

const START = 1_700_000_000_000;

function context(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    snapshot: snapshot(),
    objective: objective(),
    now: START,
    objectiveStartedAt: START,
    deathsSinceStart: 0,
    ...overrides,
  };
}

describe('fixtures', () => {
  it('produce snapshots that satisfy the shared schema', () => {
    // If this drifts, every other test here is asserting against a shape the
    // mod would reject at the door.
    expect(stateSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });
});

describe('capability registry', () => {
  it('accepts the kinds it has executors for', () => {
    expect(supportedKinds()).toEqual(['gather_resource']);
    expect(isSupportedKind('gather_resource')).toBe(true);
    expect(executorFor(objective())).toBe(gatherResource);
  });

  it('rejects a kind the policy layer cannot perform', () => {
    // The planner emitting this is a bug, and it must be caught before the
    // params are trusted rather than at the game boundary.
    expect(isSupportedKind('build_township')).toBe(false);
  });
});

describe('success criteria', () => {
  it('is incomplete while the bank is short of the target', () => {
    expect(isObjectiveComplete(snapshot(), objective().successWhen)).toBe(false);
  });

  it('is complete once the criterion holds', () => {
    const stocked = snapshot({
      bank: {
        slotsUsed: 3,
        slotsMax: 20,
        items: [{ id: NORMAL_LOGS, name: 'Normal Logs', qty: 100 }],
      },
    });
    expect(isObjectiveComplete(stocked, objective().successWhen)).toBe(true);
  });

  it('treats an absent item as zero rather than throwing', () => {
    const empty = snapshot({ bank: { slotsUsed: 0, slotsMax: 20, items: [] } });
    expect(isObjectiveComplete(empty, objective().successWhen)).toBe(false);
  });

  it('requires every criterion, not just one', () => {
    const partial = objective({
      successWhen: [
        { type: 'item_qty_at_least', itemId: NORMAL_LOGS, qty: 10 },
        { type: 'currency_at_least', currencyId: GP, amount: 999_999 },
      ],
    });
    expect(isObjectiveComplete(snapshot(), partial.successWhen)).toBe(false);
  });
});

describe('abort conditions', () => {
  it('does not abort inside the budget', () => {
    expect(checkAbort(snapshot(), { minutesExceed: 60 }, 10, 0).abort).toBe(false);
  });

  it('aborts once the time budget is exceeded', () => {
    const verdict = checkAbort(snapshot(), { minutesExceed: 60 }, 61, 0);
    expect(verdict).toMatchObject({ abort: true, outcome: 'aborted_budget' });
  });

  it('aborts below the GP floor', () => {
    const broke = snapshot({ currencies: [{ id: GP, name: 'GP', amount: 5 }] });
    const verdict = checkAbort(broke, { minutesExceed: 60, gpBelow: 100 }, 1, 0);
    expect(verdict).toMatchObject({ abort: true, outcome: 'aborted_gp_floor' });
  });

  it('aborts past the death limit', () => {
    const verdict = checkAbort(snapshot(), { minutesExceed: 60, deathsExceed: 2 }, 1, 3);
    expect(verdict).toMatchObject({ abort: true, outcome: 'aborted_deaths' });
  });

  it('ignores the GP floor when the objective did not set one', () => {
    const broke = snapshot({ currencies: [{ id: GP, name: 'GP', amount: 0 }] });
    expect(checkAbort(broke, { minutesExceed: 60 }, 1, 0).abort).toBe(false);
  });

  it('floors elapsed time at zero for clocks that jump backwards', () => {
    expect(elapsedMinutes(START - 60_000, START)).toBe(0);
  });
});

describe('gatherResource', () => {
  it('selects the tree and starts when the skill is idle', () => {
    const decision = gatherResource(context());
    expect(decision).toEqual({
      kind: 'act',
      actions: [{ type: 'gather', skillId: WOODCUTTING, recipeId: NORMAL_TREE }],
      reason: expect.stringContaining('idle'),
    });
  });

  it('does nothing while the skill is already running', () => {
    const running = snapshot({
      skills: [
        { id: 'melvorD:Woodcutting', name: 'Woodcutting', level: 15, xp: 2200, isActive: true },
      ],
    });
    expect(gatherResource(context({ snapshot: running }))).toMatchObject({
      kind: 'idle',
      reason: 'already_running',
    });
  });

  it('refuses to act while offline progress is resolving', () => {
    // Acting mid catch-up produces nonsense; this is the tier-level guard that
    // backs up the adapter's own suspension check.
    const offline = snapshot({ isOfflineLoop: true });
    expect(gatherResource(context({ snapshot: offline }))).toMatchObject({
      kind: 'idle',
      reason: 'waiting_for_game',
    });
  });

  it('checks the budget before it checks success', () => {
    // An objective that is both complete and over budget must report the abort,
    // otherwise a runaway objective could mask itself by finishing late.
    const done = snapshot({
      bank: {
        slotsUsed: 3,
        slotsMax: 20,
        items: [{ id: NORMAL_LOGS, name: 'Normal Logs', qty: 500 }],
      },
    });
    const decision = gatherResource(
      context({ snapshot: done, now: START + 61 * 60_000, objectiveStartedAt: START }),
    );
    expect(decision).toMatchObject({ kind: 'abort', outcome: 'aborted_budget' });
  });

  it('reports completion once the criteria hold', () => {
    const done = snapshot({
      bank: {
        slotsUsed: 3,
        slotsMax: 20,
        items: [{ id: NORMAL_LOGS, name: 'Normal Logs', qty: 500 }],
      },
    });
    expect(gatherResource(context({ snapshot: done }))).toMatchObject({ kind: 'complete' });
  });

  it('does not preempt another skill holding the action slot', () => {
    const busy = snapshot({
      activeAction: { id: 'melvorD:Fishing', name: 'Fishing', isActive: true },
    });
    expect(gatherResource(context({ snapshot: busy }))).toMatchObject({
      kind: 'idle',
      reason: 'nothing_to_do',
    });
  });

  it('accepts the other gathering skills that have verified executors', () => {
    const mining = objective({
      params: {
        kind: 'gather_resource',
        skillId: 'melvorD:Mining',
        recipeId: 'melvorD:Copper_Ore',
      },
    });
    const withMining = snapshot({
      skills: [{ id: 'melvorD:Mining', name: 'Mining', level: 10, xp: 500, isActive: false }],
    });
    expect(gatherResource(context({ objective: mining, snapshot: withMining }))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'gather', skillId: 'melvorD:Mining', recipeId: 'melvorD:Copper_Ore' }],
    });
  });

  it('aborts on a skill with no verified executor rather than improvising', () => {
    // Township is not a gathering skill and has no adapter routine. Attempting
    // it would mean guessing at an API, which is the thing to never do.
    const township = objective({
      params: {
        kind: 'gather_resource',
        skillId: 'melvorD:Township',
        recipeId: 'melvorD:Whatever',
      },
    });
    expect(gatherResource(context({ objective: township }))).toMatchObject({
      kind: 'abort',
      outcome: 'failed_precondition',
    });
  });

  it('aborts when the skill is missing from this game version', () => {
    const noSkills = snapshot({ skills: [] });
    expect(gatherResource(context({ snapshot: noSkills }))).toMatchObject({
      kind: 'abort',
      outcome: 'failed_precondition',
    });
  });
});

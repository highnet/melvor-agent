import type { FarmPlot } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { tendFarm } from '../src/policy/farm.js';
import type { PolicyContext } from '../src/policy/types.js';
import { objective, snapshot } from './fixtures.js';

const START = 1_700_000_000_000;
const SEED = 'melvorD:Potato';

function plot(
  id: string,
  state: FarmPlot['state'],
  planted: string | null = null,
  canUnlock = false,
): FarmPlot {
  return {
    id,
    state,
    plantedRecipeId: planted,
    plantedName: planted === null ? null : 'Potato',
    categoryId: 'melvorD:Allotment',
    canUnlock,
  };
}

// `null` rather than `undefined` for "no seed": passing `undefined` explicitly
// triggers the JS default-parameter value, which silently kept the seed set.
function context(farm: FarmPlot[], seedRecipeId: string | null = SEED): PolicyContext {
  return {
    snapshot: snapshot({ farm }),
    objective: objective({
      kind: 'tend_farm',
      params: seedRecipeId === null ? { kind: 'tend_farm' } : { kind: 'tend_farm', seedRecipeId },
      successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Farming', level: 99 }],
    }),
    now: START,
    objectiveStartedAt: START,
    deathsSinceStart: 0,
  };
}

describe('tendFarm', () => {
  it('harvests grown plots', () => {
    const decision = tendFarm(context([plot('p1', 'grown', SEED)]));
    expect(decision).toMatchObject({
      kind: 'act',
      actions: [{ type: 'harvest_plot', plotId: 'p1' }],
    });
  });

  it('harvests dead plots too, since that is how a plot is cleared', () => {
    const decision = tendFarm(context([plot('p1', 'dead', SEED)]));
    expect(decision).toMatchObject({
      kind: 'act',
      actions: [{ type: 'harvest_plot', plotId: 'p1' }],
    });
  });

  it('harvests every ready plot in one batch', () => {
    // Batching matters: one plot per tick would take a full minute to clear a
    // farm that could be cleared at once.
    const decision = tendFarm(
      context([plot('p1', 'grown', SEED), plot('p2', 'dead', SEED), plot('p3', 'growing', SEED)]),
    );
    expect(decision).toMatchObject({ kind: 'act' });
    if (decision.kind !== 'act') return;
    expect(decision.actions).toHaveLength(2);
    expect(decision.actions.every((a) => a.type === 'harvest_plot')).toBe(true);
  });

  it('plants empty plots when nothing needs harvesting', () => {
    const decision = tendFarm(context([plot('p1', 'empty')]));
    expect(decision).toMatchObject({
      kind: 'act',
      actions: [{ type: 'plant_plot', plotId: 'p1', recipeId: SEED }],
    });
  });

  it('harvests before planting, never both in one pass', () => {
    // A plot cleared this tick is only plantable next tick. Planning a plant
    // against a state the harvest has not produced yet would be acting on a
    // snapshot that does not exist.
    const decision = tendFarm(context([plot('p1', 'grown', SEED), plot('p2', 'empty')]));
    expect(decision).toMatchObject({ kind: 'act' });
    if (decision.kind !== 'act') return;
    expect(decision.actions).toEqual([{ type: 'harvest_plot', plotId: 'p1' }]);
  });

  it('harvests but does not plant when no seed is configured', () => {
    // Running out of seeds is normal, and must not stop harvesting.
    const harvest = tendFarm(context([plot('p1', 'grown', SEED)], null));
    expect(harvest).toMatchObject({ kind: 'act' });

    const idle = tendFarm(context([plot('p1', 'empty')], null));
    expect(idle).toMatchObject({ kind: 'idle', reason: 'nothing_to_do' });
  });

  it('ignores locked plots entirely', () => {
    const decision = tendFarm(context([plot('p1', 'locked'), plot('p2', 'growing', SEED)]));
    expect(decision).toMatchObject({ kind: 'idle', reason: 'already_running' });
  });

  it('idles while everything is still growing', () => {
    const decision = tendFarm(context([plot('p1', 'growing', SEED)]));
    expect(decision).toMatchObject({ kind: 'idle', reason: 'already_running' });
  });

  it('aborts when the save has no plots at all', () => {
    expect(tendFarm(context([]))).toMatchObject({
      kind: 'abort',
      outcome: 'failed_precondition',
    });
  });

  it('refuses to act while offline progress is resolving', () => {
    const ctx = context([plot('p1', 'grown', SEED)]);
    const decision = tendFarm({
      ...ctx,
      snapshot: { ...ctx.snapshot, isOfflineLoop: true },
    });
    expect(decision).toMatchObject({ kind: 'idle', reason: 'waiting_for_game' });
  });

  it('checks the budget before it harvests', () => {
    const ctx = context([plot('p1', 'grown', SEED)]);
    const decision = tendFarm({ ...ctx, now: START + 999 * 60_000 });
    expect(decision).toMatchObject({ kind: 'abort', outcome: 'aborted_budget' });
  });
});

describe('locked plots', () => {
  it('buys a plot that can be unlocked before anything else', () => {
    // Every plot in a fresh save is locked, including the first. This is the
    // step whose absence made Farming unreachable: sixteen allotment seeds sat
    // in the bank at Farming level 1 while the farm reported nothing to do.
    const decision = tendFarm(context([plot('p1', 'locked', null, true)]));

    expect(decision).toMatchObject({
      kind: 'act',
      actions: [{ type: 'unlock_plot', plotId: 'p1' }],
    });
  });

  it('unlocks before harvesting, since an extra plot is worth more than one cycle', () => {
    const decision = tendFarm(
      context([plot('p1', 'locked', null, true), plot('p2', 'grown', SEED)]),
    );

    expect(decision).toMatchObject({
      kind: 'act',
      actions: [{ type: 'unlock_plot', plotId: 'p1' }],
    });
  });

  it('leaves a plot alone when the game says it cannot be unlocked yet', () => {
    // The level or the cost is not met. Offering it anyway would produce an
    // objective that fails its precondition every tick.
    const decision = tendFarm(context([plot('p1', 'locked', null, false)]));

    expect(decision).not.toMatchObject({ kind: 'act' });
  });
});

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
    expect(supportedKinds().sort()).toEqual([
      'build_obstacle',
      'build_township',
      'bury_bones',
      'buy_shop_upgrade',
      'change_equipment_set',
      'choose_event_passive',
      'claim_casual_task',
      'claim_township_task',
      'compost_plot',
      'convert_to_township',
      'equip_food',
      'equip_item',
      'excavate_dig_site',
      'fight_monster',
      'gather_resource',
      'make_paper',
      'new_slayer_task',
      'open_item',
      'passive_cook',
      'repair_township',
      'restore_town_health',
      'run_dungeon',
      'run_golbin_raid',
      'select_dig_map',
      'select_dig_tool',
      'select_level_cap',
      'select_spell',
      'select_worship',
      'sell_items',
      'set_attack_style',
      'spend_mastery',
      'start_combat_event',
      'survey_hex',
      'tend_farm',
      'toggle_aurora',
      'toggle_bank_lock',
      'toggle_curse',
      'toggle_prayer',
      'unlock_skill_node',
      'upgrade_constellation',
      'upgrade_item',
      'use_potion',
    ]);
    for (const kind of supportedKinds()) {
      expect(isSupportedKind(kind)).toBe(true);
    }
    expect(executorFor(objective())).toBe(gatherResource);
  });

  it('rejects a kind the policy layer cannot perform', () => {
    // The planner emitting this is a bug, and it must be caught before the
    // params are trusted rather than at the game boundary.
    expect(isSupportedKind('mine_cartography')).toBe(false);
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

  it('does nothing while the skill is already running the right recipe', () => {
    const running = snapshot({
      skills: [
        { id: 'melvorD:Woodcutting', name: 'Woodcutting', level: 15, xp: 2200, isActive: true },
      ],
      activeAction: {
        id: WOODCUTTING,
        name: 'Woodcutting',
        isActive: true,
        recipeIds: [NORMAL_TREE],
      },
    });
    expect(gatherResource(context({ snapshot: running }))).toMatchObject({
      kind: 'idle',
      reason: 'already_running',
    });
  });

  it('switches recipes inside the same skill', () => {
    // Observed live: told to cut Willow while cutting Oak, the agent saw
    // "Woodcutting is active" and idled, so it kept cutting Oak for hours. The
    // skill being right is not the objective being satisfied.
    const cuttingOak = snapshot({
      skills: [
        { id: 'melvorD:Woodcutting', name: 'Woodcutting', level: 30, xp: 15_000, isActive: true },
      ],
      activeAction: {
        id: WOODCUTTING,
        name: 'Woodcutting',
        isActive: true,
        recipeIds: ['melvorD:Oak'],
      },
    });

    expect(gatherResource(context({ snapshot: cuttingOak }))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'stop_gathering', skillId: WOODCUTTING }],
    });
  });

  it('restarts when the running selection cannot be read', () => {
    // "Cannot tell" has to count as wrong: one wasted tick beats an hour on the
    // wrong recipe.
    const opaque = snapshot({
      skills: [
        { id: 'melvorD:Woodcutting', name: 'Woodcutting', level: 15, xp: 2200, isActive: true },
      ],
      activeAction: { id: WOODCUTTING, name: 'Woodcutting', isActive: true, recipeIds: [] },
    });

    expect(gatherResource(context({ snapshot: opaque }))).toMatchObject({ kind: 'act' });
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

  it('preempts another skill holding the action slot', () => {
    // Switching skills when the objective changes is the transition the whole
    // agent exists for. Refusing to preempt would pin it to whatever it started
    // first — exactly what the game already does for free.
    const busy = snapshot({
      activeAction: { id: 'melvorD:Fishing', name: 'Fishing', isActive: true },
    });
    expect(gatherResource(context({ snapshot: busy }))).toMatchObject({
      kind: 'act',
      actions: [{ type: 'stop_gathering', skillId: 'melvorD:Fishing' }],
    });
  });

  it('stops and starts on separate ticks, never batched', () => {
    // `stop` must be observed to have freed the slot before `gather` claims it.
    const busy = snapshot({
      activeAction: { id: 'melvorD:Fishing', name: 'Fishing', isActive: true },
    });
    const decision = gatherResource(context({ snapshot: busy }));
    expect(decision.kind).toBe('act');
    if (decision.kind !== 'act') return;
    expect(decision.actions).toHaveLength(1);
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

describe('leaving combat for a skill', () => {
  it('disengages instead of trying to stop combat as a skill', () => {
    // Combat holds the same single action slot but is not a gathering skill.
    // Sending stop_gathering for it refused with "no verified routine for skill
    // melvorD:Combat" and stranded the agent in a fight it had been told to
    // leave — the mirror of a fight objective waiting behind a running skill.
    const fighting = snapshot({
      activeAction: { id: 'melvorD:Combat', name: 'Combat', isActive: true, recipeIds: [] },
    });

    const decision = gatherResource({
      snapshot: fighting,
      objective: objective(),
      now: fighting.capturedAt,
      objectiveStartedAt: fighting.capturedAt,
      deathsSinceStart: 0,
    });

    expect(decision).toMatchObject({ kind: 'act', actions: [{ type: 'disengage' }] });
  });
});

describe('the critical hitpoints floor', () => {
  const noAbort = { minutesExceed: 60 };

  it('stops any activity at low HP with no food', () => {
    // Damage is not exclusive to combat: a failed pickpocket hurts, and with no
    // food there is no way back up. Live, this reached 5 HP out of 110 while
    // Thieving unattended, one failure from death.
    const dying = snapshot({
      combat: { ...snapshot().combat, hitpoints: 5, maxHitpoints: 110, food: [] },
    });

    const verdict = checkAbort(dying, noAbort, 1, 0);

    expect(verdict.abort).toBe(true);
    expect(verdict.detail).toMatch(/no food/);
  });

  it('keeps going at low HP while food remains', () => {
    // Food means the eat reflex can recover, so low HP alone is not a reason to
    // abandon the objective — only low HP with nothing to eat. Below the
    // emergency floor this no longer holds: at 5 hitpoints the reflex is
    // demonstrably losing, which is what the Golbin incident showed.
    const hurt = snapshot({
      combat: {
        ...snapshot().combat,
        hitpoints: 25,
        maxHitpoints: 110,
        food: [{ itemId: 'melvorD:Shrimp', itemName: 'Shrimp', qty: 20, healsFor: 30 }],
      },
    });

    expect(checkAbort(hurt, noAbort, 1, 0).abort).toBe(false);
  });

  it('does not fire at healthy HP', () => {
    expect(checkAbort(snapshot(), noAbort, 1, 0).abort).toBe(false);
  });
});

describe('the emergency hitpoints floor', () => {
  const noAbort = { minutesExceed: 60 };

  it('stops at very low HP even with food equipped', () => {
    // Food that cannot keep up is not safety. Live, Thieving a Golbin reached 6
    // hitpoints of 120 with 33 food equipped and the eat reflex firing
    // sixty-six times: it ate, and the damage outpaced it. The critical floor
    // did not fire precisely because food was available.
    const losing = snapshot({
      combat: {
        ...snapshot().combat,
        hitpoints: 6,
        maxHitpoints: 120,
        food: [{ itemId: 'melvorD:Chicken', itemName: 'Chicken', qty: 33, healsFor: 40 }],
      },
    });

    const verdict = checkAbort(losing, noAbort, 1, 0);

    expect(verdict.abort).toBe(true);
    expect(verdict.detail).toMatch(/not keeping up/);
  });

  it('keeps going at merely low HP while food can still recover it', () => {
    // Between the two floors the reflex is given room to work: 20% with food is
    // a fight worth continuing, 5% is not.
    const hurt = snapshot({
      combat: {
        ...snapshot().combat,
        hitpoints: 24,
        maxHitpoints: 120,
        food: [{ itemId: 'melvorD:Chicken', itemName: 'Chicken', qty: 33, healsFor: 40 }],
      },
    });

    expect(checkAbort(hurt, noAbort, 1, 0).abort).toBe(false);
  });
});

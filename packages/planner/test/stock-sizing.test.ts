import type { StateSnapshot } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * A stock target sized against what the candidate can actually make.
 *
 * `rungFor` has sized *level* targets against the rate and the budget from the
 * start, on the argument that an objective which completes "produces a journal
 * entry, a replan and a measured rate, while one that times out produces an
 * abandonment and teaches nothing". A stock target was sized against nothing:
 * `set_objective` skips `rungFor` outright when one is given, because a stock
 * target has no level to clamp, and nothing took its place.
 *
 * So the one shape being made first-class was the one shape with no guard --
 * which is a fair share of why it stayed unused. Measured live:
 * `untilQuantity: 10000` for Mind Runes against a bank holding 1,347 Rune
 * Essence, a ceiling of about 5,400, and a 90 minute abort the objective would
 * have run in full while completing nothing.
 *
 * The real tool handlers are driven here rather than the sizing function
 * directly, because the defect was never in arithmetic. It was that the branch
 * carrying a stock target went round the sizing, and a test of the sizing alone
 * would have passed against the bug.
 */

/** No goals file, so no funding target is read; these tests are about targets. */
const CTX = { memoryRoot: 'test-fixture-with-no-goals-file' };

/** The live reading the Mind Rune objective was set against. */
const snapshotWith = (mindRunes: number) =>
  ({
    capturedAt: 0,
    gameVersion: 'v1.3.1',
    characterName: 'Agent',
    gamemodeId: 'melvorD:Standard',
    currentRealmId: 'melvorD:Melvor',
    isOfflineLoop: false,
    totalLevel: 596,
    completionPercent: 4.2,
    currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 149_077 }],
    skills: [
      { id: 'melvorD:Runecrafting', name: 'Runecrafting', level: 48, xp: 5_000, isActive: false },
    ],
    bank: {
      slotsUsed: 2,
      slotsMax: 40,
      items: [
        { id: 'melvorD:Mind_Rune', name: 'Mind Rune', qty: mindRunes },
        { id: 'melvorD:Rune_Essence', name: 'Rune Essence', qty: 1_347 },
      ],
    },
    activeAction: null,
    combat: { hitpoints: 150, maxHitpoints: 150, autoEatThreshold: 0 },
  }) as unknown as StateSnapshot;

function storeWith(candidate: Record<string, unknown>, bankQty = 0) {
  const queued: unknown[] = [];
  return {
    queued,
    report: {
      snapshot: snapshotWith(bankQty),
      candidates: [candidate],
      plan: [],
      objective: null,
    },
    rememberShownCandidates() {},
    resolveChoice: (index: number) => ({ index, moved: false }),
    enqueue(command: unknown) {
      queued.push(command);
    },
  };
}

/**
 * Runecrafting Mind Runes, as the live board actually reported it.
 *
 * 7,200 runes an hour -- four per essence at 1,800 actions -- with essence
 * enough for 45 minutes. Both figures are the candidate's own: `perHour` comes
 * from `productYieldFor`, which samples the game's rolling accessor rather than
 * dividing by the cost quantity, and `sustainMinutes` from the banked inputs.
 */
const MIND_RUNES = {
  kind: 'gather_resource',
  params: {
    kind: 'gather_resource',
    skillId: 'melvorD:Runecrafting',
    recipeId: 'melvorD:Mind_Rune',
  },
  label: 'Runecrafting: Mind Rune',
  xpPerHour: 50_400,
  sustainMinutes: 45,
  produces: { itemId: 'melvorD:Mind_Rune', name: 'Mind Rune', perHour: 7_200 },
};

const step = (extra: Record<string, unknown>) => ({
  candidateIndex: 0,
  targetLevel: 49,
  abortMinutes: 90,
  rationale: 'x',
  ...extra,
});

describe('a stock target is checked against what can be produced', () => {
  it('lowers a target beyond the materials ceiling', async () => {
    // 45 minutes of essence at 7,200/h is 5,400 runes. 10,000 is unreachable
    // whatever the budget says, and the objective would have aborted at 90min
    // having completed nothing.
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }),
      { store, ...CTX } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: {
        successWhen: [{ type: 'item_qty_at_least', itemId: 'melvorD:Mind_Rune', qty: 5_400 }],
      },
    });
    expect(reply).toContain('Target lowered from 10,000 to 5,400');
  });

  it('names the ceiling that bound it, so the caller knows what to change', async () => {
    // Materials and budget need different responses -- gather more, or raise
    // abortMinutes -- and a clamp that does not say which is a number with no
    // action attached.
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }),
      { store, ...CTX } as never,
    );

    expect(reply).toContain('banked inputs last about 45min');
  });

  it('clamps to the budget when the inputs outlast it', async () => {
    // No `sustainMinutes` at all: a gathering action consumes nothing and is
    // limited only by time, so absent is "no ceiling" rather than "unknown".
    const store = storeWith({ ...MIND_RUNES, sustainMinutes: undefined });

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 100_000, abortMinutes: 60 }),
      { store, ...CTX } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: { successWhen: [{ qty: 7_200 }] },
    });
    expect(reply).toContain('the 60min budget');
  });

  it('counts what is already banked toward the target', async () => {
    // `item_qty_at_least` asks whether the bank *holds* the count, so a ceiling
    // that ignored the 1,000 already there would be wrong by exactly those
    // 1,000, in the direction that produces too little.
    const store = storeWith(MIND_RUNES, 1_000);

    await TOOLS.set_objective?.(step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }), {
      store,
      ...CTX,
    } as never);

    expect(store.queued[0]).toMatchObject({
      objective: { successWhen: [{ qty: 6_400 }] },
    });
  });

  it('leaves a reachable target exactly as asked', async () => {
    // Clamped down, never up. Raising a target inside the ceiling would mean
    // grinding further than the caller chose, which is the correction `rungFor`
    // argues at length against making on someone's behalf.
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 2_000 }),
      { store, ...CTX } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: { successWhen: [{ qty: 2_000 }] },
    });
    expect(reply).not.toContain('Target lowered');
  });

  it('says nothing about a target it cannot judge', async () => {
    // No `produces` means the candidate banks nothing identifiable, and a clamp
    // derived from no rate would be a guess wearing a measurement's clothes.
    const store = storeWith({ ...MIND_RUNES, produces: undefined });

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }),
      { store, ...CTX } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: { successWhen: [{ qty: 10_000 }] },
    });
    expect(reply).not.toContain('Target lowered');
  });

  it('says nothing when the production rate itself reads as zero', async () => {
    // A rate of zero is a rate that could not be read, not a producer that
    // makes nothing -- the same distinction the adapter draws between a
    // guarded read that fell back and a genuine absence. Clamping on it would
    // turn a broken accessor into a confident refusal, and the two are exactly
    // what the adapter-failure counter exists to keep apart.
    const store = storeWith({
      ...MIND_RUNES,
      produces: { itemId: 'melvorD:Mind_Rune', name: 'Mind Rune', perHour: 0 },
    });

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }),
      { store, ...CTX } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: { successWhen: [{ qty: 10_000 }] },
    });
    expect(reply).not.toContain('cannot reach');
    expect(reply).not.toContain('Target lowered');
  });

  it('says nothing when the target names an item this candidate does not make', async () => {
    // Perfectly legitimate: "mine ore until you hold 200 Coal" is a candidate
    // whose product is not the item asked for, and the rate on it says nothing
    // about how fast the *target* accrues. Sizing against it anyway would clamp
    // a correct target using the wrong number, which is worse than not sizing.
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Rune_Essence', untilQuantity: 10_000 }),
      { store, ...CTX } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: {
        successWhen: [{ type: 'item_qty_at_least', itemId: 'melvorD:Rune_Essence', qty: 10_000 }],
      },
    });
    expect(reply).not.toContain('Target lowered');
  });

  it('warns rather than clamping when not one unit is reachable', async () => {
    // There is no target that both fits and asks for work, so a clamp would
    // land on what is already banked and be refused a line later by the no-op
    // guard, for a reason that would read as unrelated.
    const store = storeWith({ ...MIND_RUNES, sustainMinutes: 0 });

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }),
      { store, ...CTX } as never,
    );

    expect(reply).toContain('cannot reach 10,000x Mind Rune');
  });
});

describe('the confirmation names the target it actually queued', () => {
  it('names the stock target rather than a level', async () => {
    // This line read `Target: level NaN` for every stock objective ever set --
    // live, an hour before this was written. `targetLevel` is never consulted
    // on the stock branch, so the confirmation was reporting a number nothing
    // had computed at the one moment a caller can still say they meant
    // something else.
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_objective?.(
      step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 2_000 }),
      { store, ...CTX } as never,
    );

    expect(reply).toContain('Target: until the bank holds 2,000x melvorD:Mind_Rune');
    expect(reply).not.toContain('NaN');
  });

  it('still names the level for a level target', async () => {
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_objective?.(step({ targetLevel: 55 }), {
      store,
      ...CTX,
    } as never);

    // Not pinned to 55: `rungFor` may lower a level target against the budget,
    // which is its job. The claim here is only that the line names a level.
    expect(reply).toMatch(/Target: to level \d+/);
  });
});

describe('the plan tool shows both shapes at the point of use', () => {
  it('names untilItemId in its usage string', async () => {
    // The usage string listed only `targetLevel`, so at the single moment a
    // caller looks for the parameter list, half the tool was invisible.
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_plan?.({ steps: [] }, { store, ...CTX } as never);

    expect(reply).toContain('untilItemId');
    expect(reply).toContain('untilQuantity');
    expect(reply).toContain('targetLevel');
  });

  it('sizes the first step stock target the same way', async () => {
    const store = storeWith(MIND_RUNES);

    const reply = await TOOLS.set_plan?.(
      {
        steps: [
          step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }),
          step({ targetLevel: 55 }),
        ],
      },
      { store, ...CTX } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objectives: [{ successWhen: [{ qty: 5_400 }] }, { successWhen: [{ level: 55 }] }],
    });
    expect(reply).toContain('step 1: Target lowered from 10,000 to 5,400');
  });

  it('leaves a later step unsized, because its inputs are not yet real', async () => {
    // The materials ceiling is read off the character as it stands now, and by
    // the time step two runs its inputs are whatever step one produced or
    // consumed. Projecting that far is arithmetic dressed up as foresight --
    // and worse for a stock than for a level, because a level cannot go down.
    const store = storeWith(MIND_RUNES);

    await TOOLS.set_plan?.(
      {
        steps: [
          step({ targetLevel: 55 }),
          step({ untilItemId: 'melvorD:Mind_Rune', untilQuantity: 10_000 }),
        ],
      },
      { store, ...CTX } as never,
    );

    const queued = store.queued[0] as { objectives: { successWhen: unknown[] }[] };
    expect(queued.objectives[1]?.successWhen).toEqual([
      { type: 'item_qty_at_least', itemId: 'melvorD:Mind_Rune', qty: 10_000 },
    ]);
  });
});

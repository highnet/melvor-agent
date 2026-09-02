import { describe, expect, it } from 'vitest';
import {
  NO_MOVEMENT_MS,
  NO_MOVEMENT_SUCCESSES,
  NoMovementWatch,
  readObjectiveCounter,
} from '../src/runtime/no-movement.js';
import { GP, NORMAL_LOGS, WOODCUTTING, snapshot } from './fixtures.js';

const START = 1_700_000_000_000;

/** One round per policy tick, which is every three seconds. */
const TICK_MS = 3000;

describe('readObjectiveCounter', () => {
  it('watches skill XP, not level, for a level criterion', () => {
    // Level is what the criterion states and the wrong thing to watch: a level
    // near the top of the curve takes hours, so "level has not moved" is the
    // normal condition of an objective that is working perfectly.
    const counter = readObjectiveCounter(snapshot(), [
      { type: 'skill_level_at_least', skillId: WOODCUTTING, level: 40 },
    ]);
    expect(counter).toEqual({ label: 'Woodcutting xp', value: 2200 });
  });

  it('watches the banked quantity for an item criterion', () => {
    const counter = readObjectiveCounter(snapshot(), [
      { type: 'item_qty_at_least', itemId: NORMAL_LOGS, qty: 100 },
    ]);
    expect(counter).toEqual({ label: `${NORMAL_LOGS} in the bank`, value: 40 });
  });

  it('watches the balance for a currency criterion', () => {
    const counter = readObjectiveCounter(snapshot(), [
      { type: 'currency_at_least', currencyId: GP, amount: 50_000 },
    ]);
    expect(counter).toEqual({ label: GP, value: 10_000 });
  });

  it('has nothing to watch for a one-shot objective', () => {
    // An empty criteria list is an objective whose executor decides completion
    // after a single verified action. Inventing a counter would replan exactly
    // the objectives that are meant to finish that way.
    expect(readObjectiveCounter(snapshot(), [])).toBeNull();
  });

  it('has nothing to watch for a skill the game does not register', () => {
    expect(
      readObjectiveCounter(snapshot(), [
        { type: 'skill_level_at_least', skillId: 'melvorD:Nonexistent', level: 5 },
      ]),
    ).toBeNull();
  });
});

describe('NoMovementWatch', () => {
  /** Feeds rounds at three-second intervals with a fixed counter value. */
  const run = (
    watch: NoMovementWatch,
    rounds: number,
    value: number,
    from: number,
    objectiveId = 'obj-1',
  ) => {
    let verdict = watch.recordSuccess(objectiveId, { label: 'Agility xp', value }, from);
    for (let index = 1; index < rounds; index += 1) {
      verdict = watch.recordSuccess(
        objectiveId,
        { label: 'Agility xp', value },
        from + index * TICK_MS,
      );
    }
    return verdict;
  };

  it('does not alarm on rounds alone, however many', () => {
    // The Agility thrash produced a verified action every three seconds. At
    // that rate the round threshold is crossed in under half a minute, and
    // there are healthy objectives -- a dungeon floor, a long craft -- that
    // move nothing measurable in that window.
    const watch = new NoMovementWatch();
    const verdict = run(watch, NO_MOVEMENT_SUCCESSES * 4, 0, START);
    expect(verdict.kind).toBe('watching');
  });

  it('does not alarm on elapsed time alone', () => {
    const watch = new NoMovementWatch();
    watch.recordSuccess('obj-1', { label: 'Agility xp', value: 0 }, START);
    const verdict = watch.recordSuccess(
      'obj-1',
      { label: 'Agility xp', value: 0 },
      START + NO_MOVEMENT_MS * 2,
    );
    expect(verdict.kind).toBe('watching');
  });

  it('alarms once both thresholds are crossed, naming the counter', () => {
    const watch = new NoMovementWatch();
    run(watch, NO_MOVEMENT_SUCCESSES, 0, START);
    const verdict = watch.recordSuccess(
      'obj-1',
      { label: 'Agility xp', value: 0 },
      START + NO_MOVEMENT_MS + 1,
    );

    expect(verdict).toMatchObject({
      kind: 'stalled',
      label: 'Agility xp',
      value: 0,
      successes: NO_MOVEMENT_SUCCESSES + 1,
    });
  });

  it('re-arms after alarming rather than repeating every tick', () => {
    const watch = new NoMovementWatch();
    run(watch, NO_MOVEMENT_SUCCESSES, 0, START);
    const first = watch.recordSuccess(
      'obj-1',
      { label: 'Agility xp', value: 0 },
      START + NO_MOVEMENT_MS + 1,
    );
    expect(first.kind).toBe('stalled');

    const next = watch.recordSuccess(
      'obj-1',
      { label: 'Agility xp', value: 0 },
      START + NO_MOVEMENT_MS + 1 + TICK_MS,
    );
    expect(next.kind).toBe('watching');
  });

  it('clears the episode as soon as the counter moves', () => {
    const watch = new NoMovementWatch();
    run(watch, NO_MOVEMENT_SUCCESSES, 0, START);

    const moved = watch.recordSuccess(
      'obj-1',
      { label: 'Agility xp', value: 12 },
      START + NO_MOVEMENT_MS + 1,
    );
    expect(moved.kind).toBe('moved');

    // And the clock starts again from the move, so an objective that produces
    // something every few minutes is never escalated.
    const after = watch.recordSuccess(
      'obj-1',
      { label: 'Agility xp', value: 12 },
      START + NO_MOVEMENT_MS + 1 + TICK_MS,
    );
    expect(after.kind).toBe('watching');
  });

  it('starts a fresh episode for a new objective', () => {
    const watch = new NoMovementWatch();
    run(watch, NO_MOVEMENT_SUCCESSES, 0, START);
    const verdict = watch.recordSuccess(
      'obj-2',
      { label: 'Agility xp', value: 0 },
      START + NO_MOVEMENT_MS + 1,
    );
    expect(verdict.kind).toBe('restarted');
  });

  it('starts a fresh episode when the counter itself changes', () => {
    const watch = new NoMovementWatch();
    run(watch, NO_MOVEMENT_SUCCESSES, 0, START);
    const verdict = watch.recordSuccess(
      'obj-1',
      { label: 'melvorD:GP', value: 0 },
      START + NO_MOVEMENT_MS + 1,
    );
    expect(verdict.kind).toBe('restarted');
  });

  it('forgets the episode on reset, so failures cannot count towards it', () => {
    const watch = new NoMovementWatch();
    run(watch, NO_MOVEMENT_SUCCESSES, 0, START);
    watch.reset();

    const verdict = watch.recordSuccess(
      'obj-1',
      { label: 'Agility xp', value: 0 },
      START + NO_MOVEMENT_MS + 1,
    );
    expect(verdict.kind).toBe('restarted');
  });
});

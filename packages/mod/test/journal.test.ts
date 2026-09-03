import type { JournalEntry, Objective, StateSnapshot } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { JournalBuffer } from '../src/runtime/journal.js';
import { objectiveDeltas, objectiveMetrics, snapshotGp } from '../src/runtime/metrics.js';

/**
 * The journal, and the arithmetic that gives it its content.
 *
 * The digest a planning session reads exists to provide one property: do not
 * re-propose what was already abandoned. That property is only as good as the
 * entries behind it, and both halves of producing one were unreachable from a
 * test until now -- the buffer needed a live transport, the deltas a live
 * `game`.
 */

const objective: Objective = {
  id: 'obj-1',
  kind: 'gather_resource',
  params: { kind: 'gather_resource', skillId: 'melvorD:Woodcutting', recipeId: 'melvorD:Oak' },
  rationale: 'cut oak',
  expectedDurationMin: 30,
  successWhen: [],
  abortWhen: { minutesExceed: 60 },
};

const entry = (note: string): JournalEntry => ({
  objective,
  startedAt: 0,
  endedAt: 1,
  outcome: 'completed',
  deltas: { totalLevel: 0, gp: 0, deaths: 0 },
  note,
});

describe('JournalBuffer', () => {
  it('ships what it holds and empties itself', () => {
    const journal = new JournalBuffer();
    journal.record(entry('first'));
    journal.record(entry('second'));

    expect(journal.drain().map((item) => item.note)).toEqual(['first', 'second']);
    expect(journal.size).toBe(0);
    expect(journal.drain()).toEqual([]);
  });

  it('keeps a failed send rather than losing it', () => {
    // An outcome that is never recorded is one the planner will propose again.
    const journal = new JournalBuffer();
    journal.record(entry('first'));

    const shipped = journal.drain();
    journal.requeue(shipped);

    expect(journal.drain().map((item) => item.note)).toEqual(['first']);
  });

  it('puts a failed send back in front of anything recorded since', () => {
    // The journal is read as a sequence of outcomes, and an objective that
    // ended first did not end second.
    const journal = new JournalBuffer();
    journal.record(entry('first'));
    const shipped = journal.drain();

    journal.record(entry('second'));
    journal.requeue(shipped);

    expect(journal.drain().map((item) => item.note)).toEqual(['first', 'second']);
  });
});

const snapshot = (totalLevel: number, gp: number): StateSnapshot =>
  ({
    totalLevel,
    currencies: [
      { id: 'melvorD:AbyssalPieces', name: 'Abyssal Pieces', amount: 7 },
      { id: 'melvorD:GP', name: 'GP', amount: gp },
    ],
  }) as unknown as StateSnapshot;

describe('objective metrics', () => {
  it('reads GP out of the currency list', () => {
    expect(snapshotGp(snapshot(100, 30_816))).toBe(30_816);
  });

  it('reads a bank with no GP entry as zero', () => {
    // Every caller does arithmetic with the result; undefined would poison a
    // delta rather than report one.
    expect(snapshotGp({ totalLevel: 1, currencies: [] } as unknown as StateSnapshot)).toBe(0);
  });

  it('measures what an objective moved', () => {
    const started = objectiveMetrics(snapshot(391, 30_816), 0);
    const ended = objectiveMetrics(snapshot(395, 41_000), 0);

    expect(objectiveDeltas(started, ended)).toEqual({
      totalLevel: 4,
      gp: 10_184,
      deaths: 0,
    });
  });

  it('records an objective that ran and moved nothing', () => {
    // The single most useful thing a planner can be told, and invisible from
    // the outcome alone: "aborted on time budget" reads the same whether it
    // earned 200,000 GP or nothing at all.
    const flat = objectiveMetrics(snapshot(391, 30_816), 0);
    expect(objectiveDeltas(flat, flat)).toEqual({ totalLevel: 0, gp: 0, deaths: 0 });
  });

  it('counts a death that happened during the objective', () => {
    const started = objectiveMetrics(snapshot(391, 30_816), 0);
    const ended = objectiveMetrics(snapshot(391, 12), 1);
    expect(objectiveDeltas(started, ended).deaths).toBe(1);
  });

  it('never journals a negative death count', () => {
    // The count deltas are taken from is reset when a new objective is
    // adopted, so an objective that started after a death and ended before
    // another would otherwise read as having resurrected the character.
    const started = objectiveMetrics(snapshot(391, 30_816), 2);
    const ended = objectiveMetrics(snapshot(392, 31_000), 0);
    expect(objectiveDeltas(started, ended).deaths).toBe(0);
  });
});

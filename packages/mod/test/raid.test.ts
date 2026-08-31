import { describe, expect, it } from 'vitest';
import { runGolbinRaid } from '../src/policy/raid.js';
import { objective, snapshot } from './fixtures.js';

function context(overrides: { minutes?: number } = {}) {
  const snap = snapshot();
  const started = snap.capturedAt - (overrides.minutes ?? 0) * 60_000;
  return {
    snapshot: snap,
    objective: objective({
      kind: 'run_golbin_raid',
      params: { kind: 'run_golbin_raid', difficulty: 'easy' },
      successWhen: [],
      abortWhen: { minutesExceed: 30 },
    }),
    now: snap.capturedAt,
    objectiveStartedAt: started,
    deathsSinceStart: 0,
  };
}

describe('golbin raid', () => {
  it('keeps answering the raid rather than starting it once', () => {
    // A raid makes no progress on its own: it stops at a modal and waits. An
    // objective that started it and then idled would sit at wave one forever.
    expect(runGolbinRaid(context())).toMatchObject({
      kind: 'act',
      actions: [{ type: 'advance_raid', difficulty: 'easy' }],
    });
  });

  it('flees on budget instead of aborting outright', () => {
    // Aborting would leave the raid running, and a running raid pauses the
    // ordinary game loop — the character would earn nothing indefinitely.
    // Fleeing keeps the coins earned so far.
    const decision = runGolbinRaid(context({ minutes: 45 }));

    expect(decision).toMatchObject({ kind: 'act', actions: [{ type: 'stop_raid' }] });
  });

  it('does not act while offline progress is resolving', () => {
    const offline = context();
    offline.snapshot = { ...offline.snapshot, isOfflineLoop: true };
    expect(runGolbinRaid(offline)).toMatchObject({ kind: 'idle' });
  });
});

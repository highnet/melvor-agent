import { describe, expect, it } from 'vitest';

/**
 * Death detection and game-loop liveness.
 *
 * Both are pure state machines over a counter, mirrored here because the real
 * ones live on `Agent` (which needs a live `game`). Both exist because the
 * agent could not previously tell a working character from a dead one, or a
 * ticking loop from a stopped one.
 */

/** Rising-counter death detection; null baseline means "not read yet". */
const detectDeaths = (last: number | null, current: number): { deaths: number; next: number } => {
  if (last === null || current <= last) return { deaths: 0, next: current };
  return { deaths: current - last, next: current };
};

describe('death detection', () => {
  it('reports nothing on the first reading', () => {
    // A character with a long history has not just died forty times.
    expect(detectDeaths(null, 40)).toEqual({ deaths: 0, next: 40 });
  });

  it('reports a death when the counter rises', () => {
    expect(detectDeaths(40, 41)).toEqual({ deaths: 1, next: 41 });
  });

  it('reports several deaths at once', () => {
    // Offline progression can kill a character more than once while the mod is
    // not loaded at all -- the case an event subscription would have missed
    // entirely, and the one that actually happened.
    expect(detectDeaths(40, 43)).toEqual({ deaths: 3, next: 43 });
  });

  it('reports nothing while the counter is unchanged', () => {
    expect(detectDeaths(41, 41)).toEqual({ deaths: 0, next: 41 });
  });

  it('does not report a death if the counter goes backwards', () => {
    // A different save, or a reset. Negative deaths are not a thing.
    expect(detectDeaths(41, 2)).toEqual({ deaths: 0, next: 2 });
  });
});

/** Stall detection over an independent clock. */
const stalled = (ticked: boolean, since: number | null, now: number, limitMs: number) => {
  if (ticked) return { stalled: false, since: null as number | null };
  if (since === null) return { stalled: false, since: now };
  return { stalled: now - since >= limitMs, since };
};

describe('game-loop liveness', () => {
  it('is healthy while ticks keep arriving', () => {
    expect(stalled(true, 1_000, 9_999, 15_000)).toEqual({ stalled: false, since: null });
  });

  it('starts the clock on the first missed tick rather than alarming', () => {
    // One quiet interval is not a stall; the throttle alone can produce it.
    expect(stalled(false, null, 1_000, 15_000)).toEqual({ stalled: false, since: 1_000 });
  });

  it('alarms once the stall outlasts the limit', () => {
    expect(stalled(false, 1_000, 17_000, 15_000).stalled).toBe(true);
  });

  it('stays quiet just under the limit', () => {
    expect(stalled(false, 1_000, 15_999, 15_000).stalled).toBe(false);
  });

  it('clears the stall when ticks resume', () => {
    expect(stalled(true, 1_000, 30_000)).toEqual({ stalled: false, since: null });
  });
});

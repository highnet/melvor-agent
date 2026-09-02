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
    expect(stalled(true, 1_000, 30_000, 15_000)).toEqual({ stalled: false, since: null });
  });
});

/**
 * Blocking must survive a stall, and must not outlive its cause.
 *
 * Two opposite failures in the same latch. `blocked` was set on the first
 * unreadable snapshot and nothing but an operator could clear it, so one
 * malformed read at two in the morning ended the night -- even though a
 * snapshot can be malformed for reasons that pass on their own, a value caught
 * mid-transition being the obvious one.
 *
 * And in the other direction, an offline-loop cycle resumed to `running` on
 * `settings.enabled` alone. That flag stays true when arming fails, so an agent
 * blocked on the wrong character or a stale dump needed only a sixty-second
 * stall to be promoted back to running with none of the checks re-run: a guard
 * that failed open on a timer.
 */
const blockAfter = (failures: number, limit: number): boolean => failures >= limit;

describe('snapshot failures block only when persistent', () => {
  it('tolerates a single bad snapshot', () => {
    expect(blockAfter(1, 5)).toBe(false);
  });

  it('blocks once the failures persist', () => {
    // Acting on a snapshot that does not parse is acting blind.
    expect(blockAfter(5, 5)).toBe(true);
  });

  it('recovers as soon as one parses', () => {
    // The condition that justified blocking has demonstrably passed.
    const failures = 0;
    expect(blockAfter(failures, 5)).toBe(false);
  });
});

const resumeState = (before: 'running' | 'blocked' | 'idle', enabled: boolean): string =>
  before === 'blocked' ? 'blocked' : enabled ? 'running' : 'idle';

describe('resuming from suspension restores rather than promotes', () => {
  it('returns a blocked agent to blocked', () => {
    // The allowlist exists to stop days of unattended play on the wrong save.
    expect(resumeState('blocked', true)).toBe('blocked');
  });

  it('returns a running agent to running', () => {
    expect(resumeState('running', true)).toBe('running');
  });

  it('returns a disarmed agent to idle', () => {
    expect(resumeState('running', false)).toBe('idle');
  });
});

/**
 * An abort on the health floor must stop the thing doing the damage.
 *
 * The criteria say "stopping rather than continuing to take damage with no way
 * to heal", and the handler emitted no action at all -- it cleared the
 * objective and asked for a replan while the character went on fighting or
 * pickpocketing. At 14% health with no food that is not a safety floor, it is a
 * note in a log.
 */
const stopFor = (
  outcome: 'aborted_stuck' | 'aborted_budget' | 'aborted_gp_floor',
  inCombat: boolean,
  activeSkill: string | null,
): 'combat' | 'skill' | 'none' => {
  if (outcome !== 'aborted_stuck') return 'none';
  if (inCombat) return 'combat';
  return activeSkill === null ? 'none' : 'skill';
};

describe('health aborts stop the damage', () => {
  it('disengages when the damage is a fight', () => {
    expect(stopFor('aborted_stuck', true, null)).toBe('combat');
  });

  it('stops the skill when the damage is Thieving', () => {
    expect(stopFor('aborted_stuck', false, 'melvorD:Thieving')).toBe('skill');
  });

  it('leaves a budget abort alone', () => {
    // A time budget is a scheduling decision; stopping the activity there would
    // throw away work for no reason.
    expect(stopFor('aborted_budget', false, 'melvorD:Mining')).toBe('none');
  });

  it('leaves a GP-floor abort alone', () => {
    expect(stopFor('aborted_gp_floor', false, 'melvorD:Mining')).toBe('none');
  });
});

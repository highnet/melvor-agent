import { describe, expect, it } from 'vitest';
import {
  STUCK_ESCALATIONS_BEFORE_ATTENTION,
  STUCK_REPLAN_BASE_MS,
  STUCK_REPLAN_MAX_MS,
  describeStuckAttention,
  stuckReplanDelayMs,
} from '../src/runtime/stuck.js';

/**
 * The stuck detector asked a planner that answers nothing, on every tick.
 *
 * `plan()` returns `{ objectives: [] }` unconditionally — planning happens in
 * an attached Claude Code session or it does not happen — and `detectStuck`
 * called `requestReplan('stuck_detected')` every three seconds once the flat-
 * progress window elapsed. That is roughly 1,200 HTTP round trips an hour, all
 * night, for an answer that was empty before it was sent.
 */
describe('stuck replan backoff', () => {
  it('asks promptly the first time', () => {
    expect(stuckReplanDelayMs(0)).toBe(STUCK_REPLAN_BASE_MS);
  });

  it('doubles with each unanswered escalation', () => {
    expect(stuckReplanDelayMs(1)).toBe(STUCK_REPLAN_BASE_MS * 2);
    expect(stuckReplanDelayMs(2)).toBe(STUCK_REPLAN_BASE_MS * 4);
    expect(stuckReplanDelayMs(3)).toBe(STUCK_REPLAN_BASE_MS * 8);
  });

  it('caps, so a session attaching overnight is still asked', () => {
    // Retrying is right — the first request after a session attaches is the one
    // that ends the stall. Unbounded doubling would mean a stall that began at
    // 22:00 not being retried again until the afternoon.
    expect(stuckReplanDelayMs(20)).toBe(STUCK_REPLAN_MAX_MS);
    expect(stuckReplanDelayMs(200)).toBe(STUCK_REPLAN_MAX_MS);
  });

  it('never returns a delay that would restore per-tick hammering', () => {
    for (let escalations = 0; escalations < 50; escalations += 1) {
      expect(stuckReplanDelayMs(escalations)).toBeGreaterThanOrEqual(STUCK_REPLAN_BASE_MS);
    }
  });
});

describe('stuck escalation', () => {
  it('stays quiet while retrying is still reasonable', () => {
    expect(describeStuckAttention(0, 16 * 60_000, 'mine gold')).toBeNull();
    expect(
      describeStuckAttention(STUCK_ESCALATIONS_BEFORE_ATTENTION - 1, 25 * 60_000, 'mine gold'),
    ).toBeNull();
  });

  it('names the objective and the count once asking has stopped helping', () => {
    const escalation = describeStuckAttention(
      STUCK_ESCALATIONS_BEFORE_ATTENTION,
      45 * 60_000,
      'mine gold until Mining 50',
    );

    expect(escalation).not.toBeNull();
    expect(escalation).toContain('45min');
    expect(escalation).toContain(String(STUCK_ESCALATIONS_BEFORE_ATTENTION));
    expect(escalation).toContain('mine gold until Mining 50');
  });

  it('says so plainly when there is no objective at all', () => {
    // The worst version of this failure: running, reporting healthily, with
    // nothing to do and nobody attached to say what.
    expect(describeStuckAttention(STUCK_ESCALATIONS_BEFORE_ATTENTION, 60 * 60_000, null)).toContain(
      'no objective',
    );
  });
});

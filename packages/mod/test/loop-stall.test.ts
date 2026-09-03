import { describe, expect, it } from 'vitest';
import { LOOP_STALL_MS, LoopStallWatch } from '../src/runtime/loop-stall.js';

/**
 * Game-loop liveness, driven through the code the agent actually runs.
 *
 * `liveness.test.ts` covers the threshold against a local restatement, because
 * until now the real detector was a private method on `Agent`. The two
 * properties a restatement could not reach are here: that a stall is announced
 * exactly once per episode, and that the counter keeps being tracked while the
 * agent is disarmed so arming does not inherit a stall from before it.
 */
describe('LoopStallWatch', () => {
  it('is quiet while ticks keep arriving', () => {
    const watch = new LoopStallWatch();
    expect(watch.observe(1, true, 1_000)).toBeNull();
    expect(watch.observe(2, true, 4_000)).toBeNull();
  });

  it('starts the clock on the first missed tick rather than alarming', () => {
    // One quiet interval is not a stall; the throttle alone can produce it.
    const watch = new LoopStallWatch();
    watch.observe(1, true, 1_000);
    expect(watch.observe(1, true, 4_000)).toBeNull();
  });

  it('alarms once the loop has been silent for the whole window', () => {
    const watch = new LoopStallWatch();
    watch.observe(1, true, 0);
    watch.observe(1, true, 1_000);
    expect(watch.observe(1, true, 1_000 + LOOP_STALL_MS)).toEqual({
      kind: 'stalled',
      stalledMs: LOOP_STALL_MS,
    });
  });

  it('alarms once per episode, not once per observation', () => {
    // This is the property the mirror could not test at all. An alarm repeating
    // every three seconds fills the log queue and evicts the diagnostics that
    // would explain it -- the same drown-the-signal failure the reflex backoff
    // and the stuck detector were both written for.
    const watch = new LoopStallWatch();
    watch.observe(1, true, 0);
    watch.observe(1, true, 0);
    expect(watch.observe(1, true, LOOP_STALL_MS)).not.toBeNull();
    expect(watch.observe(1, true, LOOP_STALL_MS + 3_000)).toBeNull();
    expect(watch.observe(1, true, LOOP_STALL_MS + 6_000)).toBeNull();
  });

  it('reports the loop coming back, and can alarm again afterwards', () => {
    const watch = new LoopStallWatch();
    watch.observe(1, true, 0);
    watch.observe(1, true, 0);
    watch.observe(1, true, LOOP_STALL_MS);

    expect(watch.observe(2, true, LOOP_STALL_MS + 1_000)).toEqual({ kind: 'resumed' });

    watch.observe(2, true, LOOP_STALL_MS + 2_000);
    expect(watch.observe(2, true, 2 * LOOP_STALL_MS + 2_000)).toEqual({
      kind: 'stalled',
      stalledMs: LOOP_STALL_MS,
    });
  });

  it('says nothing about a loop nothing is asking to tick', () => {
    // A stall matters only while something is supposed to be happening.
    const watch = new LoopStallWatch();
    watch.observe(1, false, 0);
    expect(watch.observe(1, false, 10 * LOOP_STALL_MS)).toBeNull();
  });

  it('does not inherit a stall from the time before it was armed', () => {
    // The tick count is tracked while disarmed, but the stall clock is not
    // started -- so arming after a long idle period does not alarm on the very
    // next observation.
    const watch = new LoopStallWatch();
    watch.observe(1, false, 0);
    watch.observe(1, false, 10 * LOOP_STALL_MS);
    expect(watch.observe(1, true, 10 * LOOP_STALL_MS)).toBeNull();
  });
});

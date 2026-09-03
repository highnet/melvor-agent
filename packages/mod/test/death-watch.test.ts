import { describe, expect, it } from 'vitest';
import { DeathWatch } from '../src/runtime/death-watch.js';

/**
 * Death detection, driven through the code the agent actually runs.
 *
 * `liveness.test.ts` covers the same state machine against a local restatement
 * of it, because until now the real one was a private method on `Agent` and
 * reaching it needed a live `game`. A restatement cannot fail when the code
 * changes, which makes it a test of the test; this file exercises the class the
 * runtime calls.
 */
describe('DeathWatch', () => {
  it('reports nothing on the first reading', () => {
    // A character with a long history has not just died forty times.
    const watch = new DeathWatch();
    expect(watch.observe(40)).toBe(0);
    expect(watch.deathsSinceStart).toBe(0);
  });

  it('reports a death when the counter rises', () => {
    const watch = new DeathWatch();
    watch.observe(40);
    expect(watch.observe(41)).toBe(1);
    expect(watch.deathsSinceStart).toBe(1);
  });

  it('reports several deaths at once', () => {
    // Offline progression can kill a character more than once while the mod is
    // not loaded at all -- the case an event subscription would have missed
    // entirely, and the one that actually happened.
    const watch = new DeathWatch();
    watch.observe(40);
    expect(watch.observe(43)).toBe(3);
    expect(watch.deathsSinceStart).toBe(3);
  });

  it('reports nothing while the counter is unchanged', () => {
    const watch = new DeathWatch();
    watch.observe(41);
    expect(watch.observe(41)).toBe(0);
  });

  it('does not report a death if the counter goes backwards', () => {
    // A different save, or a reset. Negative deaths are not a thing.
    const watch = new DeathWatch();
    watch.observe(41);
    expect(watch.observe(2)).toBe(0);
    expect(watch.deathsSinceStart).toBe(0);
  });

  it('accumulates across several observations', () => {
    // `abortWhen.deathsExceed` is measured against this total, so it has to
    // survive more than one check.
    const watch = new DeathWatch();
    watch.observe(0);
    watch.observe(1);
    watch.observe(3);
    expect(watch.deathsSinceStart).toBe(3);
  });

  it('keeps the baseline when the per-objective count is reset', () => {
    // Arming, reviving and adopting a stopgap all restart the count. Moving the
    // baseline as well would make the very next reading report the character's
    // whole history as deaths that just happened -- which is the failure the
    // null baseline exists to prevent, reintroduced one layer down.
    const watch = new DeathWatch();
    watch.observe(40);
    watch.observe(42);
    expect(watch.deathsSinceStart).toBe(2);

    watch.resetRun();
    expect(watch.deathsSinceStart).toBe(0);
    expect(watch.observe(42)).toBe(0);
    expect(watch.observe(43)).toBe(1);
  });
});

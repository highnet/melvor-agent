import { describe, expect, it } from 'vitest';
import { act } from '../src/adapter/act.js';

const never = () => false;

/**
 * The distinction between "no" and "not yet".
 *
 * The runtime abandons an objective after a handful of failures, and a
 * precondition refusal counts immediately because the same call against the
 * same state refuses identically. That reasoning holds for "no such building"
 * and fails for "the town cannot afford it": a town regenerates resources every
 * hour, so the state changes on its own.
 *
 * Conflating them stopped the town growing within a minute of it dipping below
 * its building reserve — and Township level is what gates the biome the last
 * untrained skill in scope sits behind.
 */
describe('a precondition that time will satisfy', () => {
  it('reports not_yet when the refusal carries a wait', () => {
    const result = act(
      {
        name: 'township.build',
        observe: () => ({ count: 0 }),
        precondition: () => ({ wait: 'the town regenerates hourly' }),
        perform: () => undefined,
        changed: () => true,
      },
      never,
    );

    expect(result).toMatchObject({
      ok: false,
      reason: 'not_yet',
      detail: 'the town regenerates hourly',
    });
  });

  it('still reports precondition for a plain refusal', () => {
    const result = act(
      {
        name: 'township.build',
        observe: () => ({ count: 0 }),
        precondition: () => 'no such building',
        perform: () => undefined,
        changed: () => true,
      },
      never,
    );

    expect(result).toMatchObject({ ok: false, reason: 'precondition' });
  });

  it('proceeds when the precondition returns null', () => {
    let called = false;
    const result = act(
      {
        name: 'township.build',
        observe: () => ({ count: called ? 1 : 0 }),
        precondition: () => null,
        perform: () => {
          called = true;
        },
        changed: (before, after) => after.count > before.count,
      },
      never,
    );

    expect(result.ok).toBe(true);
  });
});

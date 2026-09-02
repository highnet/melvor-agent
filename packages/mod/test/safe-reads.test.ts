import { afterEach, describe, expect, it } from 'vitest';
import {
  noteSwallowed,
  readAdapterFailures,
  recordFallback,
  resetAdapterFailures,
  safeBoolean,
  safeList,
  safeNumber,
  safeText,
  safeValue,
} from '../src/adapter/safe.js';

/**
 * Guarded reads must keep swallowing, and must stop being silent.
 *
 * The adapter swallows on purpose: game getters refuse to answer in states the
 * agent legitimately runs in, and one throwing reader must not empty the
 * candidate list. What was wrong is that roughly a hundred bare catches sat
 * against exactly one that reported anything, so a renamed accessor produced a
 * candidate quietly missing and a rate quietly at its fallback -- with no
 * signal at all, in a system whose entire diagnostic loop is comparing an
 * advertised rate against a realised one.
 *
 * So the two halves are pinned separately: the fallback still comes back, and
 * the failure is now counted.
 */
afterEach(() => resetAdapterFailures());

const throws = () => {
  throw new Error('accessor gone');
};

describe('guarded reads still return their fallback', () => {
  it('passes a working read straight through', () => {
    expect(safeValue('t.value', () => 7)).toBe(7);
    expect(safeNumber('t.number', () => 7, 1)).toBe(7);
    expect(safeList('t.list', () => [1, 2])).toEqual([1, 2]);
    expect(safeBoolean('t.boolean', () => true, false)).toBe(true);
    expect(safeText('t.text', () => 'name')).toBe('name');
    expect(readAdapterFailures()).toEqual([]);
  });

  it('falls back rather than propagating', () => {
    expect(safeValue('t.value', throws)).toBeUndefined();
    expect(safeNumber('t.number', throws, 3_000)).toBe(3_000);
    expect(safeList('t.list', throws)).toEqual([]);
    expect(safeBoolean('t.boolean', throws, false)).toBe(false);
    expect(safeText('t.text', throws)).toBe('');
  });

  it('treats an absent number as no answer, not a failure', () => {
    // Plenty of these fields are legitimately optional. Counting every absence
    // would bury the reads that actually broke.
    expect(safeNumber('t.number', () => undefined, 5)).toBe(5);
    expect(readAdapterFailures()).toEqual([]);
  });

  it('counts a non-finite number as a failed read', () => {
    // NaN is not a number that happens to be odd. A NaN interval divides into
    // an infinite rate and pins that recipe to the top of the board forever.
    expect(safeNumber('t.number', () => Number.NaN, 3_000)).toBe(3_000);
    expect(readAdapterFailures()[0]?.site).toBe('t.number');
  });
});

describe('failures are counted per site', () => {
  it('tallies repeats rather than listing them', () => {
    // These run every policy tick. A record per occurrence would flood the
    // 300-entry log queue and evict every other diagnostic before it shipped,
    // which has happened here before.
    safeValue('candidates.thievingSuccessRate', throws);
    safeValue('candidates.thievingSuccessRate', throws);
    safeValue('candidates.thievingSuccessRate', throws);

    expect(readAdapterFailures()).toEqual([
      { site: 'candidates.thievingSuccessRate', count: 3, lastError: 'accessor gone' },
    ]);
  });

  it('sorts the worst site first', () => {
    safeValue('a.rare', throws);
    safeValue('b.constant', throws);
    safeValue('b.constant', throws);

    expect(readAdapterFailures().map((entry) => entry.site)).toEqual(['b.constant', 'a.rare']);
  });

  it('keeps the last error, so a rename reads differently from a bad state', () => {
    safeValue('a.site', throws);
    safeValue('a.site', () => {
      throw new Error('none is selected');
    });

    expect(readAdapterFailures()[0]?.lastError).toBe('none is selected');
  });

  it('counts a swallowed exception a caller keeps its own control flow for', () => {
    // The `continue` inside a registry loop: skipping one malformed entry is
    // how a candidate disappears with the run otherwise looking healthy.
    noteSwallowed('registries.recipeLevel', new Error('undefined'));
    expect(readAdapterFailures()[0]).toEqual({
      site: 'registries.recipeLevel',
      count: 1,
      lastError: 'undefined',
    });
  });

  it('counts a fallback that no exception announced', () => {
    // A chain of getters that all return zero lands on the same fallback as a
    // throw and is exactly as invisible.
    recordFallback('candidates.skillInterval', 'no source reported a usable interval');
    expect(readAdapterFailures()[0]?.lastError).toBe('no source reported a usable interval');
  });
});

import { checkDumpFreshness, knowledgeDumpSchema } from '@melvor-agent/knowledge';
import { describe, expect, it } from 'vitest';
import { capSection } from '../src/adapter/registries.js';

/**
 * A cut section has to say that it was cut.
 *
 * Three sections of the dump were sliced with a bare `.slice(0, n)` and no
 * record of it, which let one file hold two disagreeing answers to the same
 * question: twelve Herblore recipes in `herbloreRecipes`, seventy-two in
 * `skillRecipes`. Nothing in either said which had been truncated, and a short
 * list is indistinguishable from a cut one.
 */
describe('capping a dump section', () => {
  it('reports no truncation when everything fits', () => {
    // The normal case, and the one that must not manufacture a warning: a
    // truncation record on every section is the same as none.
    const cut = capSection(['a', 'b', 'c'], 10);

    expect(cut.items).toEqual(['a', 'b', 'c']);
    expect(cut.truncatedAt).toBeNull();
    expect(cut.totalAvailable).toBe(3);
  });

  it('reports no truncation when the list is exactly at the limit', () => {
    // Off by one here reads as "the dump was cut" for a dump that was not, and
    // a warning that cries wolf is how a real cut goes unread later.
    expect(capSection(['a', 'b'], 2).truncatedAt).toBeNull();
  });

  it('says where it cut and how much there was', () => {
    // The whole point: `truncatedAt` alone says a cut happened,
    // `totalAvailable` says how much was lost. The old slices said neither.
    const cut = capSection(['a', 'b', 'c', 'd'], 2);

    expect(cut.items).toEqual(['a', 'b']);
    expect(cut.truncatedAt).toBe(2);
    expect(cut.totalAvailable).toBe(4);
  });

  it('does not hand back the caller its own array', () => {
    // The dump is assembled from live registry arrays; returning one by
    // reference would let a later section mutate a registry through it.
    const source = ['a'];

    expect(capSection(source, 10).items).not.toBe(source);
  });
});

/**
 * A one-time build cost is not a per-action input.
 *
 * Pure restatement of the split the dumper makes, because the real function
 * walks the live skill registry. `BaseAgilityObject.itemCosts` is what building
 * an obstacle costs once; recorded as `itemCosts` — the field the dump
 * documents as "inputs a recipe consumes" — it charges every lap the price of
 * construction, and the profit figure is then wrong by however many laps the
 * course is run.
 */
describe('splitting build costs from consumption', () => {
  const split = (costs: readonly string[], oneTime: boolean) => ({
    itemCosts: oneTime ? [] : [...costs],
    buildCosts: oneTime ? [...costs] : [],
  });

  it('records an obstacle cost as a build cost and consumes nothing', () => {
    expect(split(['Logs'], true)).toEqual({ itemCosts: [], buildCosts: ['Logs'] });
  });

  it('leaves a smelting recipe consuming its ore', () => {
    expect(split(['Iron Ore'], false)).toEqual({ itemCosts: ['Iron Ore'], buildCosts: [] });
  });

  it('never records the same cost twice', () => {
    // Both fields populated would double-charge whichever consumer reads both,
    // which is the mistake this split exists to make impossible.
    for (const oneTime of [true, false]) {
      const row = split(['Logs'], oneTime);
      expect(row.itemCosts.length === 0 || row.buildCosts.length === 0).toBe(true);
    }
  });
});

/**
 * A new section has to be required, or it is never collected.
 *
 * The policy at the top of `dump-schema.ts`, learned by defeating it: monster
 * loot tables were added with `.default([])` "for safety", so every stale dump
 * kept validating, the default was filled in, and 377 monsters carried empty
 * loot tables for as long as nobody checked. `equipment` is the section that
 * answers whether a crossbow fires an arrow — a `.default([])` on it would read
 * as "no equipment has requirements" rather than "this was never collected",
 * which is the worse of the two failures by a wide margin.
 */
describe('the equipment section is required', () => {
  it('refuses a dump that predates it, so the mod regenerates instead', () => {
    const stale = knowledgeDumpSchema.safeParse({ gameVersion: 'v1.3.1' });

    expect(stale.success).toBe(false);
    expect(stale.success ? [] : stale.error.issues.map((issue) => issue.path.join('.'))).toContain(
      'equipment',
    );
  });

  it('is what checkDumpFreshness reports as malformed rather than fresh', () => {
    // The path that matters: the arm refusal treats malformed as a trigger to
    // dump again, so a schema addition reaches the live dump without anyone
    // pressing a button. A section that parsed would never get there.
    const freshness = checkDumpFreshness({ gameVersion: 'v1.3.1' }, 'v1.3.1');

    expect(freshness.fresh).toBe(false);
    expect(freshness.fresh === false ? freshness.reason : null).toBe('malformed');
  });
});

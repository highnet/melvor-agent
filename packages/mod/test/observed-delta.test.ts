import { ok, summariseObserved, summariseResult } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';

/**
 * The summariser exists so that `ok` is not the whole of what a caller learns
 * from a verified action. Its one rule is that it never invents a delta: a
 * projection it cannot compare must produce silence, not a zero.
 */
describe('summariseObserved', () => {
  it('reports a signed magnitude for a bare number', () => {
    const delta = summariseObserved(2200, 2242);
    expect(delta?.detail).toBe('+42');
    expect(delta?.magnitudes).toEqual({ value: 42 });
  });

  it('reports each moved field of an object, and stays silent about the rest', () => {
    const delta = summariseObserved(
      { xp: 2200, level: 15, active: false, recipe: 'melvorD:Oak_Tree' },
      { xp: 2200, level: 15, active: true, recipe: 'melvorD:Willow_Tree' },
    );

    expect(delta?.detail).toBe(
      'active false -> true, recipe "melvorD:Oak_Tree" -> "melvorD:Willow_Tree"',
    );
    // xp and level did not move, so nothing claims they did.
    expect(delta?.magnitudes).toEqual({});
  });

  it('reports numeric magnitudes by path through nested objects', () => {
    const delta = summariseObserved(
      { bank: { qty: 40 }, skill: { xp: 2200 } },
      { bank: { qty: 52 }, skill: { xp: 2260.5 } },
    );

    expect(delta?.magnitudes).toEqual({ 'bank.qty': 12, 'skill.xp': 60.5 });
    expect(delta?.detail).toBe('bank.qty +12, skill.xp +60.50');
  });

  it('compares arrays on length only, never element by element', () => {
    // A reordering is not a change; reporting one would make "the selection
    // moved" a claim about position, which the projection does not carry.
    expect(summariseObserved(['a', 'b'], ['b', 'a'])).toBeNull();
    expect(summariseObserved({ recipeIds: ['a'] }, { recipeIds: ['a', 'b'] })?.magnitudes).toEqual({
      'recipeIds.length': 1,
    });
  });

  it('says nothing when the projection is unchanged', () => {
    expect(summariseObserved({ qty: 40 }, { qty: 40 })).toBeNull();
  });

  it('says nothing rather than inventing a delta for shapes it cannot compare', () => {
    expect(summariseObserved(3, 'three')).toBeNull();
    expect(summariseObserved(null, { qty: 1 })).toBeNull();
    // A getter answering NaN has no magnitude, and `NaN - NaN` must not be
    // read as "no change" either -- both are silence.
    expect(summariseObserved(Number.NaN, 5)).toBeNull();
    expect(summariseObserved({ qty: Number.NaN }, { qty: Number.NaN })).toBeNull();
  });

  it('ignores keys that are not on both sides', () => {
    expect(summariseObserved({ qty: 1 }, { other: 2 })).toBeNull();
  });
});

describe('summariseResult', () => {
  it('summarises a successful action result', () => {
    const result = ok('woodcutting.cut', { active: false, xp: 10 }, { active: true, xp: 10 });
    expect(summariseResult(result)?.detail).toBe('active false -> true');
  });

  it('returns null for a failure, which carries no observation', () => {
    const result = ok('woodcutting.cut', 1, 2);
    expect(summariseResult(result)).not.toBeNull();
    expect(
      summariseResult({
        ok: false,
        action: 'woodcutting.cut',
        reason: 'precondition',
        detail: 'no axe',
      }),
    ).toBeNull();
  });
});

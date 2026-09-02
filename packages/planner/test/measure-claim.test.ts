import type { QualitySample } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { measureAgainstClaim } from '../src/progress.js';

/**
 * Realised rates, compared against what the candidate claimed.
 *
 * Every rate error this session was found by hand -- an operator noticing a
 * number looked wrong, after hours of work had been planned around it. Crystal
 * advertised 120,000 GP/h and delivered about 10,800. Agility advertised 21
 * levels/h and delivered 6. In both cases the service was already measuring the
 * truth and had no way to line it up against the claim, because samples
 * recorded that progress happened rather than what produced it.
 */
const sample = (minutes: number, xp: number, skillId = 'melvorD:Mining'): QualitySample =>
  ({
    at: 1_700_000_000_000 + minutes * 60_000,
    totalLevel: 500,
    completionPercent: 3,
    gp: 0,
    activeSkillId: skillId,
    activeSkillXp: xp,
  }) as QualitySample;

describe('measureAgainstClaim', () => {
  it('reports the realised rate and its ratio to the claim', () => {
    // An hour of samples gaining 30,000 XP against a claim of 60,000.
    const got = measureAgainstClaim([sample(0, 0), sample(60, 30_000)], 'melvorD:Mining', 60_000);

    expect(got?.realisedXpPerHour).toBeCloseTo(30_000, 0);
    expect(got?.ratio).toBeCloseTo(0.5, 3);
  });

  it('catches an order-of-magnitude overstatement', () => {
    // The Crystal case, which cost an afternoon of planning.
    const got = measureAgainstClaim([sample(0, 0), sample(60, 10_800)], 'melvorD:Mining', 120_000);

    expect(got?.ratio).toBeLessThan(0.1);
  });

  it('ignores samples from a different skill', () => {
    // Total level mixes every skill together, so a fast one hides a slow one.
    const mixed = [sample(0, 0), sample(30, 5_000, 'melvorD:Smithing'), sample(60, 100)];

    expect(measureAgainstClaim(mixed, 'melvorD:Mining', 60_000)?.realisedXpPerHour).toBeCloseTo(
      100,
      0,
    );
  });

  it('says nothing from too short a window', () => {
    // A confident "0% of advertised" from two samples thirty seconds apart is
    // exactly the kind of number this exists to catch.
    expect(
      measureAgainstClaim([sample(0, 0), sample(0.5, 10)], 'melvorD:Mining', 60_000),
    ).toBeNull();
  });

  it('reports a realised rate even with no claim to compare against', () => {
    const got = measureAgainstClaim([sample(0, 0), sample(60, 9_000)], 'melvorD:Mining', null);

    expect(got?.realisedXpPerHour).toBeCloseTo(9_000, 0);
    expect(got?.ratio).toBeNull();
  });
});

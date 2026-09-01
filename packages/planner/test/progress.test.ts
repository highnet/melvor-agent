import type { QualitySample } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { controlRate, measureProgress } from '../src/progress.js';

const HOUR = 3_600_000;
const START = 1_700_000_000_000;

function sample(hoursIn: number, totalLevel: number, gp: number): QualitySample {
  return { at: START + hoursIn * HOUR, totalLevel, completionPercent: 1, gp };
}

describe('the quality metric', () => {
  it('measures levels per hour of real time', () => {
    const report = measureProgress([sample(0, 100, 1000), sample(2, 110, 5000)], null);

    expect(report?.totalLevelGained).toBe(10);
    expect(report?.levelsPerHour).toBeCloseTo(5);
    expect(report?.gpPerHour).toBeCloseTo(2000);
  });

  it('compares against leaving one skill running', () => {
    // The whole point of the project: beating the control condition. Two levels
    // an hour against a control of one is 2x, and that is the number the brief
    // asks to be judged on.
    const report = measureProgress([sample(0, 100, 0), sample(5, 110, 0)], 1);

    expect(report?.timesBetterThanControl).toBeCloseTo(2);
    expect(report?.detail).toMatch(/2\.00x/);
  });

  it('says plainly when the agent is losing to the control', () => {
    // An agent that cannot beat one skill left running is not worth running,
    // and softening that would defeat the reason the metric exists.
    const report = measureProgress([sample(0, 100, 0), sample(10, 102, 0)], 1);

    expect(report?.timesBetterThanControl).toBeLessThan(1);
    expect(report?.detail).toMatch(/leaving one skill running would do better/);
  });

  it('refuses to measure a window too short to mean anything', () => {
    expect(measureProgress([sample(0, 100, 0), sample(0.01, 100, 0)], 1)).toBeNull();
    expect(measureProgress([sample(0, 100, 0)], 1)).toBeNull();
  });

  it('reports no comparison rather than inventing one', () => {
    const report = measureProgress([sample(0, 100, 0), sample(2, 110, 0)], null);

    expect(report?.timesBetterThanControl).toBeNull();
    expect(report?.detail).toMatch(/No control rate/);
  });
});

describe('the control rate', () => {
  const skillXp = new Map([['melvorD:Woodcutting', 0]]);

  it('takes the best sustained action, being generous to the control', () => {
    // Deliberately generous: the single best action, never an average. A metric
    // that flatters the agent is worth nothing.
    const rate = controlRate(
      [
        {
          kind: 'gather_resource',
          xpPerHour: 100_000,
          params: { skillId: 'melvorD:Woodcutting' },
        },
        { kind: 'gather_resource', xpPerHour: 500, params: { skillId: 'melvorD:Woodcutting' } },
      ],
      skillXp,
    );

    // 100,000 XP from zero is roughly level 49 on Melvor's curve.
    expect(rate).toBeGreaterThan(40);
  });

  it('ignores one-shot actions, which cannot be left running', () => {
    const rate = controlRate(
      [
        {
          kind: 'buy_shop_upgrade',
          xpPerHour: 999_999,
          params: { purchaseId: 'melvorD:Black_Axe' },
        },
      ],
      skillXp,
    );

    expect(rate).toBeNull();
  });

  it('returns null when nothing sustained is on offer', () => {
    expect(controlRate([], skillXp)).toBeNull();
  });
});

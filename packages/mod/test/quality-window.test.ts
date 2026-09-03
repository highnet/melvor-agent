import type { QualitySample } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { QualityWindow } from '../src/runtime/quality-window.js';

/**
 * The rolling window behind the project's one quality metric.
 *
 * We run at real time: an hour of work cannot be watched, only sampled and
 * differenced. So the window is the whole instrument, and until it came off
 * `Agent` neither the cap nor the rate could be exercised -- both were
 * arithmetic over a private array on a class that needs a live `game`.
 */

const HOUR = 3_600_000;

const sample = (at: number, totalLevel: number, gp: number): QualitySample => ({
  at,
  totalLevel,
  completionPercent: 2.98,
  gp,
});

describe('QualityWindow', () => {
  it('has no rate before there is anything to difference', () => {
    const window = new QualityWindow();
    expect(window.progressRate).toBeNull();

    window.add(sample(0, 391, 30_816));
    // One sample is a reading, not a rate.
    expect(window.progressRate).toBeNull();
  });

  it('measures levels and GP per real hour', () => {
    const window = new QualityWindow();
    window.add(sample(0, 391, 30_816));
    window.add(sample(2 * HOUR, 399, 50_816));

    expect(window.progressRate).toEqual({
      hours: 2,
      levelsPerHour: 4,
      gpPerHour: 10_000,
    });
  });

  it('refuses a rate over a window too short to divide by', () => {
    // Differencing two samples a minute apart divides a rounding error by a
    // very small number, which is how a flat run produces a spectacular rate.
    const window = new QualityWindow();
    window.add(sample(0, 391, 30_816));
    window.add(sample(60_000, 392, 31_000));

    expect(window.progressRate).toBeNull();
  });

  it('reports an hour that achieved nothing as zero, not as absent', () => {
    // The failure this metric exists to expose: running, reporting healthily,
    // and moving neither total level nor GP.
    const window = new QualityWindow();
    window.add(sample(0, 391, 30_816));
    window.add(sample(HOUR, 391, 30_816));

    expect(window.progressRate).toEqual({ hours: 1, levelsPerHour: 0, gpPerHour: 0 });
  });

  it('keeps 48h of minute samples and no more', () => {
    const window = new QualityWindow();
    for (let index = 0; index <= 2_900; index += 1) {
      window.add(sample(index * 60_000, 391 + index, 0));
    }

    expect(window.length).toBe(2_880);
  });

  it('drops the oldest sample rather than the newest', () => {
    // The rate is computed from the two ends of the window, so evicting the
    // wrong end would freeze the metric on a stale reading.
    const window = new QualityWindow();
    for (let index = 0; index <= 2_880; index += 1) {
      window.add(sample(index * 60_000, 100 + index, 0));
    }

    const recent = window.recent();
    expect(recent[recent.length - 1]?.totalLevel).toBe(2_980);
    expect(window.progressRate?.levelsPerHour).toBeCloseTo(60, 5);
  });

  it('ships the tail of the window, not the archive', () => {
    const window = new QualityWindow();
    for (let index = 0; index < 500; index += 1) window.add(sample(index * 60_000, index, 0));

    const recent = window.recent();
    expect(recent).toHaveLength(120);
    expect(recent[0]?.totalLevel).toBe(380);
    expect(recent[119]?.totalLevel).toBe(499);
  });
});

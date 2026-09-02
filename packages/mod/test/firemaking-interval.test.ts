import { describe, expect, it } from 'vitest';

/**
 * Every Firemaking log must be priced at its own interval.
 *
 * `masteryIntervalFor`'s getter table had no Firemaking entry, so every log fell
 * through to the skill-wide fallback -- a nominal 3s, because `actionInterval`
 * (firemakingTicks.d.ts:89) reads `activeRecipe` and throws while nothing is
 * selected. `FiremakingLog.baseInterval` (firemakingTicks.d.ts:35) is a field on
 * the *log* and ranges from a couple of seconds to tens of seconds across the
 * tiers, so a shared interval made actions-per-hour identical for every log and
 * ranking collapsed to base XP alone. That systematically picks the slowest
 * logs: they pay more per burn precisely because they take longer.
 *
 * Modifiers come from `modifyInterval(interval, action)` (skill.d.ts:426), which
 * is action-scoped and does not read the active selection, so it answers during
 * enumeration where `actionInterval` throws.
 *
 * The predicate is mirrored here because the real one reads `game.*`.
 */
const NOMINAL = 3_000;

const modifiedInterval = (
  skill: { modifyInterval?: (interval: number, action?: object) => number },
  base: number,
  action: object,
): number => {
  try {
    const modified = skill.modifyInterval?.(base, action);
    return typeof modified === 'number' && Number.isFinite(modified) && modified > 0
      ? modified
      : base;
  } catch {
    return base;
  }
};

const firemakingIntervalFor = (
  skill: { modifyInterval?: (interval: number, action?: object) => number },
  log: { baseInterval?: number },
  fallback = NOMINAL,
): number => {
  const base = log.baseInterval;
  if (typeof base !== 'number' || !Number.isFinite(base) || base <= 0) return fallback;
  return modifiedInterval(skill, base, log);
};

/** A skill that applies a flat percentage speed-up, as the real one would. */
const fasterBy = (percent: number) => ({
  modifyInterval: (interval: number) => interval * (1 - percent / 100),
});

describe('firemaking interval is per log', () => {
  it("reads the log's own base interval rather than a nominal three seconds", () => {
    // Normal Logs burn quickly; Magic Logs take an order of magnitude longer.
    expect(firemakingIntervalFor({}, { baseInterval: 2_000 })).toBe(2_000);
    expect(firemakingIntervalFor({}, { baseInterval: 30_000 })).toBe(30_000);
  });

  it('no longer ranks the slowest log above the fastest on XP alone', () => {
    // The failure this prevents, spelled out. A slow log pays more per burn, so
    // with one shared interval it wins on xp/h -- while actually being worse.
    const fast = { baseInterval: 2_000, baseExperience: 15 };
    const slow = { baseInterval: 30_000, baseExperience: 100 };

    const perHour = (log: { baseInterval: number; baseExperience: number }, interval: number) =>
      (3_600_000 / interval) * log.baseExperience;

    // Under the old shared 3s interval the slow log looked six times better.
    expect(perHour(slow, NOMINAL)).toBeGreaterThan(perHour(fast, NOMINAL));

    // Priced at their own intervals the ordering inverts, which is the truth.
    expect(perHour(fast, firemakingIntervalFor({}, fast))).toBeGreaterThan(
      perHour(slow, firemakingIntervalFor({}, slow)),
    );
  });

  it("applies the skill's interval modifiers to the log's base", () => {
    expect(firemakingIntervalFor(fasterBy(20), { baseInterval: 10_000 })).toBe(8_000);
  });

  it('keeps the unmodified base when the modifier accessor throws', () => {
    // An unreadable modifier understates a fast skill; dropping the candidate
    // would remove Firemaking from the board entirely.
    const hostile = {
      modifyInterval: () => {
        throw new Error('no recipe selected');
      },
    };
    expect(firemakingIntervalFor(hostile, { baseInterval: 4_000 })).toBe(4_000);
  });

  it('rejects a zero or missing base rather than reporting an infinite rate', () => {
    // A zero interval divides into an infinite rate and pins the log to the top
    // of the board forever. It is not a very fast burn, it is an unreadable one.
    expect(firemakingIntervalFor({}, { baseInterval: 0 })).toBe(NOMINAL);
    expect(firemakingIntervalFor({}, {})).toBe(NOMINAL);
  });

  it('refuses a modifier that would zero the interval', () => {
    expect(firemakingIntervalFor(fasterBy(100), { baseInterval: 5_000 })).toBe(5_000);
  });
});

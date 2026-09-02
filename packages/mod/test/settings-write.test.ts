import { describe, expect, it } from 'vitest';

/**
 * Settings are written when they change, and a failure is reported once.
 *
 * The policy tier notifies every tick, so writing ran every three seconds -- a
 * character-storage write plus an HTTP PUT, roughly 9,600 of each across an
 * eight-hour night, almost all saving a value identical to the last.
 *
 * The warning was worse than the traffic. While the service was down it emitted
 * two lines every three seconds against a 300-record log queue, evicting every
 * real diagnostic before it could ship. The first read of the durable log after
 * wiring it up returned nothing but this message -- the failure demonstrating
 * itself.
 */
const shouldWrite = (encoded: string, lastWritten: string | null): boolean =>
  encoded !== lastWritten;

const shouldWarn = (failingSince: number | null, now: number, intervalMs: number): boolean =>
  failingSince === null || now - failingSince >= intervalMs;

describe('settings writes', () => {
  it('writes the first time', () => {
    expect(shouldWrite('{"a":1}', null)).toBe(true);
  });

  it('skips an identical write', () => {
    expect(shouldWrite('{"a":1}', '{"a":1}')).toBe(false);
  });

  it('writes again once something actually changed', () => {
    expect(shouldWrite('{"a":2}', '{"a":1}')).toBe(true);
  });
});

describe('persistence warnings', () => {
  it('reports the first failure immediately', () => {
    expect(shouldWarn(null, 1_000, 300_000)).toBe(true);
  });

  it('stays quiet through a continuing outage', () => {
    expect(shouldWarn(1_000, 4_000, 300_000)).toBe(false);
  });

  it('repeats once the interval has passed', () => {
    // Silence forever would be its own failure: an outage that never recovers
    // should still be visible to whoever reads the log in the morning.
    expect(shouldWarn(1_000, 400_000, 300_000)).toBe(true);
  });
});

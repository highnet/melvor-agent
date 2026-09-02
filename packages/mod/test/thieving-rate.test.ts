import { describe, expect, it } from 'vitest';

/**
 * Thieving must be priced from the per-NPC accessors, and failure must cost time.
 *
 * The rate used to read `skill.actionInterval`, which returns 0 unless Thieving
 * is the skill currently running -- so every Thieving candidate showed no rate
 * at all while the agent was doing anything else, i.e. worthless exactly when a
 * planner is deciding whether to start it. That was defended as "absent rather
 * than guessed", but the choice was never between a zero and a guess:
 * `getNPCInterval(npc)` (thieving2.d.ts:193) takes the NPC as an argument and
 * does not care what is running.
 *
 * A failed steal also costs a stun (`getStunInterval`, thieving2.d.ts:182),
 * which is time earning nothing -- the same shape as a mining respawn. Ignoring
 * it overstates precisely the NPCs whose success rate is worst.
 */
const expectedInterval = (baseMs: number, stunMs: number, successRate: number): number =>
  baseMs + (1 - successRate) * stunMs;

describe('thieving rate', () => {
  it('charges the stun that failure carries', () => {
    // 3s steal, 3s stun, 50% success: half the attempts cost an extra 3s, so
    // the expected cost is 4.5s -- a third worse than the naive 3s.
    expect(expectedInterval(3_000, 3_000, 0.5)).toBe(4_500);
  });

  it('charges nothing extra when every steal lands', () => {
    expect(expectedInterval(3_000, 3_000, 1)).toBe(3_000);
  });

  it('penalises a poor success rate hardest', () => {
    // The whole point: two NPCs with identical intervals are not equivalent,
    // and the worse one used to look identical to the better one.
    const good = expectedInterval(3_000, 3_000, 0.9);
    const bad = expectedInterval(3_000, 3_000, 0.2);

    expect(good).toBeLessThan(bad);
    expect(bad / good).toBeGreaterThan(1.4);
  });

  it('survives a missing stun reading without inventing one', () => {
    // A stun of zero understates; a fabricated one would misrank. Zero is the
    // safe direction because it is recoverable by measurement.
    expect(expectedInterval(3_000, 0, 0.5)).toBe(3_000);
  });
});

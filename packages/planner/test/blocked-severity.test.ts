import { describeDropped, selectBlocked, severityRank } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';

/**
 * Which twelve blocked opportunities a planning session actually sees.
 *
 * The list was `slice(0, 12)` over a hand-maintained concatenation, so priority
 * was the position a `push` happened to sit at: a food-reserve countdown
 * competed with "Yew unlocks at level 60" on order alone. The concatenation had
 * already been rewritten twice for exactly that reason, and a session's worth
 * of diagnostics were shipped, truncated away and never read.
 */
const entry = (label: string, severity: 'critical' | 'high' | 'normal' | 'low', rate = 0) => ({
  label,
  xpPerHour: rate,
  severity,
});

describe('severity ordering', () => {
  it('orders critical above everything and low below it', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('normal'));
    expect(severityRank('normal')).toBeLessThan(severityRank('low'));
  });

  it('treats an absent severity as ordinary, so an older mod still ranks', () => {
    expect(severityRank(undefined)).toBe(severityRank('normal'));
  });
});

describe('selectBlocked', () => {
  it('never drops a critical, however long the list', () => {
    const items = [
      ...Array.from({ length: 30 }, (_, i) => entry(`unlock ${i}`, 'low')),
      entry('Food is down to 11 meals and there is no Auto Eat', 'critical'),
    ];

    const { shown, dropped } = selectBlocked(items, 12);
    expect(shown[0]?.label).toContain('Food is down to 11 meals');
    expect(dropped.some((item) => item.severity === 'critical')).toBe(false);
  });

  it('reserves slots per tier so one loud tier cannot silence another', () => {
    // Twenty `high` entries used to be able to fill every slot. The reservation
    // is the same argument that made the mod rank blocked entries by skill
    // breadth: the list exists to say what the *game* is offering.
    const items = [
      ...Array.from({ length: 20 }, (_, i) => entry(`high ${i}`, 'high', 1000 - i)),
      ...Array.from({ length: 20 }, (_, i) => entry(`normal ${i}`, 'normal', 500 - i)),
      ...Array.from({ length: 20 }, (_, i) => entry(`low ${i}`, 'low')),
    ];

    const { shown } = selectBlocked(items, 12);
    expect(shown).toHaveLength(12);
    expect(shown.filter((item) => item.severity === 'normal').length).toBeGreaterThanOrEqual(4);
    expect(shown.filter((item) => item.severity === 'low').length).toBeGreaterThanOrEqual(2);
  });

  it('spends unused reservations rather than showing fewer than it could', () => {
    const items = Array.from({ length: 20 }, (_, i) => entry(`high ${i}`, 'high', 1000 - i));

    const { shown } = selectBlocked(items, 12);
    expect(shown).toHaveLength(12);
  });

  it('ranks by rate within a tier', () => {
    const items = [entry('slow', 'normal', 10), entry('fast', 'normal', 900)];
    expect(selectBlocked(items, 12).shown[0]?.label).toBe('fast');
  });

  it('drops nothing when everything fits', () => {
    expect(selectBlocked([entry('one', 'normal')], 12).dropped).toEqual([]);
  });
});

describe('describeDropped', () => {
  it('says nothing when nothing was cut', () => {
    expect(describeDropped([])).toBeNull();
  });

  it('names what was dropped rather than counting it', () => {
    // "...and 14 more" says a cut was made and nothing about whether it removed
    // trivia or the one line that would have unblocked the next four hours.
    const dropped = Array.from({ length: 5 }, (_, i) => entry(`Woodcutting: tree ${i}`, 'low'));
    const line = describeDropped(dropped, 2);

    expect(line).toContain('Woodcutting: tree 0');
    expect(line).toContain('Woodcutting: tree 1');
    expect(line).toContain('and 3 more');
  });
});

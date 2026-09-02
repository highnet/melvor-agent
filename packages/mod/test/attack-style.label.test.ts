import { describe, expect, it } from 'vitest';

/**
 * An attack style must say which skills it trains.
 *
 * The label said only that the choice "decides which combat skill the XP goes
 * to" -- telling the planner a decision mattered while giving it nothing to
 * decide with. This is the single lever on four of the run's goals: Hitpoints
 * 40, Defence 20, Ranged 20 and Magic 20 are each reached, or not, by this
 * selection.
 *
 * `AttackStyle.experienceGain` (attackStyle.d.ts:11-14) is the game's own
 * answer, so nothing is inferred from the style's name.
 */
const describe_ = (gains: { skill: { name: string }; ratio: number }[]): string => {
  const shares = gains.filter((g) => g.ratio > 0);
  if (shares.length === 0) return 'no skill the game will name';
  const total = shares.reduce((s, g) => s + g.ratio, 0);
  return shares
    .map((g) =>
      total > 0 && shares.length > 1
        ? `${g.skill.name} ${Math.round((g.ratio / total) * 100)}%`
        : g.skill.name,
    )
    .join(' and ');
};

describe('attack style labels name their skills', () => {
  it('names a single trained skill plainly', () => {
    expect(describe_([{ skill: { name: 'Ranged' }, ratio: 1 }])).toBe('Ranged');
  });

  it('gives the split when a style trains two skills', () => {
    // A style that splits is not the same offer as one that pours everything
    // into one, which is exactly what the old label hid.
    expect(
      describe_([
        { skill: { name: 'Attack' }, ratio: 3 },
        { skill: { name: 'Hitpoints' }, ratio: 1 },
      ]),
    ).toBe('Attack 75% and Hitpoints 25%');
  });

  it('ignores a zero-ratio entry', () => {
    expect(
      describe_([
        { skill: { name: 'Defence' }, ratio: 1 },
        { skill: { name: 'Magic' }, ratio: 0 },
      ]),
    ).toBe('Defence');
  });

  it('says so when the game names nothing', () => {
    // Better than an empty clause that reads like a complete sentence.
    expect(describe_([])).toBe('no skill the game will name');
  });
});

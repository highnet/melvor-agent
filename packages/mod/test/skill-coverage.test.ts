import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every skill the game has must be accounted for in docs/COVERAGE.md.
 *
 * "All skills are supported" is exactly the kind of claim that rots: a skill is
 * added, a doc is not, and later nobody knows whether an omission is a decision
 * or an oversight. The coverage doc names each skill with the capability that
 * trains it, or says plainly that there is a gap -- and this test fails if any
 * skill is missing from that table entirely, which is the one state that reads
 * as support while providing none.
 *
 * It also pins the false alarm found while writing the generator: parsing only
 * the literal STARTABLE_SKILL_IDS list reported Woodcutting, Mining and Fishing
 * as untrainable, because the list spreads GATHERING_SKILL_IDS. A coverage
 * document that cries wolf is worse than none.
 */
const root = process.cwd();

const readSkills = (): { id: string; name: string }[] | null => {
  try {
    return (
      JSON.parse(readFileSync(resolve(root, 'data/dump.json'), 'utf8')) as {
        skills: { id: string; name: string }[];
      }
    ).skills;
  } catch {
    return null;
  }
};

const coverage = (): string => {
  try {
    return readFileSync(resolve(root, 'docs/COVERAGE.md'), 'utf8');
  } catch {
    return '';
  }
};

// `skipIf`, not an early return. A return reports a PASS, so both checks below
// have been claiming the coverage doc was verified against the game registry on
// every CI run -- `data/` is gitignored, so there has never been a registry
// there to verify against. A skip is counted in the summary; a pass is a lie.
describe.skipIf(readSkills() === null)('coverage names every skill', () => {
  it('lists each skill in the game', () => {
    const skills = readSkills();
    if (skills === null) return;

    const doc = coverage();
    const missing = skills.filter((skill) => !doc.includes(`| ${skill.name} |`));

    expect(missing.map((s) => s.name)).toEqual([]);
  });

  it('reports no unexplained gaps', () => {
    const skills = readSkills();
    if (skills === null) return;

    // A gap is allowed to exist -- Corruption is honestly out of reach -- but it
    // must be stated with a reason rather than left blank.
    const doc = coverage();
    const bare = doc
      .split('\n')
      .filter((line) => line.includes('gap — no way to train it'))
      .map((line) => line.split('|')[1]?.trim());

    expect(bare).toEqual([]);
  });
});

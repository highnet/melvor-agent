import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every skill id the agent starts work through must exist in the game.
 *
 * Alt Magic was listed as `melvorD:AltMagic`, which is not a registry id: Alt
 * Magic is a mode of the Magic skill, held under `melvorD:Magic`. Every lookup
 * keyed on the plausible-looking name silently returned undefined, so Alt Magic
 * produced no candidates at all -- for any spell, at any level, for the entire
 * life of the repo.
 *
 * The failure mode is what makes this worth a test. It was not a refusal and
 * not a zero rate; it was absence, and a skill that cannot be found is skipped
 * in the same breath as a skill with nothing to offer. Nothing anywhere said a
 * word. So the ids are checked against the dumped skill registry rather than
 * trusted to look right.
 */
const dumpPath = resolve(process.cwd(), 'data/dump.json');

const readDump = (): { skills: { id: string }[] } | null => {
  try {
    return JSON.parse(readFileSync(dumpPath, 'utf8')) as { skills: { id: string }[] };
  } catch {
    return null;
  }
};

const startableIds = (): string[] => {
  const src = readFileSync(resolve(process.cwd(), 'packages/mod/src/adapter/gathering.ts'), 'utf8');
  const block = src.split('STARTABLE_SKILL_IDS')[1] ?? '';
  return [...block.slice(0, block.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
};

describe('startable skill ids exist in the game registry', () => {
  it('names Alt Magic by its registry id, not its display name', () => {
    // The specific regression: a mode of a skill is not a skill.
    expect(startableIds()).toContain('melvorD:Magic');
    expect(startableIds()).not.toContain('melvorD:AltMagic');
  });

  // `skipIf`, not an early return: a return reports a PASS, so this claimed to
  // have checked every id against the registry on every CI run while loading
  // nothing at all. A skip is counted in the summary and can be seen.
  it.skipIf(readDump() === null)('every startable id is a real skill', () => {
    const dump = readDump();
    if (dump === null) return;

    const known = new Set(dump.skills.map((s) => s.id));
    const unknown = startableIds().filter((id) => !known.has(id));

    expect(unknown).toEqual([]);
  });
});

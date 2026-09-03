import { noteSwallowed, safeBoolean } from './safe.js';

/**
 * Turning a game requirement into a sentence a planner can act on.
 *
 * Lived inside `registries.ts` as a private helper for the dump, which is why
 * the equip path had nothing: `readEquipCandidates` calls
 * `game.checkRequirements` and, on false, does a bare `continue`. Three
 * crossbows sat in the bank behind a Ranged level nothing would name, and the
 * only way to learn which level was to reach it. The refusal and the reason for
 * it were computed one line apart and only the refusal survived.
 *
 * Flattening an unrecognised requirement to its bare type name is what made the
 * Abyssal realm question unanswerable from the dump: `DungeonCompletion` says a
 * dungeon gates the content but not *which* dungeon, which is the only part
 * anyone needs. So the two shapes that actually gate progression are spelled
 * out, `isMet` is recorded so a satisfied gate is visibly satisfied, and
 * anything else still appears by type rather than being dropped.
 */
export function describeRequirements(read: () => readonly AnyRequirement[]): string[] {
  try {
    return read().map((requirement) => {
      const met = safeBoolean('requirements.isMet', () => requirement.isMet(), false)
        ? ' (met)'
        : '';

      if (requirement.type === 'SkillLevel') {
        return `${requirement.skill.name} ${requirement.level}${met}`;
      }
      if (requirement.type === 'DungeonCompletion') {
        return `Complete ${requirement.dungeon.name} x${requirement.count}${met}`;
      }
      return `${requirement.type}${met}`;
    });
  } catch (error) {
    noteSwallowed('requirements.describeRequirements', error);
    return [];
  }
}

/**
 * The same list, with the requirements already satisfied removed.
 *
 * What a blocked line should say. "Rune Crossbow needs Ranged 40, Ranged 40
 * (met)" is noise on an item that is not blocked by the met half, and a reader
 * that prints every requirement makes the one unmet gate harder to find rather
 * than easier.
 */
export function describeUnmetRequirements(read: () => readonly AnyRequirement[]): string[] {
  return describeRequirements(read).filter((entry) => !entry.endsWith(' (met)'));
}

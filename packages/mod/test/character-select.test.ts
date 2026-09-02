import { describe, expect, it } from 'vitest';

/**
 * Re-entering the game after a reload, without a person at the keyboard.
 *
 * A reload lands on the character-select screen and stops there: the agent is
 * not running, the service hears nothing, and the run idles until someone
 * clicks. Overnight that is the whole night, and it is why several builds sat
 * committed and unloaded while the agent worked around them.
 *
 * The selection is matched by `characterName` (save.d.ts:13) rather than by
 * slot number, because a slot index is positional and silently wrong if the
 * list reorders -- and entering the wrong save means the agent quietly playing
 * someone else's run.
 *
 * The predicate is mirrored here because the real one calls the game's
 * `getLocalInfoInSlot` and `loadLocalSave` (save.d.ts:189).
 */
const chooseSlot = (
  slots: { slotId: number; characterName: string }[],
  name: string,
): number | null => {
  const matches = slots.filter((slot) => slot.characterName === name);
  const only = matches[0];
  return only === undefined || matches.length > 1 ? null : only.slotId;
};

const slots = [
  { slotId: 0, characterName: 'Main' },
  { slotId: 6, characterName: 'Agent' },
  { slotId: 9, characterName: 'Hardcore' },
];

describe('character selection after a reload', () => {
  it('enters the game as the named character', () => {
    expect(chooseSlot(slots, 'Agent')).toBe(6);
  });

  it('refuses when no save carries the name', () => {
    // Guessing here would enter someone else's save.
    expect(chooseSlot(slots, 'Missing')).toBeNull();
  });

  it('refuses when the name does not identify one character', () => {
    // Picking the first of two would be a coin toss with a real run.
    const ambiguous = [
      { slotId: 1, characterName: 'Agent' },
      { slotId: 4, characterName: 'Agent' },
    ];

    expect(chooseSlot(ambiguous, 'Agent')).toBeNull();
  });

  it('refuses when there are no local saves at all', () => {
    expect(chooseSlot([], 'Agent')).toBeNull();
  });

  it('does not match on a partial or differently-cased name', () => {
    // Character names are identifiers here, not search terms.
    expect(chooseSlot(slots, 'agent')).toBeNull();
    expect(chooseSlot(slots, 'Age')).toBeNull();
  });
});

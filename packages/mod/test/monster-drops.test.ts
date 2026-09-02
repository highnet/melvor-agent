import { describe, expect, it } from 'vitest';

/**
 * Connecting "I need this item" to "this fight produces it".
 *
 * The pure rule, restated: the real reader consults the live monster registry.
 * What is pinned here is the decision — a fight is annotated only when it drops
 * something the agent is *already* short of, and a note on every monster is the
 * same as no note at all.
 */
function dropsOfInterest(loot: readonly string[], wanted: ReadonlySet<string>): string[] {
  return loot.filter((item) => wanted.has(item));
}

describe('monster drops the agent is short of', () => {
  const wanted = new Set(['melvorD:Potato_Seeds']);

  it('names the wanted drop so a fight reads as a means, not a risk', () => {
    // Without this, every fight candidate is "Fight X (area, combat level N)"
    // and the planner chooses by combat level — which measures danger, not
    // value. Farming was blocked on a seed while fights that drop it looked
    // identical to fights that do not.
    const loot = ['melvorD:Bones', 'melvorD:Potato_Seeds'];

    expect(dropsOfInterest(loot, wanted)).toEqual(['melvorD:Potato_Seeds']);
  });

  it('says nothing about a monster that drops nothing wanted', () => {
    expect(dropsOfInterest(['melvorD:Bones', 'melvorD:Raw_Beef'], wanted)).toEqual([]);
  });

  it('says nothing at all when the agent is short of nothing', () => {
    // A note attached to every fight is the same as no note.
    expect(dropsOfInterest(['melvorD:Potato_Seeds'], new Set())).toEqual([]);
  });
});

describe('a better recipe in the skill already running', () => {
  // An objective pins a recipe, not a skill: "pickpocket Woman until Thieving
  // 39" keeps pickpocketing Woman for eighteen levels while Marauder unlocks at
  // 21 and pays more. Nothing re-examined the choice once it was made, and I
  // caught it by eye rather than the agent reporting it.
  const notice = (runningRate: number, bestRate: number) => bestRate > runningRate * 1.1;

  it('reports a clearly better option that has since unlocked', () => {
    // Woman 6,450 xp/h against Marauder 8,585 — the live case.
    expect(notice(6450, 8585)).toBe(true);
  });

  it('says nothing when the difference is noise', () => {
    // A permanent notice is the same as no notice.
    expect(notice(6450, 6800)).toBe(false);
  });

  it('says nothing when the running recipe is already the best', () => {
    expect(notice(8585, 8585)).toBe(false);
  });
});

describe('Thieving NPCs carry the same annotation as fights', () => {
  // Monsters got "drops X, which you are short of" and Thieving did not, which
  // is backwards: the reason this character grinds Thieving at all is Bob the
  // Farmer, the only NPC in the game's data dropping Potato Seeds, and his
  // entry said nothing about it.
  const describe_ = (
    loot: readonly string[],
    unique: string | null,
    wanted: ReadonlySet<string>,
  ) => {
    const names = new Set(loot.filter((item) => wanted.has(item)));
    if (unique !== null && wanted.has(unique)) names.add(`${unique} (guaranteed)`);
    return names.size === 0 ? '' : ` — drops ${[...names].join(', ')}, which you are short of`;
  };
  const wanted = new Set(['Potato Seeds', 'Garum Seeds']);

  it('names the wanted seed a farmer drops', () => {
    expect(describe_(['Potato Seeds', 'Onion Seeds'], null, wanted)).toContain('Potato Seeds');
  });

  it('marks a guaranteed unique drop as guaranteed', () => {
    // uniqueDrop is not part of the loot table and is not rolled — an NPC whose
    // unique drop is the wanted item gives it every time, which is the
    // strongest reason to pick it and was previously nowhere on screen.
    expect(describe_([], 'Garum Seeds', wanted)).toContain('Garum Seeds (guaranteed)');
  });

  it('stays silent for an NPC dropping nothing wanted', () => {
    expect(describe_(['Coins', 'Bones'], null, wanted)).toBe('');
  });
});

describe('a skill with no candidates', () => {
  // A skill with no affordable recipe emits nothing, and absence is
  // indistinguishable from impossibility. That cost two mistakes in one day:
  // Summoning looked unavailable when it held 19 shards against recipes needing
  // dozens, and Crafting silently left the list mid-plan the moment its 75
  // leather became 86 gloves — the same skill measured minutes earlier as the
  // best rate on the board.
  const reason = (hasCandidates: boolean, levelAllows: boolean) =>
    hasCandidates ? null : levelAllows ? 'unstocked' : 'locked';

  it('says unstocked when the level allows but the bank is empty', () => {
    expect(reason(false, true)).toBe('unstocked');
  });

  it('says locked when the level does not allow it', () => {
    // A real progression gate, which readLockedActions already reports.
    expect(reason(false, false)).toBe('locked');
  });

  it('says nothing about a skill that is running fine', () => {
    // The blocked list has a twelve-line budget this session learned to respect
    // the hard way; a skill with candidates does not need to explain itself.
    expect(reason(true, true)).toBeNull();
  });
});

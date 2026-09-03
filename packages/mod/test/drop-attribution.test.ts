import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLockedActions, readUnstockedSkills } from '../src/adapter/blocked.js';
import { readGatherCandidates } from '../src/adapter/candidates.js';
import { readAdapterFailures, resetAdapterFailures } from '../src/adapter/safe.js';
import { installFakeGame } from './fixtures.js';

/**
 * `candidates.noCandidates` filed every dropped recipe under "mastery-locked".
 *
 * Live, after the mastery-gate fix landed, with the character at Firemaking 32,
 * Summoning 11, Herblore 1 and Harvesting 1:
 *
 * ```
 * melvorD:Firemaking   all 33 dropped: 29 mastery-locked, 0 level-locked, 1 realm-locked, 3 unaffordable
 * melvorD:Herblore     all 72 dropped: 71 mastery-locked, 0 level-locked, 0 realm-locked, 1 unaffordable
 * melvorItA:Harvesting all  7 dropped:  5 mastery-locked, 0 level-locked, 2 realm-locked, 0 unaffordable
 * ```
 *
 * `0 level-locked` is structurally impossible to beat: the loop asked the
 * mastery gate first and only fell back to the level requirement when the gate
 * was not answering the question at all, so for every skill that *does* have
 * mastery the level counter could never leave zero. Checked against the
 * knowledge dump, the 29 Firemaking refusals are 17 logs from Teak (35) to
 * Carrion (120) and 12 Abyssal-realm logs; the 71 Herblore refusals are the 70
 * potions above level 1 plus one Abyssal potion. Nothing was dropped that
 * should have been offered -- the three level-unlocked logs really are
 * unaffordable, because the bank holds 125 Yew Logs and no log a level-32
 * character may burn -- so the recipes were right and only the heading lied.
 *
 * The heading is not cosmetic. `reportSilentSkill` prints at all only when
 * `mastery` or `realm` is non-zero, on the stated grounds that
 * `readLockedActions` and `readUnstockedSkills` already carry level and stock;
 * so a level block filed as mastery both names the wrong cause and keeps a line
 * alive that the module had decided not to print. And "mastery-locked" sends
 * the planner hunting for mastery XP when the answer is a level or a realm --
 * the same class of misdirection as the Alt Magic `false` that meant "this
 * skill has no mastery system" and was read as "this action is locked".
 *
 * The real readers are driven here. A mirror of the classification would agree
 * with itself and pass, which is exactly what it must not do: the bug was in
 * which check ran first, not in what any one check returns.
 */
let uninstall = (): void => {};

beforeEach(() => {
  resetAdapterFailures();
});

afterEach(() => {
  uninstall();
  resetAdapterFailures();
});

const MELVOR = { id: 'melvorD:Melvor', isUnlocked: true };
const ABYSSAL = { id: 'melvorItA:Abyssal', isUnlocked: false };
const ETERNAL = { id: 'melvorItA:Eternal', isUnlocked: false };

const FIREMAKING_ID = 'melvorD:Firemaking';
const HARVESTING_ID = 'melvorItA:Harvesting';

/**
 * A log, in the shape `candidates.ts` reads.
 *
 * `itemCosts` rather than `log`, because both reach the same branch of
 * `canAfford` and only one of them is declared on `RecipeLike`.
 */
function log(
  id: string,
  level: number,
  realm: { id: string; isUnlocked: boolean },
  extra: { abyssalLevel?: number } = {},
) {
  const item = { id: `${id}_item`, name: id };
  return {
    id,
    name: id,
    level,
    baseExperience: 20,
    recipeInterval: 2_000,
    realm,
    itemCosts: [{ item, quantity: 1 }],
    ...extra,
  };
}

/** Firemaking as the live board has it: 32, and nothing burnable banked. */
const NORMAL = log('Normal_Logs', 1, MELVOR);
const OAK = log('Oak_Logs', 10, MELVOR);
const WILLOW = log('Willow_Logs', 25, MELVOR);
const TEAK = log('Teak_Logs', 35, MELVOR);
const MAPLE = log('Maple_Logs', 45, MELVOR);
/** Abyssal content gates on `abyssalLevel`; the standard `level` reads 99. */
const ABYSSIA = log('Abyssia_Logs', 99, ABYSSAL, { abyssalLevel: 1 });
/** Eternal-realm content, gated on neither track: `level` and `abyssalLevel` 0. */
const RIFTWOOD = log('Riftwood_Logs', 0, ETERNAL);

const FIREMAKING_LOGS = [NORMAL, OAK, WILLOW, TEAK, MAPLE, ABYSSIA, RIFTWOOD];

/**
 * A vein, as Harvesting declares them: every requirement on the abyssal track.
 *
 * Dump: all seven veins carry `level: 0`, six sit in `melvorItA:Abyssal` with
 * an `abyssalLevel` from 1 to 55, and Rift Vein sits in `melvorItA:Eternal`
 * with no requirement at all. None of them consumes anything.
 */
function vein(id: string, abyssalLevel: number, realm: { id: string; isUnlocked: boolean }) {
  return { id, name: id, level: 0, baseExperience: 50, recipeInterval: 3_000, realm, abyssalLevel };
}

const ABYSSAL_VEIN = vein('Abyssal_Vein', 1, ABYSSAL);
const TWISTED_VEIN = vein('Twisted_Vein', 11, ABYSSAL);
const RIFT_VEIN = vein('Rift_Vein', 0, ETERNAL);

/**
 * The mastery gate as every non-Alt-Magic skill in this loop answers it.
 *
 * The typings declare `isMasteryActionUnlocked` (skill.d.ts:806, abstract) and
 * decline to state what it returns, so this is pinned from live behaviour
 * rather than assumed: the counts above match, recipe for recipe, a gate that
 * refuses exactly what the character lacks the level or the realm for.
 */
function gateOn(refused: readonly { id: string }[]) {
  return (action: { id: string }) => !refused.some((recipe) => recipe.id === action.id);
}

function installSkills(skills: Record<string, unknown>, held: Record<string, number> = {}): void {
  uninstall = installFakeGame({
    gp: { id: 'melvorD:GP' },
    bank: { getQty: (item: { id: string }) => held[item.id] ?? 0 },
    activeAction: undefined,
    skills: { getObjectByID: (id: string) => skills[id] },
  });
}

function installFiremaking(overrides: Record<string, unknown> = {}): void {
  installSkills(
    {
      [FIREMAKING_ID]: {
        id: FIREMAKING_ID,
        name: 'Firemaking',
        level: 32,
        abyssalLevel: 1,
        hasMastery: true,
        actions: { allObjects: FIREMAKING_LOGS },
        isMasteryActionUnlocked: gateOn([TEAK, MAPLE, ABYSSIA]),
        ...overrides,
      },
    },
    // 125 Yew Logs and nothing else, exactly as the live bank reports. Yew is a
    // level-60 burn, so no log the character may burn is in stock.
    { Yew_Logs_item: 125 },
  );
}

/** What `reportSilentSkill` last said about a skill, or undefined. */
function tally(skillId: string): string | undefined {
  return readAdapterFailures().find(
    (failure) => failure.site === `candidates.noCandidates:${skillId}`,
  )?.lastError;
}

describe('a dropped recipe is counted under the reason that actually stopped it', () => {
  it('reports level-locked recipes as level-locked, not as mastery-locked', () => {
    installFiremaking();

    readGatherCandidates();

    // Teak (35) and Maple (45) against a level of 32. Before this, both were
    // filed as mastery and the level counter read 0 for every skill with a
    // mastery system -- which is every skill in this loop except Alt Magic.
    expect(tally(FIREMAKING_ID)).toBe(
      'all 7 recipe(s) dropped: 0 mastery-locked, 2 level-locked, 2 realm-locked, 3 unaffordable',
    );
  });

  it('keeps mastery for the refusals neither realm nor level explains', () => {
    // The residual, and the only thing "mastery-locked" may now mean: the gate
    // refused a recipe in an open realm at a level the character has. Blinding
    // the counter entirely would be the opposite error -- this line exists
    // because the mastery gate can empty a whole skill on its own.
    installFiremaking({ isMasteryActionUnlocked: gateOn([TEAK, MAPLE, ABYSSIA, WILLOW]) });

    readGatherCandidates();

    expect(tally(FIREMAKING_ID)).toBe(
      'all 7 recipe(s) dropped: 1 mastery-locked, 2 level-locked, 2 realm-locked, 2 unaffordable',
    );
  });

  it('leaves the gate deciding, so our level reading can only relabel', () => {
    // Label-only, and it has to stay label-only. `isMasteryActionUnlocked` is
    // declared abstract (skill.d.ts:806) with no statement of what it returns,
    // so promoting our own `recipe.level` comparison to a gate would drop a
    // recipe the game had unlocked by some route we cannot see -- a missing
    // candidate traded for a tidier tally.
    //
    // A gate that admits everything therefore admits Teak and Maple too,
    // level 32 or not, and they fall to the affordability check like the rest.
    // Nothing here is level-locked because nothing was refused for level.
    installFiremaking({ isMasteryActionUnlocked: () => true });

    readGatherCandidates();

    expect(tally(FIREMAKING_ID)).toBe(
      'all 7 recipe(s) dropped: 0 mastery-locked, 0 level-locked, 2 realm-locked, 5 unaffordable',
    );
  });

  it('offers a recipe the bank can pay for, so the gate is not simply refusing everything', () => {
    installSkills(
      {
        [FIREMAKING_ID]: {
          id: FIREMAKING_ID,
          name: 'Firemaking',
          level: 32,
          abyssalLevel: 1,
          hasMastery: true,
          actions: { allObjects: FIREMAKING_LOGS },
          isMasteryActionUnlocked: gateOn([TEAK, MAPLE, ABYSSIA]),
        },
      },
      { Oak_Logs_item: 400 },
    );

    const offered = readGatherCandidates().filter(
      (candidate) => (candidate.params as { skillId?: string }).skillId === FIREMAKING_ID,
    );

    expect(
      offered.map((candidate) => (candidate.params as { recipeId?: string }).recipeId),
    ).toEqual(['Oak_Logs']);
    expect(tally(FIREMAKING_ID)).toBeUndefined();
  });
});

describe('a realm-locked skill is not described as a stock or level problem', () => {
  function installHarvesting(): void {
    installSkills({
      [HARVESTING_ID]: {
        id: HARVESTING_ID,
        name: 'Harvesting',
        level: 1,
        abyssalLevel: 1,
        hasMastery: true,
        actions: { allObjects: [ABYSSAL_VEIN, TWISTED_VEIN, RIFT_VEIN] },
        isMasteryActionUnlocked: gateOn([TWISTED_VEIN]),
      },
    });
  }

  it('attributes every vein to its realm', () => {
    installHarvesting();

    readGatherCandidates();

    // Live this read "5 mastery-locked, 2 realm-locked" for the seven real
    // veins, which is the reading that would have the planner grinding
    // Harvesting mastery for a realm that opens on "Complete Into the Abyss x1".
    expect(tally(HARVESTING_ID)).toBe(
      'all 3 recipe(s) dropped: 0 mastery-locked, 0 level-locked, 3 realm-locked, 0 unaffordable',
    );
  });

  it('does not tell the planner to go and buy materials for it', () => {
    installHarvesting();

    // `readUnstockedSkills` filtered on `recipe.level <= skill.level`, and every
    // vein reads `level: 0` because its real requirement lives on the abyssal
    // track. So an entire realm-locked skill was announced as "nothing it can
    // make is in stock" -- a shopping list for veins that consume nothing, in a
    // realm the character cannot enter.
    expect(readUnstockedSkills().map((entry) => entry.label)).toEqual([]);
  });

  it('does not offer a locked realm as a level to grind toward', () => {
    installHarvesting();

    expect(readLockedActions().map((entry) => entry.label)).toEqual([]);
  });
});

describe('the locked list names the requirement the recipe is actually gated on', () => {
  it('names the nearest reachable level and skips locked realms', () => {
    installFiremaking();

    // Teak at 35, not Abyssia's nominal `level: 99` and not Riftwood's 0.
    expect(readLockedActions().map((entry) => entry.label)).toEqual([
      'Firemaking: Teak_Logs unlocks at level 35 (currently 32)',
    ]);
  });
});

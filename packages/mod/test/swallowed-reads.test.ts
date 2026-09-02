import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBlockedOpportunities, readGatherCandidates } from '../src/adapter/candidates.js';
import { readAdapterFailures, resetAdapterFailures } from '../src/adapter/safe.js';
import { installFakeGame } from './fixtures.js';

/**
 * The five sites a live session reported, driven through the real readers.
 *
 * `adapterFailures` is read to answer one question -- which accessor stopped
 * working -- and it had five standing entries that were not accessors stopping
 * working:
 *
 * ```
 * candidates.share1                              x1104
 * candidates.skillInterval:melvorD:Cooking         x138
 * candidates.skillInterval:melvorD:Agility         x138
 * candidates.blockedInterval:melvorD:Woodcutting    x46
 * candidates.blockedInterval:melvorD:Fishing        x46
 * ```
 *
 * Four of them described skills that were pricing every recipe correctly, and
 * the fifth described a read that has never once succeeded and never will. Both
 * shapes cost the same thing: a real regression arrives as a sixth line under a
 * thousand lines of noise, in the one report whose purpose is to make it
 * visible.
 *
 * So the assertions here are about the *report*, not only about the numbers.
 * The real `readGatherCandidates` and `readBlockedOpportunities` are driven --
 * a mirror of the resolution order could not have caught the ordering bug,
 * since the bug was which source got asked first.
 */
let uninstall = (): void => {};

beforeEach(() => {
  resetAdapterFailures();
});

afterEach(() => {
  uninstall();
  resetAdapterFailures();
});

/** Every site currently reporting, so an assertion can name a prefix. */
const sites = (): string[] => readAdapterFailures().map((failure) => failure.site);

const countAt = (site: string): number =>
  readAdapterFailures().find((failure) => failure.site === site)?.count ?? 0;

// --- Mining gems -----------------------------------------------------------

/** The message `Mining.activeRock` (rockTicking.d.ts:133) throws with nothing selected. */
const NO_ROCK_SELECTED = 'Tried to get active rock data, but none is selected.';

const GP = { id: 'melvorD:GP' };

/**
 * A gem-bearing rock, and a Mining that refuses to price its gem roll.
 *
 * `getRockGemChance` (rockTicking.d.ts:157) takes the rock as an argument and
 * still consults the selection, so it throws in exactly the state candidate
 * enumeration runs in. That is not a stub being pessimistic: it is the only
 * behaviour this call has ever exhibited in a live session.
 */
function installMining(rockCount: number): void {
  const rocks = Array.from({ length: rockCount }, (_, index) => ({
    id: `melvorD:Rock_${index}`,
    name: `Rock ${index}`,
    level: 1,
    baseExperience: 10,
    baseQuantity: 1,
    baseRespawnInterval: 0,
    giveGems: true,
    giveSuperiorGems: false,
    product: { id: `melvorD:Ore_${index}`, sellsFor: { currency: GP, quantity: 20 } },
  }));

  uninstall = installFakeGame({
    gp: GP,
    mining: {
      id: 'melvorD:Mining',
      name: 'Mining',
      baseInterval: 3_000,
      chanceToDoubleGems: 0,
      actions: { allObjects: rocks },
      canMineOre: () => true,
      getRockMaxHP: () => 5,
      getRockGemChance: () => {
        throw new Error(NO_ROCK_SELECTED);
      },
      getRockSuperiorGemChance: () => 0,
    },
    randomGemTable: { getAverageDropValue: () => new Map([[GP, 400]]) },
    randomSuperiorGemTable: { getAverageDropValue: () => new Map([[GP, 4_000]]) },
  });
}

describe('an unpriceable gem roll reads as unknown, and reports once per pass', () => {
  it('says the gem value is unknown rather than pricing it at zero', () => {
    // The whole point of the fix. A rock whose value is mostly its gem chance
    // was indistinguishable on the board from one that yields no gems at all,
    // because both contributed exactly 0 extra GP and neither said why.
    installMining(1);

    const mining = readGatherCandidates().filter((candidate) =>
      candidate.label.startsWith('Mining:'),
    );

    expect(mining).toHaveLength(1);
    expect(mining[0]?.label).toContain('gem value unknown, not zero');
    expect(mining[0]?.label).toContain('prices the ore only');
  });

  it('reports the refusal once for the pass, not once per rock', () => {
    // `candidates.share1 x1104` was 138 passes times 8 gem-bearing rocks. The
    // count still has to move -- a silent fallback is what `safe.ts` exists to
    // prevent -- but eight identical entries per pass say nothing the first
    // does not, and they bury every other site under themselves.
    installMining(8);
    readGatherCandidates();

    expect(countAt('candidates.rockGemChance')).toBe(1);
    expect(sites()).not.toContain('candidates.share1');
  });

  it('still counts one pass per pass, so a persistent refusal accumulates', () => {
    // Once per pass, not once ever: a read that stopped working must keep
    // showing up, or the report answers "what broke" and not "what is broken".
    installMining(3);
    readGatherCandidates();
    readGatherCandidates();

    expect(countAt('candidates.rockGemChance')).toBe(2);
  });

  it('names how many rocks the single report covers', () => {
    installMining(8);
    readGatherCandidates();

    expect(readAdapterFailures().find((f) => f.site === 'candidates.rockGemChance')?.lastError) //
      .toContain('8 gem-bearing rock(s)');
  });
});

// --- Per-recipe intervals --------------------------------------------------

/** Throws the way an `actionInterval` getter does while nothing is selected. */
const noSelection = (): never => {
  throw new Error('Tried to access active recipe, but none is selected.');
};

/**
 * The four skills that reported an interval failure while pricing correctly.
 *
 * Each is shaped the way the typings say it is: no skill-wide interval to
 * report, and a per-recipe getter that answers fine.
 *
 * - Cooking: `actionInterval` (cooking.d.ts:71) throws, `baseInterval` is on
 *   `CookingRecipe` (:15), `getRecipeCookingInterval` (:100) answers.
 * - Agility: `actionInterval` (agility.d.ts:194) throws, `baseInterval` is on
 *   `AgilityObstacle` (:77), `getObstacleInterval` (:223) answers.
 * - Woodcutting: `actionInterval` (woodcutting.d.ts:86) throws, `baseInterval`
 *   is on `WoodcuttingTree` (:46), `getTreeInterval` (:76) answers.
 * - Fishing: `actionInterval` (fishing.d.ts:100) throws, `Fish` carries a
 *   min/max pair (:13-14), and `getMinFishInterval`/`getMaxFishInterval`
 *   (:128, :130) answer.
 */
function installSkills(): void {
  const recipe = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: id,
    level: 1,
    baseExperience: 10,
    baseInterval: 2_000,
    ...extra,
  });

  const skill = (id: string, accessors: Record<string, unknown>, extraRecipes: object[] = []) => ({
    id,
    name: id,
    level: 99,
    actions: { allObjects: [recipe(`${id}_Action`), ...extraRecipes] },
    get actionInterval(): number {
      return noSelection();
    },
    ...accessors,
  });

  // One recipe Cooking can make and one it cannot, so a single fixture drives
  // both paths: the affordable one becomes a candidate, the other a blocked
  // entry whose XP/hr is the thing the nominal interval was getting wrong.
  const blockedCook = recipe('melvorD:Cooking_Blocked', {
    itemCosts: [{ item: { id: 'melvorD:Raw_Shrimp', name: 'Raw Shrimp' }, quantity: 5 }],
  });

  const registry = new Map<string, unknown>([
    [
      'melvorD:Cooking',
      skill('melvorD:Cooking', { getRecipeCookingInterval: () => 1_800 }, [blockedCook]),
    ],
    ['melvorD:Agility', skill('melvorD:Agility', { getObstacleInterval: () => 5_000 })],
    ['melvorD:Woodcutting', skill('melvorD:Woodcutting', { getTreeInterval: () => 4_000 })],
    [
      'melvorD:Fishing',
      skill('melvorD:Fishing', {
        getMinFishInterval: () => 4_000,
        getMaxFishInterval: () => 8_000,
      }),
    ],
  ]);

  uninstall = installFakeGame({
    gp: GP,
    bank: { getQty: () => 0 },
    // An empty course, so the lap-rate reader answers "no lap" rather than
    // throwing into a site this test would then have to explain.
    agility: { activeCourse: { builtObstacles: new Map() } },
    skills: { getObjectByID: (id: string) => registry.get(id) },
  });
}

describe('a skill that prices its recipes individually files no failure', () => {
  it('reports nothing for Cooking or Agility on the candidate path', () => {
    // Both have a per-recipe getter that answers for every recipe, and neither
    // has a skill-wide interval to fall back on. The old order asked for the
    // fallback first and reported its absence, so two working skills filed a
    // failure apiece on every pass -- 276 entries describing skills being
    // shaped the way they are shaped.
    installSkills();
    const candidates = readGatherCandidates();

    // Not vacuous: Cooking really did reach the interval read. The candidate
    // path resolves the interval *after* the affordability check, so a fixture
    // whose recipes were all unaffordable would assert nothing at all.
    expect(candidates.some((entry) => entry.label.startsWith('melvorD:Cooking:'))).toBe(true);
    expect(candidates.some((entry) => entry.label.startsWith('melvorD:Agility:'))).toBe(true);
    expect(sites().filter((site) => site.startsWith('candidates.skillInterval:'))).toEqual([]);
  });

  it('reports nothing for Woodcutting or Fishing on the blocked path', () => {
    // These two never reached the mastery table at all: the blocked loop asked
    // each skill for one interval covering every recipe, which is a question
    // neither can answer.
    installSkills();
    readBlockedOpportunities();

    expect(sites().filter((site) => site.startsWith('candidates.blockedInterval:'))).toEqual([]);
  });

  it('prices a blocked entry at the recipe interval, not the nominal three seconds', () => {
    // The report was only half of it. A flat 3s made every blocked entry's
    // XP/hr a restatement of its base XP, and the blocked list is *sorted* by
    // XP/hr -- so the ranking was wrong in the same direction for every skill
    // whose interval lives on the recipe.
    installSkills();
    const blocked = readBlockedOpportunities().find((entry) =>
      entry.label.startsWith('melvorD:Cooking:'),
    );

    // 1,800ms per cook at 10 XP is 20,000 XP/h; the nominal 3s said 12,000.
    expect(blocked).toBeDefined();
    expect(blocked?.xpPerHour).toBeCloseTo(20_000, 5);
  });
});

describe('an interval nothing can report is still recorded', () => {
  it('records the blocked path when a per-recipe getter is lost', () => {
    // Proves the blocked-path assertion above is not vacuous. Woodcutting has
    // no skill-wide interval at all, so losing `getTreeInterval` leaves nothing
    // between the reader and the nominal constant -- and that is the event the
    // site was named for in the first place.
    installSkills();
    const registry = (
      globalThis as { game?: { skills: { getObjectByID: (id: string) => unknown } } }
    ).game;
    const woodcutting = registry?.skills.getObjectByID('melvorD:Woodcutting') as {
      getTreeInterval: () => number;
    };
    woodcutting.getTreeInterval = () => {
      throw new Error('accessor renamed');
    };

    readBlockedOpportunities();

    expect(countAt('candidates.blockedInterval:melvorD:Woodcutting')).toBeGreaterThan(0);
  });

  it('records once when neither the recipe nor the skill answers', () => {
    // The counter must not have been traded away for quiet. A skill that has
    // genuinely lost its accessor reports exactly as before.
    uninstall = installFakeGame({
      gp: GP,
      skills: {
        getObjectByID: (id: string) =>
          id === 'melvorD:Cooking'
            ? {
                id,
                name: id,
                level: 99,
                actions: { allObjects: [{ id: 'x', name: 'x', level: 1, baseExperience: 10 }] },
                get actionInterval(): number {
                  return noSelection();
                },
                getRecipeCookingInterval: () => {
                  throw new Error('accessor renamed');
                },
              }
            : undefined,
      },
    });

    readGatherCandidates();

    expect(countAt('candidates.skillInterval:melvorD:Cooking')).toBe(1);
  });
});

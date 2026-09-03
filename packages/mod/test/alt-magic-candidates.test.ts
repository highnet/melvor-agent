import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readBlockedOpportunities, readGatherCandidates } from '../src/adapter/candidates.js';
import { readAdapterFailures, resetAdapterFailures } from '../src/adapter/safe.js';
import { installFakeGame } from './fixtures.js';

/**
 * Alt Magic produced zero candidates at any level, with every rune in the bank.
 *
 * Hand-issuing the objective worked: `set_objective` on `melvorF:JustLearning`
 * cast fine and took Magic from 2 to 10 in six minutes. `list_candidates`
 * meanwhile returned nothing for the skill -- not available, not blocked, no
 * adapter-failure line, nothing thrown. The skill simply was not there.
 *
 * The gate was `isMasteryActionUnlocked`. `AltMagic` overrides it
 * (altMagic.d.ts:109) alongside `hasMastery` (:102),
 * `computeTotalMasteryActions` (:107) and `updateTotalUnlockedMasteryActions`
 * (:108), and its answer for a spell is not "this spell is locked" -- but the
 * enumerator read `=== false` as locked and `continue`d without a word.
 *
 * The real `readGatherCandidates` and `readBlockedOpportunities` are driven
 * here rather than a mirror of the predicate, because the bug was about *which
 * filter ran and what it did next*. A mirror of the gate would have agreed with
 * itself and passed.
 */
let uninstall = (): void => {};

beforeEach(() => {
  resetAdapterFailures();
});

afterEach(() => {
  uninstall();
  resetAdapterFailures();
});

const GP = { id: 'melvorD:GP' };

const AIR_RUNE = { id: 'melvorD:Air_Rune', name: 'Air Rune' };
const NATURE_RUNE = { id: 'melvorD:Nature_Rune', name: 'Nature Rune' };

/** `Just Learning`: level 1, two runes a cast, no item to convert. */
const JUST_LEARNING = {
  id: 'melvorF:JustLearning',
  name: 'Just Learning',
  level: 1,
  baseExperience: 10,
  runesRequired: [
    { item: AIR_RUNE, quantity: 2 },
    { item: NATURE_RUNE, quantity: 1 },
  ],
  specialCost: { quantity: 0 },
};

/** A spell well above the character's Magic level, to prove the gate is replaced. */
const BONE_OFFERING = {
  id: 'melvorF:BoneOffering',
  name: 'Bone Offering',
  level: 18,
  baseExperience: 30,
  runesRequired: [{ item: NATURE_RUNE, quantity: 1 }],
  specialCost: { quantity: 0 },
};

/**
 * Alt Magic as the game presents it, plus a bank the test controls.
 *
 * `hasMastery` and `isMasteryActionUnlocked` are stubbed the way a skill with
 * no mastery answers: false to everything. The typings state that AltMagic
 * overrides both and decline to state what they return, so the fixture pins the
 * behaviour that reproduces the live symptom -- 26 spells in, nothing out.
 */
function installAltMagic(
  held: Record<string, number>,
  overrides: Record<string, unknown> = {},
  player: { useCombinationRunes: boolean } = { useCombinationRunes: false },
): void {
  const magic = {
    id: 'melvorD:Magic',
    name: 'Magic',
    level: 10,
    abyssalLevel: 1,
    baseInterval: 2_000,
    hasMastery: false,
    actions: { allObjects: [JUST_LEARNING, BONE_OFFERING] },
    isMasteryActionUnlocked: () => false,
    ...overrides,
  };

  uninstall = installFakeGame({
    gp: GP,
    bank: { getQty: (item: { id: string }) => held[item.id] ?? 0 },
    combat: { player },
    skills: { getObjectByID: (id: string) => (id === 'melvorD:Magic' ? magic : undefined) },
  });
}

/** Every failure site currently reporting. */
const sites = (): string[] => readAdapterFailures().map((failure) => failure.site);

const magicCandidates = () =>
  readGatherCandidates().filter(
    (candidate) => (candidate.params as { skillId?: string }).skillId === 'melvorD:Magic',
  );

describe('a skill whose mastery answer is not a lock still reaches the board', () => {
  it('offers a spell the character holds the runes for', () => {
    installAltMagic({ 'melvorD:Air_Rune': 1_793, 'melvorD:Nature_Rune': 400 });

    const offered = magicCandidates();

    expect(offered.map((candidate) => candidate.params)).toContainEqual({
      kind: 'gather_resource',
      skillId: 'melvorD:Magic',
      recipeId: 'melvorF:JustLearning',
    });
    // 2s a cast at 10 XP is 18,000 XP/h; the skill's own baseInterval, not a
    // nominal constant.
    expect(offered[0]?.xpPerHour).toBeCloseTo(18_000, 5);
  });

  it('still refuses a spell above the character level', () => {
    // The mastery answer *was* the level check for every other skill in this
    // loop, so dropping it without a replacement would have offered every spell
    // in the book at Magic 1. Bone Offering needs 18 against a level of 10.
    installAltMagic({ 'melvorD:Air_Rune': 1_793, 'melvorD:Nature_Rune': 400 });

    const labels = magicCandidates().map((candidate) => candidate.label);

    expect(labels.some((label) => label.includes('Bone Offering'))).toBe(false);
    expect(labels.some((label) => label.includes('Magic: Just Learning'))).toBe(true);
  });

  it('keeps consulting mastery for a skill that genuinely has it', () => {
    // The fix must not blind the gate. A skill reporting mastery, with some
    // actions unlocked and some not, is answering the question it was asked.
    installAltMagic(
      { 'melvorD:Air_Rune': 1_793, 'melvorD:Nature_Rune': 400 },
      {
        hasMastery: true,
        isMasteryActionUnlocked: (action: { id: string }) => action.id === 'melvorF:BoneOffering',
      },
    );

    expect(magicCandidates().map((candidate) => candidate.params)).toEqual([
      {
        kind: 'gather_resource',
        skillId: 'melvorD:Magic',
        recipeId: 'melvorF:BoneOffering',
      },
    ]);
  });
});

describe('rune costs are priced, so a spell is never offered unpayable', () => {
  it('withholds a spell whose runes are absent', () => {
    // Nothing read `runesRequired` before this: AltMagic declares no
    // `getRecipeCosts` and a spell has no `itemCosts`, so every spell fell
    // through the affordability check as free. Offered, cast once, stopped.
    installAltMagic({ 'melvorD:Air_Rune': 1_793, 'melvorD:Nature_Rune': 0 });

    expect(magicCandidates()).toEqual([]);
  });

  it('withholds a spell short of one of several runes', () => {
    installAltMagic({ 'melvorD:Air_Rune': 1, 'melvorD:Nature_Rune': 400 });

    expect(magicCandidates()).toEqual([]);
  });

  it('states which rune is missing rather than dropping the skill', () => {
    // The whole point. A withheld candidate with no stated reason is the same
    // silence one filter further along.
    installAltMagic({ 'melvorD:Air_Rune': 1_793, 'melvorD:Nature_Rune': 0 });

    const entry = readBlockedOpportunities().find((blocked) =>
      blocked.label.includes('Just Learning'),
    );

    expect(entry).toBeDefined();
    expect(entry?.missing).toEqual([
      { itemId: 'melvorD:Nature_Rune', name: 'Nature Rune', need: 1, have: 0 },
    ]);
  });

  it('prices the combination-rune list when the player uses combination runes', () => {
    // Holding the standard runes does not help in that mode, so the two lists
    // are alternatives rather than a union. `Player.useCombinationRunes`
    // (player.d.ts:122) is the switch; `runesRequiredAlt` (spells.d.ts:28) is
    // the list.
    const DUST_RUNE = { id: 'melvorD:Dust_Rune', name: 'Dust Rune' };
    installAltMagic(
      { 'melvorD:Air_Rune': 1_793, 'melvorD:Nature_Rune': 400, 'melvorD:Dust_Rune': 0 },
      {
        actions: {
          allObjects: [{ ...JUST_LEARNING, runesRequiredAlt: [{ item: DUST_RUNE, quantity: 1 }] }],
        },
      },
      { useCombinationRunes: true },
    );

    expect(magicCandidates()).toEqual([]);
  });
});

describe('a skill that vanishes entirely says so', () => {
  it('records a fallback naming why every recipe was dropped', () => {
    // The exact original failure, reproduced with the gate left on: a skill
    // that reports mastery, unlocks one action so the gate stays live, and
    // refuses the rest -- while the one it admits cannot be paid for. Before
    // this line the outcome was no candidate, no blocked entry, no failure
    // line, and a planner concluding the skill does not exist.
    installAltMagic(
      { 'melvorD:Air_Rune': 0, 'melvorD:Nature_Rune': 0 },
      {
        hasMastery: true,
        isMasteryActionUnlocked: (action: { id: string }) => action.id === 'melvorF:JustLearning',
      },
    );

    readGatherCandidates();

    expect(sites()).toContain('candidates.noCandidates:melvorD:Magic');
    expect(
      readAdapterFailures().find((f) => f.site === 'candidates.noCandidates:melvorD:Magic')
        ?.lastError,
    ).toContain('1 mastery-locked');
  });

  it('stays quiet about a skill that is merely unstocked or merely under-levelled', () => {
    // `readUnstockedSkills` and `readLockedActions` already tell the planner
    // both of those in the lists built for them. Filing them here as well would
    // put a permanent line per idle skill in the one report whose job is to
    // show what actually broke.
    installAltMagic({ 'melvorD:Air_Rune': 0, 'melvorD:Nature_Rune': 0 });

    readGatherCandidates();

    expect(magicCandidates()).toEqual([]);
    expect(sites()).not.toContain('candidates.noCandidates:melvorD:Magic');
  });
});

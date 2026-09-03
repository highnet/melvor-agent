import { describe, expect, it } from 'vitest';
import {
  MASTERY_HEADROOM_LEVEL,
  masteryIntervalFor,
  masteryNote,
  productYieldFor,
  xpMultiplierFor,
} from '../src/adapter/rates.js';
import type { RecipeLike } from '../src/adapter/recipes.js';
import { readAdapterFailures, resetAdapterFailures } from '../src/adapter/safe.js';

/**
 * Rates scale with mastery, so an instantaneous rate is a myopic way to choose
 * work that will run for hours.
 *
 * Mastery scales the things rates are built from: a rock yields more before it
 * empties, an interval shortens, a steal succeeds more often. An action sitting
 * mid-table today can be the best on the board after a sustained run, while one
 * already at 99 is as good as it will ever be. Comparing only current numbers
 * systematically favours whatever is already mastered and never commits long
 * enough to master anything else.
 *
 * Everything here drives the real functions. The versions this file used to
 * hold were restatements — a private `resolveInterval` that knew three skills
 * where the implementation knows nine, a private copy of the headroom constant,
 * and a `yieldFor` that omitted the success-chance term entirely. A restatement
 * cannot fail when the code changes, which makes it a test of the test.
 *
 * `AnySkill` stands in as a structural type: these readers only ever reach for
 * named accessors, and a stub carrying exactly the ones under test is a more
 * honest fixture than a whole fake skill.
 */
const skillWith = (id: string, accessors: Record<string, unknown> = {}): AnySkill =>
  ({ id, ...accessors }) as unknown as AnySkill;

/** The mining half of this story lives in `mining-respawn.test.ts`. */
describe('per-recipe mastery intervals across skills', () => {
  const recipe = { id: 'melvorD:Yew' };

  it('prefers the skill-specific getter over the flat interval', () => {
    expect(
      masteryIntervalFor(
        skillWith('melvorD:Woodcutting', { getTreeInterval: () => 9_000 }),
        recipe,
        12_000,
      ),
    ).toBe(9_000);
  });

  it('uses the getter for non-gathering skills too', () => {
    // Thieving success and speed both scale with mastery; pricing it at a flat
    // interval understates exactly the NPC the character has practised on.
    expect(
      masteryIntervalFor(
        skillWith('melvorD:Thieving', { getNPCInterval: () => 2_400 }),
        recipe,
        3_000,
      ),
    ).toBe(2_400);
  });

  it('takes the midpoint of the Fishing range', () => {
    // Fishing reports min and max rather than a figure. Pretending either end
    // is *the* interval biases every fishing rate in one direction.
    expect(
      masteryIntervalFor(
        skillWith('melvorD:Fishing', {
          getMinFishInterval: () => 4_000,
          getMaxFishInterval: () => 8_000,
        }),
        recipe,
        3_000,
      ),
    ).toBe(6_000);
  });

  it("reads Alt Magic's base interval, which is legible with no spell selected", () => {
    // `actionInterval` throws when no spell is chosen, which is the state
    // candidate enumeration runs in — so every spell was priced a third slow
    // against the generic 3s fallback.
    expect(masteryIntervalFor(skillWith('melvorD:Magic', { baseInterval: 2_000 }), recipe, 3_000)) //
      .toBe(2_000);
  });

  it('falls back when the skill has no per-action getter', () => {
    // Artisan skills share one interval across the whole skill, so the flat
    // value is already the mastery-modified one.
    expect(masteryIntervalFor(skillWith('melvorD:Smithing'), recipe, 2_000)).toBe(2_000);
  });

  it('falls back when the getter returns something unusable', () => {
    // A zero or NaN interval would divide into an infinite rate and put the
    // recipe at the top of the board.
    expect(
      masteryIntervalFor(
        skillWith('melvorD:Cooking', { getRecipeCookingInterval: () => 0 }),
        recipe,
        3_000,
      ),
    ).toBe(3_000);
    expect(
      masteryIntervalFor(
        skillWith('melvorD:Cooking', { getRecipeCookingInterval: () => Number.NaN }),
        recipe,
        3_000,
      ),
    ).toBe(3_000);
  });

  it('falls back when the getter throws', () => {
    expect(
      masteryIntervalFor(
        skillWith('melvorD:Woodcutting', {
          getTreeInterval: () => {
            throw new Error('accessor gone');
          },
        }),
        recipe,
        12_000,
      ),
    ).toBe(12_000);
  });
});

/**
 * Mastery headroom is flagged, never projected.
 *
 * The growth curve is not in the typings, and folding a guess at it into
 * `xpPerHour` would put a fabricated number where a measured one belongs —
 * the exact failure that had Crystal advertising an order of magnitude above
 * what it paid.
 */
describe('mastery headroom is flagged, not projected', () => {
  const note = (level: number): string =>
    masteryNote(skillWith('melvorD:Mining', { getMasteryLevel: () => level }), {
      id: 'melvorD:Copper_Ore',
    });

  it('flags an action with room to grow', () => {
    expect(note(1)).toMatch(/mastery 1\/99/);
    expect(note(20)).toMatch(/this rate improves with sustained use/);
  });

  it('stays quiet once the growth left is not worth flagging', () => {
    // Above the line the note would appear on nearly everything and stop
    // carrying information.
    expect(note(MASTERY_HEADROOM_LEVEL)).toBe('');
    expect(note(99)).toBe('');
  });

  it('stays quiet when mastery cannot be read at all', () => {
    // A skill without mastery must not silently read as "fully mastered", nor
    // claim headroom it has no evidence for.
    expect(note(0)).toBe('');
    expect(masteryNote(skillWith('melvorD:Mining'), { id: 'melvorD:Copper_Ore' })).toBe('');
  });
});

/**
 * Yield and XP scale with mastery too, and both come from the game's own
 * accessors rather than a multiplier assembled by this codebase.
 *
 * `modifyPrimaryProductQuantity` (skill.d.ts:455) is documented as returning
 * the modified product quantity, and `getXPModifier` (skill.d.ts:375) as a
 * percentage XP modifier. Reimplementing either would mean guessing how
 * mastery, gear, agility bonuses and pet effects combine.
 */
describe('yield and XP scale with mastery', () => {
  const recipe: RecipeLike = {
    id: 'melvorD:Yew',
    name: 'Yew Tree',
    level: 60,
    baseExperience: 175,
    product: { id: 'melvorD:Yew_Logs' },
  };

  it('uses the game-modified product quantity', () => {
    expect(
      productYieldFor(
        skillWith('melvorD:Woodcutting', {
          modifyPrimaryProductQuantity: (_i: object, q: number) => q * 2,
        }),
        recipe,
        1,
      ),
    ).toBe(2);
  });

  it('discounts the yield by the chance the action lands its product', () => {
    // A burnt cook and a junk catch cost the time and the inputs and produce
    // nothing. Both used to be priced as though every action landed.
    expect(
      productYieldFor(
        skillWith('melvorD:Cooking', { getRecipeSuccessChance: () => 70 }),
        recipe,
        1,
      ),
    ).toBeCloseTo(0.7, 5);
  });

  it('falls back to the base quantity when the accessor is absent', () => {
    // A skill without the accessor must not silently yield zero, which would
    // sort every one of its recipes off the bottom of the board.
    expect(productYieldFor(skillWith('melvorD:Smithing'), recipe, 3)).toBe(3);
  });

  it('falls back when the accessor returns something unusable', () => {
    expect(
      productYieldFor(
        skillWith('melvorD:Woodcutting', { modifyPrimaryProductQuantity: () => 0 }),
        recipe,
        2,
      ),
    ).toBe(2);
    expect(
      productYieldFor(
        skillWith('melvorD:Woodcutting', { modifyPrimaryProductQuantity: () => Number.NaN }),
        recipe,
        2,
      ),
    ).toBe(2);
  });

  it('turns a percentage XP modifier into a multiplier', () => {
    expect(xpMultiplierFor(skillWith('melvorD:Woodcutting', { getXPModifier: () => 0 }), recipe)) //
      .toBe(1);
    expect(
      xpMultiplierFor(skillWith('melvorD:Woodcutting', { getXPModifier: () => 15 }), recipe),
    ).toBeCloseTo(1.15, 5);
  });

  it('clamps a modifier that would zero or invert the rate', () => {
    // -100% would zero the rate and sort the recipe off the board; anything
    // worse would make it negative and sort it below unavailable work.
    expect(
      xpMultiplierFor(skillWith('melvorD:Woodcutting', { getXPModifier: () => -100 }), recipe),
    ).toBe(0);
    expect(
      xpMultiplierFor(skillWith('melvorD:Woodcutting', { getXPModifier: () => -250 }), recipe),
    ).toBe(0);
  });

  it('is neutral when the modifier cannot be read', () => {
    expect(xpMultiplierFor(skillWith('melvorD:Woodcutting'), recipe)).toBe(1);
    expect(
      xpMultiplierFor(
        skillWith('melvorD:Woodcutting', { getXPModifier: () => Number.NaN }),
        recipe,
      ),
    ).toBe(1);
  });
});

/**
 * The yield accessor is a sample, not a getter, and a rate built from one call
 * is a coin flip.
 *
 * Measured live: 37 consecutive planner reports, character mining Gold, nothing
 * else moving. Smithing Gold Bar alternated between exactly 212,400 and exactly
 * 468,000 GP/h; Mining Gold between 53,283 and 100,294; two values each, never
 * anything between, flipping independently per recipe while every `xp/h` on the
 * board stayed fixed. `modifyPrimaryProductQuantity` (skill.d.ts:476) rolls the
 * doubling internally, so `productYieldFor` was pricing an hour of work off one
 * throw of that die, and the planner re-ranked every skill against every other
 * one each time the die landed differently.
 *
 * These drive the real `productYieldFor` against accessors that roll, because
 * the whole bug is that the accessor rolls. A fixture returning a constant
 * cannot fail this way, which is why the tests above passed throughout.
 *
 * Every roll here comes from a script this file owns rather than from
 * `Math.random`. The first version of these tests did use `Math.random`, and it
 * failed about half of all runs: the implementation it was written against read
 * the *minimum* of eight samples as the un-doubled quantity, which is wrong
 * whenever all eight happen to double, and 200 draws of a one-in-390 event is
 * itself a coin flip. A probabilistic test cannot tell a defect from bad luck,
 * so a red run has to mean a defect. The scripts below make each case
 * reproducible, including the runs of identical samples that are exactly what
 * the estimator has to survive.
 */
describe('yield is an expectation, not a sample', () => {
  const goldBar: RecipeLike = {
    id: 'melvorD:Gold_Bar',
    name: 'Gold Bar',
    level: 40,
    baseExperience: 20,
    product: { id: 'melvorD:Gold_Bar' },
  };

  /**
   * Doubles exactly where `script` says to, cycling. `true` is a roll that
   * landed, which is the only thing `modifyPrimaryProductQuantity` hides.
   */
  const scriptedDoubler = (
    script: readonly boolean[],
    accessors: Record<string, unknown> = {},
  ): AnySkill => {
    let call = 0;
    return skillWith('melvorD:Smithing', {
      modifyPrimaryProductQuantity: (_i: object, q: number) =>
        script[call++ % script.length] === true ? q * 2 : q,
      ...accessors,
    });
  };

  /** Alternating heads and tails: the coin is fair and always shows both faces. */
  const ALTERNATING = [true, false] as const;

  it('returns the same number every call when the accessor rolls', () => {
    const skill = scriptedDoubler(ALTERNATING, { getDoublingChance: () => 50 });
    const readings = new Set(Array.from({ length: 200 }, () => productYieldFor(skill, goldBar, 1)));

    // One value, not two. This is the assertion the live swing violates.
    expect([...readings]).toEqual([1.5]);
  });

  it('survives a long run of identical samples', () => {
    // The regression that got this reverted. A minimum-of-N estimator reads a
    // run of doubled samples as the un-doubled quantity and reports twice the
    // truth -- a sample dressed as an estimate, which is the very defect this
    // function was written to remove. These runs are longer than any budget, so
    // nothing here can have seen the other face; the chance has to decide which
    // face it is looking at.
    const ALWAYS = new Array<boolean>(32).fill(true);
    const NEVER = new Array<boolean>(32).fill(false);

    // Doubles six times in ten, and every sample doubled: the doubled face.
    expect(
      productYieldFor(scriptedDoubler(ALWAYS, { getDoublingChance: () => 60 }), goldBar, 1),
    ).toBeCloseTo(1.6, 5);

    // Doubles one time in ten, and no sample doubled: the un-doubled face.
    expect(
      productYieldFor(scriptedDoubler(NEVER, { getDoublingChance: () => 10 }), goldBar, 1),
    ).toBeCloseTo(1.1, 5);
  });

  it('states the price of the one run it cannot read', () => {
    // Honesty about the residual rather than a claim of none. A run that
    // contradicts its own chance -- every sample doubled on a recipe that
    // doubles one time in ten -- is indistinguishable from a base quantity of
    // two that never doubled, and the estimator reads it as the latter. That is
    // a 2x misprice, the same size as the bug this replaces.
    //
    // The difference is the frequency, and it is bought deliberately: the
    // budget is set so a run this misleading turns up about once in a million
    // recipe-passes, against the every-other-pass of a single call. Six
    // consecutive doubles at a 10% chance is a one-in-a-million event; this
    // fixture simply performs it on demand.
    expect(
      productYieldFor(
        scriptedDoubler(new Array<boolean>(32).fill(true), { getDoublingChance: () => 10 }),
        goldBar,
        1,
      ),
    ).toBeCloseTo(2.2, 5);
  });

  it('prices the doubling at the chance, not at whether it landed', () => {
    // The alternating fixture's sample mean is 1.5x and its stated chance is
    // 1.25x, so an implementation that averaged would pass a test written
    // against the mean. It has to be the chance.
    expect(
      productYieldFor(scriptedDoubler(ALTERNATING, { getDoublingChance: () => 25 }), goldBar, 1),
    ) //
      .toBeCloseTo(1.25, 5);
    expect(
      productYieldFor(scriptedDoubler(ALTERNATING, { getDoublingChance: () => 25 }), goldBar, 4),
    ) //
      .toBeCloseTo(5, 5);
  });

  it('keeps the deterministic bonuses the accessor applies', () => {
    // Removing the coin flip must not remove anything else: a skill that adds a
    // flat bar per action still reports it. A zero chance is also the one case
    // with no coin to remove, so it costs a single call and is exact.
    expect(
      productYieldFor(
        skillWith('melvorD:Smithing', {
          modifyPrimaryProductQuantity: (_i: object, q: number) => q + 1,
          getDoublingChance: () => 0,
        }),
        goldBar,
        2,
      ),
    ).toBe(3);
  });

  it('averages, and names the site, when the chance getter refuses', () => {
    // Several per-action chance getters in this adapter consult the live
    // selection and throw during enumeration -- `Mining.getRockGemChance` has
    // never once succeeded. A doubling getter that does the same must not
    // silently strip the bonus: with no chance to divide out, the mean of the
    // samples is still unbiased, and the failure has to be countable rather
    // than invisible.
    resetAdapterFailures();
    const skill = scriptedDoubler(ALTERNATING, {
      getDoublingChance: () => {
        throw new Error('Tried to get active recipe data, but none is selected');
      },
    });

    expect(productYieldFor(skill, goldBar, 1)).toBeCloseTo(1.5, 5);
    expect(readAdapterFailures().map((failure) => failure.site)) //
      .toContain('candidates.doublingChance:melvorD:Smithing');
    resetAdapterFailures();
  });

  it('averages, and names the site, when the samples are not a doubling', () => {
    // Three halves is not twice one, so whatever this accessor is doing the
    // doubling model does not describe it. Guessing a base quantity from
    // evidence that contradicts the model is how the reverted version got its
    // 2x; the mean is unbiased whatever the shape, and the surprise is recorded
    // rather than absorbed.
    resetAdapterFailures();
    let call = 0;
    const skill = skillWith('melvorD:Smithing', {
      modifyPrimaryProductQuantity: (_i: object, q: number) => (call++ % 2 === 0 ? q * 1.5 : q),
      getDoublingChance: () => 50,
    });

    expect(productYieldFor(skill, goldBar, 1)).toBeCloseTo(1.25, 5);
    expect(readAdapterFailures().map((failure) => failure.site)) //
      .toContain('candidates.yieldShape:melvorD:Smithing');
    resetAdapterFailures();
  });

  it('still discounts the expectation by the chance the action lands', () => {
    // The two corrections compose: a recipe that lands seven times in ten and
    // doubles one time in five is worth 0.7 x 1.2.
    expect(
      productYieldFor(
        skillWith('melvorD:Cooking', {
          modifyPrimaryProductQuantity: (() => {
            let call = 0;
            return (_i: object, q: number) => (call++ % 2 === 0 ? q * 2 : q);
          })(),
          getDoublingChance: () => 20,
          getRecipeSuccessChance: () => 70,
        }),
        goldBar,
        1,
      ),
    ).toBeCloseTo(0.84, 5);
  });
});

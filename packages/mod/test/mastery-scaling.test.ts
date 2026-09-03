import { describe, expect, it } from 'vitest';
import {
  MASTERY_HEADROOM_LEVEL,
  masteryIntervalFor,
  masteryNote,
  productYieldFor,
  xpMultiplierFor,
} from '../src/adapter/candidates.js';
import type { RecipeLike } from '../src/adapter/recipes.js';

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

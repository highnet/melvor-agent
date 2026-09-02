import { describe, expect, it } from 'vitest';

/**
 * Two rates that cannot be computed honestly must say so, not guess.
 *
 * A passively regenerating rock is charged the bare interval, and a Harvesting
 * vein is charged no decay at all. Both are upper bounds and neither can be
 * corrected from the typings:
 *
 * - `Mining.regenRockHP` (rockTicking.d.ts:176) restores an unstated amount
 *   every `passiveRegenInterval` (:108). The obvious model -- one HP per
 *   interval -- was implemented and measured, and it came out 3.3x above the
 *   realised rate.
 * - A `HarvestingVein` decays through `reduceVeinIntensity()`
 *   (harvesting.d.ts:109) and each product has a `minIntensityPercent`
 *   (harvesting.d.ts:16) below which it stops dropping, but the decay per action
 *   is nowhere in the typings.
 *
 * So the label carries the uncertainty instead. Understating or flagging is
 * recoverable; overstating is what cost this project an afternoon on Crystal's
 * 120,000 GP/h.
 *
 * The predicates are mirrored here because the real ones read `game.*`.
 */

const HARVESTING_ID = 'melvorItA:Harvesting';

const passiveRegenNote = (rock: { hasPassiveRegen?: boolean }): string =>
  rock.hasPassiveRegen === true
    ? ' — rate unverified: this rock regenerates while mined and the HP restored per regen tick is not stated in the typings, so this is an upper bound'
    : '';

const veinDecayNote = (skillId: string): string =>
  skillId === HARVESTING_ID
    ? ' — rate unverified: a vein loses intensity as it is harvested and the decay per action is not stated in the typings, so this is an upper bound'
    : '';

describe('passive-regen rocks flag their uncertainty', () => {
  it('names the unverified rate on a regenerating rock', () => {
    const note = passiveRegenNote({ hasPassiveRegen: true });
    expect(note).toContain('rate unverified');
    expect(note).toContain('upper bound');
  });

  it('says nothing for a rock that depletes, whose respawn is already charged', () => {
    // Depleting rocks have an honest correction, so a warning here would be
    // noise -- and a note on everything carries no information.
    expect(passiveRegenNote({ hasPassiveRegen: false })).toBe('');
    expect(passiveRegenNote({})).toBe('');
  });
});

describe('harvesting flags its vein decay', () => {
  it('names the unverified rate on Harvesting', () => {
    const note = veinDecayNote(HARVESTING_ID);
    expect(note).toContain('rate unverified');
    expect(note).toContain('upper bound');
  });

  it('leaves every other skill alone', () => {
    expect(veinDecayNote('melvorD:Firemaking')).toBe('');
    expect(veinDecayNote('melvorD:Mining')).toBe('');
  });
});

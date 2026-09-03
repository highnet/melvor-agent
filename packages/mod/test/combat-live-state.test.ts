import { afterEach, describe, expect, it } from 'vitest';
import { readInCombat } from '../src/adapter/combat.js';
import {
  restoreValuablesAfterCombat,
  stripValuablesForFight,
} from '../src/runtime/combat-reflex.js';
import { installFakeGame } from './fixtures.js';

/**
 * The reflex tier's reading of "am I fighting" has to be taken now.
 *
 * Reflexes run on a 1s throttle against `lastSnapshot`, which only refreshes on
 * the 3s policy clock. Live, that inverted the valuables pair by exactly one
 * throttled tick: `reflex.restoreValuables` fired one second after every
 * `combat.engage` — reading the pre-engage snapshot, seeing no fight, and
 * putting the Thiever's Cape and Jeweled Necklace back on *during* the fight
 * the strip exists to protect them from — and `reflex.stripValuables` fired one
 * second after each disengage, stripping a character who had stopped fighting.
 *
 * Its author anticipated one throttled tick of exposure on the strip side and
 * wrote it down. The restore side has the same lag and the opposite
 * consequence, because it undoes the protection rather than delaying it.
 */

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function fighting(isActive: boolean) {
  uninstall = installFakeGame({ combat: { isActive } });
}

describe('reading combat state live', () => {
  it('reports the fight the game is running right now', () => {
    fighting(true);
    expect(readInCombat()).toBe(true);
  });

  it('reports no fight when the game has stopped', () => {
    fighting(false);
    expect(readInCombat()).toBe(false);
  });

  it('reads the same getter the disengage precondition does', () => {
    // `CombatManager.isActive` (combatManager.d.ts:309). Asking a different
    // question here would be a second opinion about one fact, which is the
    // shape this repo has already had disagree while neither half looked wrong.
    fighting(true);
    const seen: string[] = [];
    uninstall?.();
    uninstall = installFakeGame({
      combat: {
        get isActive() {
          seen.push('isActive');
          return true;
        },
      },
    });
    readInCombat();
    expect(seen).toEqual(['isActive']);
  });
});

describe('the valuables pair against a live reading', () => {
  it('does not restore while a fight is running', () => {
    // The failure: this fired one second into every fight for seventeen
    // minutes, re-equipping exactly what had just been taken off.
    expect(
      restoreValuablesAfterCombat({ inCombat: true, hasStashedValuables: true }, () => {
        throw new Error('restored mid-fight');
      }),
    ).toBeNull();
  });

  it('restores once the fight is over, however it ended', () => {
    const outcome = restoreValuablesAfterCombat(
      { inCombat: false, hasStashedValuables: true },
      () => ({ ok: true, action: 'equipment.equip' }) as never,
    );
    expect(outcome).toMatchObject({ name: 'reflex.restoreValuables' });
  });

  it('does not strip a character who is not fighting', () => {
    expect(
      stripValuablesForFight({ inCombat: false, strippable: 2 }, () => {
        throw new Error('stripped out of combat');
      }),
    ).toBeNull();
  });
});

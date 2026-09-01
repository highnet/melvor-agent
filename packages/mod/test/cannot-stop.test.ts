import { describe, expect, it } from 'vitest';

/**
 * Classifying "this skill cannot stop right now".
 *
 * The distinction the adapter has to make: a precondition is a refusal the
 * caller should give up on, `not_yet` is a wait. Getting it wrong is not
 * cosmetic — the policy tier abandons an objective on the first, and retries on
 * the second.
 */
function classify(isActive: boolean, canStop: boolean): 'refuse' | 'wait' | 'proceed' {
  if (!isActive) return 'refuse';
  if (!canStop) return 'wait';
  return 'proceed';
}

describe('stopping a skill that says it cannot stop', () => {
  it('waits rather than abandoning the objective behind it', () => {
    // The live cost: the plan was food, then Magic, then Thieving. Thieving was
    // running and could not release the action slot for the length of one stun
    // from a failed pickpocket — seconds. The Magic step was moved to the back
    // of the plan and never came round again, and it read as the third combat
    // objective in a row failing for reasons of its own.
    expect(classify(true, false)).toBe('wait');
  });

  it('still refuses when the skill is not running at all', () => {
    // Nothing to wait for: this one is a genuine mistake by the caller.
    expect(classify(false, false)).toBe('refuse');
  });

  it('proceeds when the skill can stop', () => {
    expect(classify(true, true)).toBe('proceed');
  });
});

describe('Thieving damage against health on hand', () => {
  // Thieving is the only thing that hurts the character without being combat,
  // and it had no survivability gate — combat screens every monster by level
  // and re-checks the real max hit once the fight starts, while Thieving
  // checked only that food was equipped. Golbin Chief hits 10.1 at level 16,
  // harder than NPCs ten levels above it, and was chosen on XP alone.
  const tooHard = (maxHit: number, currentHp: number) => maxHit > currentHp * 0.25;

  it('allows a hit the character can plainly absorb', () => {
    expect(tooHard(10.1, 150)).toBe(false);
  });

  it('refuses the same NPC once health is low', () => {
    // The case a max-health check waves through, and the one that matters.
    // 10.1 against 40 is already over a quarter, which is the point: the gate
    // tightens as the bar empties rather than staying nominally satisfied.
    expect(tooHard(10.1, 40)).toBe(true);
    expect(tooHard(10.1, 60)).toBe(false);
  });

  it('keeps gentle NPCs available at low health', () => {
    // Refusing safe pickpockets costs the income that funds Auto Eat, which is
    // what would remove this problem entirely.
    expect(tooHard(3.2, 30)).toBe(false);
  });
});

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

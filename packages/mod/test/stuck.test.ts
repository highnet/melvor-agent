import { describe, expect, it } from 'vitest';
import { describeStuckAttention } from '../src/runtime/stuck.js';

/**
 * What the stall report says it watched.
 *
 * The operator saw "no total level or GP movement for 22min" while Woodcutting
 * earned 34,560 xp/h, and replied "this warning seems wrong". It was: the
 * detector compared total level and GP, and Woodcutting was level 60 where one
 * level costs about three hours. Twenty-two minutes without a total level is
 * the normal condition of working a high skill.
 */
describe('naming the measure in a stall report', () => {
  it('names the counter it actually watched', () => {
    const message = describeStuckAttention(4, 22 * 60_000, 'Cut 300 Yew Logs', 'Woodcutting xp');

    expect(message).toContain('Woodcutting xp has not moved for 22min');
    expect(message).not.toContain('total level or GP');
  });

  it('falls back to naming both coarse measures when there is no counter', () => {
    // A one-shot objective has no counter by design, and then total level and
    // GP genuinely are what is being watched — so saying so is honest.
    const message = describeStuckAttention(4, 20 * 60_000, 'Buy a bank slot', null);

    expect(message).toContain('progress has not moved');
  });
});

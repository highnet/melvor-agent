import { describe, expect, it } from 'vitest';

/**
 * Woodcutting cuts as many trees as the character has paid to cut.
 *
 * `treeCutLimit` is a real purchasable capability -- Multi-Tree is a shop
 * upgrade, and the uncapped upgrade reflex will buy it -- but the executor only
 * ever cleared the selection to make room for its target, so extra slots stayed
 * empty however many had been earned. Meanwhile the candidate priced a single
 * tree, understating Woodcutting by exactly the multiple that had been bought.
 *
 * Both halves matter and neither works alone: filling the slots without
 * repricing hides the gain, and repricing without filling them advertises a
 * rate the executor will not deliver -- which is the class of error this
 * project keeps paying for.
 */
const slotsToFill = (limit: number, active: string[], primary: string): number =>
  Math.max(0, limit - new Set([...active, primary]).size);

const effectiveInterval = (intervalMs: number, limit: number): number =>
  intervalMs / Math.max(1, limit);

describe('tree cut limit', () => {
  it('fills the spare slot when the limit allows two', () => {
    expect(slotsToFill(2, [], 'Yew')).toBe(1);
  });

  it('fills nothing at a limit of one', () => {
    expect(slotsToFill(1, [], 'Yew')).toBe(0);
  });

  it('does not double-count a primary already selected', () => {
    // selectTree toggles, so re-selecting would deselect -- the bug this whole
    // area of the executor exists to avoid.
    expect(slotsToFill(2, ['Yew'], 'Yew')).toBe(1);
  });

  it('halves the effective interval when two trees are cut at once', () => {
    // Two trees produce two trees' worth of logs in the same wall-clock time.
    expect(effectiveInterval(12_000, 2)).toBe(6_000);
  });

  it('leaves the interval alone at a limit of one', () => {
    expect(effectiveInterval(12_000, 1)).toBe(12_000);
  });

  it('never divides by a zero or missing limit', () => {
    // An unreadable limit must not produce an infinite rate.
    expect(effectiveInterval(12_000, 0)).toBe(12_000);
  });
});

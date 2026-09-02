import { describe, expect, it } from 'vitest';

/**
 * Choosing which secondary a Summoning tablet is made from.
 *
 * Pure restatement of the rule, because the real function reaches into the live
 * game for pricing. What is being pinned is the decision: ask what each option
 * costs, never whether one is merely present.
 */
function pick(options: readonly string[], affordable: (item: string) => boolean): string | null {
  return options.find(affordable) ?? null;
}

const heldAtAll = (held: Record<string, number>) => (item: string) => (held[item] ?? 0) > 0;

describe('picking a Summoning secondary', () => {
  // Ent accepts any log. Summoning prices a secondary by its value, so a cheap
  // log is needed in far greater quantity than an expensive one.
  const options = ['melvorD:Normal_Logs', 'melvorD:Mahogany_Logs'];
  const bank: Record<string, number> = { 'melvorD:Normal_Logs': 1, 'melvorD:Mahogany_Logs': 15 };

  it('the old rule picked a log there was nowhere near enough of', () => {
    // The live failure: "missing materials for melvorF:Ent" while holding 57
    // shards and fifteen perfectly good Mahogany Logs. One Normal Log matched
    // "held at all" and the recipe was pointed at it.
    expect(pick(options, heldAtAll(bank))).toBe('melvorD:Normal_Logs');
  });

  it('pricing each option finds the one that can actually pay', () => {
    // Normal Logs need 25 at this tier; Mahogany needs 5.
    const canPay = (item: string) =>
      item === 'melvorD:Normal_Logs' ? (bank[item] ?? 0) >= 25 : (bank[item] ?? 0) >= 5;

    expect(pick(options, canPay)).toBe('melvorD:Mahogany_Logs');
  });

  it('returns nothing when no option can pay, rather than a false positive', () => {
    expect(pick(options, () => false)).toBeNull();
  });
});

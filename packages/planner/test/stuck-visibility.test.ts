import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * A stuck action being visible where a planning session actually looks.
 *
 * The adapter's ledgers notice an action repeating forever against a world that
 * does not move, and appended their finding to the `ActionResult` detail. That
 * reaches `data/logs/*.jsonl` — and the policy tier puts the detail in the
 * structured payload rather than the message, so the line was greppable and
 * nothing more. All four loops it was built from ran for hours because nothing
 * put them in front of a person, so a finding that only a grep can reach is the
 * same failure again.
 *
 * They ride out on `adapterFailures`, which is already rendered, marked
 * `kind: 'stuck'` so they get their own sentence: "guarded read failed at"
 * would send a reader hunting a renamed getter for a loop.
 */

const stuck = (site: string, count: number, lastError: string) => ({
  site,
  count,
  lastError,
  kind: 'stuck' as const,
});

const read = (site: string, count: number) => ({
  site,
  count,
  lastError: 'not a function',
});

function storeWith(adapterFailures: unknown[]) {
  return {
    report: {
      runState: 'running',
      blockedReason: null,
      candidates: [],
      plan: [],
      objective: null,
      objectiveStartedAt: null,
      quality: [],
      logs: [],
      journalEntries: [],
      blockedOpportunities: [],
      adapterFailures,
      snapshot: {
        characterName: 'test',
        gameVersion: 'v1.3.1',
        totalLevel: 98,
        completionPercent: 0.79,
        currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 100 }],
        skills: [],
        bank: { slotsUsed: 1, slotsMax: 20, items: [] },
        activeAction: null,
        combat: { hitpoints: 10, maxHitpoints: 10, autoEatThreshold: 0 },
      },
    },
    reportAgeMs: 100,
    readQuality: async () => [],
    rememberShownCandidates() {},
  };
}

const summarise = async (adapterFailures: unknown[]): Promise<string> =>
  await TOOLS.get_agent_state!({}, { store: storeWith(adapterFailures), memoryRoot: '.' } as never);

describe('a stuck action in get_agent_state', () => {
  it('states the finding, not just the action name', async () => {
    const text = await summarise([
      stuck(
        'reflex.repairTownship',
        1,
        'reflex.repairTownship has now failed 5 times in a row against an identical projection',
      ),
    ]);

    expect(text).toContain('Actions stuck');
    expect(text).toContain('reflex.repairTownship has now failed 5 times in a row');
  });

  it('never calls a loop a failing read', async () => {
    // The two need different fixes: a read that fell back means a renamed
    // accessor, a stuck action means the agent is achieving nothing. Sharing
    // the sentence would point at the wrong one.
    const text = await summarise([stuck('agility.run', 1, 'something is undoing it')]);

    expect(text).not.toContain('Adapter reads failing');
  });

  it('survives the truncation that hides the fifth-worst read', async () => {
    // Reads run every tick and outnumber a stuck action by thousands to one, so
    // ranking by count would push the more serious finding past the five the
    // summary prints. That truncation has already hidden real failures here.
    const text = await summarise([
      stuck('agility.run', 1, 'something is undoing it, so the work is being redone'),
      ...[1, 2, 3, 4, 5, 6].map((index) => read(`candidates.noisy${index}`, 4_000 - index)),
    ]);

    expect(text).toContain('something is undoing it');
    expect(text).toContain('Adapter reads failing');
    expect(text).toContain('candidates.noisy1 ×3999');
    // Still five reads, and the stuck line did not spend one of the slots.
    expect(text).not.toContain('candidates.noisy6');
  });

  it('says nothing at all while no action is stuck', async () => {
    // A line that appears every pass is the noise that buried the last two
    // diagnostics in this project.
    expect(await summarise([read('candidates.rockGemChance', 12)])).not.toContain('Actions stuck');
    expect(await summarise([])).not.toContain('Actions stuck');
  });
});

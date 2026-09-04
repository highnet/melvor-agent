import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * The town, in the summary a planning session actually reads.
 *
 * Township is the operator's stated first priority and nothing about the town
 * appeared in `get_agent_state` at all — its level, storage and happiness were
 * in the snapshot and rendered nowhere, so the whole skill reached a session
 * only as build candidates near the bottom of `list_candidates`.
 *
 * The first version of the line proved the point twice over. It printed
 * `0 GP/h` with no explanation, and an unexplained zero against 165 working
 * citizens reads as a fault: the formula is
 * `currentPopulation * GP_PER_CITIZEN * (taxRate / 100)` and the only term that
 * can zero it is the tax rate, which sounds exactly like a slider somebody left
 * alone. There is no slider — `BASE_TAX_RATE` is 0 (township.d.ts:405) and the
 * rate is entirely the `townshipTaxPerCitizen` modifier, which one building
 * supplies. The zero is structural, and a correct number that costs every
 * reader the same hour is not finished.
 */

interface TownOverrides {
  happiness?: number;
  health?: number;
  gpPerHour?: number;
  tax?: unknown;
  modelMismatch?: string | null;
}

function storeWithTown(town: unknown) {
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
      adapterFailures: [],
      snapshot: {
        characterName: 'test',
        gameVersion: 'v1.3.1',
        totalLevel: 627,
        completionPercent: 4.47,
        currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 274_121 }],
        skills: [],
        bank: { slotsUsed: 1, slotsMax: 20, items: [] },
        activeAction: null,
        combat: { hitpoints: 10, maxHitpoints: 10, autoEatThreshold: 0 },
        township: town,
      },
    },
    reportAgeMs: 100,
    readQuality: async () => [],
    rememberShownCandidates() {},
  };
}

/** The live town this was written against, with the field under test overridden. */
function town(overrides: TownOverrides = {}) {
  return {
    created: true,
    level: 33,
    population: 184,
    happiness: overrides.happiness ?? 0,
    education: 27,
    healthPercent: 90,
    storageUsed: 33_271,
    storageMax: 60_000,
    worship: 'Terran',
    season: 'Summer',
    resources: [],
    economy: {
      basePopulation: 184,
      population: 184,
      workingPopulation: 165,
      happiness: overrides.happiness ?? 0,
      health: overrides.health ?? 90,
      xpPerHour: 1980,
      gpPerHour: overrides.gpPerHour ?? 0,
      ticksPerHour: 12,
      tax:
        'tax' in overrides
          ? overrides.tax
          : {
              rate: 0,
              unbuiltSource: {
                buildingId: 'melvorF:Town_Hall',
                name: 'Town Hall',
                tier: 5,
                perBuilding: 10,
                requiresTownshipLevel: 80,
                requiresPopulation: 40_000,
              },
            },
      modelMismatch: overrides.modelMismatch ?? null,
    },
  };
}

// Looked up once and checked, rather than with the `!` its sibling tests use.
// Those non-null assertions are 23 of the warnings that currently sit over
// Biome's diagnostic cap and make `pnpm check` fail at random; adding more is
// not free.
const getAgentState = TOOLS.get_agent_state;
if (getAgentState === undefined) throw new Error('get_agent_state is not registered');

const summarise = async (t: unknown): Promise<string> =>
  await getAgentState({}, { store: storeWithTown(t), memoryRoot: '.' } as never);

describe('the town in get_agent_state', () => {
  it('says what the town pays per hour', async () => {
    const text = await summarise(town());
    expect(text).toContain('Town: Township 33');
    expect(text).toContain('1,980 Township xp/h');
  });

  it('explains a zero GP rate instead of merely printing it', async () => {
    // The whole point. "0 GP/h" invites an investigation on every read; naming
    // the cause is what makes the line cheap rather than noisy.
    const text = await summarise(town());
    expect(text).toContain('structural');
    expect(text).toContain('Town Hall');
    expect(text).toContain('Township 80');
    expect(text).toContain('40,000 population');
  });

  it('stops explaining once the town is actually taxed', async () => {
    // A line that survives its own condition is how a diagnostic becomes
    // wallpaper, and this repo has twice had a real one buried that way.
    const text = await summarise(town({ gpPerHour: 7416, tax: { rate: 30, unbuiltSource: null } }));
    expect(text).toContain('7,416 GP/h');
    expect(text).not.toContain('structural');
  });

  it('does not claim happiness buys GP while the town is untaxed', async () => {
    // This said "+1% of both figures above" and it was an overstatement the
    // moment the tax finding landed: one percent of a zero GP rate is zero.
    const text = await summarise(town());
    expect(text).toContain('the GP one is 0');
    expect(text).not.toContain('+1% of both figures above');
  });

  it('claims both figures once there is a GP figure to claim', async () => {
    const text = await summarise(
      town({ happiness: 6, gpPerHour: 7416, tax: { rate: 30, unbuiltSource: null } }),
    );
    expect(text).toContain('+6% on both figures above');
  });

  it('names an unreliable model rather than reporting figures from it', async () => {
    const text = await summarise(town({ modelMismatch: 'modelled 184 against 900' }));
    expect(text).toContain('UNRELIABLE');
    expect(text).not.toContain('Township xp/h and');
  });

  it('says nothing at all about a character with no town', async () => {
    const text = await summarise(null);
    expect(text).not.toContain('Town:');
  });

  it('survives a report from a mod build that predates the economy', async () => {
    // The mod only reloads with the game, so a field added today arrives absent
    // from a report written by yesterday's build. A missing field must cost one
    // line of the summary, never the whole summary.
    const older = { ...town() } as Record<string, unknown>;
    older.economy = undefined;

    const text = await summarise(older);
    expect(text).toContain('Town: Township 33');
    expect(text).toContain('predates it');
  });
});

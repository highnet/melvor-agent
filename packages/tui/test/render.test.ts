import type { Dashboard } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { render } from '../src/render.js';

/** Strips ANSI so assertions read against visible text. */
function plain(lines: string[]): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI is the point
  return lines.join('\n').replace(/\[[0-9;]*m/g, '');
}

const snapshot = {
  capturedAt: 1_700_000_000_000,
  gameVersion: 'v1.3.1',
  characterName: 'throwaway',
  gamemodeId: 'melvorD:Standard',
  currentRealmId: 'melvorD:Melvor',
  isOfflineLoop: false,
  totalLevel: 122,
  completionPercent: 1.53,
  currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 12_345 }],
  skills: [{ id: 'melvorD:Woodcutting', name: 'Woodcutting', level: 15, xp: 2200, isActive: true }],
  bank: { slotsUsed: 4, slotsMax: 20, items: [] },
  activeAction: {
    id: 'melvorD:Woodcutting',
    name: 'Woodcutting',
    isActive: true,
    recipeIds: ['melvorD:Normal_Logs'],
  },
  farm: [],
  combat: {
    inCombat: false,
    hitpoints: 100,
    maxHitpoints: 100,
    prayerPoints: 0,
    autoEatThreshold: 0,
    autoEatHPLimit: 0,
    autoEatEfficiency: 0,
    maxHit: 10,
    minHit: 1,
    accuracy: 100,
    attackInterval: 2600,
    maxBarrier: 0,
    combatLevel: 12,
    food: [],
    selectedEquipmentSet: 0,
    selectedFoodSlot: 0,
    equipment: [],
    enemy: null,
  },
  township: null,
};

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    connected: true,
    lastReportAgeMs: 500,
    report: {
      runState: 'running',
      snapshot,
      objective: null,
      candidates: [],
      blockedOpportunities: [],
      planRemaining: 0,
      journalEntries: [],
      adapterFailures: [],
      logs: [
        { at: 1_700_000_000_000, level: 'info', source: 'policy', message: 'started cutting' },
      ],
      quality: [],
      blockedReason: null,
    },
    digest: { recent: [], aggregates: [] },
    levelsPerHour: 3.5,
    gpPerHour: 12_000,
    ...overrides,
  };
}

describe('render', () => {
  it('shows the run state and the progress rate', () => {
    const text = plain(render(dashboard(), null, 100, 30));
    expect(text).toContain('RUNNING');
    expect(text).toContain('3.50 levels/h');
    expect(text).toContain('throwaway');
  });

  it('surfaces the transport error instead of stale data', () => {
    // Showing a stale snapshot as though it were live is how an operator ends
    // up believing a dead agent is fine.
    const text = plain(render(dashboard(), 'ECONNREFUSED', 100, 30));
    expect(text).toContain('planner service unreachable');
    expect(text).not.toContain('throwaway');
  });

  it('calls out the suspended offline window', () => {
    const offline = dashboard();
    if (offline.report === null) throw new Error('fixture must include a report');
    const text = plain(
      render(
        {
          ...offline,
          report: { ...offline.report, snapshot: { ...snapshot, isOfflineLoop: true } },
        },
        null,
        100,
        30,
      ),
    );
    expect(text).toContain('offline progress resolving');
  });

  it('shows the blocked reason verbatim', () => {
    const blocked = dashboard();
    if (blocked.report === null) throw new Error('fixture must include a report');
    const text = plain(
      render(
        {
          ...blocked,
          report: {
            ...blocked.report,
            runState: 'blocked',
            blockedReason: 'knowledge dump version_mismatch: dump is for v1.3.0',
          },
        },
        null,
        120,
        30,
      ),
    );
    expect(text).toContain('BLOCKED');
    expect(text).toContain('version_mismatch');
  });

  it('surfaces adapter reads that are failing', () => {
    // The failure mode with no other symptom: a renamed accessor takes a
    // candidate off the list or drops a rate to its nominal fallback, and the
    // run otherwise looks entirely healthy. Around a hundred bare catches used
    // to swallow these with no signal anywhere.
    const failing = dashboard();
    if (failing.report === null) throw new Error('fixture must include a report');
    const text = plain(
      render(
        {
          ...failing,
          report: {
            ...failing.report,
            adapterFailures: [
              { site: 'candidates.thievingSuccessRate', count: 412, lastError: 'not a function' },
              { site: 'township.readTaskCandidates', count: 9, lastError: 'undefined' },
            ],
          },
        },
        null,
        120,
        30,
      ),
    );
    expect(text).toContain('candidates.thievingSuccessRate ×412');
    expect(text).toContain('+1 more');
  });

  it('says nothing about adapter reads while they all work', () => {
    // A permanent warning line is a warning nobody reads.
    expect(plain(render(dashboard(), null, 100, 30))).not.toContain('adapter reads failing');
  });

  it('reads auto-eat as not owned rather than zero', () => {
    const text = plain(render(dashboard(), null, 100, 30));
    expect(text).toContain('auto-eat none');
  });

  it('never emits more lines than the terminal has rows', () => {
    // The draw loop slices, but a render that grossly overshoots would mean the
    // log pane is not actually respecting the height it was given.
    const lines = render(dashboard(), null, 80, 20);
    expect(lines.length).toBeLessThanOrEqual(20);
  });

  it('reports a silent mod rather than implying it is connected', () => {
    const text = plain(
      render(dashboard({ connected: false, lastReportAgeMs: 90_000 }), null, 100, 30),
    );
    expect(text).toContain('mod silent');
    expect(text).toContain('2m ago');
  });
});

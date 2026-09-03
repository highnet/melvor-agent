import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, resetActLedger } from '../src/adapter/act.js';
import { readAdapterFailures, recordFallback, resetAdapterFailures } from '../src/adapter/safe.js';

/**
 * The stuck ledgers riding out on the report rather than only into the log.
 *
 * The detector caught the failure class that cost a day, and its finding went
 * to one place: the `ActionResult` detail. Both tiers log that, so it reached
 * `data/logs/*.jsonl` — but the policy tier puts the detail in the structured
 * payload rather than the message, so a `STUCK` line was greppable and appeared
 * on no panel and in no state summary. Every one of the four loops ran for
 * hours precisely because nothing surfaced them where a person looks, which
 * makes "the finding is only greppable" the same bug one level up.
 *
 * `readAdapterFailures()` is the counted list that already reaches both, so
 * that is where these go — marked `kind: 'stuck'`, because a loop is not a read
 * that fell back and must not be described as one.
 */

const never = (): boolean => false;

/** `reflex.repairTownship` with no biome open: the day-long loop, in miniature. */
const repair = (efficiency: number) =>
  act(
    {
      name: 'reflex.repairTownship',
      observe: () => ({ buildingId: 'melvorF:Miners_Pit', efficiency }),
      perform: () => undefined,
      changed: () => false,
    },
    never,
  );

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetActLedger();
  resetAdapterFailures();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('a stuck action on the report', () => {
  it('says nothing until the ledger reports, then names the action', () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) repair(85);
    // Four honest single failures are not a finding. A line here would be the
    // every-pass noise that has twice buried a real diagnostic in this project.
    expect(readAdapterFailures()).toEqual([]);

    repair(85);

    const [entry] = readAdapterFailures();
    expect(entry?.site).toBe('reflex.repairTownship');
    expect(entry?.kind).toBe('stuck');
    expect(entry?.count).toBe(1);
    // The finding itself, so the report says what is wrong rather than only
    // that something is.
    expect(entry?.lastError).toContain('5 times in a row');
  });

  it('counts stuck runs and not stuck passes', () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) repair(85);
    // Twenty failures, one run: the ledger reports on the transition, and the
    // count has to inherit that or the report becomes a per-tick counter.
    expect(readAdapterFailures()[0]?.count).toBe(1);

    // A different projection is a new loop, and worth a second count.
    for (let attempt = 1; attempt <= 5; attempt += 1) repair(40);
    expect(readAdapterFailures()[0]?.count).toBe(2);
    // The line the report carries is the ledger's own, word for word: the same
    // sentence that is warned in the game console and appended to the result
    // detail. Three wordings of one finding is how a reader ends up comparing
    // them instead of reading them. The unmoved projection itself stays in the
    // detail, where the whole before/after evidence lives.
    expect(readAdapterFailures()[0]?.lastError).toContain('identical projection');
  });

  it('carries a redone action too, which never fails at all', () => {
    vi.useFakeTimers();
    try {
      let worn = 'melvorF:Staff_of_Air';
      const equip = () =>
        act(
          {
            name: 'equipment.equip',
            observe: () => ({ slot: 'melvorD:Weapon', itemId: worn }),
            perform: () => {
              worn = 'melvorD:Steel_Scimitar';
              return true;
            },
            changed: (before, after) => before.itemId !== after.itemId,
          },
          never,
        );

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        equip();
        // The other tier puts the staff back between ticks, which is what made
        // this loop report `ok` with true evidence forty minutes running.
        worn = 'melvorF:Staff_of_Air';
        vi.advanceTimersByTime(1_500);
      }

      const [entry] = readAdapterFailures();
      expect(entry?.site).toBe('equipment.equip');
      expect(entry?.lastError).toContain('something is undoing it');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ranks ahead of guarded reads however loud they are', () => {
    // The display truncates — `mcp-tools.ts` renders five — and that truncation
    // has already hidden real failures behind noisier sites. A read failing on
    // every tick outnumbers a stuck action by thousands to one, so ordering by
    // count alone would push the more serious finding off the end.
    for (let index = 0; index < 6; index += 1) {
      for (let tick = 0; tick < 400; tick += 1) {
        recordFallback(`candidates.noisy${index}`, 'no source reported a usable interval');
      }
    }
    for (let attempt = 1; attempt <= 5; attempt += 1) repair(85);

    const failures = readAdapterFailures();
    expect(failures[0]?.site).toBe('reflex.repairTownship');
    expect(failures.slice(0, 5).filter((entry) => entry.kind === 'stuck')).toHaveLength(1);
    // The reads keep their own worst-first order behind it.
    expect(failures[1]?.count).toBe(400);
  });

  it('keeps a stuck action separate from a read of the same name', () => {
    // Two maps, so a read site that happens to match an action name stays two
    // entries rather than one entry flipping kind under the renderer.
    recordFallback('reflex.repairTownship', 'no efficiency reported');
    for (let attempt = 1; attempt <= 5; attempt += 1) repair(85);

    const named = readAdapterFailures().filter((entry) => entry.site === 'reflex.repairTownship');
    expect(named.map((entry) => entry.kind)).toEqual(['stuck', undefined]);
  });
});

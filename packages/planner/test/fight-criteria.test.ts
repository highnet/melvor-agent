import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * What a fight objective finishes on.
 *
 * `successFor` keyed its level criterion off `candidate.params.skillId`, which
 * a fight has no such field for, so every fight fell through to the `[]` branch
 * written for one-shot sales and purchases. `targetLevel: 22` was accepted and
 * discarded without a word, the objective was queued with `successWhen: []` and
 * the confirmation called it "one-shot".
 *
 * A fight is the opposite of one-shot: it is the only route this character has
 * to `hp-40`, `defence-20` or `prayer-20`, and it trains for as long as it
 * runs. Hitpoints is the criterion because every fight trains it whatever the
 * attack style, and the candidate carries neither the weapon nor the style that
 * would say which other skill it also trains.
 */

function storeWith(candidate: { kind: string; params: Record<string, unknown>; label: string }) {
  const queued: unknown[] = [];
  return {
    queued,
    report: { snapshot: null, candidates: [candidate] },
    rememberShownCandidates() {},
    resolveChoice: (index: number) => ({ index, moved: false }),
    enqueue(command: unknown) {
      queued.push(command);
    },
  };
}

const LEECH = {
  kind: 'fight_monster',
  params: {
    kind: 'fight_monster',
    monsterId: 'melvorD:Leech',
    areaId: 'melvorD:Wet_Forest',
  },
  label: 'Fight Leech',
};

describe('a fight objective', () => {
  it('finishes on the Hitpoints level it was given', async () => {
    const store = storeWith(LEECH);

    await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 22, abortMinutes: 60, rationale: 'toward hp-40' },
      { store } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: {
        kind: 'fight_monster',
        successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Hitpoints', level: 22 }],
      },
    });
  });

  it('says so in the confirmation, rather than calling it one-shot', async () => {
    // The caller reads this line to check they got what they asked for. It
    // said "Target: one-shot" for a seventeen-minute grind.
    const store = storeWith(LEECH);

    const reply = await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 22, abortMinutes: 60, rationale: 'toward hp-40' },
      { store } as never,
    );

    expect(String(reply)).toContain('to level 22');
  });

  it('carries the same criterion into a dungeon', async () => {
    const store = storeWith({
      kind: 'run_dungeon',
      params: { kind: 'run_dungeon', dungeonId: 'melvorD:Chicken_Coop' },
      label: 'Chicken Coop',
    });

    await TOOLS.set_objective!(
      {
        candidateIndex: 0,
        targetLevel: 30,
        abortMinutes: 60,
        rationale: 'a dungeon trains it too',
      },
      { store } as never,
    );

    expect(store.queued[0]).toMatchObject({
      objective: {
        successWhen: [{ type: 'skill_level_at_least', skillId: 'melvorD:Hitpoints', level: 30 }],
      },
    });
  });

  it('leaves a sale one-shot, which it genuinely is', async () => {
    const store = storeWith({
      kind: 'sell_items',
      params: { kind: 'sell_items', itemId: 'melvorD:Gold_Bar', quantity: 100 },
      label: 'Sell Gold Bars',
    });

    await TOOLS.set_objective!(
      { candidateIndex: 0, targetLevel: 1, abortMinutes: 5, rationale: 'a sale has no level' },
      { store } as never,
    );

    expect(store.queued[0]).toMatchObject({ objective: { successWhen: [] } });
  });
});

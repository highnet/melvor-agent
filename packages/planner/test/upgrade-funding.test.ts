import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Candidate, StateSnapshot } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/mcp-tools.js';

/**
 * Funding an upgrade the character has qualified for and cannot afford.
 *
 * The operator's rule, stated plainly: *whenever we can unlock a skill upgrade
 * but we don't have enough money for it we should prioritize getting the money
 * for it.* Nothing could act on it. `fundingTarget` — the one authorisation the
 * sell reflex has, bounded to expire on success and capped at what the goal
 * needs — was derived solely from an unmet `currency_at_least` goal in
 * `GOALS.md`, and there was none, so `Rune Fishing Rod` at 300,000 against
 * 174,154 authorised nothing while the run banked stock it would not sell.
 *
 * The tools are driven for real. `fundingTargetFor` is private and the
 * objective it rides on is the thing that matters, so asserting on the queued
 * command is asserting on what the mod will actually receive.
 */

const MINE = {
  kind: 'gather_resource',
  params: { kind: 'gather_resource', skillId: 'melvorD:Mining', recipeId: 'melvorD:Gold_Ore' },
  label: 'Mining: Gold Ore',
  xpPerHour: 40_000,
  available: true,
} satisfies Candidate;

/** The rod, the gloves and Multi-Tree, as the live snapshot carried them. */
const UPGRADES = [
  { id: 'melvorD:Multi_Tree', name: 'Multi-Tree', gpCost: 1_000_000, shortfall: 825_846 },
  { id: 'melvorD:Rune_Fishing_Rod', name: 'Rune Fishing Rod', gpCost: 300_000, shortfall: 125_846 },
  { id: 'melvorD:Gem_Gloves', name: 'Gem Gloves', gpCost: 500_000, shortfall: 325_846 },
];

function snapshotWith(moneyBlockedUpgrades: unknown[]): StateSnapshot {
  return {
    capturedAt: 1,
    gameVersion: 'v1.3.1',
    characterName: 'Agent',
    gamemodeId: 'melvorD:Standard',
    currentRealmId: 'melvorD:Melvor',
    isOfflineLoop: false,
    totalLevel: 800,
    completionPercent: 5,
    currencies: [{ id: 'melvorD:GP', name: 'GP', amount: 174_154 }],
    skills: [{ id: 'melvorD:Mining', name: 'Mining', level: 70, xp: 1_000_000, isActive: false }],
    bank: { slotsUsed: 2, slotsMax: 40, items: [] },
    activeAction: null,
    combat: { hitpoints: 150, maxHitpoints: 150, autoEatThreshold: 0 },
    moneyBlockedUpgrades,
  } as unknown as StateSnapshot;
}

function storeWith(snapshot: StateSnapshot) {
  const queued: unknown[] = [];
  return {
    queued,
    report: { snapshot, candidates: [MINE] },
    rememberShownCandidates() {},
    resolveChoice: (index: number) => ({ index, moved: false }),
    enqueue(command: unknown) {
      queued.push(command);
    },
  };
}

/** A memory root with the given GOALS.md, or none at all. */
async function memoryRoot(goals?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'melvor-funding-'));
  if (goals !== undefined) await writeFile(join(root, 'GOALS.md'), goals, 'utf8');
  return root;
}

async function objectiveFrom(store: ReturnType<typeof storeWith>, root: string) {
  await TOOLS.set_objective!(
    { candidateIndex: 0, targetLevel: 73, abortMinutes: 90, rationale: 'mine gold' },
    { store, memoryRoot: root } as never,
  );

  return (store.queued[0] as { objective: { fundingTarget?: unknown } }).objective;
}

describe('funding an upgrade blocked only on money', () => {
  it('authorises selling toward the cheapest one when no goal names a figure', async () => {
    const store = storeWith(snapshotWith(UPGRADES));

    // The cheapest, not the first in the list and not the largest shortfall.
    // The same argument the goal branch makes for the nearest target: the
    // smallest authorisation that is currently true.
    expect(await objectiveFrom(store, await memoryRoot())).toMatchObject({
      fundingTarget: {
        goalId: 'upgrade:melvorD:Rune_Fishing_Rod',
        currencyId: 'melvorD:GP',
        amount: 300_000,
      },
    });
  });

  it('is unmoved by the order the upgrades arrive in', async () => {
    // Registry order made "take the last match" accidentally correct once
    // before in this repo, so the claim is made against a reversed list too.
    const store = storeWith(snapshotWith([...UPGRADES].reverse()));

    expect(await objectiveFrom(store, await memoryRoot())).toMatchObject({
      fundingTarget: { goalId: 'upgrade:melvorD:Rune_Fishing_Rod', amount: 300_000 },
    });
  });

  it('targets the price, not the shortfall', async () => {
    // `fundingTarget.amount` is compared against the balance held, so a target
    // of 125,846 would already be met at 174,154 and the authorisation would
    // expire before selling anything.
    const objective = await objectiveFrom(storeWith(snapshotWith(UPGRADES)), await memoryRoot());

    expect((objective.fundingTarget as { amount: number }).amount).toBeGreaterThan(174_154);
  });

  it('yields to a figure the operator wrote down', async () => {
    // A number in GOALS.md is a decision a person made; this fallback fills the
    // case that used to authorise nothing, and must not override one.
    //
    // Deliberately *larger* than the rod's 300,000, so the assertion cannot
    // pass by the fallback happening to agree: 1,000,000 is the answer only if
    // the operator's goal was consulted first.
    const root = await memoryRoot(
      '- Buy Auto Eat. <!-- id: auto-eat --> <!-- done: currency melvorD:GP >= 1000000 -->\n',
    );
    const store = storeWith(snapshotWith(UPGRADES));

    expect(await objectiveFrom(store, root)).toMatchObject({
      fundingTarget: { goalId: 'auto-eat', amount: 1_000_000 },
    });
  });

  it('authorises nothing when no upgrade is money-blocked', async () => {
    // The default posture stays "this agent does not sell". An absent target is
    // the whole of the guard; there is no threshold underneath it.
    const objective = await objectiveFrom(storeWith(snapshotWith([])), await memoryRoot());

    expect(objective.fundingTarget).toBeUndefined();
  });

  it('authorises nothing when the mod is too old to report the field', async () => {
    // The service reloads on save and the mod only on a game reload, so a
    // running mod that predates the field reports a snapshot without it.
    const snapshot = snapshotWith([]) as Record<string, unknown>;
    snapshot.moneyBlockedUpgrades = undefined;

    const objective = await objectiveFrom(
      storeWith(snapshot as unknown as StateSnapshot),
      await memoryRoot(),
    );

    expect(objective.fundingTarget).toBeUndefined();
  });
});

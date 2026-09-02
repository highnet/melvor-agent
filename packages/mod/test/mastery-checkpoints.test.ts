import { afterEach, describe, expect, it } from 'vitest';
import {
  checkpointLoss,
  nextCheckpointPercent,
  poolXpForLevels,
  readMasteryCandidates,
  spendMasteryPool,
} from '../src/adapter/management.js';
import { installFakeGame } from './fixtures.js';

/**
 * Spending the mastery pool is not free, and the game says so itself.
 *
 * Mastery pool checkpoints are granted as the pool fills and revoked as it
 * empties, and spending pool XP is the one thing that empties it. The game
 * ships a confirmation dialog for exactly this loss —
 * `showMasteryCheckpointconfirmations`, settings.d.ts:80 — and the adapter
 * calls the underlying method with no dialog, so the refusal has to live in the
 * adapter or nowhere.
 *
 * These drive the real functions rather than restating them; a mirrored
 * predicate here would keep passing after the implementation moved, which is
 * the drift `mining-respawn.test.ts` was written to stop repeating.
 */

const uninstalls: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
  (globalThis as Record<string, unknown>).exp = undefined;
});

/** The checkpoint percents Melvor's base skills actually use. */
const CHECKPOINTS = [10, 25, 50, 95];

describe('nextCheckpointPercent', () => {
  it('names the lowest checkpoint still ahead', () => {
    expect(nextCheckpointPercent(CHECKPOINTS, 11)).toBe(25);
  });

  it('is null once every checkpoint is held, which is when spending gives one back', () => {
    expect(nextCheckpointPercent(CHECKPOINTS, 96)).toBeNull();
  });

  it('does not treat the checkpoint the pool is exactly on as still ahead', () => {
    expect(nextCheckpointPercent(CHECKPOINTS, 25)).toBe(50);
  });
});

describe('poolXpForLevels', () => {
  // The XP already banked against the action counts towards the target level,
  // so the pool only pays the shortfall. Charging the full level cost would
  // over-estimate and refuse spends that are in fact safe.
  const levelToXp = (level: number): number => level * 100;

  it('charges the shortfall to the target level, not the whole level', () => {
    expect(poolXpForLevels(250, 2, 1, levelToXp)).toBe(50);
  });

  it('never returns a negative cost for an action already past the target', () => {
    expect(poolXpForLevels(900, 2, 1, levelToXp)).toBe(0);
  });
});

describe('checkpointLoss', () => {
  // The game's own hypothetical-XP accessor, standing in: one bonus at 100 xp,
  // two at 500.
  const bonusesAt = (xp: number): number => (xp >= 500 ? 2 : xp >= 100 ? 1 : 0);

  it('is zero when the surplus above the checkpoint covers the spend', () => {
    expect(checkpointLoss(600, 50, bonusesAt)).toBe(0);
  });

  it('counts the bonuses a spend would revoke', () => {
    expect(checkpointLoss(600, 550, bonusesAt)).toBe(2);
  });

  it('is null — not zero — when the count cannot be read', () => {
    // The distinction is the whole guard: "cannot tell" must refuse, because
    // the loss it is guarding is silent and cannot be undone.
    expect(checkpointLoss(600, 50, () => undefined)).toBeNull();
  });
});

/** A stand-in skill carrying only the accessors the code under test reaches for. */
function poolSkill(options: {
  poolXp: number;
  masteryXp: number;
  masteryLevel: number;
  /** Pool XP at which each successive checkpoint becomes active. */
  checkpointXp: number[];
  onSpend?: (levels: number) => void;
}): Record<string, unknown> {
  const action = { id: 'melvorD:Normal_Tree', name: 'Normal Tree' };
  const state = { poolXp: options.poolXp, masteryLevel: options.masteryLevel };

  return {
    id: 'melvorD:Woodcutting',
    name: 'Woodcutting',
    actions: {
      allObjects: [action],
      getObjectByID: (id: string) => (id === action.id ? action : undefined),
    },
    getMasteryLevel: () => state.masteryLevel,
    getMasteryXP: () => options.masteryXp,
    getMasteryPoolXP: () => state.poolXp,
    getMasteryPoolProgress: () => 60,
    getMasteryPoolBonusesInRealm: () => CHECKPOINTS.map((percent) => ({ percent })),
    getActiveMasteryPoolBonusCount: (_realm: unknown, xp: number) =>
      options.checkpointXp.filter((threshold) => xp >= threshold).length,
    levelUpMasteryWithPoolXP: (_action: unknown, levels: number) => {
      // What the real method does, as far as this test cares: charge the pool
      // and raise the level.
      state.poolXp -= 100 * levels;
      state.masteryLevel += levels;
      options.onSpend?.(levels);
    },
  };
}

function install(skill: Record<string, unknown>): void {
  (globalThis as Record<string, unknown>).exp = { levelToXP: (level: number) => level * 100 };
  uninstalls.push(
    installFakeGame({
      currentRealm: { id: 'melvorD:Melvor' },
      skills: {
        allObjects: [skill],
        getObjectByID: (id: string) => (id === skill.id ? skill : undefined),
      },
    }),
  );
}

describe('spendMasteryPool refuses a spend that would revoke a checkpoint', () => {
  it('refuses when the spend drops the pool below a held checkpoint', () => {
    let spends = 0;
    // 550 pool XP, checkpoints at 100 and 500, and a level costing 100. The
    // spend would land on 450 and hand back the second bonus.
    install(
      poolSkill({
        poolXp: 550,
        masteryXp: 100,
        masteryLevel: 1,
        checkpointXp: [100, 500],
        onSpend: () => {
          spends += 1;
        },
      }),
    );

    const result = spendMasteryPool('melvorD:Woodcutting', 'melvorD:Normal_Tree', 1, () => false);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('precondition');
    expect(result.ok === false && result.detail).toContain('checkpoint');
    // The refusal has to happen *before* the call: the loss is not undoable.
    expect(spends).toBe(0);
  });

  it('allows a spend the surplus covers, and proves the checkpoints survived', () => {
    install(poolSkill({ poolXp: 900, masteryXp: 100, masteryLevel: 1, checkpointXp: [100, 500] }));

    const result = spendMasteryPool('melvorD:Woodcutting', 'melvorD:Normal_Tree', 1, () => false);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observed.after.masteryLevel).toBe(2);
    expect(result.observed.after.poolXp).toBe(800);
    expect(result.observed.after.activeBonuses).toBe(result.observed.before.activeBonuses);
  });

  it('refuses when the checkpoint count cannot be read at all', () => {
    const skill = poolSkill({
      poolXp: 900,
      masteryXp: 100,
      masteryLevel: 1,
      checkpointXp: [100, 500],
    });
    skill.getActiveMasteryPoolBonusCount = () => {
      throw new Error('renamed');
    };
    install(skill);

    const result = spendMasteryPool('melvorD:Woodcutting', 'melvorD:Normal_Tree', 1, () => false);

    // Fail closed. A guard that cannot see is not a reason to act anyway.
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.detail).toContain('refusing to spend');
  });
});

describe('the candidate label carries the pool standing', () => {
  it('names how full the pool is and where the next checkpoint sits', () => {
    install(poolSkill({ poolXp: 900, masteryXp: 100, masteryLevel: 1, checkpointXp: [100, 500] }));

    const [candidate] = readMasteryCandidates();

    // 900 pool XP alone reads as pure surplus; it is not, and the label has to
    // say so or the planner cannot tell one spend from another.
    expect(candidate?.label).toContain('pool 60.0% full');
    expect(candidate?.label).toContain('next checkpoint at 95%');
  });
});

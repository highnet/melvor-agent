import type { Objective, StateSnapshot } from '@melvor-agent/shared';

export const WOODCUTTING = 'melvorD:Woodcutting';
export const NORMAL_TREE = 'melvorD:Normal_Tree';
export const NORMAL_LOGS = 'melvorD:Normal_Logs';
export const GP = 'melvorD:GP';

/**
 * A minimal but schema-valid snapshot.
 *
 * Built by hand rather than recorded so tests state their preconditions
 * explicitly; `overrides` is a deep-ish merge over the fields tests actually vary.
 */
export function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  const base: StateSnapshot = {
    capturedAt: 1_700_000_000_000,
    gameVersion: 'v1.3.1',
    characterName: 'throwaway',
    gamemodeId: 'melvorD:Standard',
    currentRealmId: 'melvorD:Melvor',
    isOfflineLoop: false,
    totalLevel: 120,
    completionPercent: 1.5,
    currencies: [{ id: GP, name: 'GP', amount: 10_000 }],
    skills: [
      { id: WOODCUTTING, name: 'Woodcutting', level: 15, xp: 2200, isActive: false },
      { id: 'melvorD:Fishing', name: 'Fishing', level: 10, xp: 1100, isActive: false },
    ],
    bank: {
      slotsUsed: 3,
      slotsMax: 20,
      items: [{ id: NORMAL_LOGS, name: 'Normal Logs', qty: 40 }],
    },
    activeAction: null,
    farm: [],
    township: null,
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
  };

  return { ...base, ...overrides };
}

export function objective(overrides: Partial<Objective> = {}): Objective {
  const base: Objective = {
    id: 'obj-1',
    kind: 'gather_resource',
    params: { kind: 'gather_resource', skillId: WOODCUTTING, recipeId: NORMAL_TREE },
    successWhen: [{ type: 'item_qty_at_least', itemId: NORMAL_LOGS, qty: 100 }],
    abortWhen: { minutesExceed: 60 },
    expectedDurationMin: 30,
    rationale: 'test fixture',
  };
  return { ...base, ...overrides };
}

import type { Objective, ObjectiveKind } from '@melvor-agent/shared';
import { buyShopUpgrade } from './buy.js';
import { equipGear } from './equip.js';
import { tendFarm } from './farm.js';
import { fightMonster } from './fight.js';
import { gatherResource } from './gather.js';
import { sellItems } from './sell.js';
import type { PolicyExecutor } from './types.js';

/**
 * The capability registry.
 *
 * This is the enforcement point for "the planner must never emit an action the
 * policy layer couldn't already perform". A kind with no entry here cannot be
 * executed, and the runtime rejects such an objective before parsing its params
 * — so the rule is a runtime assertion rather than a convention someone has to
 * remember.
 *
 * `Record<ObjectiveKind, ...>` makes the compiler enforce the other direction
 * too: adding a kind to the shared schema without an executor fails the build.
 */
const EXECUTORS: Record<ObjectiveKind, PolicyExecutor> = {
  gather_resource: gatherResource,
  sell_items: sellItems,
  buy_shop_upgrade: buyShopUpgrade,
  fight_monster: fightMonster,
  tend_farm: tendFarm,
  equip_item: equipGear,
  equip_food: equipGear,
};

/** Whether the policy layer can execute this objective kind at all. */
export function isSupportedKind(kind: string): kind is ObjectiveKind {
  return Object.hasOwn(EXECUTORS, kind);
}

/** Every kind the mod can currently execute. Sent to the planner as its menu. */
export function supportedKinds(): ObjectiveKind[] {
  return Object.keys(EXECUTORS) as ObjectiveKind[];
}

/**
 * Looks up the executor for an objective.
 *
 * @param objective - A validated objective.
 * @returns The executor, or null when the kind is unsupported — which is a
 *          planner bug, not a runtime condition to work around.
 */
export function executorFor(objective: Objective): PolicyExecutor | null {
  return EXECUTORS[objective.kind] ?? null;
}

export { buyShopUpgrade } from './buy.js';
export { assessSurvivability, normaliseFraction } from './combat-gate.js';
export { fightMonster } from './fight.js';
export { tendFarm } from './farm.js';
export { gatherResource } from './gather.js';
export { sellItems } from './sell.js';
export * from './criteria.js';
export type * from './types.js';

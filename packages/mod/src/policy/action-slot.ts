import type { StateSnapshot } from '@melvor-agent/shared';
import type { PolicyAction } from './types.js';

/**
 * Melvor runs exactly one action at a time.
 *
 * Every executor that wants to start something must first take the slot from
 * whoever holds it, and "whoever" is not uniform: combat is left by disengaging,
 * a skill by stopping it, and a skill the executor itself owns not at all.
 *
 * This exists because the same mistake was made four times in one day, each
 * time in a different executor and each time with the same symptom — an
 * objective that did nothing and said nothing useful:
 *
 * - a fight objective set while fishing waited behind it forever
 * - a mining objective set while fighting sent `stop_gathering` for combat,
 *   which refused with "no verified routine for skill melvorD:Combat"
 * - Cartography took the slot and had no stop routine, stranding everything
 * - surveying refused with "another action is running: melvorD:Woodcutting"
 *   while the stopgap happily kept cutting trees
 *
 * A shared helper is the honest fix: the fifth executor should not have to
 * rediscover this.
 */

/** Combat occupies the action slot under this id, but is not a gathering skill. */
export const COMBAT_ACTION_ID = 'melvorD:Combat';

/**
 * The action needed to free the slot, or null when it is already free.
 *
 * @param snapshot - Current state.
 * @param ownedByCaller - Ids the caller considers its own, which it must not
 *   stop. A gathering executor owns its skill; the explore executor owns both
 *   Cartography and Archaeology.
 * @returns An action and the reason for it, or null when nothing is in the way.
 */
export function releaseActionSlot(
  snapshot: StateSnapshot,
  ownedByCaller: readonly string[],
): { action: PolicyAction; reason: string } | null {
  const active = snapshot.activeAction;
  if (active === null) return null;
  if (ownedByCaller.includes(active.id)) return null;

  if (active.id === COMBAT_ACTION_ID) {
    // Combat is not a gathering skill and has no stop routine; it is left the
    // way it is entered.
    return {
      action: { type: 'disengage' },
      reason: 'combat holds the action slot; disengaging',
    };
  }

  return {
    action: { type: 'stop_gathering', skillId: active.id },
    reason: `${active.name} holds the action slot; stopping it`,
  };
}

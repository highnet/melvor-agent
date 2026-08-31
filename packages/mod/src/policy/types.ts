import type { Objective, StateSnapshot } from '@melvor-agent/shared';

/**
 * An intent the policy layer produces.
 *
 * Deliberately not a game call: the policy layer is pure and never touches the
 * adapter. The runtime translates these into adapter actions, which is what
 * keeps this tier testable against recorded snapshots.
 *
 * Every variant here must have a corresponding adapter action. A variant with
 * no executor is the failure the capability registry exists to catch.
 */
export type PolicyAction =
  /** Be gathering this recipe with this skill. One intent, not select-then-start. */
  | { type: 'gather'; skillId: string; recipeId: string }
  | { type: 'stop_gathering'; skillId: string }
  /** Sell a named quantity of one item. Never a filter, never the whole bank. */
  | { type: 'sell'; itemId: string; quantity: number }
  | { type: 'buy'; purchaseId: string; quantity: number }
  /**
   * Engage a monster. The runtime refuses to perform this without a passing
   * survivability verdict, so the intent alone never authorises a fight.
   */
  | { type: 'engage'; monsterId: string; areaId: string }
  | { type: 'disengage' }
  | { type: 'harvest_plot'; plotId: string }
  | { type: 'plant_plot'; plotId: string; recipeId: string }
  | { type: 'equip'; itemId: string; slotId?: string }
  | { type: 'equip_food'; itemId: string; quantity: number }
  | { type: 'spend_mastery'; skillId: string; actionId: string; levels: number }
  | { type: 'set_attack_style'; attackTypeId: 'melee' | 'ranged' | 'magic'; styleId: string }
  | { type: 'toggle_prayer'; prayerId: string }
  | { type: 'use_potion'; itemId: string }
  | { type: 'new_slayer_task'; categoryId: string; payWithCoins: boolean }
  | { type: 'run_dungeon'; dungeonId: string }
  | { type: 'select_spell'; spellId: string }
  | { type: 'build_township'; buildingId: string; biomeId: string }
  | { type: 'repair_township'; buildingId: string; biomeId: string }
  | { type: 'survey_hex' }
  | { type: 'excavate_dig_site'; digSiteId: string }
  | { type: 'select_dig_map'; digSiteId: string; mapIndex: number }
  | { type: 'select_dig_tool'; digSiteId: string; toolId: string }
  | { type: 'advance_raid'; difficulty: string }
  | { type: 'stop_raid' }
  | { type: 'build_obstacle'; obstacleId: string }
  | { type: 'toggle_curse'; curseId: string }
  | { type: 'toggle_aurora'; auroraId: string }
  | { type: 'toggle_bank_lock'; itemId: string }
  | { type: 'select_level_cap'; capIncreaseId: string; skillId: string };

/** Why the policy layer chose to do nothing. Surfaced in the log, not swallowed. */
export type PolicyIdleReason =
  | 'objective_satisfied'
  | 'already_running'
  | 'nothing_to_do'
  | 'waiting_for_game';

export type PolicyDecision =
  | {
      kind: 'act';
      actions: PolicyAction[];
      reason: string;
      /**
       * Finish the objective once these actions are verified.
       *
       * For a one-shot decision — toggling a prayer, spending a mastery pool —
       * leaving the objective open makes the policy tier re-issue it every
       * tick, which for a toggle means flipping it on and off forever.
       */
      completeAfter?: boolean;
    }
  | { kind: 'idle'; reason: PolicyIdleReason; detail: string }
  | { kind: 'complete'; detail: string }
  | {
      kind: 'abort';
      outcome: 'aborted_budget' | 'aborted_gp_floor' | 'aborted_deaths' | 'failed_precondition';
      detail: string;
    };

/** Everything a policy executor is allowed to see. No clock reads, no globals. */
export interface PolicyContext {
  snapshot: StateSnapshot;
  objective: Objective;
  /** Wall clock, injected so the tier stays deterministic under test. */
  now: number;
  /** When the current objective started, for the minutes budget. */
  objectiveStartedAt: number;
  /** Deaths observed since the objective started. */
  deathsSinceStart: number;
}

/**
 * A pure executor for one objective kind.
 *
 * Registering one is what makes an `ObjectiveKind` legal: the planner cannot
 * emit a kind that has no executor here, because the runtime rejects it before
 * the params are parsed.
 */
export type PolicyExecutor = (context: PolicyContext) => PolicyDecision;

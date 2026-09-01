import { checkAbort, elapsedMinutes } from './criteria.js';
import type { PolicyAction, PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Executes the one-shot management objectives.
 *
 * Mastery spending, attack style, prayers, potions and Slayer tasks all share a
 * shape: apply a decision, observe it landed, done. There is no rate and no
 * level to reach, so completion is read from the snapshot rather than from a
 * criterion the planner had to invent — which matters, because an invented
 * criterion for a one-shot action is usually either instantly true or never
 * true, and both waste a planning cycle.
 *
 * The adapter still verifies each action properly; this tier only decides
 * *whether it is still worth doing*.
 */
export const manage: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;
  const params = objective.params;

  const abort = checkAbort(
    snapshot,
    objective.abortWhen,
    elapsedMinutes(now, objectiveStartedAt),
    deathsSinceStart,
  );
  if (abort.abort) return { kind: 'abort', outcome: abort.outcome, detail: abort.detail };

  if (snapshot.isOfflineLoop) {
    return {
      kind: 'idle',
      reason: 'waiting_for_game',
      detail: 'offline progress is still resolving',
    };
  }

  switch (params.kind) {
    case 'spend_mastery':
      // The adapter refuses on an empty pool, and the failure limit ends the
      // objective, so there is no useful snapshot check to make first: pool XP
      // is not carried in the snapshot.
      return act(
        {
          type: 'spend_mastery',
          skillId: params.skillId,
          actionId: params.actionId,
          levels: params.levels,
        },
        `spending ${params.skillId} mastery pool on ${params.actionId}`,
      );

    case 'set_attack_style':
      return act(
        { type: 'set_attack_style', attackTypeId: params.attackTypeId, styleId: params.styleId },
        `setting ${params.attackTypeId} style to ${params.styleId}`,
      );

    case 'toggle_prayer':
      return act(
        { type: 'toggle_prayer', prayerId: params.prayerId },
        `toggling prayer ${params.prayerId}`,
      );

    case 'use_potion':
      return act({ type: 'use_potion', itemId: params.itemId }, `drinking ${params.itemId}`);

    case 'new_slayer_task':
      // Taking a task while one is unfinished throws the old one away, which is
      // a real cost: partial kill progress is lost.
      if (snapshot.combat.inCombat) {
        return {
          kind: 'idle',
          reason: 'already_running',
          detail: 'in combat; not rerolling the task mid-fight',
        };
      }
      return act(
        {
          type: 'new_slayer_task',
          categoryId: params.categoryId,
          payWithCoins: params.payWithCoins,
        },
        `taking a new slayer task from ${params.categoryId}`,
      );

    case 'select_spell':
      return act(
        { type: 'select_spell', spellId: params.spellId },
        `selecting attack spell ${params.spellId}`,
      );

    case 'build_township':
      return act(
        { type: 'build_township', buildingId: params.buildingId, biomeId: params.biomeId },
        `building ${params.buildingId} in ${params.biomeId}`,
      );

    case 'repair_township':
      return act(
        { type: 'repair_township', buildingId: params.buildingId, biomeId: params.biomeId },
        `repairing ${params.buildingId} in ${params.biomeId}`,
      );

    case 'select_dig_map':
      return act(
        { type: 'select_dig_map', digSiteId: params.digSiteId, mapIndex: params.mapIndex },
        `selecting map ${params.mapIndex} for ${params.digSiteId}`,
      );

    case 'select_dig_tool':
      return act(
        { type: 'select_dig_tool', digSiteId: params.digSiteId, toolId: params.toolId },
        `selecting ${params.toolId} for ${params.digSiteId}`,
      );

    case 'build_obstacle':
      return act(
        { type: 'build_obstacle', obstacleId: params.obstacleId },
        `building ${params.obstacleId}`,
      );

    case 'upgrade_constellation':
      return act(
        {
          type: 'upgrade_constellation',
          constellationId: params.constellationId,
          modifierKind: params.modifierKind,
          index: params.index,
        },
        `upgrading ${params.constellationId} ${params.modifierKind} ${params.index}`,
      );

    case 'unlock_skill_node':
      return act(
        {
          type: 'unlock_skill_node',
          skillId: params.skillId,
          treeId: params.treeId,
          nodeId: params.nodeId,
        },
        `unlocking ${params.nodeId}`,
      );

    case 'change_equipment_set':
      return act(
        { type: 'change_equipment_set', setIndex: params.setIndex },
        `switching to equipment set ${params.setIndex}`,
      );

    case 'compost_plot':
      return act(
        {
          type: 'compost_plot',
          plotId: params.plotId,
          compostId: params.compostId,
          amount: params.amount,
        },
        `composting ${params.plotId}`,
      );

    case 'passive_cook':
      return act(
        { type: 'passive_cook', categoryId: params.categoryId },
        `starting passive cooking in ${params.categoryId}`,
      );

    case 'restore_town_health':
      return act(
        { type: 'restore_town_health', resourceId: params.resourceId, amount: params.amount },
        `restoring town health with ${params.resourceId}`,
      );

    case 'upgrade_item':
      return act(
        {
          type: 'upgrade_item',
          upgradedItemId: params.upgradedItemId,
          quantity: params.quantity,
          allowDowngrade: params.allowDowngrade,
        },
        `upgrading into ${params.upgradedItemId}`,
      );

    case 'select_worship':
      return act(
        { type: 'select_worship', worshipId: params.worshipId },
        `setting the town's worship to ${params.worshipId}`,
      );

    case 'claim_township_task':
      return act(
        { type: 'claim_township_task', taskId: params.taskId },
        `claiming the township task ${params.taskId}`,
      );

    case 'claim_casual_task':
      return act(
        { type: 'claim_casual_task', taskId: params.taskId },
        `claiming the casual task ${params.taskId}`,
      );

    case 'start_combat_event':
      return act(
        { type: 'start_combat_event', eventId: params.eventId },
        `starting the combat event ${params.eventId}`,
      );

    case 'choose_event_passive':
      return act(
        params.passiveId === undefined
          ? { type: 'choose_event_passive' }
          : { type: 'choose_event_passive', passiveId: params.passiveId },
        'answering the event passive choice',
      );

    case 'convert_to_township':
      return act(
        {
          type: 'convert_to_township',
          itemId: params.itemId,
          resourceId: params.resourceId,
          quantity: params.quantity,
        },
        `trading ${params.quantity}x ${params.itemId} to the town for ${params.resourceId}`,
      );

    case 'bury_bones':
      return act(
        { type: 'bury_bones', itemId: params.itemId, quantity: params.quantity },
        `burying ${params.quantity}x ${params.itemId}`,
      );

    case 'toggle_curse':
      return act({ type: 'toggle_curse', curseId: params.curseId }, `toggling ${params.curseId}`);

    case 'toggle_aurora':
      return act(
        { type: 'toggle_aurora', auroraId: params.auroraId },
        `toggling ${params.auroraId}`,
      );

    case 'toggle_bank_lock':
      return act(
        { type: 'toggle_bank_lock', itemId: params.itemId },
        `toggling the bank lock on ${params.itemId}`,
      );

    case 'select_level_cap':
      // Permanent, and the alternatives are lost with it — but an unchosen
      // increase leaves the character stuck at its cap forever, which is worse.
      return act(
        {
          type: 'select_level_cap',
          capIncreaseId: params.capIncreaseId,
          skillId: params.skillId,
        },
        `raising the ${params.skillId} level cap`,
      );

    default:
      return {
        kind: 'abort',
        outcome: 'failed_precondition',
        detail: `manage received params of kind ${params.kind}`,
      };
  }
};

/**
 * Emits one action and treats the objective as finished.
 *
 * A one-shot decision is complete once it has been *attempted and verified* by
 * the adapter. Leaving the objective open would make the policy tier re-issue
 * it every tick, which for a prayer toggle would flip it on and off forever.
 */
function act(action: PolicyAction, reason: string): PolicyDecision {
  return { kind: 'act', actions: [action], reason, completeAfter: true };
}

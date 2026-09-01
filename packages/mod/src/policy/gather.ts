import { releaseActionSlot } from './action-slot.js';
import { checkAbort, elapsedMinutes, isObjectiveComplete } from './criteria.js';
import type { PolicyContext, PolicyDecision, PolicyExecutor } from './types.js';

/**
 * Skills with a verified adapter executor.
 *
 * Mirrors `GATHERING_SKILL_IDS` in the adapter. Duplicated rather than imported
 * because the policy tier must stay free of adapter imports to remain pure and
 * testable; the adapter refuses an unknown skill anyway, so the two cannot
 * silently disagree about what is executable — only about what is attempted.
 */
const SUPPORTED_GATHERING_SKILLS: ReadonlySet<string> = new Set([
  // Gathering
  'melvorD:Woodcutting',
  'melvorD:Mining',
  'melvorD:Fishing',
  // Artisan (one shared routine — they inherit ArtisanSkill)
  'melvorD:Smithing',
  'melvorD:Crafting',
  'melvorD:Fletching',
  'melvorD:Herblore',
  'melvorD:Runecrafting',
  'melvorD:Summoning',
  // Individually routed
  'melvorD:Firemaking',
  'melvorD:Cooking',
  'melvorD:Thieving',
  'melvorD:Astrology',
  'melvorD:Agility',
  'melvorD:AltMagic',
  'melvorItA:Harvesting',
]);

/**
 * Executes a `gather_resource` objective.
 *
 * Order matters and is the whole safety argument: abort conditions are checked
 * before success, and success before any action is chosen. An objective that
 * has blown its budget must not get one more tick of work, and one already
 * satisfied must not be restarted.
 *
 * Pure by construction — it reads only its context and returns intents. The
 * runtime performs them through the adapter and verifies the result.
 *
 * Covers the gathering skills listed in {@link SUPPORTED_GATHERING_SKILLS}.
 * Their selection APIs differ substantially, so the adapter holds one verified
 * routine per skill and this tier only names the skill and recipe.
 */
export const gatherResource: PolicyExecutor = (context: PolicyContext): PolicyDecision => {
  const { snapshot, objective, now, objectiveStartedAt, deathsSinceStart } = context;

  if (objective.params.kind !== 'gather_resource') {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `gatherResource received params of kind ${objective.params.kind}`,
    };
  }

  const minutes = elapsedMinutes(now, objectiveStartedAt);
  const abort = checkAbort(snapshot, objective.abortWhen, minutes, deathsSinceStart);
  if (abort.abort) {
    return { kind: 'abort', outcome: abort.outcome, detail: abort.detail };
  }

  if (isObjectiveComplete(snapshot, objective.successWhen)) {
    return { kind: 'complete', detail: `all ${objective.successWhen.length} criteria met` };
  }

  const { skillId, recipeId } = objective.params;

  if (!SUPPORTED_GATHERING_SKILLS.has(skillId)) {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `no verified executor for gathering skill ${skillId}`,
    };
  }

  // The game is mid catch-up or between ticks; do nothing rather than guess.
  if (snapshot.isOfflineLoop) {
    return {
      kind: 'idle',
      reason: 'waiting_for_game',
      detail: 'offline progress is still resolving',
    };
  }

  const skill = snapshot.skills.find((entry) => entry.id === skillId);
  if (skill === undefined) {
    return {
      kind: 'abort',
      outcome: 'failed_precondition',
      detail: `skill ${skillId} is not registered in this game version`,
    };
  }

  const active = snapshot.activeAction;

  if (skill.isActive) {
    // Running the right skill is not the same as running the right recipe.
    // Observed live: told to cut Willow while cutting Oak, this idled and the
    // character kept cutting Oak for hours — the objective was accepted and
    // then quietly ignored, which is worse than refusing it.
    //
    // An unreadable selection counts as wrong. Restarting the right recipe
    // costs one tick; running the wrong one costs the whole objective.
    const running = active?.recipeIds ?? [];
    if (running.includes(recipeId)) {
      return {
        kind: 'idle',
        reason: 'already_running',
        detail: `${skill.name} is already gathering ${recipeId}`,
      };
    }

    return {
      kind: 'act',
      actions: [{ type: 'stop_gathering', skillId }],
      reason:
        running.length === 0
          ? `${skill.name} is active but its selection could not be read; restarting on ${recipeId}`
          : `${skill.name} is gathering ${running.join(', ')}, not ${recipeId}; stopping to switch`,
    };
  }

  // Another skill holds the action slot. The game runs one active action at a
  // time, so starting without stopping first would silently no-op.
  //
  // Preempting is the *point*: switching skills when the objective changes is
  // the transition this whole agent exists to perform. Refusing to preempt
  // would leave it running whatever it happened to start first, forever —
  // precisely the behaviour the game already gives you for free.
  //
  // Stop and start are separate ticks rather than one batch: `stop` has to be
  // observed to have actually taken the slot free before `gather` can claim it,
  // and batching them would start against a state the stop has not produced yet.
  const inTheWay = releaseActionSlot(snapshot, [skillId]);
  if (inTheWay !== null) {
    return {
      kind: 'act',
      actions: [inTheWay.action],
      reason: `${inTheWay.reason} to run ${skill.name}`,
    };
  }

  return {
    kind: 'act',
    actions: [{ type: 'gather', skillId, recipeId }],
    reason: `${skill.name} is idle; gathering ${recipeId}`,
  };
};

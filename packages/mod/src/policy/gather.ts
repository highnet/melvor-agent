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
  'melvorD:Woodcutting',
  'melvorD:Mining',
  'melvorD:Fishing',
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

  if (skill.isActive) {
    return {
      kind: 'idle',
      reason: 'already_running',
      detail: `${skill.name} is already active`,
    };
  }

  // Another skill holds the action slot. Stop it first; the game runs one
  // active action at a time, so starting without stopping would silently no-op.
  const active = snapshot.activeAction;
  if (active !== null && active.id !== skillId) {
    return {
      kind: 'idle',
      reason: 'nothing_to_do',
      detail: `${active.name} holds the active action slot; not preempting it in Phase 1`,
    };
  }

  return {
    kind: 'act',
    actions: [{ type: 'gather', skillId, recipeId }],
    reason: `${skill.name} is idle; gathering ${recipeId}`,
  };
};

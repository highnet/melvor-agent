import type { StateSnapshot, SuccessCriterion } from '@melvor-agent/shared';
import { bankQuantity, currencyAmount } from '../policy/criteria.js';

/**
 * The number an objective's success condition is actually about.
 *
 * `learnings/README.md` states the rule this implements: *pick the counter
 * before starting, then verify it moved*. It was written after a fight that
 * returned `ok` on every engage for seventeen minutes with GP frozen at exactly
 * 30,816 — every capability check passed and nothing died. The objective's own
 * success criterion already names the counter, so nothing has to be guessed.
 */
export interface ObjectiveCounter {
  /** For the log line and the report, e.g. `Woodcutting xp`. */
  label: string;
  value: number;
}

/**
 * The counter an objective's success condition names, read from a snapshot.
 *
 * Skill criteria are watched by **XP, not level**. Level is what the criterion
 * states, and watching it would fire on a perfectly healthy objective: a level
 * takes minutes to hours near the top of the curve, so "level has not moved"
 * is the normal condition of working, while XP moves with every action.
 *
 * @param snapshot - The most recent validated observation.
 * @param criteria - The objective's success conditions.
 * @returns The first readable counter, or null when there is none to watch —
 *          an empty criteria list is a one-shot objective whose executor
 *          decides completion, and it has no counter by design.
 */
export function readObjectiveCounter(
  snapshot: StateSnapshot,
  criteria: readonly SuccessCriterion[],
): ObjectiveCounter | null {
  for (const criterion of criteria) {
    switch (criterion.type) {
      case 'skill_level_at_least': {
        const skill = snapshot.skills.find((entry) => entry.id === criterion.skillId);
        // A skill the game does not register is not a counter reading zero; it
        // is no reading at all, and the objective will be aborted for that by
        // its executor rather than escalated as a stall by this.
        if (skill === undefined) continue;
        return { label: `${skill.name} xp`, value: skill.xp };
      }
      case 'item_qty_at_least':
        return {
          label: `${criterion.itemId} in the bank`,
          value: bankQuantity(snapshot, criterion.itemId),
        };
      case 'currency_at_least':
        return {
          label: criterion.currencyId,
          value: currencyAmount(snapshot, criterion.currencyId),
        };
    }
  }
  return null;
}

/**
 * Verified actions in a row, with a flat counter, before the alarm.
 *
 * Both this and {@link NO_MOVEMENT_MS} must be exceeded, and the pair is
 * deliberately conservative: the cost of a false alarm here is a replan issued
 * against a healthy objective, which throws away an objective that was working.
 *
 * Eight rounds alone is not enough evidence. The policy tier evaluates every
 * three seconds, so eight successful rounds can pass in twenty-four seconds,
 * and there are entirely healthy objectives that produce nothing measurable in
 * that window — a dungeon floor, a long Summoning craft, a fight against
 * something with a lot of hitpoints.
 */
export const NO_MOVEMENT_SUCCESSES = 8;

/**
 * How long the counter must stay flat, alongside {@link NO_MOVEMENT_SUCCESSES}.
 *
 * Five minutes is longer than any single action cycle in this game and shorter
 * than the fifteen minutes `detectStuck` waits on total level and GP. That gap
 * is the point of this detector sitting beside that one rather than replacing
 * it: `detectStuck` asks whether the *character* is going anywhere, which
 * Township ticking in the background can answer for it, while this asks whether
 * the number *this objective* was chosen to move has moved.
 */
export const NO_MOVEMENT_MS = 5 * 60_000;

/** What one round of verified actions says about the objective's counter. */
export type MovementVerdict =
  /** A new objective, or a new counter: the episode starts here. */
  | { kind: 'restarted' }
  /** The counter moved since the last round. The objective is working. */
  | { kind: 'moved' }
  /** Flat so far, but not yet past both thresholds. */
  | { kind: 'watching' }
  /** Actions keep succeeding and the counter has not moved. */
  | { kind: 'stalled'; label: string; value: number; successes: number; forMs: number };

/**
 * Watches the counter an objective's success condition names across rounds of
 * verified actions.
 *
 * Fed only by rounds where *every* action succeeded. A failing objective is
 * already handled — the runtime abandons it after five consecutive failures —
 * and the failure this catches is the opposite one: the game accepting every
 * call and the objective achieving nothing.
 *
 * Pure and separate from `Agent` so the thresholds are pinned by a test rather
 * than living in a private method, the way `progressMarker` was silently wrong
 * for a day inside one.
 */
export class NoMovementWatch {
  private episode: {
    objectiveId: string;
    label: string;
    value: number;
    successes: number;
    since: number;
  } | null = null;

  /**
   * Records one round in which every action the objective issued succeeded.
   *
   * @param objectiveId - The objective those actions belonged to.
   * @param counter - The counter reading taken for this round.
   * @param now - Wall clock, in epoch milliseconds.
   * @returns What this round says about the objective.
   */
  recordSuccess(objectiveId: string, counter: ObjectiveCounter, now: number): MovementVerdict {
    const episode = this.episode;

    if (
      episode === null ||
      episode.objectiveId !== objectiveId ||
      episode.label !== counter.label
    ) {
      this.episode = {
        objectiveId,
        label: counter.label,
        value: counter.value,
        successes: 1,
        since: now,
      };
      return { kind: 'restarted' };
    }

    if (counter.value !== episode.value) {
      this.episode = {
        objectiveId,
        label: counter.label,
        value: counter.value,
        successes: 1,
        since: now,
      };
      return { kind: 'moved' };
    }

    episode.successes += 1;
    const forMs = now - episode.since;
    if (episode.successes < NO_MOVEMENT_SUCCESSES || forMs < NO_MOVEMENT_MS) {
      return { kind: 'watching' };
    }

    // Re-armed from here rather than latched, so a stall that outlives its
    // replan escalates once per window instead of on every subsequent tick.
    // That is the same drown-the-signal failure the stuck reporter and the
    // reflex backoff were both written for, in the one place whose entire job
    // is to be noticed.
    this.episode = {
      objectiveId,
      label: counter.label,
      value: counter.value,
      successes: 1,
      since: now,
    };
    return {
      kind: 'stalled',
      label: counter.label,
      value: counter.value,
      successes: episode.successes,
      forMs,
    };
  }

  /**
   * Forgets the current episode.
   *
   * Called on any action failure: "succeeding and going nowhere" is a different
   * claim from "failing", and mixing rounds of the two would let a run of
   * refusals count towards an alarm about success.
   */
  reset(): void {
    this.episode = null;
  }
}

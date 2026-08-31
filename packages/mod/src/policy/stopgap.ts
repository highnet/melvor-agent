import type { Candidate, Objective } from '@melvor-agent/shared';

/**
 * How long the agent will wait for a planning session before acting anyway.
 *
 * Long enough that a session which is merely thinking gets to finish, short
 * enough that an unattended night is not spent standing still. Ninety seconds
 * of idling is nothing; ninety seconds repeated for eight hours is the whole
 * run.
 */
export const STOPGAP_DELAY_MS = 90_000;

/** How long a stopgap objective runs before the agent asks for a plan again. */
const STOPGAP_MINUTES = 30;

/**
 * Chooses something to do when no planning session has answered.
 *
 * The agent is meant to be *planned*, not steered by a scoring function — that
 * is the whole architecture, and this does not change it. What it changes is
 * the failure mode when nobody is there: an unplanned agent used to stand
 * still, which converts every gap in coverage into hours of nothing.
 *
 * So this is deliberately the dumbest defensible choice: the highest-XP
 * sustained action available. It is not trying to be a planner and should not
 * be improved into one. Its only job is to make the floor "some progress"
 * rather than "no progress", and every stopgap objective is short and says in
 * its rationale that it is a stopgap, so a session that arrives later replaces
 * it within half an hour.
 *
 * Only sustained work qualifies. A one-shot — buying, equipping, toggling — is
 * a *decision*, and making decisions without a planner is exactly the greedy
 * behaviour this project exists to avoid; a stopgap that bought things would
 * spend the bank on whatever was cheapest.
 *
 * @param candidates - What the mod has proven it can do right now.
 * @param now - Wall clock, for the objective id.
 * @returns An objective to run, or null when nothing sustained is available.
 */
export function chooseStopgap(candidates: readonly Candidate[], now: number): Objective | null {
  const sustained = candidates.filter((candidate) => candidate.kind === 'gather_resource');
  if (sustained.length === 0) return null;

  // Producers before consumers. The highest-XP action available is usually an
  // artisan one — Firemaking burns logs at 96,000 xp/h — and left unattended it
  // converts a bank the agent spent hours filling into nothing but XP. A
  // candidate that earns GP is producing something; one that does not is
  // consuming what a planner may have been saving.
  const earners = sustained.filter((candidate) => (candidate.gpPerHour ?? 0) > 0);
  const pool = earners.length > 0 ? earners : sustained;

  const best = pool.reduce((leader, candidate) =>
    (candidate.xpPerHour ?? 0) > (leader.xpPerHour ?? 0) ? candidate : leader,
  );

  const skillId = (best.params as { skillId?: string }).skillId;

  return {
    id: `stopgap-${now}`,
    kind: best.kind,
    params: best.params,
    // No success criterion: a stopgap is not trying to reach anything. It runs
    // until its budget expires, which is what triggers the next replan.
    successWhen: [],
    abortWhen: { minutesExceed: STOPGAP_MINUTES },
    expectedDurationMin: STOPGAP_MINUTES,
    rationale: `stopgap: no planning session answered, so running the best sustained action available (${best.label}). A real plan should replace this.${
      skillId === undefined ? '' : ` Training ${skillId}.`
    }`,
  };
}

import { type Candidate, type Objective, levelsPerHour } from '@melvor-agent/shared';

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
 * So this is deliberately the dumbest defensible choice: the sustained action
 * that gains the most *levels* per hour. It is not trying to be a planner and
 * should not be improved into one.
 *
 * Levels, not XP, and that is the whole of the change. Ranking by XP per hour
 * silently prefers whichever skill is already highest, because a level costs
 * more XP the further up the curve it sits. Left to it, the stopgap picked
 * Mahogany on a level-60 Woodcutting and scored 0.78x the control condition —
 * losing to the very thing the metric compares against, while Ranged and Magic
 * sat at level 1 nearby. Same rule, same lack of ambition, correct unit. Its only job is to make the floor "some progress"
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
 * @param skillXp - Current XP per skill, to compare candidates in levels rather
 *   than in XP. An unknown skill is treated as zero XP, which flatters an
 *   untrained one — acceptable, because an untrained skill genuinely is where
 *   the cheap levels are.
 * @param now - Wall clock, for the objective id.
 * @returns An objective to run, or null when nothing sustained is available.
 */
export function chooseStopgap(
  candidates: readonly Candidate[],
  skillXp: ReadonlyMap<string, number>,
  now: number,
): Objective | null {
  // Before falling back to grinding, take anything that is free.
  //
  // The rule this bends is "a stopgap makes no decisions", and it bends it only
  // where there is no decision to make: claiming a finished task and opening a
  // container spend nothing, forfeit nothing, and are strictly better done than
  // left. Leaving them is how an unattended agent sat on sixteen bird nests for
  // a whole session while the seeds inside were the one thing blocking Farming.
  //
  // Anything that spends — buying, selling, equipping, burying — stays out.
  // Those are judgements about what to give up, and a scoring function making
  // them unattended is the greedy behaviour this whole design refuses.
  const free = candidates.find(
    (candidate) =>
      candidate.kind === 'claim_township_task' ||
      candidate.kind === 'claim_casual_task' ||
      candidate.kind === 'open_item',
  );

  if (free !== undefined) {
    return {
      id: `stopgap-free-${now}`,
      kind: free.kind,
      params: free.params,
      successWhen: [],
      abortWhen: { minutesExceed: 5 },
      expectedDurationMin: 1,
      rationale: `stopgap: taking a free action that costs nothing and is strictly better done than left (${free.label}). A real plan should still replace this.`,
    };
  }

  const sustained = candidates.filter((candidate) => candidate.kind === 'gather_resource');
  if (sustained.length === 0) return null;

  // Producers before consumers. The highest-XP action available is usually an
  // artisan one — Firemaking burns logs at 96,000 xp/h — and left unattended it
  // converts a bank the agent spent hours filling into nothing but XP. A
  // candidate that earns GP is producing something; one that does not is
  // consuming what a planner may have been saving.
  const earners = sustained.filter((candidate) => (candidate.gpPerHour ?? 0) > 0);
  const pool = earners.length > 0 ? earners : sustained;

  const rate = (candidate: Candidate): number => {
    const skillId = (candidate.params as { skillId?: string }).skillId;
    if (skillId === undefined) return 0;
    return levelsPerHour(skillXp.get(skillId) ?? 0, candidate.xpPerHour ?? 0);
  };

  const best = pool.reduce((leader, candidate) =>
    rate(candidate) > rate(leader) ? candidate : leader,
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
    rationale: `stopgap: no planning session answered, so running the sustained action that gains the most levels per hour (${best.label}, about ${rate(best).toFixed(2)} levels/hour). A real plan should replace this.${
      skillId === undefined ? '' : ` Training ${skillId}.`
    }`,
  };
}

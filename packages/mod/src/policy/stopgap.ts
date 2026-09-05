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
 * The one ranking that outranks levels per hour is a Township task, on the
 * operator's stated rule *"otherwise do township tasks"*. That is still not a
 * decision this function makes: the task is the game's own advice about what
 * to do next and it states its own quantity. See the comment at the filter.
 *
 * @param candidates - What the mod has proven it can do right now.
 * @param skillXp - Current XP per skill, to compare candidates in levels rather
 *   than in XP. An unknown skill is treated as zero XP, which flatters an
 *   untrained one — acceptable, because an untrained skill genuinely is where
 *   the cheap levels are.
 * @param now - Wall clock, for the objective id.
 * @returns An objective to run, or null when nothing sustained is available.
 */
/**
 * Hours of work still owed on the Township task a candidate would fill.
 *
 * `quantity` is an absolute bank target and `have` is what is banked, so the
 * difference is the work left; `produces.perHour` is the candidate's own
 * expectation, carrying the same mastery and yield terms as the rate printed
 * beside it. Infinity for anything that is not both — the callers filter those
 * out first, and a sentinel that sorts last is the safe reading if one slips
 * through.
 */
function hoursLeft(candidate: Candidate): number {
  const wanted = candidate.suggestedStock;
  const perHour = candidate.produces?.perHour ?? 0;
  if (wanted === undefined || perHour <= 0) return Number.POSITIVE_INFINITY;

  return Math.max(0, wanted.quantity - wanted.have) / perHour;
}

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

  const startable = candidates.filter((candidate) => candidate.kind === 'gather_resource');
  if (startable.length === 0) return null;

  // "Sustained" has to mean the inputs last, not merely that the *kind* of
  // action is the sort that runs. Unattended, this picked `Runecrafting: Smoke
  // Rune` for a thirty-minute budget: the craft started, ran for three seconds,
  // and was refused for missing materials -- twice, having done the identical
  // thing with Alt Magic's Item Alchemy a minute earlier. Both candidates
  // announced it in their own labels, "inputs run out almost immediately", and
  // nothing here was reading that.
  //
  // `canAfford` was not the gap and filtering harder on it would not have
  // helped: one action *was* affordable, which is the only question it asks.
  // The horizon is the question a thirty-minute objective needs answered.
  //
  // A missing horizon is no limit rather than unknown -- gathering consumes
  // nothing -- so this never empties a board that has a tree on it. If it does
  // empty, the unfiltered pool is used anyway: a guard that leaves the agent
  // with nothing to do has replaced a bad half hour with an idle one.
  const lasting = startable.filter(
    (candidate) => (candidate.sustainMinutes ?? Number.POSITIVE_INFINITY) >= STOPGAP_MINUTES,
  );
  const sustained = lasting.length > 0 ? lasting : startable;

  // Producers before consumers. The highest-XP action available is usually an
  // artisan one — Firemaking burns logs at 96,000 xp/h — and left unattended it
  // converts a bank the agent spent hours filling into nothing but XP. A
  // candidate that earns GP is producing something; one that does not is
  // consuming what a planner may have been saving.
  const earners = sustained.filter((candidate) => (candidate.gpPerHour ?? 0) > 0);
  const pool = earners.length > 0 ? earners : sustained;

  // Township tasks before levels, which is the operator's rule stated plainly:
  // "otherwise do township tasks".
  //
  // The stopgap has only ever adopted gathering ranked by levels per hour, so
  // nothing built the town unattended — and Township is the skill the skilling
  // outfits sit behind, which is a permanent multiplier on every skill the run
  // will spend the rest of its life training. A task also states its own
  // finish line, so this is the one stopgap that can end on an achievement
  // rather than on its budget expiring.
  //
  // It stays inside the pool above rather than beside it, so every guard the
  // pool applies still holds: the inputs must last the half hour, and a
  // consumer is still not adopted over a producer. This reorders a filtered
  // list; it does not widen it.
  //
  // Not a decision the stopgap invented. The task is the *game's* own advice
  // about what to do next, the quantity is the task's own, and the candidate
  // was already carrying both — `suggestedStock` reached nothing but a label.
  //
  // Restricted to candidates that price their own output, because the ranking
  // below is in hours and a candidate with no `produces.perHour` cannot say
  // how long its task would take. Ranking those by units left instead would
  // put 100 Bones above 5,000 fish without knowing that the fish arrive seven
  // times faster — a comparison across two different units, which is how this
  // repo got a mining rate that advertised 120,000 GP/h and realised 10,800.
  const forTown = pool.filter(
    (candidate) =>
      candidate.suggestedStock?.source === 'township_task' &&
      (candidate.produces?.perHour ?? 0) > 0,
  );
  if (forTown.length > 0) {
    // The one nearest done, in hours of work left. Finishing a task pays;
    // being a third of the way through three of them pays nothing.
    const nearest = forTown.reduce((leader, candidate) =>
      hoursLeft(candidate) < hoursLeft(leader) ? candidate : leader,
    );
    const wanted = nearest.suggestedStock;

    if (wanted !== undefined) {
      return {
        id: `stopgap-town-${now}`,
        kind: nearest.kind,
        params: nearest.params,
        // A real finish line, unlike every other stopgap objective. The
        // criterion doubles as a sale guard: `stockTargetsOf` reserves exactly
        // what the objective named, so the liquidation reflex cannot sell the
        // fish out from under the task that wants them.
        successWhen: [{ type: 'item_qty_at_least', itemId: wanted.itemId, qty: wanted.quantity }],
        abortWhen: { minutesExceed: STOPGAP_MINUTES },
        expectedDurationMin: STOPGAP_MINUTES,
        rationale: `stopgap: no planning session answered, so working the Township task nearest to done (${nearest.label}) — ${wanted.quantity.toLocaleString()}x ${wanted.name} wanted, ${wanted.have.toLocaleString()} banked. A real plan should replace this.`,
      };
    }
  }

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

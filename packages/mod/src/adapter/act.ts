import { type ActionResult, fail, ok } from '@melvor-agent/shared';
import { noteSwallowed, recordStuck } from './safe.js';

/**
 * Options for a single verified action.
 *
 * @typeParam T - The projection of game state this action claims to change.
 */
export interface ActSpec<T> {
  /** Stable name, used in logs and in the ActionResult. */
  name: string;
  /** Cheap, pure projection of the state this action intends to change. */
  observe: () => T;
  /**
   * Return a reason to refuse, or null to proceed.
   *
   * A bare string is a refusal about the current state, which the runtime
   * treats as final. `{ wait }` is a refusal the passage of time will lift on
   * its own — a town regenerating resources, a crop still growing — and the
   * runtime waits instead of abandoning the objective.
   */
  precondition?: () => string | { wait: string } | null;
  /** The raw game call. Its return value, if any, is captured as evidence. */
  perform: () => unknown;
  /** True when `after` reflects the intended change. */
  changed: (before: T, after: T) => boolean;
}

/**
 * Runs a game action and returns evidence that it worked.
 *
 * A game call returning without throwing does not mean it worked: requirements
 * can be unmet, the wrong screen can be open, an offline tick can swallow it.
 * Worse, the game's own return conventions are inconsistent —
 * `Player.equipItem` returns boolean, `Player.equipFood` returns
 * `boolean | undefined`, and `Bank.removeItemQuantity` and
 * `Woodcutting.selectTree` return `void`. So the return value is recorded as
 * *supporting* detail, never as the verdict; the verdict is the before/after diff.
 *
 * One result is a fact about one call. A *run* of them is a different claim,
 * and nothing above the adapter was keeping the count. Two ledgers do:
 * `noteNoChange` for an action failing repeatedly against a projection that
 * never moves, and `noteRedone` for one succeeding repeatedly from a state it
 * keeps being returned to. Each appends its finding to the result detail once,
 * on the transition — never on every pass, which is how two real diagnostics
 * have already been buried here.
 *
 * @param spec - What to observe, what to call, and what counts as changed.
 * @param isSuspended - Guard: refuses to act while offline progress is resolving.
 * @returns Success carrying before/after evidence, or a typed failure.
 */
export function act<T>(spec: ActSpec<T>, isSuspended: () => boolean): ActionResult<T> {
  if (isSuspended()) {
    return fail<T>(spec.name, 'suspended', 'game is inside its offline-progress loop');
  }

  const refusal = spec.precondition?.() ?? null;
  if (refusal !== null && typeof refusal === 'object') {
    return fail<T>(spec.name, 'not_yet', refusal.wait);
  }
  if (refusal !== null) {
    return fail<T>(spec.name, 'precondition', refusal);
  }

  let before: T;
  try {
    before = spec.observe();
  } catch (error) {
    return fail<T>(spec.name, 'threw', `observe() before: ${describe(error)}`);
  }

  let returned: unknown;
  try {
    returned = spec.perform();
  } catch (error) {
    return fail<T>(spec.name, 'threw', describe(error));
  }

  let after: T;
  try {
    after = spec.observe();
  } catch (error) {
    return fail<T>(spec.name, 'threw', `observe() after: ${describe(error)}`);
  }

  if (!spec.changed(before, after)) {
    // An explicit `false` return distinguishes "the game refused" from "the
    // game silently did nothing", which is worth keeping for diagnosis.
    const hint = returned === false ? ' (game call returned false)' : '';
    const beforeJson = safeJson(before);
    const note = noteNoChange(spec.name, beforeJson);
    return fail<T>(
      spec.name,
      'no_state_change',
      `state unchanged after call${hint}: ${beforeJson} -> ${safeJson(after)}${note}`,
    );
  }

  forgetNoChange(spec.name);
  const churn = noteRedone(spec.name, safeJson(before));
  return ok(
    spec.name,
    before,
    after,
    [returned === undefined ? undefined : `returned ${safeJson(returned)}`, churn]
      .filter((part) => part !== undefined && part !== '')
      .join('') || undefined,
  );
}

/**
 * One action's run of no-change failures since it last worked.
 *
 * `repeats` is the run of *identical* `before` projections and is the signal
 * this ledger exists for. `run` counts every consecutive no-change for the
 * action whatever the projection, and exists because a projection carrying a
 * value that moves every tick would reset `repeats` forever and quietly
 * disable the detector — which is the same class of bug being caught.
 */
interface NoChangeRun {
  projection: string;
  repeats: number;
  reported: boolean;
  run: number;
  runReported: boolean;
}

/**
 * How many identical no-change failures before the ledger says so.
 *
 * This only *reports*; it never refuses, so the number is a noise threshold
 * rather than a bound on behaviour. Refusing would be the dangerous half: a
 * legitimately retried action — waiting on a respawn, a cooldown, a tick
 * boundary — produces exactly this shape, and an adapter that starts declining
 * real work is worse than one that is noisy.
 *
 * Five, and not more, because the tier above forgets faster than that:
 * `ACTION_FAILURE_LIMIT` in `runtime/agent.ts` abandons an objective after five
 * consecutive failures, so a threshold above five would never be reached by an
 * objective at all — and two of the four loops this exists for (Agility, Alt
 * Magic) were objectives, re-adopted after each abandonment. The ledger's own
 * value is that it survives those replans: `altMagic.cast` failed five times in
 * fifteen seconds, was abandoned, was re-planned, and did it again all day.
 *
 * Five is also cheap in the other direction. `reflex.repairTownship` fires
 * once a minute, so five is five minutes of a day-long loop.
 */
const IDENTICAL_LIMIT = 5;

/**
 * The same, for a run whose projection is never twice the same.
 *
 * Checked against the real projections: most are stable ids and counts, but
 * `equipment.eatFood` carries live hitpoints (`equipment.ts`), `combat.loot`
 * carries the pending drop count, and the mastery projection carries pool XP.
 * A loop in one of those would move the projection on every pass and never
 * repeat, so `IDENTICAL_LIMIT` could not see it.
 *
 * Deliberately much larger, because a moving projection is weaker evidence: an
 * action that changes *something* on every pass may well be making progress
 * the `changed` predicate is too narrow to credit. Forty consecutive is still
 * forty calls that bought nothing the predicate can name.
 */
const MOVING_LIMIT = 40;

/**
 * How many actions the ledger tracks at once.
 *
 * Entries are keyed by action name, and the names are a fixed set of literals
 * (`township.build`, `reflex.repairTownship`) plus a handful built from skill
 * ids — bounded by the adapter's own surface, not by how long the process has
 * run. The cap is belt and braces against a future dynamic name turning a
 * ledger into a leak in a process that runs for days.
 *
 * Eviction is least-recently-updated, and its cost is stated plainly: evicting
 * a run in progress restarts its count, so a report is delayed rather than
 * lost. That only happens with more than this many actions failing at once,
 * which is a bigger problem than the one being reported.
 */
const MAX_TRACKED = 64;

const noChangeRuns = new Map<string, NoChangeRun>();

/**
 * Records a no-change failure and returns a note to append, once.
 *
 * Two of the four loops found on 2026-09-03 land here: `altMagic.cast` failing
 * every two seconds, and `reflex.repairTownship` once a minute for a whole day.
 * Both produced a truthful `no_state_change` on their very first call, and
 * nothing remembered the second one; both were found by a human reading a log,
 * hours later. The shape is that the call reads a selection it does not take,
 * and for an agent that never clicks a UI that selection is absent.
 *
 * `reflex.refillFood` — 232 identical no-change warnings in one run, never
 * investigated — is a third that had been sitting in the logs unrecognised.
 * The other two loops reported `ok` rather than failing at all; `noteRedone`
 * below is what covers those.
 *
 * So the ledger is `act` itself rather than a guard per action: one place that
 * notices the same call failing against the same unmoved projection, and says
 * so on the transition instead of on every pass. This project has twice had a
 * real diagnostic buried by a report that fired every tick — the settings write
 * looping at 3s, and `reflex.refillFood` warning 232 times in one run — so the
 * once-ness is not politeness, it is what makes the line readable at all.
 *
 * @param name - The action's stable name.
 * @param projection - `before`, serialised; the state that did not move.
 * @returns A note to append to the failure detail, or '' on every other call.
 */
function noteNoChange(name: string, projection: string): string {
  const previous = noChangeRuns.get(name);
  const entry: NoChangeRun =
    previous === undefined || previous.projection !== projection
      ? {
          projection,
          repeats: 1,
          reported: false,
          run: (previous?.run ?? 0) + 1,
          runReported: previous?.runReported ?? false,
        }
      : { ...previous, repeats: previous.repeats + 1, run: previous.run + 1 };

  // Re-inserting keeps Map iteration order as least-recently-updated first,
  // which is what the eviction below relies on.
  noChangeRuns.delete(name);
  noChangeRuns.set(name, entry);
  evictOldest(noChangeRuns);

  if (entry.repeats >= IDENTICAL_LIMIT && !entry.reported) {
    entry.reported = true;
    return report(
      name,
      `${name} has now failed ${entry.repeats} times in a row against an identical projection — the call may read a selection it does not take (see learnings/game-state.md)`,
    );
  }

  if (entry.run >= MOVING_LIMIT && !entry.runReported) {
    entry.runReported = true;
    return report(
      name,
      `${name} has now failed ${entry.run} times in a row while its projection kept moving — either the call achieves nothing, or \`changed\` is too narrow to credit what it does`,
    );
  }

  return '';
}

/** Clears an action's run. Success is the only evidence that it is unstuck. */
function forgetNoChange(name: string): void {
  noChangeRuns.delete(name);
}

/**
 * One action's run of successes that all started from the same state.
 */
interface RedoneRun {
  projection: string;
  repeats: number;
  since: number;
  reported: boolean;
}

/**
 * How many identical re-dos before the ledger says so, and how fast.
 *
 * This half exists because the brief's premise did not survive the logs. Two
 * of the four loops never produced a `no_state_change` at all — they reported
 * `ok`, with real before/after evidence, every single time:
 *
 *   equipment.equip ok — itemId "melvorF:Staff_of_Air" -> "melvorD:Steel_Scimitar"
 *   {"slot":"melvorD:Weapon","itemId":"melvorF:Staff_of_Air","quantity":1} -> {...Steel_Scimitar}
 *
 * every 3s for forty minutes, and `agility.run` with
 * `{"active":false,...} -> {"active":true,...}` every six seconds for a
 * fifteen-minute stretch that earned no XP. The evidence was true both times.
 * What gives it away is that the *before* is identical on every pass: the
 * change is real and something puts it back, so the work is being redone
 * rather than done.
 *
 * The window is what separates that from ordinary repetition. A building
 * degrades and is repaired again from the same efficiency, which is correct and
 * happens minutes apart; a tier fighting another tier repeats inside seconds.
 * Five identical re-dos in a minute is a loop by any reading — Agility managed
 * five in fifteen seconds, the gear reflex in seven and a half.
 */
const REDONE_LIMIT = 5;
const REDONE_WINDOW_MS = 60_000;

const redoneRuns = new Map<string, RedoneRun>();

/**
 * Records a success and returns a note to append, once.
 *
 * Weaker evidence than a no-change run, and deliberately treated as such: a
 * legitimate repeat is possible, so this reports and never refuses, and it
 * reports once per run rather than once per pass. `StuckEquipWatch`
 * (`runtime/stuck-equip.ts`) still owns the *bounding* of the equip case — it
 * knows which item the reflex asked for, which `act` cannot see.
 *
 * @param name - The action's stable name.
 * @param projection - `before`, serialised; the state the action started from.
 * @returns A note to append to the success detail, or '' on every other call.
 */
function noteRedone(name: string, projection: string): string {
  const now = Date.now();
  const previous = redoneRuns.get(name);
  const continues =
    previous !== undefined &&
    previous.projection === projection &&
    now - previous.since <= REDONE_WINDOW_MS;

  const entry: RedoneRun = continues
    ? { ...previous, repeats: previous.repeats + 1 }
    : { projection, repeats: 1, since: now, reported: false };

  redoneRuns.delete(name);
  redoneRuns.set(name, entry);
  evictOldest(redoneRuns);

  if (entry.repeats >= REDONE_LIMIT && !entry.reported) {
    entry.reported = true;
    return report(
      name,
      `${name} has now succeeded ${entry.repeats} times in a row from an identical starting state within ${Math.round((now - entry.since) / 1000)}s — something is undoing it, so the work is being redone rather than done`,
    );
  }

  return '';
}

function evictOldest(runs: Map<string, unknown>): void {
  while (runs.size > MAX_TRACKED) {
    const oldest = runs.keys().next();
    if (oldest.done === true) return;
    runs.delete(oldest.value);
  }
}

/**
 * Emits one finding, on the transition, to all three places it has to reach.
 *
 * The detail note is for the log, the warning is for whoever has the game open,
 * and `recordStuck` is what puts it on the panel and in the state summary. Only
 * the third is new, and it is the one that matters: the detail travels inside
 * the policy tier's structured payload rather than its message, so before this
 * a `STUCK` line could be grepped out of `data/logs/*.jsonl` and was visible
 * nowhere a person actually looks. A detector nobody reads until after the next
 * day-long loop is the failure it was built to prevent.
 *
 * Called only from the two `!reported` transitions above, which is what keeps
 * the counter meaningful: it counts stuck runs, not stuck passes.
 *
 * @param name - The action's stable name, used as the report's site.
 * @param message - The ledger's finding.
 * @returns The note to append to the result detail.
 */
function report(name: string, message: string): string {
  console.warn(`[play-agent] ${message}`);
  recordStuck(name, message);
  return ` — STUCK: ${message}`;
}

/** Test seam; the agent never resets this. */
export function resetActLedger(): void {
  noChangeRuns.clear();
  redoneRuns.clear();
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (error) {
    noteSwallowed('act.safeJson', error);
    return String(value);
  }
}

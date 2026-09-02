/**
 * Guarded reads of game state, counted so a failure is visible.
 *
 * The adapter is full of `try { ... } catch { return fallback; }`, and that is
 * the right shape: game getters throw in states the agent legitimately runs in
 * — `Mining.actionInterval` refuses to answer with no rock selected, and
 * candidate enumeration is precisely when nothing is selected. Swallowing those
 * is deliberate.
 *
 * What was wrong is that swallowing them was *silent*. Around a hundred bare
 * catches sat against exactly one that reported anything, so when the game
 * renames an accessor the symptoms are a candidate quietly vanishing from the
 * list and a rate quietly falling back to its nominal value — with no signal
 * anywhere, in a system whose whole diagnostic loop is "compare the advertised
 * number against the realised one". A rate that fell back is not a rate that is
 * wrong; it is a rate nobody can tell is wrong.
 *
 * So every guarded read names its site and increments a counter, and the
 * counters ride out on the report. Behaviour is unchanged: the same value comes
 * back from the same fallback. The only new thing is that somebody can see it.
 *
 * Sites are named `file.what` (`candidates.thievingSuccessRate`), because the
 * useful question is which reading stopped working, not which line.
 */

/** One site's failure tally, with the most recent reason. */
export interface AdapterFailure {
  site: string;
  count: number;
  /** The last error's message, for telling a rename from a transient state. */
  lastError: string;
}

const failures = new Map<string, AdapterFailure>();

/**
 * Warned-about sites, so the log is not flooded.
 *
 * These reads run on every policy tick. A warning per occurrence would emit
 * thousands an hour into a 300-record queue and evict every real diagnostic
 * before it could ship — which has happened here before, from a settings write
 * looping at 3s. The count is the durable signal; the log line is the pointer.
 */
const warned = new Set<string>();

function record(site: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const existing = failures.get(site);

  if (existing === undefined) {
    failures.set(site, { site, count: 1, lastError: message });
  } else {
    existing.count += 1;
    existing.lastError = message;
  }

  if (!warned.has(site)) {
    warned.add(site);
    console.warn(`[play-agent] guarded read failed at ${site}:`, error);
  }
}

/**
 * Every site that has failed, worst first.
 *
 * Cumulative for the run rather than drained per report, because the question
 * an operator asks at 8am is "what has been failing all night", and a counter
 * that resets every three seconds cannot answer it.
 */
export function readAdapterFailures(): AdapterFailure[] {
  return [...failures.values()].sort((a, b) => b.count - a.count);
}

/** Test seam; the agent never resets these. */
export function resetAdapterFailures(): void {
  failures.clear();
  warned.clear();
}

/**
 * Counts an exception a caller is deliberately swallowing.
 *
 * For the catches that cannot become a `safeX` call without changing control
 * flow — the `continue` inside a registry loop, the `return []` around a whole
 * enumeration. Those are the ones that matter most, because skipping one
 * malformed entry is how a candidate disappears from the list with the run
 * otherwise looking healthy. The block keeps its shape; it just stops being
 * silent.
 */
export function noteSwallowed(site: string, error: unknown): void {
  record(site, error);
}

/**
 * Counts a fallback that no exception announced.
 *
 * Not every silent failure throws. A chain of getters that all return zero, or
 * a registry lookup that finds nothing, lands on the same fallback as a throw
 * and is exactly as invisible — and for the reads this module exists for, the
 * fallback *is* the symptom. The caller decides what counts.
 */
export function recordFallback(site: string, why: string): void {
  record(site, new Error(why));
}

/** A read that may throw. `undefined` means it did, or that it had no answer. */
export function safeValue<T>(site: string, read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    record(site, error);
    return undefined;
  }
}

/**
 * A numeric read, falling back on a throw or an unusable value.
 *
 * Non-finite counts as a failure, deliberately. A NaN interval divides into an
 * infinite rate and pins that recipe to the top of the board forever, so it is
 * not a number that happens to be odd — it is a read that did not work, and it
 * should be counted as one.
 */
export function safeNumber(site: string, read: () => number | undefined, fallback: number): number {
  try {
    const value = read();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value === undefined) return fallback;

    record(site, new Error(`unusable number: ${String(value)}`));
    return fallback;
  } catch (error) {
    record(site, error);
    return fallback;
  }
}

/** A list read, falling back to empty. */
export function safeList<T>(site: string, read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    record(site, error);
    return [];
  }
}

/** A boolean read. A guess either way is wrong, so the caller names the default. */
export function safeBoolean(site: string, read: () => boolean, fallback: boolean): boolean {
  try {
    return read();
  } catch (error) {
    record(site, error);
    return fallback;
  }
}

/** A string read, falling back to empty — a missing name reads as absent, not wrong. */
export function safeText(site: string, read: () => string): string {
  try {
    return read();
  } catch (error) {
    record(site, error);
    return '';
  }
}

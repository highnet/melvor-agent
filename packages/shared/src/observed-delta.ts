import type { ActionResult } from './action-result.js';

/**
 * A described change between the two projections a successful action observed.
 *
 * `ActionResult` has always carried `observed.before` and `observed.after`, and
 * nothing above the adapter ever read them: the runtime branched on `ok` and
 * logged the object. That made every verification a property of one adapter
 * closure's `changed()`, and a wrong `changed` invisible to every layer above
 * it. Both of this project's worst rate bugs had exactly that shape — Agility
 * reporting `ok` on every tick while delivering no XP at all.
 *
 * This is the smallest honest thing that can be built out of a heterogeneous
 * projection: say what moved and by how much where the two shapes can be
 * compared, and say nothing where they cannot. A delta invented for a shape it
 * does not fit would be worse than silence, because the whole point of the
 * evidence is that it is not a claim.
 */
export interface ObservedDelta {
  /** Human-readable magnitudes, e.g. `qty +12, active false -> true`. */
  detail: string;
  /**
   * Numeric field deltas keyed by field path, for callers that need arithmetic
   * rather than prose. Empty when the projection held no comparable numbers.
   */
  magnitudes: Readonly<Record<string, number>>;
}

/**
 * How deep into a nested projection the summariser will walk.
 *
 * Three levels covers every projection the adapter currently returns and bounds
 * the cost of a summary that runs on every verified action. Deeper structures
 * are described down to this depth rather than not at all.
 */
const MAX_DEPTH = 3;

/**
 * Describes what changed between an action's before and after projections.
 *
 * @param before - The projection taken before the game call.
 * @param after - The projection taken after it.
 * @returns The described change, or null when the two shapes support no honest
 *          comparison — differing types, unreadable values, or nothing moved.
 */
export function summariseObserved(before: unknown, after: unknown): ObservedDelta | null {
  const parts: string[] = [];
  const magnitudes: Record<string, number> = {};
  walk('', before, after, 0, parts, magnitudes);
  if (parts.length === 0) return null;
  return { detail: parts.join(', '), magnitudes };
}

/**
 * The same summary, taken straight off an action result.
 *
 * @param result - What an adapter action returned.
 * @returns The described change on success, or null for a failure (which
 *          carries no observation) or an incomparable projection.
 */
export function summariseResult<T>(result: ActionResult<T>): ObservedDelta | null {
  if (!result.ok) return null;
  return summariseObserved(result.observed.before, result.observed.after);
}

function walk(
  path: string,
  before: unknown,
  after: unknown,
  depth: number,
  parts: string[],
  magnitudes: Record<string, number>,
): void {
  const prefix = path === '' ? '' : `${path} `;

  if (typeof before === 'number' && typeof after === 'number') {
    // A projection that reads NaN — a getter answering in a state it does not
    // like — has no magnitude, and `NaN - NaN` would be reported as "no change"
    // by any comparison that did not check. That is the exact reading this
    // summariser exists to refuse to make up.
    if (!Number.isFinite(before) || !Number.isFinite(after)) return;
    const delta = after - before;
    if (delta === 0) return;
    magnitudes[path === '' ? 'value' : path] = delta;
    parts.push(`${prefix}${delta > 0 ? '+' : ''}${formatNumber(delta)}`);
    return;
  }

  if (typeof before === 'boolean' && typeof after === 'boolean') {
    if (before === after) return;
    parts.push(`${prefix}${before} -> ${after}`);
    return;
  }

  if (typeof before === 'string' && typeof after === 'string') {
    if (before === after) return;
    parts.push(`${prefix}"${before}" -> "${after}"`);
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Length, and only length. Comparing elements would need an identity for
    // them that the projection does not supply — `recipeIds` is a list of ids
    // and `equipment` a list of slots, and treating position as identity would
    // report a reordering as a change.
    if (before.length === after.length) return;
    const key = path === '' ? 'length' : `${path}.length`;
    const delta = after.length - before.length;
    magnitudes[key] = delta;
    parts.push(`${prefix}${before.length} -> ${after.length} entries`);
    return;
  }

  if (isRecord(before) && isRecord(after)) {
    if (depth >= MAX_DEPTH) return;
    for (const key of Object.keys(before)) {
      // Keys on one side only are skipped rather than reported as appearing or
      // vanishing: a projection built by an object literal always has the same
      // keys, so a mismatch here means the two came from different reads and
      // nothing about them is comparable.
      if (!(key in after)) continue;
      walk(
        path === '' ? key : `${path}.${key}`,
        before[key],
        after[key],
        depth + 1,
        parts,
        magnitudes,
      );
    }
    return;
  }

  // Mixed types, null against an object, a function, a symbol: no claim.
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

import { type ActionResult, fail, ok } from '@melvor-agent/shared';

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
    return fail<T>(
      spec.name,
      'no_state_change',
      `state unchanged after call${hint}: ${safeJson(before)} -> ${safeJson(after)}`,
    );
  }

  return ok(
    spec.name,
    before,
    after,
    returned === undefined ? undefined : `returned ${safeJson(returned)}`,
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

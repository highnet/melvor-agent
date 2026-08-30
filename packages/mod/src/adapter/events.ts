/** Undoes a subscription. Every listener the mod creates returns one of these. */
export type Disposer = () => void;

/**
 * Subscribes to a `Game` event and returns a disposer.
 *
 * `GameEventEmitter` wraps mitt and exposes only `on` / `off` — there is no
 * `once` and no built-in unsubscribe handle. An unattended agent that leaks
 * listeners across reloads will double-fire its reflexes, so every subscription
 * is wrapped here and the kill switch disposes all of them.
 *
 * The emitter is typed against the `GameEvents` map, so an event-name typo is a
 * compile error rather than a silently dead listener.
 *
 * @param event - Key of `GameEvents`, e.g. `'offlineLoopExited'`.
 * @param handler - Called with the event payload.
 * @returns A disposer that removes exactly this handler.
 */
export function onGameEvent<K extends keyof GameEvents>(
  event: K,
  handler: (payload: GameEvents[K]) => void,
): Disposer {
  game.on(event, handler);
  return () => game.off(event, handler);
}

/**
 * Runs a handler after every game loop tick.
 *
 * This is what makes the reflex tier genuinely per-tick rather than a timer
 * approximating one. Patching is the only way to hook the loop, so it lives
 * here with every other game touchpoint.
 *
 * The hook is a `function`, not an arrow: patch hooks are invoked with `this`
 * bound to the patched instance, and an arrow would silently capture module
 * scope instead. Nothing here needs `this`, but the habit is the one that
 * matters — the failure is quiet when it does.
 *
 * @param ctx - The mod context, which owns patching.
 * @param handler - Called after each loop. Must be cheap; the loop is hot.
 * @returns A disposer. Note that the mod API has no unpatch, so this only stops
 *          the handler from doing work — the patch itself remains installed.
 */
export function onGameLoop(ctx: Modding.ModContext, handler: () => void): Disposer {
  let active = true;
  // `function`, not an arrow: patch hooks are invoked with `this` bound to the
  // patched instance, and an arrow silently captures module scope instead.
  // useArrowFunction is disabled for this directory in biome.json so the lint
  // autofix cannot quietly reintroduce that bug.
  ctx.patch(Game, 'loop').after(function () {
    if (active) handler();
  });
  return () => {
    active = false;
  };
}

/**
 * Collects disposers so a single call tears everything down.
 *
 * Disposal is best-effort and never throws: the kill switch must always
 * complete, even if one listener was already removed.
 */
export class Subscriptions {
  private disposers: Disposer[] = [];

  /** Registers a disposer for later teardown. */
  add(disposer: Disposer): void {
    this.disposers.push(disposer);
  }

  /** Runs and clears every registered disposer. Safe to call repeatedly. */
  disposeAll(): void {
    const pending = this.disposers;
    this.disposers = [];
    for (const dispose of pending) {
      try {
        dispose();
      } catch {
        // Teardown is best-effort by design; see class doc.
      }
    }
  }

  /** How many subscriptions are currently held. Surfaced in the panel. */
  get size(): number {
    return this.disposers.length;
  }
}

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

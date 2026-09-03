/**
 * Death detection, as a state machine over a rising counter.
 *
 * There was no death detection of any kind. `deathsSinceStart` was only ever
 * assigned zero, never incremented, so `abortWhen.deathsExceed` could never
 * fire and the `death` replan trigger was never sent -- and the run that died
 * overnight went on choosing objectives as though nothing had happened,
 * because nothing in the agent could tell the two states apart.
 *
 * Polling a counter rather than listening for an event is deliberate. There
 * is no death event to subscribe to, and a counter that only rises also
 * catches a death that happened while the mod was not loaded at all -- during
 * offline progression, which is exactly how this character died last time.
 * An event would have missed the one case that matters most.
 *
 * Separated from `Agent` because everything here is arithmetic over one number
 * and can therefore be tested directly. On the class it could not be: reaching
 * it needed a live `game`, so the behaviour was mirrored in a test file
 * instead, and a mirror cannot fail when the code changes.
 *
 * The counter is read by the caller and passed in, which is also what keeps
 * this side of the adapter boundary.
 */
export class DeathWatch {
  /** Null until the first reading; see {@link observe}. */
  private lastCount: number | null = null;
  private deaths = 0;

  /** Deaths observed since the current objective started. */
  get deathsSinceStart(): number {
    return this.deaths;
  }

  /**
   * Folds one reading of the game's death counter in.
   *
   * @param current - `game.stats.Combat.get(CombatStats.Deaths)`, read by the
   *                  caller.
   * @returns How many deaths this reading revealed; 0 when none did.
   */
  observe(current: number): number {
    // First reading establishes the baseline; a character with a long history
    // has not just died forty times.
    if (this.lastCount === null) {
      this.lastCount = current;
      return 0;
    }

    if (current <= this.lastCount) {
      this.lastCount = current;
      return 0;
    }

    const died = current - this.lastCount;
    this.lastCount = current;
    this.deaths += died;
    return died;
  }

  /**
   * Starts the per-objective count again, without moving the baseline.
   *
   * The baseline is a fact about the save and outlives any one objective; the
   * count is what `abortWhen.deathsExceed` is measured against and belongs to
   * the objective that is running. Resetting both would make the next reading
   * report every death in the character's history as new.
   */
  resetRun(): void {
    this.deaths = 0;
  }
}

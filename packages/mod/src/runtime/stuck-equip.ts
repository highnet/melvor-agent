/**
 * Remembers equips that report success and do not take effect.
 *
 * The failure this exists for, measured live on 2026-09-03: a Steel Scimitar
 * and a Staff of Air traded the weapon slot for forty minutes, roughly forty
 * equips a minute, every one of them a verified `ok` with a genuine before/after
 * diff. Both readings were true; what nothing above the adapter could see was
 * that the *next* look would undo it.
 *
 * The cause was found afterwards and is written up in `learnings/game-state.md`.
 * It is worth naming here because the first note in this file guessed wrong:
 * nothing in the game reverted anything. Two tiers of this agent were equipping
 * different weapons into the same slot on different clocks -- an `equip_item`
 * objective on the 3,000ms policy tick and `reflex.upgradeGear` on the 1,000ms
 * reflex tick -- and the reflex's half left no adapter line in the log, so the
 * loop read as one action being undone by the game. Both halves are fixed in
 * `equipment.ts`: the gear reader no longer offers a *style switch* as an
 * upgrade for a reflex to act on, and `statScore` no longer counts attack speed
 * as a benefit.
 *
 * This is kept anyway, and not as a memorial. `ActionResult` cannot detect a
 * confirmed-then-reverted equip on its own -- its contract is that a verified
 * `ok` carries real evidence of a change, and it did; the change was real and
 * then it was taken back. Catching that needs a second look on a later tick,
 * which is what this does and why it lives above the adapter. Any future
 * disagreement of the same shape -- another tier, or the game's own
 * `Player.checkEquipmentRequirements` (player.d.ts:139), which unequips gear
 * whose requirements stop being met -- lands here as one reported refusal
 * rather than as an unbounded loop that reads as success.
 *
 * `act` now keeps its own ledger of actions that keep being redone
 * (`adapter/act.ts`, `noteRedone`), and this does *not* defer to it. The two
 * answer different questions and only one of them can refuse:
 *
 * - the ledger reports. It sees only what `ActSpec` gives it — an action name
 *   and a projection — so it can say "`equipment.equip` has succeeded five
 *   times from an identical slot state" and nothing more. It cannot name the
 *   item the reflex asked for, and it cannot decline to offer it again.
 * - this refuses. `lastEquipAttempt` is the reflex's own record of what it put
 *   on, which is knowledge the adapter does not have and should not acquire:
 *   giving `act` a memory of *who* asked would make every action's evidence
 *   depend on the tier that issued it.
 *
 * So the ledger is the diagnostic and this is the bound, and the two crossing
 * the same loop from different sides is the intended arrangement rather than
 * duplication. Removing this would leave a forty-equips-a-minute loop reported
 * once and then unbounded, which is what the 2026-09-03 morning looked like.
 *
 * What it can say is bounded by what it is told. `lastEquipAttempt` is set only
 * on the reflex's own equips, so the item it names is the one the *reflex* put
 * on, which in the 2026-09-03 loop was the staff and not the scimitar. It
 * reports that an equip did not hold; it does not attribute the cause, and the
 * message must not either.
 */
export class StuckEquipWatch {
  /** Items whose equip was confirmed and then undone, and the tally so far. */
  private readonly attempts = new Map<string, number>();
  private readonly stuck = new Set<string>();

  /**
   * How many confirmed-then-reverted equips before an item is abandoned.
   *
   * Not one. A single reversion is indistinguishable from a legitimate race --
   * the game may unequip during its own tick for a reason that will not repeat,
   * and refusing forever on that would strand a slot the character could fill.
   * Three consecutive is a pattern.
   */
  private static readonly LIMIT = 3;

  /**
   * Call once per tick with the item the reflex last equipped, if any, and
   * what the slot actually holds now.
   *
   * @param itemId - What the previous tick equipped, or null if it equipped
   *                 nothing.
   * @param wornItemId - What that slot holds on this tick.
   */
  record(itemId: string | null, wornItemId: string | null): void {
    if (itemId === null) return;

    if (wornItemId === itemId) {
      // It stuck. Any earlier reversion was the one-off race described above.
      this.attempts.delete(itemId);
      this.stuck.delete(itemId);
      return;
    }

    const seen = (this.attempts.get(itemId) ?? 0) + 1;
    this.attempts.set(itemId, seen);
    if (seen >= StuckEquipWatch.LIMIT) this.stuck.add(itemId);
  }

  /** Items the reflex must stop offering. */
  ids(): string[] {
    return [...this.stuck];
  }

  /** Whether an item has just crossed the limit, for reporting it once. */
  isStuck(itemId: string): boolean {
    return this.stuck.has(itemId);
  }
}

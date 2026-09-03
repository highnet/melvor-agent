/**
 * Remembers equips that report success and do not take effect.
 *
 * The failure this exists for, measured live: `reflex.upgradeGear` equipped a
 * Steel Scimitar over a Staff of Air about every 1.5 seconds, indefinitely.
 * Every call returned `ok` with a genuine before/after diff, because the
 * adapter's read of `player.equipment.equippedItems` really did show the
 * scimitar immediately after the call. By the next tick the staff was back and
 * the bank's scimitar count had not moved. Something undoes the slot between
 * the call and the following tick without logging anything, and the typings do
 * not say what.
 *
 * `ActionResult` cannot catch this on its own. Its contract is that a verified
 * `ok` carries real evidence of a change, and it did -- the change was real and
 * then it was reverted. Detecting that needs a second look on a later tick,
 * which is what this does and why it lives above the adapter.
 *
 * Deliberately not a fix for the reversion, whose cause is still unknown. It
 * turns an unbounded loop that reads as success into one reported refusal.
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

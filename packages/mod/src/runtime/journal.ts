import type { JournalEntry } from '@melvor-agent/shared';

/**
 * Objective outcomes waiting to be shipped to the service.
 *
 * The journal has had a schema, a store method and a digest the planner reads
 * since the beginning, and nothing ever wrote to it: `addJournalEntry` had one
 * caller, a test. So `get_journal` could only answer "Nothing attempted yet",
 * and the property the digest exists to provide -- do not re-propose what was
 * already abandoned -- simply was not there. The mod knew every outcome and
 * threw it away as a log line.
 *
 * The one behaviour worth naming is {@link requeue}. An entry that is never
 * recorded is one the planner will propose again, so a failed send must not
 * lose it -- and the requeued entries go in *front* of anything recorded since,
 * because the journal is read as a sequence of outcomes and an objective that
 * ended first did not end second.
 *
 * A class rather than two fields on `Agent`, because that is what makes the
 * drain-and-restore pair testable at all: reaching it on the class needed a
 * live `game` and a live transport.
 */
export class JournalBuffer {
  private pending: JournalEntry[] = [];

  /** How many entries are waiting. */
  get size(): number {
    return this.pending.length;
  }

  record(entry: JournalEntry): void {
    this.pending.push(entry);
  }

  /** Takes everything waiting, leaving the buffer empty. */
  drain(): JournalEntry[] {
    const entries = this.pending;
    this.pending = [];
    return entries;
  }

  /** Puts a failed send's entries back, ahead of anything recorded since. */
  requeue(entries: readonly JournalEntry[]): void {
    this.pending = [...entries, ...this.pending];
  }
}

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgentReport,
  Command,
  JournalDigest,
  JournalEntry,
  LogRecord,
} from '@melvor-agent/shared';

/**
 * Server-side state.
 *
 * The mod is sandboxed and cannot write to disk, so everything durable lives
 * here: the log, the journal, save exports and the knowledge dump. Kept
 * deliberately simple — files, not a database. The planning calls themselves
 * are stateless; this is the memory they read from.
 */
export class Store {
  private lastReport: AgentReport | null = null;
  private lastReportAt: number | null = null;
  private pendingCommands: Command[] = [];
  private journal: JournalEntry[] = [];
  /**
   * The candidate labels as they were last *shown* to a planning session.
   *
   * Candidate indices are positions in a list that changes with game state, so
   * an index read a minute ago can point at something else entirely by the time
   * it is used. Remembering what was shown lets a choice be checked against it
   * instead of trusting the number.
   */
  private lastShownCandidates: { key: string; label: string }[] = [];

  constructor(private readonly dataDir: string) {}

  /** Creates the data directory tree. Safe to call repeatedly. */
  async init(): Promise<void> {
    await mkdir(join(this.dataDir, 'saves'), { recursive: true });
    await mkdir(join(this.dataDir, 'logs'), { recursive: true });
  }

  /**
   * Records a report from the mod and hands back queued commands.
   *
   * Commands are drained, so each is delivered at most once. A command that is
   * lost to a dropped connection is not retried: re-arming an agent twice
   * because a response never arrived is worse than making the operator click
   * again.
   */
  async acceptReport(report: AgentReport): Promise<Command[]> {
    this.lastReport = report;
    this.lastReportAt = Date.now();

    if (report.logs.length > 0) {
      await this.appendLogs(report.logs);
    }

    const commands = this.pendingCommands;
    this.pendingCommands = [];
    return commands;
  }

  /**
   * Records the candidate list handed to a planning session.
   *
   * Identity is the kind and params, not the label. Labels carry live numbers —
   * a mastery pool ticks up every second — so comparing text would reject a
   * choice that had not actually changed, which is worse than not checking:
   * a guard that cries wolf gets worked around.
   */
  rememberShownCandidates(
    candidates: readonly { kind: string; params: unknown; label: string }[],
  ): void {
    this.lastShownCandidates = candidates.map((candidate) => ({
      key: identityOf(candidate),
      label: candidate.label,
    }));
  }

  /**
   * Resolves a chosen index to the candidate the session actually picked.
   *
   * The guard exists because an index is a position in a list that moves with
   * game state, and acting on a stale one is silent and wrong: a request to
   * equip a dagger once built a storehouse, because smithing finished between
   * listing and choosing.
   *
   * But refusing was too blunt. The list churns constantly — every sale, every
   * item consumed in a fight, every skill that levels reshuffles it — so a plan
   * built from a fresh listing could still be stale by the time it was
   * submitted, and a whole afternoon produced refusal after refusal for choices
   * that were never actually wrong. A guard that fires on the correct answer
   * gets worked around, which is the failure mode it was written to prevent.
   *
   * So: if the exact identity the session chose is still on the list somewhere,
   * follow it. That satisfies the guard's real purpose — act on what was
   * chosen, never on whatever slid into that slot — while surviving churn that
   * changes only positions. Only a choice that has genuinely *gone* is refused.
   *
   * @returns The index to act on, or the mismatch to report.
   */
  resolveChoice(
    index: number,
    current: readonly { kind: string; params: unknown; label: string }[],
  ): { index: number; moved: boolean } | { error: string } {
    const shown = this.lastShownCandidates[index];
    const atIndex = current[index];
    if (atIndex === undefined) return { index, moved: false };

    // Nothing remembered for this index means there is nothing to check
    // against, and an unverified index is precisely the thing this guard
    // exists to refuse. The old behaviour was to fall through and act on it.
    //
    // That is not a hypothetical. Saving any planner file reloads the service
    // and empties this memory, so every save silently disarmed the guard while
    // leaving it apparently in place — and twice in a row a chosen index was
    // resolved to a completely different fight, once to a Seagull and once to
    // the Lair of the Spider Queen. The reply named what it had queued, which
    // is the only reason it was caught at all.
    if (shown === undefined) {
      return {
        error: `no candidate listing is remembered for index ${index} — the planner service restarts with an empty memory, so an index from before a restart cannot be verified. Call list_candidates first`,
      };
    }

    if (shown.key === identityOf(atIndex)) return { index, moved: false };

    const relocated = current.findIndex((candidate) => identityOf(candidate) === shown.key);
    if (relocated >= 0) return { index: relocated, moved: true };

    return {
      error: `candidate ${index} was "${shown.label}" when you listed it, and that choice is no longer available at all (position ${index} now holds "${atIndex.label}")`,
    };
  }

  /**
   * The label this index carried when it was last listed.
   *
   * Exists so a reply can name what was asked for alongside what was queued.
   * A resolution that silently disagrees with the caller's intent is the one
   * failure this whole mechanism is meant to make impossible, and it can only
   * be caught if both halves are visible in the same sentence.
   */
  shownLabel(index: number): string | null {
    return this.lastShownCandidates[index]?.label ?? null;
  }

  /** Queues a command for the next report. */
  enqueue(command: Command): void {
    this.pendingCommands.push(command);
  }

  get report(): AgentReport | null {
    return this.lastReport;
  }

  get reportAgeMs(): number | null {
    return this.lastReportAt === null ? null : Date.now() - this.lastReportAt;
  }

  /** Appends log records as JSON lines, one file per day. */
  private async appendLogs(records: readonly LogRecord[]): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const lines = records.map((record) => JSON.stringify(record)).join('\n');
    await appendFile(join(this.dataDir, 'logs', `${day}.jsonl`), `${lines}\n`, 'utf8');
  }

  /**
   * Log records from disk, newest last.
   *
   * `appendLogs` has written every record to `data/logs/<day>.jsonl` since the
   * beginning and nothing ever read it back, so `get_recent_activity` answered
   * from `report.logs` -- whatever the mod happened to drain in the last three
   * seconds. After any reload that is empty, which is exactly when a
   * post-mortem is wanted: every investigation of a death or a stall this
   * session hit "Log is empty" while the evidence sat on disk.
   *
   * Today and yesterday, because a stall at midnight is read at nine.
   */
  async readRecentLogs(limit: number, level?: LogRecord['level']): Promise<LogRecord[]> {
    const day = (offset: number): string =>
      new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);

    const records: LogRecord[] = [];
    for (const name of [day(1), day(0)]) {
      try {
        const raw = await readFile(join(this.dataDir, 'logs', `${name}.jsonl`), 'utf8');
        for (const line of raw.split(String.fromCharCode(10))) {
          if (line.trim() === '') continue;
          try {
            records.push(JSON.parse(line) as LogRecord);
          } catch {
            // A truncated final line is normal for an append-only file.
          }
        }
      } catch {
        // A day with no log file is not an error.
      }
    }

    const filtered = level === undefined ? records : records.filter((r) => r.level === level);
    return filtered.slice(-limit);
  }

  /** Persists a save export, stamped so exports are never overwritten. */
  async writeSave(save: string, reason: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(this.dataDir, 'saves', `${stamp}-${reason}.txt`);
    await writeFile(path, save, 'utf8');
    return path;
  }

  /**
   * Reads persisted agent settings.
   *
   * Settings live here rather than in the game's `characterStorage` because
   * that only persists for a mod installed from mod.io, and Melvor requires
   * game-admin approval for mod.io entries — which is incompatible with keeping
   * this private. On a single machine the trade is free: settings no longer
   * travel with the save, but there is only one machine.
   *
   * @returns The stored settings object, or null when none has been written.
   */
  async readSettings(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(join(this.dataDir, 'settings.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Persists agent settings. Written atomically enough for a local file. */
  async writeSettings(settings: unknown): Promise<void> {
    await writeFile(join(this.dataDir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8');
  }

  async writeDump(dump: unknown): Promise<void> {
    await writeFile(join(this.dataDir, 'dump.json'), JSON.stringify(dump, null, 2), 'utf8');
  }

  /** Reads the stored dump, or null when there is none. */
  async readDump(): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(join(this.dataDir, 'dump.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  addJournalEntry(entry: JournalEntry): void {
    this.journal.push(entry);
  }

  /**
   * Builds the digest the planner actually sees.
   *
   * Recent entries verbatim, older ones rolled into aggregate lines. Feeding
   * the whole journal would eat the context budget, and a planner that
   * re-proposes what it abandoned yesterday is the failure this prevents.
   *
   * @param recentCount - How many entries to keep verbatim.
   */
  digest(recentCount = 10): JournalDigest {
    const recent = this.journal.slice(-recentCount);
    const older = this.journal.slice(0, Math.max(0, this.journal.length - recentCount));

    const byKind = new Map<string, JournalEntry[]>();
    for (const entry of older) {
      const bucket = byKind.get(entry.objective.kind) ?? [];
      bucket.push(entry);
      byKind.set(entry.objective.kind, bucket);
    }

    const aggregates = [...byKind.entries()].map(([kind, entries]) => {
      const durations = entries
        .map((entry) => (entry.endedAt - entry.startedAt) / 60_000)
        .sort((a, b) => a - b);
      return {
        kind,
        attempts: entries.length,
        completed: entries.filter((entry) => entry.outcome === 'completed').length,
        aborted: entries.filter((entry) => entry.outcome.startsWith('aborted')).length,
        medianMinutes: durations[Math.floor(durations.length / 2)] ?? 0,
      };
    });

    return { recent, aggregates };
  }
}

/**
 * What makes two candidates the same choice.
 *
 * The kind and the params, which are what the agent will actually execute.
 * Everything else in a candidate is presentation.
 */
function identityOf(candidate: { kind: string; params: unknown }): string {
  return `${candidate.kind}:${JSON.stringify(candidate.params)}`;
}

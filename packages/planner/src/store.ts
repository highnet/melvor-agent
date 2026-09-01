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
  private lastShownCandidates: string[] = [];

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

  /** Records the candidate list handed to a planning session. */
  rememberShownCandidates(labels: readonly string[]): void {
    this.lastShownCandidates = [...labels];
  }

  /**
   * Checks a chosen index still points at what the session was shown.
   *
   * @returns null when the choice is sound, or the mismatch to report.
   */
  checkChoice(index: number, currentLabel: string): string | null {
    const shown = this.lastShownCandidates[index];
    if (shown === undefined) return null;
    if (shown === currentLabel) return null;

    return `candidate ${index} was "${shown}" when you listed it and is now "${currentLabel}" — the list shifted, so this choice would act on something you did not pick`;
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

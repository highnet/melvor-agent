import type { LogLevel, LogRecord } from '@melvor-agent/shared';

/**
 * In-memory log with a bounded buffer.
 *
 * The mod is sandboxed and cannot write to disk, so durable logging happens in
 * the planner service; this holds the tail for the in-game panel and for the
 * next report. The buffer is bounded because an agent running for days would
 * otherwise grow one without limit.
 */
export class Logger {
  private records: LogRecord[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly capacity = 300) {}

  /**
   * Appends a record.
   *
   * @param level - Severity.
   * @param source - Which tier produced it, so the panel can filter.
   * @param message - Human-readable summary.
   * @param data - Structured evidence, usually a serialised `ActionResult`.
   */
  log(level: LogLevel, source: LogRecord['source'], message: string, data?: unknown): void {
    this.records.push({
      at: Date.now(),
      level,
      source,
      message,
      ...(data === undefined ? {} : { data }),
    });
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
    for (const listener of this.listeners) listener();
  }

  info(source: LogRecord['source'], message: string, data?: unknown): void {
    this.log('info', source, message, data);
  }

  warn(source: LogRecord['source'], message: string, data?: unknown): void {
    this.log('warn', source, message, data);
  }

  error(source: LogRecord['source'], message: string, data?: unknown): void {
    this.log('error', source, message, data);
  }

  /** Most recent records, newest last. */
  tail(count = 50): LogRecord[] {
    return this.records.slice(-count);
  }

  /**
   * Removes and returns everything buffered, for shipping to the service.
   *
   * Draining rather than copying means a report that reaches the service is not
   * re-sent; a report that fails is pushed back by the caller.
   */
  drain(): LogRecord[] {
    const drained = this.records;
    this.records = [];
    return drained;
  }

  /** Puts records back at the front after a failed send, preserving order. */
  requeue(records: LogRecord[]): void {
    this.records.unshift(...records);
    if (this.records.length > this.capacity) {
      this.records.splice(0, this.records.length - this.capacity);
    }
  }

  /** Subscribes to changes so the panel can re-render. Returns a disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

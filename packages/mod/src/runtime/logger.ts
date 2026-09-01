import type { LogLevel, LogRecord } from '@melvor-agent/shared';

/**
 * In-memory log with two bounded buffers.
 *
 * The mod is sandboxed and cannot write to disk, so durable logging happens in
 * the planner service; this holds the tail for the in-game panel and the queue
 * for the next report. Both buffers are bounded because an agent running for
 * days would otherwise grow one without limit.
 *
 * They are separate because a single buffer was doing two jobs with
 * incompatible lifetimes. Shipping a report drains the queue, which also wiped
 * the panel — so the in-game activity list emptied itself every few seconds and
 * the operator could never read what had just happened. What has been sent and
 * what is worth showing are different questions.
 */
export class Logger {
  /** Everything recent, for the panel. Never drained.  */
  private history: LogRecord[] = [];
  /** Not yet shipped to the service. Drained on each report. */
  private pending: LogRecord[] = [];
  private readonly listeners = new Set<() => void>();

  /**
   * @param capacity - Records kept for display.
   * @param queueCapacity - Records held for the next report. Smaller, because a
   *   long service outage should not push out the display history.
   */
  constructor(
    private readonly capacity = 500,
    private readonly queueCapacity = 300,
  ) {}

  /**
   * Appends a record.
   *
   * @param level - Severity.
   * @param source - Which tier produced it, so the panel can filter.
   * @param message - Human-readable summary.
   * @param data - Structured evidence, usually a serialised `ActionResult`.
   */
  log(level: LogLevel, source: LogRecord['source'], message: string, data?: unknown): void {
    const record: LogRecord = {
      at: Date.now(),
      level,
      source,
      message,
      ...(data === undefined ? {} : { data }),
    };

    this.history.push(record);
    if (this.history.length > this.capacity) {
      this.history.splice(0, this.history.length - this.capacity);
    }

    this.pending.push(record);
    if (this.pending.length > this.queueCapacity) {
      this.pending.splice(0, this.pending.length - this.queueCapacity);
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

  /** Most recent records for display, newest last. Unaffected by reporting. */
  tail(count = 50): LogRecord[] {
    return this.history.slice(-count);
  }

  /**
   * Removes and returns everything buffered, for shipping to the service.
   *
   * Draining rather than copying means a report that reaches the service is not
   * re-sent; a report that fails is pushed back by the caller.
   */
  drain(): LogRecord[] {
    const drained = this.pending;
    this.pending = [];
    return drained;
  }

  /** Puts records back at the front after a failed send, preserving order. */
  requeue(records: LogRecord[]): void {
    this.pending.unshift(...records);
    if (this.pending.length > this.queueCapacity) {
      this.pending.splice(0, this.pending.length - this.queueCapacity);
    }
  }

  /** Subscribes to changes so the panel can re-render. Returns a disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

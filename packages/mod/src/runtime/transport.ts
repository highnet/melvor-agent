import type { AgentReply, AgentReport } from '@melvor-agent/shared';
import { agentReplySchema } from '@melvor-agent/shared';

/**
 * HTTP client for the local planner service.
 *
 * Everything here degrades rather than halts. The service is where disk logging,
 * the journal and save exports live, but the agent must keep playing when it is
 * down — an unreachable service is a lost log line, not a stopped agent.
 */
export class Transport {
  private consecutiveFailures = 0;
  private lastError: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 4000,
  ) {}

  /** True once the service has failed enough times to be considered down. */
  get isDegraded(): boolean {
    return this.consecutiveFailures >= 3;
  }

  /** Most recent transport error, for the panel. Null while healthy. */
  get error(): string | null {
    return this.lastError;
  }

  /**
   * Ships a report and collects any queued commands.
   *
   * @param report - Current run state, snapshot, candidates and drained logs.
   * @returns The reply, or null when the service could not be reached.
   */
  async report(report: AgentReport): Promise<AgentReply | null> {
    const body = await this.post('/agent/report', report);
    if (body === null) return null;

    const parsed = agentReplySchema.safeParse(body);
    if (!parsed.success) {
      // Garbage from the service is treated as unreachable rather than trusted.
      this.lastError = `malformed reply: ${parsed.error.issues[0]?.message ?? 'unknown'}`;
      this.consecutiveFailures += 1;
      return null;
    }

    this.consecutiveFailures = 0;
    this.lastError = null;
    return parsed.data;
  }

  /** Uploads a save string for the service to write to disk. */
  async uploadSave(save: string, reason: string): Promise<boolean> {
    return (await this.post('/agent/save', { save, reason, at: Date.now() })) !== null;
  }

  /** Uploads a knowledge dump for the service to write to disk. */
  async uploadDump(dump: unknown): Promise<boolean> {
    return (await this.post('/agent/dump', dump)) !== null;
  }

  /**
   * Loads persisted settings from the service.
   *
   * @returns The stored settings, or null when the service is unreachable or
   *          has none — the caller falls back to defaults rather than guessing.
   */
  async loadSettings(): Promise<unknown | null> {
    return this.get('/agent/settings');
  }

  /** Persists settings. Returns false when the service could not be reached. */
  async saveSettings(settings: unknown): Promise<boolean> {
    return (
      (await this.request('/agent/settings', {
        method: 'PUT',
        body: JSON.stringify(settings),
      })) !== null
    );
  }

  /** Fetches the stored dump so the mod can run its own staleness check. */
  async fetchDump(): Promise<unknown | null> {
    return this.get('/agent/dump');
  }

  private async post(path: string, payload: unknown): Promise<unknown | null> {
    return this.request(path, { method: 'POST', body: JSON.stringify(payload) });
  }

  private async get(path: string): Promise<unknown | null> {
    return this.request(path, { method: 'GET' });
  }

  private async request(path: string, init: RequestInit): Promise<unknown | null> {
    // AbortSignal.timeout keeps a hung service from stalling the policy tick.
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        this.consecutiveFailures += 1;
        this.lastError = `${init.method} ${path} -> HTTP ${response.status}`;
        return null;
      }

      return await response.json();
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError =
        error instanceof Error ? `${init.method} ${path} -> ${error.message}` : String(error);
      return null;
    }
  }
}

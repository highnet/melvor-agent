import type { CharacterSettings } from '../adapter/index.js';
import type { AgentSettings } from './agent.js';
import type { Logger } from './logger.js';
import type { Transport } from './transport.js';

/**
 * Durable settings, backed by two stores that fail in different ways.
 *
 * `characterStorage` is the natural home — settings travel with the save — but
 * it only persists for a mod installed from mod.io, and that route depends on
 * the mod.io entry staying healthy and approved. The local service has no such
 * dependency but is machine-local.
 *
 * So: the service is authoritative, `characterStorage` is a cache. Both are
 * written; whichever is available on the next boot wins, service first. Neither
 * being available is survivable — the agent falls back to defaults, which are
 * disarmed and dry-run, so the failure mode is "does nothing" rather than
 * "does something unintended".
 */
export class SettingsStore {
  constructor(
    private readonly cache: CharacterSettings<AgentSettings>,
    private readonly transport: Transport,
    private readonly log: Logger,
    private readonly defaults: AgentSettings,
  ) {}

  /**
   * Reads settings synchronously from the in-game cache.
   *
   * Used during `onCharacterLoaded`, where nothing may await. The result may be
   * stale or defaults; {@link hydrate} corrects it once the service answers.
   */
  readCached(): AgentSettings {
    return this.cache.read();
  }

  /**
   * Loads authoritative settings from the service.
   *
   * @returns The merged settings, or the cached ones when the service is down.
   */
  async hydrate(): Promise<AgentSettings> {
    const remote = await this.transport.loadSettings();
    const cached = this.cache.read();

    if (remote === null || typeof remote !== 'object') {
      this.log.warn(
        'runtime',
        'settings service unavailable; using in-game cache. Changes may not survive a reload.',
      );
      return cached;
    }

    // Merge over defaults so a setting added in a later build is not read as
    // undefined against an older stored object.
    const merged = { ...this.defaults, ...cached, ...(remote as Partial<AgentSettings>) };

    // The allowlist is the one setting where "empty" is never a deliberate
    // instruction — it is what an unwritten store looks like. Letting an empty
    // side win means a single failed fetch disarms the agent permanently, which
    // is what happened: the service had no allowlist, the mod adopted it, and
    // arming refused ever after with no way back except the panel.
    //
    // So a populated list always beats an empty one, whichever side holds it.
    if (merged.characterAllowlist.length === 0 && cached.characterAllowlist.length > 0) {
      merged.characterAllowlist = cached.characterAllowlist;
      this.log.warn(
        'runtime',
        'the service returned an empty character allowlist; keeping the local one rather than disarming',
      );
    }

    return merged;
  }

  /**
   * Persists settings to both stores.
   *
   * Failures are logged rather than thrown: an agent that stops playing because
   * it could not save a preference is worse than one that keeps playing with a
   * preference it will forget.
   */
  async write(settings: AgentSettings): Promise<void> {
    const cacheError = this.cache.write(settings);
    if (cacheError !== null) this.log.warn('runtime', `character storage: ${cacheError}`);

    const saved = await this.transport.saveSettings(settings);
    if (!saved) {
      this.log.warn('runtime', 'could not persist settings to the service; cached in-game only');
    }
  }
}

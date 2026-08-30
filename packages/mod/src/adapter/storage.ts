/**
 * Character-scoped settings persistence.
 *
 * Two constraints from the mod API shape everything here:
 *
 * 1. The cap is 8,192 bytes per character per mod, keys included. That is
 *    enough for settings and the current objective, and nowhere near enough for
 *    the journal — which is why the journal lives on disk in the planner service.
 * 2. A local mod loaded via the Creator Toolkit only persists if it is linked to
 *    mod.io and installed from there. Unlinked, writes are expected to vanish.
 *    Silent data loss in a days-long unattended run is the worst failure mode
 *    available, so this module verifies its own writes and reports when
 *    persistence is not working.
 */

/** Budget from the mod API, used to fail loudly before the game truncates. */
const CHARACTER_STORAGE_LIMIT_BYTES = 8192;

export interface PersistenceHealth {
  /** False when a write-then-read round trip did not return what was written. */
  working: boolean;
  detail: string;
  bytesUsed: number;
  bytesLimit: number;
}

export class CharacterSettings<T extends Record<string, unknown>> {
  constructor(
    private readonly ctx: Modding.ModContext,
    private readonly key: string,
    private readonly defaults: T,
  ) {}

  /**
   * Reads persisted settings, falling back to defaults per-field.
   *
   * Merges rather than replaces, so adding a new setting in a later build does
   * not read as `undefined` against an older stored object.
   */
  read(): T {
    const stored = this.ctx.characterStorage.getItem(this.key) as Partial<T> | undefined | null;
    if (stored === undefined || stored === null || typeof stored !== 'object') {
      return { ...this.defaults };
    }
    return { ...this.defaults, ...stored };
  }

  /**
   * Persists settings.
   *
   * @param value - Complete settings object to store.
   * @returns An error string when the payload exceeds the budget, else null.
   */
  write(value: T): string | null {
    const encoded = JSON.stringify(value);
    const bytes = byteLength(encoded) + byteLength(this.key);
    if (bytes > CHARACTER_STORAGE_LIMIT_BYTES) {
      return `settings are ${bytes} bytes, over the ${CHARACTER_STORAGE_LIMIT_BYTES} byte character storage limit`;
    }
    this.ctx.characterStorage.setItem(this.key, value);
    return null;
  }

  /**
   * Round-trips a probe value to find out whether persistence actually works.
   *
   * The mod API gives no signal for the unlinked-local-mod case, so the only
   * way to know is to write something and read it back.
   *
   * @returns Health, including whether the round trip survived.
   */
  checkHealth(): PersistenceHealth {
    const probeKey = `${this.key}__probe`;
    const probe = Date.now();
    let working = false;
    let detail = '';

    try {
      this.ctx.characterStorage.setItem(probeKey, probe);
      working = this.ctx.characterStorage.getItem(probeKey) === probe;
      detail = working
        ? 'character storage round trip succeeded'
        : 'write did not survive read-back — is the local mod linked to mod.io and installed from there?';
      this.ctx.characterStorage.removeItem(probeKey);
    } catch (error) {
      detail = `character storage threw: ${error instanceof Error ? error.message : String(error)}`;
    }

    const encoded = JSON.stringify(this.read());
    return {
      working,
      detail,
      bytesUsed: byteLength(encoded) + byteLength(this.key),
      bytesLimit: CHARACTER_STORAGE_LIMIT_BYTES,
    };
  }
}

/** UTF-8 byte length, since the storage budget is bytes and not characters. */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

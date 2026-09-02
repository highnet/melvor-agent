/**
 * The last known service URL, remembered outside the save.
 *
 * The character-select screen is the one place the agent runs where neither
 * store that holds settings exists yet: `characterStorage` needs a character,
 * and asking the service for its own address is circular. So the auto-load hook
 * built `new Transport(DEFAULT_SETTINGS.serviceUrl)` — the *default*, not the
 * configured one — and an operator running the service anywhere else got a hook
 * that silently could not work, on the exact screen it was written to get past.
 *
 * `localStorage` is per-browser and survives a reload, which is precisely the
 * scope of the problem. The panel already keeps its layout there.
 *
 * Best-effort in both directions: a missing or unreadable value falls back to
 * the default, which is what the code did unconditionally before.
 */
const KEY = 'melvor-agent:service-url';

/** Remembers a working service URL for the next boot's character-select screen. */
export function rememberServiceUrl(url: string): void {
  try {
    if (url !== '') localStorage.setItem(KEY, url);
  } catch {
    // A storage quota or a privacy setting is not worth a log line here; the
    // fallback is the default URL, which is what shipped before.
  }
}

/**
 * The remembered service URL, or the fallback.
 *
 * @param fallback - Usually `DEFAULT_SETTINGS.serviceUrl`.
 */
export function recallServiceUrl(fallback: string): string {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === null || stored === '' ? fallback : stored;
  } catch {
    return fallback;
  }
}

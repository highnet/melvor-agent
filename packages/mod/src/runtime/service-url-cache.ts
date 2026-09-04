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

/**
 * Where the repository lives, remembered for the same reason and a worse one.
 *
 * `launchPlannerService(this.settings.repoPath)` exists so the mod can restart
 * a planner service that has died. But `repoPath` arrives *from* that service,
 * and `DEFAULT_SETTINGS.repoPath` is `''`, which the launcher refuses outright.
 * So the one path capable of restarting the service was only readable while the
 * service was already up: the relaunch could never fire when it was needed.
 *
 * Measured: the service died overnight and stayed dead for about eight hours.
 * The character kept mining the last thing it had been told to mine -- safe and
 * productive, and completely unable to replan, because every objective comes
 * from a session talking to a service that was not there. `Run state: blocked`
 * the whole time.
 *
 * Same store and same best-effort handling as the URL above, for the same
 * reason: this has to survive a reload and be readable before any character
 * exists.
 */
const REPO_PATH_KEY = 'melvor-agent:repo-path';

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

/** Remembers the repository path so a dead service can be restarted. */
export function rememberRepoPath(repoPath: string): void {
  try {
    if (repoPath !== '') localStorage.setItem(REPO_PATH_KEY, repoPath);
  } catch {
    // As above: the fallback is the configured value, which is what shipped.
  }
}

/**
 * The remembered repository path, or the fallback.
 *
 * @param fallback - Usually `settings.repoPath`, which is `''` until the
 *   service has answered at least once.
 */
export function recallRepoPath(fallback: string): string {
  try {
    const stored = localStorage.getItem(REPO_PATH_KEY);
    return stored === null || stored === '' ? fallback : stored;
  } catch {
    return fallback;
  }
}

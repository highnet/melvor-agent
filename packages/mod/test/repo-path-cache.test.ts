import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recallRepoPath, rememberRepoPath } from '../src/runtime/service-url-cache.js';

/**
 * The repository path, remembered outside the save.
 *
 * The failure this closes, measured: the planner service died overnight and
 * stayed dead about eight hours. `launchPlannerService(settings.repoPath)`
 * exists to restart it, but `repoPath` arrives *from* the service and defaults
 * to `''`, which the launcher refuses — so the one path capable of restarting
 * the service was readable only while the service was already up.
 */
const KEY = 'melvor-agent:repo-path';
const REPO = 'C:Userssomeonecodemelvor-agent';

/** A localStorage stand-in; the real one does not exist under vitest. */
function installStorage(store: Map<string, string>, throws = false): void {
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => {
      if (throws) throw new Error('storage is unavailable');
      return store.get(k) ?? null;
    },
    setItem: (k: string, v: string) => {
      if (throws) throw new Error('storage is unavailable');
      store.set(k, v);
    },
  };
}

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  installStorage(store);
});

afterEach(() => {
  (globalThis as Record<string, unknown>).localStorage = undefined;
});

describe('remembering where the repository is', () => {
  it('recalls a remembered path in preference to an empty configured one', () => {
    rememberRepoPath(REPO);

    // `''` is what `settings.repoPath` reads on the boot after a crash, which
    // is the only boot where this matters.
    expect(recallRepoPath('')).toBe(REPO);
  });

  it('never remembers an empty path over a good one', () => {
    rememberRepoPath(REPO);
    rememberRepoPath('');

    expect(store.get(KEY)).toBe(REPO);
  });

  it('falls back when nothing has been remembered', () => {
    expect(recallRepoPath('C:\fallback')).toBe('C:\fallback');
  });

  it('falls back rather than throwing when storage refuses', () => {
    installStorage(store, true);

    expect(() => rememberRepoPath(REPO)).not.toThrow();
    expect(recallRepoPath('C:\fallback')).toBe('C:\fallback');
  });
});

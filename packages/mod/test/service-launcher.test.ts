import { describe, expect, it } from 'vitest';
import { launchPlannerService } from '../src/runtime/service-launcher.js';

describe('starting the planner from the game', () => {
  it('refuses without a repository path rather than guessing one', () => {
    // A wrong path spawns a process that fails somewhere the operator cannot
    // see it, which is worse than not spawning at all — the error would read
    // "unreachable" exactly as it did before, with a stray process behind it.
    const outcome = launchPlannerService('');

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/no repository path/);
  });

  it('refuses in a build with no Node integration', () => {
    // Under vitest there is no NW.js require, which is the same position a
    // plain browser is in. Reporting it beats a button that silently does
    // nothing.
    const outcome = launchPlannerService('/some/path');

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toMatch(/no Node integration/);
  });
});

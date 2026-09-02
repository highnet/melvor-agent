import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILD_STAMP_TOLERANCE_MS,
  isNewerBuild,
  parseBuildInfo,
  readBuildInfo,
} from '../src/build-info.js';

/**
 * "Is the fix I just made actually running?"
 *
 * The mod only reloads with the game, so the code on disk and the code running
 * can be hours apart. The check that answers this has now failed in two
 * different ways: it read a stale artifact from a folder the build no longer
 * writes to, and it compared timestamps as sliced strings so a build straddling
 * a second boundary reported a newer build waiting immediately after a
 * successful reload.
 */
describe('isNewerBuild', () => {
  it('is quiet when the two stamps are the same build', () => {
    expect(isNewerBuild('2026-09-02T06:22:54.705Z', '2026-09-02T06:22:54.698Z')).toBe(false);
  });

  it('is quiet across a second boundary, which string slicing was not', () => {
    // `stamp.slice(0, 19)` compared "…06:22:54" against "…06:22:55" as text and
    // called four milliseconds a newer build. That is exactly how a warning
    // becomes noise and then becomes ignored.
    expect(isNewerBuild('2026-09-02T06:22:55.002Z', '2026-09-02T06:22:54.998Z')).toBe(false);
  });

  it('fires for a build that is genuinely waiting', () => {
    expect(isNewerBuild('2026-09-02T08:00:00.000Z', '2026-09-02T06:22:54.698Z')).toBe(true);
  });

  it('fires just past the tolerance and not just inside it', () => {
    const running = '2026-09-02T06:00:00.000Z';
    const inside = new Date(Date.parse(running) + BUILD_STAMP_TOLERANCE_MS).toISOString();
    const past = new Date(Date.parse(running) + BUILD_STAMP_TOLERANCE_MS + 1).toISOString();

    expect(isNewerBuild(inside, running)).toBe(false);
    expect(isNewerBuild(past, running)).toBe(true);
  });

  it('never fires on a stamp it cannot read', () => {
    // A staleness warning that fires on its own uncertainty is noise.
    expect(isNewerBuild('not a date', '2026-09-02T06:00:00.000Z')).toBe(false);
    expect(isNewerBuild('2026-09-02T06:00:00.000Z', 'not a date')).toBe(false);
    expect(isNewerBuild(undefined, '2026-09-02T06:00:00.000Z')).toBe(false);
    expect(isNewerBuild('2026-09-02T06:00:00.000Z', null)).toBe(false);
  });
});

describe('parseBuildInfo', () => {
  it('reads the stamp the build wrote', () => {
    expect(parseBuildInfo('built 2026-09-02T06:22:54.698Z\nformat esm\n')).toBe(
      '2026-09-02T06:22:54.698Z',
    );
  });

  it('returns nothing for a file that does not carry one', () => {
    expect(parseBuildInfo('format esm\n')).toBeUndefined();
  });
});

describe('readBuildInfo', () => {
  it('prefers the linked Creator Toolkit folder the build actually writes to', () => {
    // `packages/mod/build.mjs` writes its output to MELVOR_CT_DIR whenever it
    // is set, and the README tells the operator to set it. Walking up from cwd
    // for `dist-local` found whatever leftover was last written there and
    // compared the running build against a stamp from days ago, so the warning
    // never fired at all.
    const linked = mkdtempSync(join(tmpdir(), 'melvor-ct-'));
    writeFileSync(join(linked, 'BUILD_INFO.txt'), 'built 2026-09-02T08:00:00.000Z\n');

    const repo = mkdtempSync(join(tmpdir(), 'melvor-repo-'));
    mkdirSync(join(repo, 'packages', 'mod', 'dist-local'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'mod', 'dist-local', 'BUILD_INFO.txt'),
      'built 2026-08-20T08:00:00.000Z\n',
    );

    expect(parseBuildInfo(readBuildInfo({ MELVOR_CT_DIR: linked }, repo) ?? '')).toBe(
      '2026-09-02T08:00:00.000Z',
    );
  });

  it('falls back to dist-local when nothing is linked', () => {
    const repo = mkdtempSync(join(tmpdir(), 'melvor-repo-'));
    mkdirSync(join(repo, 'packages', 'mod', 'dist-local'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'mod', 'dist-local', 'BUILD_INFO.txt'),
      'built 2026-08-20T08:00:00.000Z\n',
    );

    expect(parseBuildInfo(readBuildInfo({}, repo) ?? '')).toBe('2026-08-20T08:00:00.000Z');
  });

  it('walks up, because nothing guarantees the service starts at the repo root', () => {
    const repo = mkdtempSync(join(tmpdir(), 'melvor-repo-'));
    const deep = join(repo, 'packages', 'planner');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(repo, 'packages', 'mod', 'dist-local'), { recursive: true });
    writeFileSync(
      join(repo, 'packages', 'mod', 'dist-local', 'BUILD_INFO.txt'),
      'built 2026-08-20T08:00:00.000Z\n',
    );

    expect(readBuildInfo({}, deep)).not.toBeNull();
  });

  it('is null when neither location has been built', () => {
    const empty = mkdtempSync(join(tmpdir(), 'melvor-empty-'));
    expect(readBuildInfo({ MELVOR_CT_DIR: empty }, empty)).toBeNull();
  });
});

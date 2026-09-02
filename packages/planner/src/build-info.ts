import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Tolerance when comparing the running build against the one on disk.
 *
 * The bundle stamps itself and `BUILD_INFO.txt` is written by the same build,
 * so the two can straddle a second boundary. They are now written from one
 * timestamp, which makes this belt-and-braces — but the previous attempt at
 * this compared `stamp.slice(0, 19)` as *strings*, so 06:22:54.998 against
 * 06:22:55.002 read as a newer build and the warning fired straight after a
 * successful reload. Five seconds is far longer than a build's own write skew
 * and far shorter than the hours a genuinely unloaded build sits waiting.
 */
export const BUILD_STAMP_TOLERANCE_MS = 5_000;

/**
 * Whether the build on disk is meaningfully newer than the one running.
 *
 * Compared as instants, not as text. String comparison of ISO stamps is
 * *almost* right, which is what made it survive review: it orders correctly
 * within a fixed format and fails only on the millisecond noise that this
 * comparison consists entirely of.
 *
 * @param built - Stamp from the build artifact, or undefined when unreadable.
 * @param running - Stamp the mod reported, or null when it reported none.
 * @returns True only when both parse and the gap exceeds the tolerance.
 */
export function isNewerBuild(built: string | undefined, running: string | null): boolean {
  if (built === undefined || running === null) return false;

  const builtAt = Date.parse(built);
  const runningAt = Date.parse(running);
  // A stamp that will not parse is not evidence of anything. A staleness
  // warning that fires on its own uncertainty is noise, and this repo has
  // already paid for one of those.
  if (Number.isNaN(builtAt) || Number.isNaN(runningAt)) return false;

  return builtAt - runningAt > BUILD_STAMP_TOLERANCE_MS;
}

/** The `built <stamp>` line from a BUILD_INFO.txt body. */
export function parseBuildInfo(info: string): string | undefined {
  return /built\s+(\S+)/.exec(info)?.[1];
}

/**
 * Locates the BUILD_INFO.txt of the build that is actually loaded in the game.
 *
 * Both places, in this order, because the build writes to one of them and the
 * previous version of this check looked only at the other. `packages/mod/build.mjs`
 * writes its output to `MELVOR_CT_DIR` whenever that is set — and the README
 * tells the operator to set it, because Directory Link is how the mod reaches
 * the game at all. So the walk up from `process.cwd()` found the leftover
 * `dist-local` from whenever the variable was last unset, compared the running
 * build against a stamp from days ago, and never warned. A staleness check that
 * reads the wrong artifact is worse than none: it answers the question
 * confidently and wrongly.
 *
 * @returns The file's contents, or null when neither location has one.
 */
export function readBuildInfo(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string | null {
  const linked = env.MELVOR_CT_DIR;
  if (linked !== undefined && linked !== '') {
    const info = readIfPresent(join(linked, 'BUILD_INFO.txt'));
    if (info !== null) return info;
  }

  // Walked up rather than assumed: the service is started from the repo root by
  // `pnpm planner`, but nothing guarantees that and a hardcoded join silently
  // produces no warning at all when it is wrong.
  let dir = cwd;
  for (let depth = 0; depth < 6; depth += 1) {
    const info = readIfPresent(join(dir, 'packages', 'mod', 'dist-local', 'BUILD_INFO.txt'));
    if (info !== null) return info;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Starting the planner service from inside the game.
 *
 * The agent is useless without the service and cannot tell you so usefully: it
 * reports "unreachable, start it with pnpm planner" to a panel nobody is
 * looking at. A crash proved the cost — the machine came back, the game came
 * back, the agent re-armed itself, and it sat blind until a human noticed the
 * service had not come back with them.
 *
 * This is possible only because Melvor's desktop client is NW.js and the game
 * frame has Node integration, which the HTTP transport already relies on for
 * exactly the same reason. `child_process` comes from the same `require`.
 *
 * Deliberately a button and never automatic. An agent that restarts its own
 * planner whenever it cannot reach one would, against a service that is broken
 * rather than absent, spawn a new process every few seconds forever. The
 * failure this fixes is "nobody was there to type a command", not "the service
 * needs supervising" — and those want very different mechanisms.
 */

/** Minimal shape of the bits of `child_process` used here. */
interface SpawnedProcess {
  pid?: number;
  unref(): void;
  on(event: 'error', handler: (error: Error) => void): void;
}

interface ChildProcessModule {
  spawn(
    command: string,
    args: readonly string[],
    options: { cwd: string; detached: boolean; shell: boolean; stdio: string },
  ): SpawnedProcess;
}

type NodeRequire = (id: string) => unknown;

/**
 * Finds NW.js's `require`, if this page has Node integration.
 *
 * Same lookup as the HTTP transport, repeated rather than shared because the
 * two modules fail independently: a build where Node is missing should lose the
 * launcher and keep the transport's own fallback to `fetch`.
 */
function nodeRequire(): NodeRequire | null {
  const scope = globalThis as { require?: unknown; nw?: unknown };

  if (typeof scope.require === 'function') return scope.require as NodeRequire;

  const nw = scope.nw as { require?: unknown } | undefined;
  if (nw !== undefined && typeof nw.require === 'function') {
    return nw.require as NodeRequire;
  }

  return null;
}

/** Whether this build can start a process at all. */
export function canLaunchService(): boolean {
  return nodeRequire() !== null;
}

export interface LaunchOutcome {
  ok: boolean;
  detail: string;
}

/**
 * Spawns the planner service, detached, from the repository directory.
 *
 * Detached and unreferenced on purpose: the service must outlive the game
 * window, or closing the game to reload a mod would take the planner with it —
 * which is the situation this exists to avoid, not to reproduce.
 *
 * The working directory has to be supplied because the mod has no idea where
 * the repository is. It is a setting rather than a guess: guessing wrong spawns
 * a process that fails somewhere the operator cannot see.
 *
 * @param repoPath - Absolute path to the melvor-agent repository.
 * @param command - The command to run, defaulting to the documented one.
 */
export function launchPlannerService(repoPath: string, command = 'pnpm planner'): LaunchOutcome {
  if (repoPath.trim() === '') {
    return {
      ok: false,
      detail: 'no repository path is configured, so there is nowhere to run the command from',
    };
  }

  const required = nodeRequire();
  if (required === null) {
    return {
      ok: false,
      detail: 'this build has no Node integration, so it cannot start a process',
    };
  }

  try {
    const childProcess = required('child_process') as ChildProcessModule;
    const [executable, ...args] = command.split(/\s+/u);
    if (executable === undefined) {
      return { ok: false, detail: `"${command}" is not a runnable command` };
    }

    const child = childProcess.spawn(executable, args, {
      cwd: repoPath,
      detached: true,
      // shell: true so `pnpm` resolves through PATH on Windows, where it is a
      // .cmd shim that spawn cannot execute directly.
      shell: true,
      // Ignored rather than piped: nothing in the game reads these, and an
      // unread pipe fills and blocks the child once it has logged enough.
      stdio: 'ignore',
    });

    let spawnError: string | null = null;
    child.on('error', (error) => {
      spawnError = error.message;
    });

    child.unref();

    // A pid is the only evidence available synchronously. The service still has
    // to bind its port, so this claims the process started — never that the
    // service is up. The panel finds that out the same way it always does, by
    // the next report succeeding.
    if (spawnError !== null) {
      return { ok: false, detail: `spawn failed: ${String(spawnError)}` };
    }

    return {
      ok: true,
      detail:
        child.pid === undefined
          ? `started "${command}" in ${repoPath}; waiting for it to answer`
          : `started "${command}" in ${repoPath} as pid ${child.pid}; waiting for it to answer`,
    };
  } catch (error) {
    return { ok: false, detail: `could not start the service: ${String(error)}` };
  }
}

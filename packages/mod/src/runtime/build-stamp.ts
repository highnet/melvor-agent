/**
 * When the running bundle was built.
 *
 * Injected by esbuild's `define` at compile time. The mod only reloads with the
 * game, so the code on disk and the code actually running can be hours apart —
 * and until now nothing said so. A whole session went by describing fixes as
 * "pending a reload", with no way for anyone, including the agent, to check
 * whether that was still true or the reload had already happened.
 *
 * Declared with a fallback because the constant only exists in a bundled build;
 * under vitest the identifier is not defined at all.
 */
declare const __MELVOR_AGENT_BUILD__: string | undefined;

export function readBuildStamp(): string | null {
  try {
    return typeof __MELVOR_AGENT_BUILD__ === 'string' ? __MELVOR_AGENT_BUILD__ : null;
  } catch {
    return null;
  }
}

/**
 * A short, human-readable form of the build time.
 *
 * Local time and to the minute, because it is read against a build log the
 * operator has in front of them, not parsed by anything.
 */
export function describeBuild(stamp: string | null): string {
  if (stamp === null) return 'unknown build';
  const parsed = new Date(stamp);
  if (Number.isNaN(parsed.getTime())) return 'unknown build';
  return parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

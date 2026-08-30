/**
 * Produces the save-export string.
 *
 * Uses `game.generateSaveString()` rather than the global `exportSave()`, which
 * drives the export modal — useless to an unattended agent. The string is
 * handed to the planner service, which is the only component that can write to
 * disk.
 *
 * @returns The save string, or an error when the game refuses to serialise.
 */
export function exportSave(): { ok: true; save: string } | { ok: false; detail: string } {
  try {
    const save = game.generateSaveString();
    if (typeof save !== 'string' || save.length === 0) {
      return { ok: false, detail: 'generateSaveString returned an empty value' };
    }
    return { ok: true, save };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

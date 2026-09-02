import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';

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

/**
 * Saves, then reloads the page so the mod is re-read from disk.
 *
 * The mod only changes when the game reloads, which until now meant a human at
 * the keyboard clicking the Creator Toolkit. That made every fix wait on
 * someone being present: today a deadlock fix, a course-thrash fix and four
 * diagnostics all sat committed and unloaded while the agent worked around
 * them, and two attempts to do it by driving the UI opened the Equipment panel
 * and the Summoning Synergies panel instead.
 *
 * `saveData` first, and it is not optional. A reload without it discards
 * whatever the game has not yet written on its own timer, which would turn a
 * convenience into a way to lose an hour.
 *
 * Deliberately the whole page rather than anything cleverer. Melvor loads mods
 * at startup; there is no documented way to swap one in place, and inventing
 * one would be exactly the kind of guess this codebase keeps paying for.
 */
export function reloadGame(): ActionResult<{ reloading: boolean }> {
  try {
    saveData();
  } catch (error) {
    return fail('save.reloadGame', 'threw', `save failed, refusing to reload: ${String(error)}`);
  }

  try {
    window.location.reload();
  } catch (error) {
    return fail('save.reloadGame', 'threw', `reload failed: ${String(error)}`);
  }

  // Nothing after this observes anything: the page is going away. Reported as
  // ok because the save succeeded and the reload was issued, which is the whole
  // of what can be known from here.
  return {
    ok: true,
    action: 'save.reloadGame',
    before: { reloading: false },
    after: { reloading: true },
    detail: 'saved and reloading; the mod will be re-read from disk',
  };
}

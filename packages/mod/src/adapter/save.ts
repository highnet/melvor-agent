import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { THIEVING_ID, stopGathering } from './gathering.js';
import { noteSwallowed } from './safe.js';
import { restoreStashedValuables } from './valuables.js';

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
  // Stop anything that costs health BEFORE saving, and save the stopped state.
  //
  // A reload is not a pause. The game computes offline progression from the
  // save, so a save taken mid-Thieving tells the next session to replay all of
  // that elapsed time -- landing the hits, but with the mod not yet loaded and
  // therefore no eatWhenLow to answer them. The character then dies during the
  // load, before anything is running that could have prevented it. That is how
  // this run died with 99 cooked Seahorse sitting in the bank.
  //
  // The reload is also not unattended on the other side: it lands on the
  // character-select screen and nothing resumes until a character is picked. So
  // the gap between saving and playing again is unbounded, which makes leaving
  // a damaging activity armed across it strictly indefensible.
  const stopped = stopDamagingActivity();

  // And put the fight's stripped valuables back on before the save, for the
  // same reason the stop happens before it: a reload is not a pause. The stash
  // that would restore them lives in this page's memory and goes away with the
  // page, while the save records the character wearing nothing in those slots
  // — so a reload taken mid-fight would leave the operator's Thiever's Cape in
  // the bank with nothing left that knows it belongs on the character.
  //
  // Nothing is lost either way, which is why this is tidiness rather than
  // safety: stashed gear sits in the bank where the death penalty cannot reach
  // it, and the next session's fill reflex would put it back unprompted. Doing
  // it here means the save is of the character as the operator left it.
  const restored = restoreStashedValuables(() => false);

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
    observed: { before: { reloading: false }, after: { reloading: true } },
    detail: [
      stopped === null ? undefined : `stopped ${stopped} first`,
      restored.ok ? 'put stripped valuables back on' : undefined,
      'saved and reloading; the mod will be re-read from disk',
    ]
      .filter((part) => part !== undefined)
      .join('; '),
  };
}

/**
 * Stops a health-costing activity so it is not left armed across a reload.
 *
 * Returns the skill id it stopped, or null when nothing needed stopping. Best
 * effort by design: a reload that cannot stop the activity is still better than
 * no reload, so a failure here is reported in the detail rather than aborting.
 */
function stopDamagingActivity(): string | null {
  try {
    if (game.combat.isActive) {
      game.combat.stop();
      return 'combat';
    }

    const active = game.activeAction;
    if (active?.id === THIEVING_ID) {
      stopGathering(THIEVING_ID, () => false);
      return THIEVING_ID;
    }
  } catch (error) {
    noteSwallowed('save.stopDamagingActivity', error);
    // Reported as "not stopped"; the reload proceeds either way.
  }

  return null;
}

/**
 * Local save slots, with the character in each.
 *
 * Matching by `characterName` (save.d.ts:13) rather than by slot number is the
 * whole safety property here. A slot index is positional and silently wrong if
 * the list ever reorders; a name identifies the character actually meant, and
 * loading the wrong save would mean the agent quietly playing someone else's
 * run.
 */
export function readLocalSaveSlots(): { slotId: number; characterName: string }[] {
  const slots: { slotId: number; characterName: string }[] = [];

  for (let slotId = 0; slotId < LOCAL_SAVE_SLOT_COUNT; slotId += 1) {
    try {
      const header = getLocalInfoInSlot(slotId);
      if (header === undefined) continue;
      if (!('characterName' in header)) continue;

      slots.push({ slotId, characterName: header.characterName });
    } catch (error) {
      noteSwallowed('save.readLocalSaveSlots', error);
      // A slot that will not describe itself is not a slot worth loading.
    }
  }

  return slots;
}

/**
 * How many local slots to probe.
 *
 * The game exposes no count, so this walks a fixed range and skips whatever is
 * absent. Over-scanning costs nothing; under-scanning would hide a character.
 */
const LOCAL_SAVE_SLOT_COUNT = 16;

/**
 * Enters the game as the named character, from the character-select screen.
 *
 * A reload lands here and stops: the agent is not running, the service reports
 * nothing, and the run idles until a human clicks. Overnight that is the whole
 * night. Since the mod's own `onCharacterSelectionLoaded` hook proves it is
 * alive on this screen, the click is automatable and there is no good reason
 * for a person to be the one making it.
 *
 * Refuses on anything ambiguous. Zero matches means the expected character is
 * not here and guessing would enter the wrong save; more than one match means
 * the name does not identify a character, and picking the first would be a coin
 * toss with someone's run. In both cases doing nothing leaves the screen up for
 * a human, which is exactly where this started and is a safe place to stop.
 */
export function loadCharacterByName(name: string): ActionResult<{ slotId: number }> {
  const matches = readLocalSaveSlots().filter((slot) => slot.characterName === name);

  const only = matches[0];
  if (only === undefined || matches.length > 1) {
    return fail(
      'save.loadCharacterByName',
      'precondition',
      matches.length > 1
        ? `${matches.length} local saves are named ${name}; refusing to guess which is the agent`
        : `no local save is named ${name}`,
    );
  }

  try {
    void loadLocalSave(only.slotId);
  } catch (error) {
    return fail('save.loadCharacterByName', 'threw', `load failed: ${String(error)}`);
  }

  return {
    ok: true,
    action: 'save.loadCharacterByName',
    observed: { before: { slotId: -1 }, after: { slotId: only.slotId } },
    detail: `loading ${name} from local slot ${only.slotId}`,
  };
}

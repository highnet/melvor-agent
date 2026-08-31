import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';

/**
 * Cartography and Archaeology — the two skills that feed each other.
 *
 * Surveying reveals dig sites and produces the maps Archaeology digs with;
 * digging is what makes the surveying worth doing. Neither is reachable through
 * the ordinary gathering path, because neither is a recipe: Cartography acts on
 * a *position on a map* and Archaeology on a dig site with a consumable map.
 *
 * Both are Atlas of Discovery content and simply absent without that expansion,
 * so every entry point here tolerates the skill not existing at all.
 */

// --- cartography -----------------------------------------------------------

/** A hex worth surveying, with the reason it is worth it. */
interface SurveyTarget {
  hex: Hex;
  label: string;
}

/**
 * Finds the best hex to survey.
 *
 * "Best" is the nearest unfinished hex in survey range, preferring one with a
 * point of interest: POIs are what actually unlock things — dig sites, fast
 * travel, portals — while an empty hex only pays XP.
 *
 * Hexes are identified by position rather than by id because they have none;
 * that is also why the objective carries no hex parameter and this choice is
 * made here, in code, against live state.
 */
function findSurveyTarget(): SurveyTarget | null {
  const cartography = game.cartography;
  if (cartography === undefined) return null;

  const map = cartography.activeMap;
  if (map === undefined) return null;

  // A WorldMap carries no realm of its own, so the realm refusal is applied to
  // where the character currently is. Abyssal maps are only reachable from an
  // abyssal realm, so this catches them at the only point that matters.
  if (isRefusedRealm(game.currentRealm.id)) return null;

  let best: SurveyTarget | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const column of map.hexes.values()) {
    for (const hex of column.values()) {
      try {
        if (hex.isMaxLevel) continue;
        if (!hex.inSurveyRange) continue;
        if (hex.cartographyLevel > cartography.level) continue;

        // A point of interest is the only thing surveying unlocks that
        // compounds; plain hexes pay XP alone.
        const score = (hex.hasPOI ? 1000 : 0) - hex.surveyLevel;
        if (score <= bestScore) continue;

        bestScore = score;
        best = {
          hex,
          label: hex.hasPOI
            ? `Survey hex (${hex.q}, ${hex.r}) — ${hex.pointOfInterest?.name ?? 'point of interest'}, survey level ${hex.surveyLevel}/${hex.maxLevel}`
            : `Survey hex (${hex.q}, ${hex.r}) — survey level ${hex.surveyLevel}/${hex.maxLevel}`,
        };
      } catch {
        // A hex whose state cannot be read is not a target.
      }
    }
  }

  return best;
}

/**
 * Starts surveying the best available hex.
 *
 * Auto-survey rather than a single survey action: the game will keep working
 * through the hex on its own, which is what an idle player leaves running, and
 * what makes this survive the offline window.
 *
 * `startAutoSurvey` returns a boolean, but the evidence is the skill actually
 * being active on the hex we chose.
 */
export function surveyBestHex(isSuspended: () => boolean): ActionResult<{
  surveying: boolean;
  hex: string | null;
}> {
  const cartography = game.cartography;
  if (cartography === undefined) {
    return fail('cartography.survey', 'precondition', 'Cartography is not installed');
  }

  const target = findSurveyTarget();
  if (target === null) {
    return fail(
      'cartography.survey',
      'precondition',
      'no hex in survey range is both unfinished and within the Cartography level',
    );
  }

  const project = (): { surveying: boolean; hex: string | null } => {
    const hex = cartography.autoSurveyHex;
    return {
      surveying: cartography.isSurveying,
      hex: hex === undefined ? null : `${hex.q},${hex.r}`,
    };
  };

  const chosen = `${target.hex.q},${target.hex.r}`;

  return act(
    {
      name: 'cartography.survey',
      observe: project,
      precondition: () => {
        const active = game.activeAction;
        if (active !== undefined && active.id !== cartography.id) {
          return `another action is running: ${active.id}`;
        }
        return null;
      },
      perform: () => cartography.startAutoSurvey(target.hex),
      changed: (_before, after) => after.surveying && after.hex === chosen,
    },
    isSuspended,
  );
}

// --- archaeology -----------------------------------------------------------

/**
 * Starts excavating a dig site.
 *
 * `canExcavate` is the game's own answer to "is this actually doable" — it
 * accounts for the map, its charges and the selected tools, all of which fail
 * silently otherwise. Reimplementing that check here would be the classic way
 * to get it subtly wrong.
 */
export function excavateDigSite(
  digSiteId: string,
  isSuspended: () => boolean,
): ActionResult<{ digSiteId: string | null; active: boolean }> {
  const archaeology = game.archaeology;
  if (archaeology === undefined) {
    return fail('archaeology.excavate', 'precondition', 'Archaeology is not installed');
  }

  const digSite = archaeology.actions.getObjectByID(digSiteId);
  if (digSite === undefined) {
    return fail('archaeology.excavate', 'precondition', `no dig site ${digSiteId}`);
  }

  const project = (): { digSiteId: string | null; active: boolean } => ({
    digSiteId: archaeology.currentDigSite?.id ?? null,
    active: archaeology.isActive,
  });

  return act(
    {
      name: 'archaeology.excavate',
      observe: project,
      precondition: () => {
        if (!archaeology.canExcavate(digSite)) {
          return `${digSiteId} cannot be excavated — it needs a map with charges and the right tools selected`;
        }
        const active = game.activeAction;
        if (active !== undefined && active.id !== archaeology.id) {
          return `another action is running: ${active.id}`;
        }
        return null;
      },
      perform: () => archaeology.startDigging(digSite),
      changed: (_before, after) => after.active && after.digSiteId === digSiteId,
    },
    isSuspended,
  );
}

/**
 * Exploration work that is currently possible.
 *
 * At most one survey candidate is offered, because the choice of *which* hex is
 * made from live geometry — survey range moves with the player — and a stale
 * list of hexes would be worse than no list.
 */
export function readExplorationCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  const target = findSurveyTarget();
  if (target !== null) {
    candidates.push({
      kind: 'survey_hex',
      params: { kind: 'survey_hex' },
      label: target.label,
      available: true,
    });
  }

  const archaeology = game.archaeology;
  if (archaeology !== undefined) {
    for (const digSite of archaeology.actions.allObjects) {
      try {
        if (!archaeology.canExcavate(digSite)) continue;
        candidates.push({
          kind: 'excavate_dig_site',
          params: { kind: 'excavate_dig_site', digSiteId: digSite.id },
          label: `Excavate ${digSite.name} (${digSite.selectedMap?.charges ?? 0} map charges)`,
          available: true,
        });
      } catch {
        // A dig site that cannot answer for itself is not a candidate.
      }
    }
  }

  return candidates;
}

// --- archaeology setup -----------------------------------------------------

/**
 * Selects a dig site's map.
 *
 * Excavating is impossible without one, so this is the step that turns a dig
 * site from "listed" into "doable". Maps are held per dig site and identified
 * by index, which is the game's own model — they are not namespaced objects.
 *
 * @param digSiteId - The dig site whose map to select.
 * @param mapIndex - Index into that dig site's `maps`.
 */
export function selectDigSiteMap(
  digSiteId: string,
  mapIndex: number,
  isSuspended: () => boolean,
): ActionResult<{ selectedIndex: number; charges: number }> {
  const archaeology = game.archaeology;
  if (archaeology === undefined) {
    return fail('archaeology.selectMap', 'precondition', 'Archaeology is not installed');
  }

  const digSite = archaeology.actions.getObjectByID(digSiteId);
  if (digSite === undefined) {
    return fail('archaeology.selectMap', 'precondition', `no dig site ${digSiteId}`);
  }

  const project = (): { selectedIndex: number; charges: number } => ({
    selectedIndex: digSite.selectedMapIndex,
    charges: digSite.selectedMap?.charges ?? 0,
  });

  return act(
    {
      name: 'archaeology.selectMap',
      observe: project,
      precondition: () => {
        if (!Number.isInteger(mapIndex) || mapIndex < 0 || mapIndex >= digSite.maps.length) {
          return `${digSiteId} has ${digSite.maps.length} maps; ${mapIndex} is out of range`;
        }
        if ((digSite.maps[mapIndex]?.charges ?? 0) <= 0) {
          return `map ${mapIndex} of ${digSiteId} has no charges left`;
        }
        return null;
      },
      perform: () => archaeology.setMapAsActive(digSite, mapIndex),
      changed: (_before, after) => after.selectedIndex === mapIndex,
    },
    isSuspended,
  );
}

/**
 * Turns one of a dig site's tools on.
 *
 * Tools decide *which artefact sizes* a dig can find, so digging with none
 * selected finds nothing while still consuming map charges — a silent waste
 * that looks exactly like bad luck.
 */
export function selectDigSiteTool(
  digSiteId: string,
  toolId: string,
  isSuspended: () => boolean,
): ActionResult<{ tools: string[] }> {
  const archaeology = game.archaeology;
  if (archaeology === undefined) {
    return fail('archaeology.selectTool', 'precondition', 'Archaeology is not installed');
  }

  const digSite = archaeology.actions.getObjectByID(digSiteId);
  if (digSite === undefined) {
    return fail('archaeology.selectTool', 'precondition', `no dig site ${digSiteId}`);
  }

  const tool = archaeology.tools.getObjectByID(toolId);
  if (tool === undefined) {
    return fail('archaeology.selectTool', 'precondition', `no archaeology tool ${toolId}`);
  }

  const project = (): { tools: string[] } => ({
    tools: digSite.selectedTools.map((selected) => selected.id).sort(),
  });

  return act(
    {
      name: 'archaeology.selectTool',
      observe: project,
      precondition: () =>
        digSite.selectedTools.includes(tool) ? `${toolId} is already selected` : null,
      perform: () => archaeology.setToolAsActive(digSite, tool),
      changed: (_before, after) => after.tools.includes(toolId),
    },
    isSuspended,
  );
}

/**
 * Dig site setup that is currently missing.
 *
 * Offered as candidates rather than done automatically because *which* map and
 * *which* tools is a real trade-off — tools cost charges and target different
 * artefact sizes, so the right choice depends on what the run is for.
 */
export function readDigSiteSetupCandidates(): Candidate[] {
  const archaeology = game.archaeology;
  if (archaeology === undefined) return [];

  const candidates: Candidate[] = [];

  for (const digSite of archaeology.actions.allObjects) {
    try {
      if (!digSite.isDiscovered) continue;

      if (digSite.selectedMap === undefined) {
        const usable = digSite.maps.findIndex((map) => map.charges > 0);
        if (usable >= 0) {
          candidates.push({
            kind: 'select_dig_map',
            params: { kind: 'select_dig_map', digSiteId: digSite.id, mapIndex: usable },
            label: `Select a map for ${digSite.name} (${digSite.maps[usable]?.charges ?? 0} charges) — excavation is impossible without one`,
            available: true,
          });
        }
        continue;
      }

      if (digSite.selectedTools.length === 0) {
        for (const tool of archaeology.tools.allObjects) {
          candidates.push({
            kind: 'select_dig_tool',
            params: { kind: 'select_dig_tool', digSiteId: digSite.id, toolId: tool.id },
            label: `Use the ${tool.name} at ${digSite.name} — with no tool selected a dig finds nothing and still spends charges`,
            available: true,
          });
        }
      }
    } catch {
      // A dig site that cannot answer for itself is not a candidate.
    }
  }

  return candidates;
}

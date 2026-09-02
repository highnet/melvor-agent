import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/**
 * The two things that keep working while the character does something else.
 *
 * Passive cooking runs in the background of every other action, and Township
 * health decays on its own and throttles the whole town when it falls. Both are
 * free value that a player picks up in passing and an agent misses entirely,
 * because neither is ever the "current action" — which is the only thing a
 * skill-at-a-time agent looks at.
 */

// --- passive cooking -------------------------------------------------------

/** What starting passive cooking claims to change. */
export interface PassiveCookProjection {
  categoryId: string;
  passive: boolean;
}

function projectCooking(categoryId: string): PassiveCookProjection {
  const cooking = game.cooking;
  const category = cooking.categories.getObjectByID(categoryId);
  return {
    categoryId,
    passive: category === undefined ? false : cooking.passiveCookTimers.get(category) !== undefined,
  };
}

/**
 * Starts passive cooking in a category.
 *
 * The only genuinely *parallel* production in the game: it fills a stockpile
 * while the character mines, fights or chops. Leaving it off costs nothing
 * visible, which is exactly why it stays off forever without someone to notice.
 *
 * Food is also the input to the survivability gate, so a stockpile filling in
 * the background is what eventually makes combat possible.
 *
 * @param categoryId - Namespaced `CookingCategory` id.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function startPassiveCooking(
  categoryId: string,
  isSuspended: () => boolean,
): ActionResult<PassiveCookProjection> {
  const cooking = game.cooking;
  const category = cooking.categories.getObjectByID(categoryId);
  if (category === undefined) {
    return fail('cooking.passive', 'precondition', `no cooking category ${categoryId}`);
  }

  return act(
    {
      name: 'cooking.passive',
      observe: () => projectCooking(categoryId),
      precondition: () => {
        if (projectCooking(categoryId).passive) return `${categoryId} is already cooking passively`;
        if (cooking.selectedRecipes.get(category) === undefined) {
          return `${categoryId} has no recipe selected`;
        }
        return null;
      },
      perform: () => cooking.startPassiveCooking(category),
      changed: (_before, after) => after.passive,
    },
    isSuspended,
  );
}

/** Cooking categories that have a recipe selected but are not cooking. */
export function readPassiveCookingCandidates(): Candidate[] {
  const cooking = game.cooking;
  const candidates: Candidate[] = [];

  for (const category of cooking.categories.allObjects) {
    try {
      const recipe = cooking.selectedRecipes.get(category);
      if (recipe === undefined) continue;
      if (cooking.passiveCookTimers.get(category) !== undefined) continue;

      candidates.push({
        kind: 'passive_cook',
        params: { kind: 'passive_cook', categoryId: category.id },
        label: `Passively cook ${recipe.product.name} in ${category.name} — runs in the background of whatever else is happening`,
        available: true,
      });
    } catch {
      // A category that cannot report its timer is not a candidate.
    }
  }

  return candidates;
}

// --- township health -------------------------------------------------------

/**
 * Spends a resource to restore town health.
 *
 * Health decays continuously and drags every rate in the town down with it, so
 * a town left alone for a week produces a fraction of what its buildings say it
 * should. Restoring it is cheap and the effect is immediate — the definition of
 * upkeep a human does without thinking about it.
 *
 * @param resourceId - The `TownshipResource` to spend, usually Herbs or Potions.
 * @param amount - How much to spend.
 */
/**
 * Town health as a real percentage.
 *
 * `townData.healthPercent` reads 0 on a town the game's own Township page shows
 * at 100%, so it is not the displayed figure and cannot be compared against
 * 100. The stored `health` against `maxHealth` is, and that is what the page
 * agrees with.
 *
 * This mattered more than a wrong label: because the reader believed health was
 * 0%, it offered restores on a town that was already full, the game did nothing
 * each time, and the "already full" precondition could never fire to explain
 * why. The earlier diagnosis — that only herbs and potions are accepted — is
 * true of the API but was not what was happening here.
 */
export function townHealthPercent(): number {
  const township = game.township;
  const max = township.maxHealth;
  if (max <= 0) return 0;

  return (township.townData.health / max) * 100;
}

export function increaseTownHealth(
  resourceId: string,
  amount: number,
  isSuspended: () => boolean,
): ActionResult<{ healthPercent: number }> {
  const township = game.township;
  const resource = township.resources.getObjectByID(resourceId);
  if (resource === undefined) {
    return fail('township.health', 'precondition', `no township resource ${resourceId}`);
  }

  const project = (): { healthPercent: number } => ({
    healthPercent: townHealthPercent(),
  });

  return act(
    {
      name: 'township.health',
      observe: project,
      precondition: () => {
        if (!township.townData.townCreated) return 'the town has not been created yet';
        if (townHealthPercent() >= 100) return 'town health is already full';
        // Refused with a reason rather than performed as a silent no-op: the
        // game only accepts herbs or potions here.
        if (!HEALTH_RESOURCE_IDS.includes(resourceId)) {
          return `town health can only be restored with Herbs or Potions, not ${resourceId}`;
        }
        const cost = township.getIncreaseHealthCost(resource);
        if (resource.amount < cost) {
          return `needs ${cost} ${resourceId}, town has ${resource.amount}`;
        }
        return null;
      },
      perform: () => township.increaseHealth(resource, amount),
      changed: (before, after) => after.healthPercent > before.healthPercent,
    },
    isSuspended,
  );
}

/**
 * The only resources the game will accept for town health.
 *
 * `increaseHealthOptions` is documented as "the quantities that health may be
 * increased by using herbs/potions", and that is literal: passing Food, Wood,
 * Stone or Ore makes `increaseHealth` a no-op. The reader offered all of them
 * because `getIncreaseHealthCost` returns a number for any resource, so seven
 * impossible candidates sat on the list and each one burned five retries before
 * the failure limit gave up on it.
 *
 * Ids as literals because `TownshipResourceTypeID` is an ambient const enum,
 * which cannot be referenced under `verbatimModuleSyntax` — the same constraint
 * as the realm ids.
 */
const HEALTH_RESOURCE_IDS = ['melvorF:Herbs', 'melvorF:Potions'];

/** Town health worth restoring, when the town can pay for it. */
export function readTownHealthCandidates(): Candidate[] {
  const township = game.township;
  if (!township.townData.townCreated) return [];
  if (townHealthPercent() >= 100) return [];

  const candidates: Candidate[] = [];

  for (const resource of township.resources.allObjects) {
    try {
      if (!HEALTH_RESOURCE_IDS.includes(resource.id)) continue;
      const cost = township.getIncreaseHealthCost(resource);
      if (cost <= 0 || resource.amount < cost) continue;

      candidates.push({
        kind: 'restore_town_health',
        params: { kind: 'restore_town_health', resourceId: resource.id, amount: cost },
        label: `Restore town health with ${cost} ${resource.name} (currently ${Math.round(townHealthPercent())}% — low health drags every rate in the town down)`,
        available: true,
      });
    } catch {
      // A resource that cannot price the restore is not a candidate.
    }
  }

  return candidates;
}

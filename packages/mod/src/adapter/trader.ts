import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/**
 * The Township Trader — the bridge between skilling and the town.
 *
 * A newly founded town owns nothing, produces nothing, and can therefore build
 * nothing: every building costs resources the town does not have, so the skill
 * deadlocks on its first move. The way out is the same one a human takes, which
 * is to hand the town what the character already gathered — logs become Wood,
 * ore becomes Ore, fish become Food.
 *
 * That makes this the capability that turns Woodcutting into Township, and
 * without it founding a town accomplishes nothing at all.
 */

/** What a conversion claims to change: bank down, town resource up. */
export interface ConversionProjection {
  resourceId: string;
  townAmount: number;
  bankQuantity: number;
}

/**
 * Trades bank items to the town for a resource.
 *
 * `processConversionToTownship` returns void, and the quantity is *staged*
 * separately by `updateConvertToQty` rather than passed in — so both sides are
 * observed instead: the item leaving the bank and the resource arriving.
 *
 * @param itemId - Namespaced item id to hand over, already in the bank.
 * @param resourceId - Namespaced `TownshipResource` id to receive.
 * @param quantity - How many items to convert. Capped at what the bank holds
 *                   and at what the town's storage can accept.
 */
export function convertItemToTownship(
  itemId: string,
  resourceId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<ConversionProjection> {
  const township = game.township;
  const resource = township.resources.getObjectByID(resourceId);
  if (resource === undefined) {
    return fail('township.convert', 'precondition', `no township resource ${resourceId}`);
  }

  const item = game.items.getObjectByID(itemId);
  if (item === undefined) {
    return fail('township.convert', 'precondition', `no item ${itemId}`);
  }

  const conversion = township
    .getResourceItemConversionsToTownship(resource)
    // `TownshipItemConversion` is a class and an interface merged: the class
    // side carries the item, the interface side the direction maps.
    .find((candidate) => candidate.item === item);

  if (conversion === undefined) {
    return fail(
      'township.convert',
      'precondition',
      `${itemId} cannot be traded to the town for ${resourceId}`,
    );
  }

  const project = (): ConversionProjection => ({
    resourceId,
    townAmount: resource.amount,
    bankQuantity: game.bank.getQty(item),
  });

  return act(
    {
      name: 'township.convert',
      observe: project,
      precondition: () => {
        if (!township.townData.townCreated) return 'the town has not been created yet';
        const held = game.bank.getQty(item);
        if (held <= 0) return `bank holds no ${itemId}`;
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        // Converting into a full store burns the items for nothing.
        if (township.getMaxPossibleConvertToTownshipValue(conversion) <= 0) {
          return `the town cannot accept any more ${resourceId}`;
        }
        return null;
      },
      perform: () => {
        const affordable = Math.min(
          quantity,
          game.bank.getQty(item),
          township.getMaxPossibleConvertToTownshipValue(conversion),
        );
        township.updateConvertToQty(affordable, conversion);
        township.processConversionToTownship(conversion, resource);
      },
      // Both sides must move. The bank falling alone would mean the items were
      // consumed for nothing, which is the failure worth catching.
      changed: (before, after) =>
        after.bankQuantity < before.bankQuantity && after.townAmount > before.townAmount,
    },
    isSuspended,
  );
}

/**
 * Trades the town's resources back for items.
 *
 * The reverse direction is rarely the right move — the town needs its resources
 * far more than the bank needs another log — so it exists for completeness and
 * is not offered as a candidate. A planner that wants it can ask.
 */
export function convertTownshipToItem(
  resourceId: string,
  itemId: string,
  quantity: number,
  isSuspended: () => boolean,
): ActionResult<ConversionProjection> {
  const township = game.township;
  const resource = township.resources.getObjectByID(resourceId);
  if (resource === undefined) {
    return fail('township.convertBack', 'precondition', `no township resource ${resourceId}`);
  }

  const item = game.items.getObjectByID(itemId);
  if (item === undefined) {
    return fail('township.convertBack', 'precondition', `no item ${itemId}`);
  }

  const conversion = township
    .getResourceItemConversionsFromTownship(resource)
    .find((candidate) => candidate.item === item);

  if (conversion === undefined) {
    return fail(
      'township.convertBack',
      'precondition',
      `${resourceId} cannot be traded back for ${itemId}`,
    );
  }

  const project = (): ConversionProjection => ({
    resourceId,
    townAmount: resource.amount,
    bankQuantity: game.bank.getQty(item),
  });

  return act(
    {
      name: 'township.convertBack',
      observe: project,
      precondition: () => {
        if (!township.townData.townCreated) return 'the town has not been created yet';
        if (resource.amount <= 0) return `the town has no ${resourceId}`;
        if (!Number.isInteger(quantity) || quantity <= 0) {
          return `quantity must be a positive integer, got ${quantity}`;
        }
        return null;
      },
      perform: () => {
        township.updateConvertFromQty(quantity, resource, conversion);
        township.processConversionFromTownship(conversion, resource);
      },
      changed: (before, after) =>
        after.townAmount < before.townAmount && after.bankQuantity > before.bankQuantity,
    },
    isSuspended,
  );
}

/** Below this, the town is too poor to build anything and needs seeding. */
const STARVED_RESOURCE_THRESHOLD = 100;

/**
 * Trades the town actually needs.
 *
 * Only offered for resources the town is short of, and only for items the bank
 * has a real surplus of. Both halves matter: trading away a stack the character
 * is about to use is a loss, and topping up a resource the town already has
 * plenty of does nothing.
 */
export function readTraderCandidates(): Candidate[] {
  const township = game.township;
  if (!township.townData.townCreated) return [];

  const candidates: Candidate[] = [];

  for (const resource of township.resources.allObjects) {
    try {
      // GP is a currency the character can spend directly; handing it to the
      // town is a decision, not a bootstrap. Compared by id because
      // `TownshipResourceTypeID` is an ambient const enum, which cannot be
      // referenced under verbatimModuleSyntax.
      if (resource.id === 'melvorF:GP') continue;
      if (resource.amount >= STARVED_RESOURCE_THRESHOLD) continue;

      for (const conversion of township.getResourceItemConversionsToTownship(resource)) {
        const item = conversion.item;
        const held = game.bank.getQty(item);
        if (held < STARVED_RESOURCE_THRESHOLD) continue;
        if (township.getMaxPossibleConvertToTownshipValue(conversion) <= 0) continue;

        candidates.push({
          kind: 'convert_to_township',
          params: {
            kind: 'convert_to_township',
            itemId: item.id,
            resourceId: resource.id,
            quantity: held,
          },
          label: `Trade ${held}x ${item.name} to the town for ${resource.name} (town has ${Math.round(resource.amount)}) — a town with no resources can build nothing`,
          available: true,
        });
      }
    } catch {
      // A resource that cannot report its conversions is not a candidate.
    }
  }

  return candidates;
}

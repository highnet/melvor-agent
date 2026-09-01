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
 * Long treated as rarely worth doing — the town needs its resources more than
 * the bank needs another log — and so left unoffered. That reasoning holds for
 * logs and fails badly for anything the town alone can make: `Herbs → Herb Box`
 * yields finished herbs, which is Herblore's input and the only route to it
 * that does not run through Farming. A capability nothing offers is a
 * capability that does not exist, which is how Herblore stayed unreachable.
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

/**
 * How much of an item the bank must hold before any of it is offered to the town.
 *
 * The gate this replaces asked whether the *town* was below 100, which was
 * written for seeding a brand-new town and stopped being the right question the
 * moment the town started building. Observed live: the town held 798 Wood, was
 * blocked from building Wooden Huts for want of more, and the character had
 * 1,412 Normal Logs sitting in the bank — no candidate was offered, because 798
 * is not "starved" by a threshold meant for a town that owns nothing.
 *
 * A town that cannot afford its next building is starved in the way that
 * matters. So the question is now about the bank instead: is there a real
 * surplus to give? The town's own storage cap still decides how much it can
 * take, and the planner still decides whether to give it.
 */
const BANK_SURPLUS_THRESHOLD = 200;

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

      for (const conversion of township.getResourceItemConversionsToTownship(resource)) {
        const item = conversion.item;
        const held = game.bank.getQty(item);
        if (held < BANK_SURPLUS_THRESHOLD) continue;
        if (township.getMaxPossibleConvertToTownshipValue(conversion) <= 0) continue;

        candidates.push({
          kind: 'convert_to_township',
          params: {
            kind: 'convert_to_township',
            itemId: item.id,
            resourceId: resource.id,
            quantity: held,
          },
          label: `Trade ${held}x ${item.name} to the town for ${resource.name} (town has ${Math.round(resource.amount)}) — the town builds with resources the character can simply hand it`,
          available: true,
        });
      }
    } catch {
      // A resource that cannot report its conversions is not a candidate.
    }
  }

  return candidates;
}

/** The town must hold at least this much before anything is traded away. */
const TRADE_BACK_SURPLUS = 200;

/**
 * Goods only the town can make.
 *
 * Offered from a surplus, never from a town that needs the resource itself, and
 * only for items the bank does not already hold a pile of. The point is the
 * things with no other source — Herb Boxes above all, which carry the herbs
 * Herblore needs and which no skill the character has can otherwise produce.
 */
export function readTownshipGoodsCandidates(): Candidate[] {
  const township = game.township;
  if (!township.townData.townCreated) return [];

  const candidates: Candidate[] = [];

  for (const resource of township.resources.allObjects) {
    try {
      if (resource.amount < TRADE_BACK_SURPLUS) continue;

      for (const conversion of township.getResourceItemConversionsFromTownship(resource)) {
        const item = conversion.item;
        // A stack already held is not the bottleneck this exists to clear.
        if (game.bank.getQty(item) > 0) continue;

        candidates.push({
          kind: 'convert_from_township',
          params: {
            kind: 'convert_from_township',
            resourceId: resource.id,
            itemId: item.id,
            quantity: 1,
          },
          label: `Trade ${resource.name} (town has ${Math.round(resource.amount)}) for ${item.name} — the town is the only source of this`,
          available: true,
        });
      }
    } catch {
      // A resource that cannot report its conversions is not a candidate.
    }
  }

  return candidates;
}

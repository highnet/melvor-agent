import type { Candidate } from '@melvor-agent/shared';
import { noteSwallowed } from './safe.js';
import { readTaskWantedQuantities } from './township.js';

/**
 * How much of an item something else is short of, and why.
 *
 * Every goal and every plan step this run has ever set was level-shaped, and
 * not because the alternative was missing: `parseCondition` reads
 * `item <id> >= <n>`, `set_objective` and `set_plan` both take
 * `untilItemId`/`untilQuantity`, and `item_qty_at_least` has been in the
 * contract, in `criteria.ts` and in the panel from the start. Nothing could
 * ever *say* a number, so the shape may as well not have existed -- and a plan
 * went out reading "craft Mind Runes to Runecrafting 49", a level target for a
 * stock problem, which would have stopped at whatever rune count level 49
 * happened to land on.
 *
 * The numbers were never missing either. `missingInputs` returns
 * `{ itemId, need, have }`, `readTaskWantedQuantities` returns a map of item to
 * quantity, and the blocked list already prints `Magic: Superheat II — Earth
 * Rune from Runecrafting: Earth Rune — needs Earth Rune 1/3` -- a producer, an
 * item and a number, which is a complete stock objective in prose and
 * unreadable by any code. This is that sentence as data.
 *
 * A demand is deliberately a **suggestion**, carried to the planner on the
 * candidate that would satisfy it. This module does not choose targets; see
 * `rungFor` in the planner for the standing argument that a tool reports and
 * the caller decides.
 */
export interface StockDemand {
  itemId: string;
  name: string;
  /**
   * An absolute bank target, matching `item_qty_at_least` -- never a delta.
   *
   * The criterion the planner will build from this asks whether the bank holds
   * at least `qty`, so a shortfall expressed as "how many more" would be wrong
   * by whatever is already banked, in the direction that produces too little.
   */
  quantity: number;
  have: number;
  /** How the figure was derived, in a sentence the planner can argue with. */
  why: string;
  /**
   * Which kind of consumer wants it.
   *
   * The two are told apart in `why` and nowhere else, which made the
   * distinction readable by a person and invisible to code — the same failure
   * this whole module was written to fix, one field further in. The stopgap
   * needs it: the operator's rule is *otherwise do township tasks*, and "a
   * town task wants 5,000 fish" is a job worth adopting unattended, while "a
   * blocked recipe wants an hour of Earth Runes" is a production chain whose
   * consumer a planner chose and the stopgap did not.
   */
  source: 'township_task' | 'recipe_input';
}

/**
 * Turns one blocked recipe's shortfall into a stock figure.
 *
 * The scale is the whole difficulty. A blocked recipe's `need` is *one craft's
 * worth* -- three Earth Runes for a Superheat cast -- and "craft until you have
 * 3" is an objective that ends in seconds, which is the no-op shape the plan
 * tool already refuses. Some multiple is wanted, and inventing one would put a
 * guess exactly where this repo keeps finding measurements should be.
 *
 * So the multiple is read off the consumer rather than chosen: **one hour of
 * the consumer at its own actions-per-hour**. The hour is not arbitrary either
 * -- `expectedDurationMin` is capped at 60 by both planning tools and
 * `abortMinutes` defaults to 60, so an hour is the largest span an objective is
 * expected to cover, and "enough for the thing that wants it to run one full
 * objective" is the smallest figure that is not immediately spent.
 *
 * What is already banked counts toward it, because the target is absolute.
 *
 * @param actionsPerHour - The *consumer's* rate, from its own resolved
 *   interval. Zero or non-finite yields no demand: a rate that could not be
 *   read is not a rate to multiply by.
 */
export function demandFromShortfall(
  consumerLabel: string,
  missing: { itemId: string; name: string; need: number; have: number },
  actionsPerHour: number,
): StockDemand | null {
  if (!Number.isFinite(actionsPerHour) || actionsPerHour <= 0) return null;
  if (!(missing.need > 0)) return null;

  const quantity = Math.ceil(missing.need * actionsPerHour);
  if (!Number.isFinite(quantity) || quantity <= 0) return null;

  return {
    itemId: missing.itemId,
    name: missing.name,
    quantity,
    have: missing.have,
    why: `${consumerLabel} consumes ${missing.need} per action at about ${Math.round(actionsPerHour).toLocaleString()} actions/h, so ${quantity.toLocaleString()} is one hour of it; ${missing.have.toLocaleString()} banked`,
    source: 'recipe_input',
  };
}

/**
 * What the town's unfinished tasks are asking for.
 *
 * The one demand source that needs no scaling at all: a task states its own
 * quantity, and `readTaskWantedQuantities` already keeps the largest single ask
 * per item because tasks are completed one at a time. That figure is exactly an
 * `item_qty_at_least` target -- the goal is a bank count -- so it is passed
 * through untouched.
 *
 * Items already covered are dropped rather than reported as satisfied: a
 * suggestion to produce something the bank already holds enough of is the
 * no-op the plan tool would refuse anyway.
 */
export function readTaskStockDemands(bankQty: (itemId: string) => number): StockDemand[] {
  const demands: StockDemand[] = [];

  try {
    for (const [itemId, quantity] of readTaskWantedQuantities()) {
      const have = bankQty(itemId);
      if (have >= quantity) continue;

      demands.push({
        itemId,
        name: itemId,
        quantity,
        have,
        why: `a Township task wants ${quantity.toLocaleString()} and ${have.toLocaleString()} are banked — tasks pay GP, items and the Township XP the skilling outfits sit behind`,
        source: 'township_task',
      });
    }
  } catch (error) {
    noteSwallowed('stockDemand.readTaskStockDemands', error);
    // A town that will not describe its tasks asks for nothing; the blocked
    // list carries its own reason and this must not cost the report.
  }

  return demands;
}

/**
 * Collapses many demands for the same item into the one that covers them all.
 *
 * The largest, and its own reasoning kept verbatim. Summing would be wrong:
 * two consumers wanting an hour of Earth Runes each are not run at the same
 * time, so the larger already covers the smaller -- the same argument
 * `readTaskWantedQuantities` makes for taking the largest single ask rather
 * than the sum of every task in the game.
 */
export function mergeDemands(demands: readonly StockDemand[]): Map<string, StockDemand> {
  const byItem = new Map<string, StockDemand>();

  for (const demand of demands) {
    const held = byItem.get(demand.itemId);
    if (held === undefined || demand.quantity > held.quantity) byItem.set(demand.itemId, demand);
  }

  return byItem;
}

/**
 * Puts each demand on the candidate that would produce it.
 *
 * This is the join the blocked list was already describing in prose and could
 * not hand to anything: `describeProducers` names the producing recipe in a
 * label, and a label is not a candidate index. A candidate carries `produces`,
 * a demand carries an item, and matching the two is the whole mechanism.
 *
 * Every matching candidate is annotated, not just the best one. Which producer
 * to run is a planning decision -- Runecrafting has several rune recipes and
 * the character may be level-gated out of the fastest -- and narrowing the list
 * here would be choosing on the caller's behalf.
 *
 * Returns new candidates rather than mutating: the enumeration is cached for
 * the panel, and annotating in place would leave last pass's suggestions on it
 * after the shortfall was filled.
 */
export function annotateStockDemand(
  candidates: readonly Candidate[],
  demands: ReadonlyMap<string, StockDemand>,
): Candidate[] {
  if (demands.size === 0) return [...candidates];

  return candidates.map((candidate) => {
    const produced = candidate.produces?.itemId;
    if (produced === undefined) return candidate;

    const demand = demands.get(produced);
    if (demand === undefined) return candidate;

    return {
      ...candidate,
      suggestedStock: {
        itemId: demand.itemId,
        // The candidate's own name for the item, where it has one. A Township
        // task demand only ever carries an id -- the wanted map is keyed by id
        // and holds no names -- and "melvorD:Mind_Rune" in a suggestion the
        // planner is meant to read is exactly the prose-versus-data failure
        // this whole change is about, one layer up.
        name: candidate.produces?.name ?? demand.name,
        quantity: demand.quantity,
        have: demand.have,
        why: demand.why,
        source: demand.source,
      },
    };
  });
}

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectiveKindSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';

/**
 * Can the planner actually *choose* every capability?
 *
 * The reachability suite proves each objective kind has an executor, and the
 * typed registry proves it at compile time. Neither proves anything ever offers
 * one. Slayer had a working executor and no candidate reader for a full day:
 * the contract listed it, the tests passed, and the planner could not select it
 * in play — a capability that exists only in the type system.
 *
 * This scans the adapter for candidate literals rather than running the game,
 * because candidate readers need the `game` global. It is a coarse check by
 * design: it asks whether some reader *mentions* producing a kind, which is
 * exactly the gap that went unnoticed.
 */

const here = dirname(fileURLToPath(import.meta.url));
const adapterDir = resolve(here, '../src/adapter');

/** Kinds the planner is never meant to select for itself, and why. */
const NOT_SELECTABLE: Record<string, string> = {
  // Answered only when an event stops and asks; offering it otherwise would be
  // choosing an answer to a question nobody posed.
  choose_event_passive: 'only offered while an event is waiting on a passive',
  // Locking an item guards against *accidental* selling, and the reasoning here
  // used to be that every sale is a deliberate objective, so a lock could only
  // block a decision already taken on purpose.
  //
  // That premise was falsified in play. A sell plan built seconds after a
  // listing would have sold two Garum Seeds — the only herb seeds of the whole
  // session — because the list reordered underneath it and index 91 stopped
  // meaning Oak Logs. The sale would have been deliberate in form and not at
  // all in intent. The drift guard refused it, and the sell reader now also
  // refuses to offer the last of any recipe ingredient, which is the cheaper
  // and automatic version of a lock.
  //
  // The manual lock stays unoffered: with those two guards in place it is once
  // again an operator's tool rather than a play decision.
  toggle_bank_lock: 'an operator safeguard, not a play decision',
};

function adapterSource(): string {
  return readdirSync(adapterDir)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => readFileSync(join(adapterDir, name), 'utf8'))
    .join('\n');
}

describe('every capability is selectable', () => {
  it('has a candidate reader that can produce each objective kind', () => {
    const source = adapterSource();

    const missing = objectiveKindSchema.options.filter((kind) => {
      if (NOT_SELECTABLE[kind] !== undefined) return false;
      // A candidate literal names its kind twice: once on the candidate and
      // once inside params. Either spelling counts as "something offers this".
      return !source.includes(`kind: '${kind}'`);
    });

    // A kind with an executor and no reader is a capability that exists only in
    // the type system: the build passes, the contract lists it, and the planner
    // can never pick it.
    expect(missing).toEqual([]);
  });

  it('notices a kind nothing offers', () => {
    // Proves the check can fail. Without it, "everything is selectable" and
    // "the scan matched nothing" look identical.
    const source = "kind: 'gather_resource'";
    const invented = ['gather_resource', 'melvorx_basketweaving'].filter(
      (kind) => !source.includes(`kind: '${kind}'`),
    );

    expect(invented).toEqual(['melvorx_basketweaving']);
  });
});

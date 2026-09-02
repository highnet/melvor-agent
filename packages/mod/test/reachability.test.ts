import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectiveKindSchema } from '@melvor-agent/shared';
import { describe, expect, it } from 'vitest';
import { supportedKinds } from '../src/policy/index.js';

/**
 * Is every system in the installed game actually reachable?
 *
 * "Feature complete" is a claim about the *game*, not about this codebase, so
 * checking it against a list I wrote from memory proves nothing. These tests
 * check against the knowledge dump — generated from the running game's own
 * registries — so a skill that exists in the player's install and has no way to
 * be trained fails the build rather than being quietly absent.
 *
 * The dump is NOT committed -- `data/` is gitignored, because it is generated
 * from a real save. So on CI, and on any fresh clone, there is nothing to check
 * against.
 *
 * That used to be invisible. Every assertion sat behind `if (dump === null)
 * return;`, including `expect(unreachable).toEqual([])`, so the suite reported
 * six passing reachability checks having made none of them -- and the docstring
 * said the dump was committed state, which was simply false. A gate that
 * reports green while asserting nothing is worse than no gate: it is the only
 * kind that can be trusted and be wrong.
 *
 * The dump-dependent checks are now declared with `describe.skipIf`, so vitest
 * reports them as SKIPPED and the run summary says so out loud. The checks that
 * need no dump -- the negative control, and the contract-vs-registry equality
 * that is the reason this file catches a capability added to the shared
 * contract while the mod is not being built -- run unconditionally, on CI
 * included.
 *
 * Making the absent case a hard failure is the right end state, and it needs a
 * redacted registry-only fixture (ids and names, no save state) committed
 * first. Until that exists, failing here would only turn main red.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dumpPath = resolve(here, '../../../data/dump.json');

interface Dump {
  gameVersion: string;
  skills: { id: string; name: string }[];
  dungeons: { id: string }[];
  monsters: { id: string }[];
  shopPurchases: { id: string }[];
}

function loadDump(): Dump | null {
  try {
    return JSON.parse(readFileSync(dumpPath, 'utf8')) as Dump;
  } catch {
    return null;
  }
}

/**
 * Skills reachable through `gather_resource`, mirroring the adapter's list.
 *
 * Duplicated deliberately: if this list and the adapter's drift apart, that is
 * exactly the bug worth failing on, and importing the adapter here would pull
 * in the `game` global that only exists inside Melvor.
 */
const GATHERABLE = new Set([
  'melvorD:Woodcutting',
  'melvorD:Mining',
  'melvorD:Fishing',
  'melvorD:Smithing',
  'melvorD:Crafting',
  'melvorD:Fletching',
  'melvorD:Herblore',
  'melvorD:Runecrafting',
  'melvorD:Summoning',
  'melvorD:Firemaking',
  'melvorD:Cooking',
  'melvorD:Thieving',
  'melvorD:Astrology',
  'melvorD:Agility',
  'melvorD:AltMagic',
  'melvorItA:Harvesting',
]);

/** Skills trained by a capability other than gathering, and which one. */
const OTHERWISE_REACHABLE: Record<string, string> = {
  'melvorD:Farming': 'tend_farm and compost_plot',
  'melvorD:Township': 'build_township, repair_township, restore_town_health',
  'melvorAoD:Cartography': 'survey_hex and make_paper',
  'melvorAoD:Archaeology': 'excavate_dig_site, select_dig_map, select_dig_tool',
  'melvorD:Attack': 'fight_monster, run_dungeon, start_combat_event',
  'melvorD:Strength': 'fight_monster, run_dungeon, start_combat_event',
  'melvorD:Defence': 'fight_monster, run_dungeon, start_combat_event',
  'melvorD:Hitpoints': 'fight_monster, run_dungeon, start_combat_event',
  'melvorD:Ranged': 'fight_monster with a ranged attack style',
  'melvorD:Magic': 'fight_monster with select_spell',
  'melvorD:Prayer': 'toggle_prayer, and bones from fighting',
  'melvorD:Slayer': 'new_slayer_task then fight_monster',
  'melvorD:Corruption': 'passive: unlocks by fighting in the Abyss',
  'melvorItA:Corruption': 'passive: unlocks by fighting in the Abyss',
};

const dump = loadDump();

/** Whether a skill has any path to being trained. */
const unreachableIn = (skills: { id: string }[]): string[] =>
  skills
    .map((skill) => skill.id)
    .filter((id) => !GATHERABLE.has(id) && OTHERWISE_REACHABLE[id] === undefined);

describe('game reachability', () => {
  it('notices a skill it has no path to train', () => {
    // The negative control, and the only reason the checks below mean anything:
    // without it, "no unreachable skills" and "the predicate is broken" look
    // identical. It needs no dump, so it runs everywhere -- including on the CI
    // runs where the rest of this file cannot.
    expect(unreachableIn([{ id: 'melvorX:Basketweaving' }])).toEqual(['melvorX:Basketweaving']);
  });

  it('has an executor for every capability the contract declares', () => {
    // The typed registry already enforces this at compile time; asserting it
    // here is what catches a kind added to the contract while the mod is not
    // being built — the contract is shared, and the planner would happily emit
    // an objective nothing can perform.
    expect([...supportedKinds()].sort()).toEqual([...objectiveKindSchema.options].sort());
  });
});

/**
 * Declared with `skipIf` rather than guarded with an early `return`.
 *
 * The difference is the whole point of this change: an early return reports a
 * PASS, so `expect(unreachable).toEqual([])` was claiming a clean bill of
 * health on every CI run without ever loading a skill list. `skipIf` reports a
 * SKIP, and the run summary counts it, so "this gate did not run" is a thing
 * anyone reading the output can see.
 */
describe.skipIf(dump === null)('game reachability, against the installed registries', () => {
  it('can train every skill the installed game registers', () => {
    if (dump === null) return;

    // A truncated dump would make this pass by having nothing to check, which
    // is the failure mode that matters most for a test whose whole job is to
    // notice absence.
    expect(dump.skills.length).toBeGreaterThan(20);

    // A skill in the player's install with no path to train it is the exact
    // shape of "not feature complete", and it should break the build rather
    // than be discovered months later as a level 1 skill nobody noticed.
    expect(unreachableIn(dump.skills)).toEqual([]);
  });

  it('can fight the dungeons and monsters the game registers', () => {
    if (dump === null) return;

    // Every monster and dungeon goes through the same two capabilities, so the
    // check that matters is that those capabilities exist and the game has
    // content for them — a registry that came back empty means the dump is
    // broken, and the coverage claim rests on it.
    expect(dump.monsters.length).toBeGreaterThan(0);
    expect(dump.dungeons.length).toBeGreaterThan(0);
    expect(supportedKinds()).toContain('fight_monster');
    expect(supportedKinds()).toContain('run_dungeon');
  });

  it('can buy what the shop sells', () => {
    if (dump === null) return;

    expect(dump.shopPurchases.length).toBeGreaterThan(0);
    expect(supportedKinds()).toContain('buy_shop_upgrade');
  });
});

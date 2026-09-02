import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { objectiveKindSchema } from '../packages/shared/src/objective.js';

/**
 * Generates `docs/COVERAGE.md` — what the agent can actually do.
 *
 * Feature completeness is the kind of claim that rots quietly: a capability is
 * added, a doc is not, and six weeks later nobody knows whether the gap in the
 * list is real. So the list of capabilities is derived from the contract that
 * defines them, and CI fails when the committed file disagrees.
 *
 * What is *not* covered still has to be written by hand — absence cannot be
 * derived — but each entry states why, so "missing" and "deliberately out of
 * scope" stay distinguishable.
 *
 * Run: `pnpm docs:coverage` (write) or `pnpm docs:coverage:check` (verify).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const output = join(repoRoot, 'docs/COVERAGE.md');
const checkOnly = process.argv.includes('--check');

/** Human descriptions, keyed by kind. A kind with none is a hole in the docs. */
const DESCRIPTIONS: Record<string, string> = {
  gather_resource: 'Train any gathering or artisan skill on a chosen recipe',
  sell_items: 'Sell one item stack, keeping a stated quantity',
  buy_shop_upgrade: 'Buy from the shop above a GP floor',
  fight_monster: 'Fight a monster, behind the survivability gate',
  run_dungeon: 'Run a dungeon, gated on its hardest monster',
  tend_farm: 'Buy, plant and harvest farm plots',
  compost_plot: 'Compost a growing plot so the crop cannot die',
  equip_item: 'Equip gear, including mid-fight',
  equip_food: 'Equip food from the bank',
  change_equipment_set: 'Switch between saved loadouts',
  spend_mastery: "Convert a skill's mastery pool into mastery levels",
  set_attack_style: 'Choose which combat skill receives XP',
  toggle_prayer: 'Turn a prayer on or off',
  toggle_curse: 'Turn a curse on or off',
  toggle_aurora: 'Turn an aurora on or off',
  select_spell: 'Choose the attack spell for Magic combat',
  use_potion: 'Drink a potion for the current activity',
  new_slayer_task: 'Take a Slayer task',
  toggle_bank_lock: 'Lock a bank item so selling cannot destroy it',
  upgrade_item: 'Combine bank materials into a better item',
  build_township: 'Build a Township building in a biome',
  repair_township: 'Repair a degraded Township building',
  restore_town_health: 'Spend town resources to restore town health',
  survey_hex: 'Survey the best available Cartography hex',
  excavate_dig_site: 'Excavate an Archaeology dig site',
  select_dig_map: 'Select the map a dig site digs with',
  travel_to_poi: 'Travel to a surveyed Point of Interest, which is how dig sites are reached',
  select_dig_tool: 'Select which tools a dig site uses',
  build_obstacle: 'Build an Agility course obstacle',
  upgrade_constellation: 'Spend stardust on a constellation modifier',
  unlock_skill_node: 'Spend skill points on a skill tree node',
  select_level_cap: 'Choose which skill a level cap increase raises',
  passive_cook: 'Start passive cooking, which runs behind everything else',
  run_golbin_raid: 'Play a Golbin Raid, answering each choice it stops on',
  select_worship: "Choose the town's worship while it is still free",
  make_paper: 'Make Cartography paper, which is what maps are made from',
  start_combat_event: 'Enter a combat event — the end-game gauntlet ending in a final boss',
  choose_event_passive: 'Answer the passive choice an event freezes on between stages',
  convert_from_township:
    'Trade town resources back for goods only the town can make, such as Herb Boxes',
  convert_to_township: 'Trade bank items to the town for resources it can build with',
  bury_bones: 'Bury bones for Prayer XP and the points prayers spend',
  open_item: 'Open bird nests and chests, the only source of some items',
  claim_mastery_token:
    'Claim a Mastery Token into its skill mastery pool, which the sell list was otherwise offering to liquidate',
  claim_township_task: 'Claim a finished Township task',
  claim_casual_task: 'Claim a finished casual task, freeing one of its five slots',
};

/** Systems with no capability, and why that is the right call. */
const NOT_COVERED: [string, string][] = [
  ['Ancient Relics', 'granted automatically by playing; there is nothing to decide'],
  ['Pets', 'rolled automatically from actions the agent already performs'],
  ['Mastery checkpoints', 'applied by the game the moment the threshold is crossed'],
  ['Bank tabs and sorting', 'cosmetic; no effect on what the character can do'],
  [
    'Switching an existing Township worship',
    'the first choice is a capability; switching later costs 50,000,000 GP and destroys every worship building, so it is not offered beside "build a hut" where a planner skimming labels could pick it',
  ],
  [
    'Offering item downgrades as candidates',
    'the capability exists and an objective may ask for a downgrade outright; it is never *proposed*, because it destroys the better item for a refund and no enumeration should tempt a planner into one',
  ],
  [
    'Limited-time events',
    'rewards roll automatically from actions the agent already performs; there is no choice to make',
  ],
  [
    'Clue Hunt',
    'a puzzle chain the developers deliberately hid — the typings scold anyone reading them. Solving it by reading game data would defeat its point rather than play it',
  ],
];

const kinds = objectiveKindSchema.options;
const missing = kinds.filter((kind) => DESCRIPTIONS[kind] === undefined);
if (missing.length > 0) {
  throw new Error(
    `no description for capability kind(s): ${missing.join(', ')}. Add them to scripts/gen-coverage.ts.`,
  );
}

/**
 * Skill ids the generic enumeration will start.
 *
 * Read from the source rather than duplicated, and the whole file is scanned
 * for `melvor*:` ids because STARTABLE_SKILL_IDS spreads GATHERING_SKILL_IDS,
 * which is declared elsewhere in the file behind named constants -- a reader
 * that only looked at the literal list reported Woodcutting, Mining and Fishing
 * as unsupported, which would have been a false alarm in a document whose whole
 * job is to be trusted.
 */
const STARTABLE = new Set(
  [
    ...readFileSync(resolve(repoRoot, 'packages/mod/src/adapter/gathering.ts'), 'utf8').matchAll(
      /'(melvor[A-Za-z]*:[A-Za-z]+)'/g,
    ),
  ].map((m) => m[1] as string),
);

/**
 * Skills trained through a dedicated capability rather than the generic recipe
 * enumeration, and skills the agent genuinely cannot train yet.
 *
 * Anything absent from both this map and STARTABLE_SKILL_IDS shows as a gap,
 * which is the point: "all skills are supported" should be checkable rather
 * than asserted.
 */
const SKILL_NOTES: Record<string, string> = {
  'melvorD:Attack': 'combat — `fight_monster` with `set_attack_style`',
  'melvorD:Strength': 'combat — `fight_monster` with `set_attack_style`',
  'melvorD:Defence': 'combat — `fight_monster` with `set_attack_style`',
  'melvorD:Hitpoints': 'combat — trained by taking damage in `fight_monster`',
  'melvorD:Ranged': 'combat — `fight_monster` with a ranged style and ammunition',
  'melvorD:Prayer': 'combat — `bury_bones` for points, `toggle_prayer` to spend them',
  'melvorD:Slayer': 'combat — `new_slayer_task`, then `fight_monster`',
  'melvorD:Farming': '`tend_farm` (plant, compost, harvest)',
  'melvorD:Township': '`build_township`, `repair_township`, `claim_township_task`',
  'melvorAoD:Cartography': '`survey_hex`, `make_paper`, `travel_to_poi`',
  'melvorAoD:Archaeology': '`excavate_dig_site` with `select_dig_map` and `select_dig_tool`',
  'melvorItA:Corruption':
    'not yet — gated behind the Abyssal realm, which needs the Into the Abyss dungeon',
  'melvorItA:Harvesting':
    'startable, but gated behind the Abyssal realm, which needs the Into the Abyss dungeon',
};

const skillRows = (() => {
  let skills: { id: string; name: string }[] = [];
  try {
    skills = (
      JSON.parse(readFileSync(resolve(repoRoot, 'data/dump.json'), 'utf8')) as {
        skills: { id: string; name: string }[];
      }
    ).skills;
  } catch {
    return ['| _(no dump available; run `dump_knowledge`)_ | |'];
  }

  return skills.map((skill) => {
    const note = SKILL_NOTES[skill.id];
    if (note !== undefined) return `| ${skill.name} | ${note} |`;
    if (STARTABLE.has(skill.id))
      return `| ${skill.name} | startable — recipes offered as candidates |`;
    return `| ${skill.name} | **gap — no way to train it** |`;
  });
})();

const lines = [
  '# Coverage',
  '',
  '<!-- Generated by scripts/gen-coverage.ts. Do not edit by hand. -->',
  '',
  `The agent has **${kinds.length} capabilities**. Each is a decision the planner can`,
  'choose and the mod can verify — every one returns before/after evidence rather',
  'than a return value it was told to trust.',
  '',
  '## What the agent can do',
  '',
  '| Capability | What it does |',
  '| --- | --- |',
  ...[...kinds].sort().map((kind) => `| \`${kind}\` | ${DESCRIPTIONS[kind]} |`),
  '',
  '## Every skill, and how the agent trains it',
  '',
  'Generated from the skill registry in `data/dump.json`, so a skill the game',
  'adds cannot quietly go unlisted. "Startable" means the generic candidate',
  'enumeration offers its recipes; the rest are named with the capability that',
  'covers them, or with what is still missing.',
  '',
  '| Skill | How it is trained |',
  '| --- | --- |',
  ...skillRows,
  '',
  '## What it deliberately does not do',
  '',
  '| System | Why not |',
  '| --- | --- |',
  ...NOT_COVERED.map(([system, why]) => `| ${system} | ${why} |`),
  '',
];

const contents = `${lines.join('\n')}`;

if (checkOnly) {
  let committed = '';
  try {
    committed = readFileSync(output, 'utf8');
  } catch {
    console.error('docs/COVERAGE.md is missing. Run: pnpm docs:coverage');
    process.exit(1);
  }

  if (committed !== contents) {
    console.error('docs/COVERAGE.md is out of date. Run: pnpm docs:coverage');
    process.exit(1);
  }

  console.log(`docs/COVERAGE.md is current (${kinds.length} capabilities).`);
} else {
  writeFileSync(output, contents, 'utf8');
  console.log(`Wrote docs/COVERAGE.md (${kinds.length} capabilities).`);
}

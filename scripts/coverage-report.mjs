/**
 * Reports what the agent can actually do, from live game data.
 *
 * Deliberately not a hand-maintained checklist: it reads the knowledge dump for
 * every skill the installed game has — including expansion content — and the
 * live candidate list for what the agent is currently able to act on. A skill
 * present in the dump but absent from the candidates is a real gap, and it
 * shows up here the moment the game adds one rather than when someone
 * remembers to update a document.
 *
 * Usage: node scripts/coverage-report.mjs   (planner service must be running)
 */

const BASE = process.env.MELVOR_AGENT_URL ?? 'http://localhost:8787';

/**
 * Skills the agent cannot start, with the reason.
 *
 * Being explicit about *why* matters: "not implemented yet" and "cannot work
 * this way" need different responses, and lumping them together hides which
 * gaps are worth closing.
 */
const KNOWN_GAPS = {
  'melvorD:Farming': 'handled by the tend_farm objective, not gather_resource',
  'melvorD:Attack': 'combat — reached via fight_monster, not as a startable skill',
  'melvorD:Strength': 'combat — reached via fight_monster',
  'melvorD:Defence': 'combat — reached via fight_monster',
  'melvorD:Hitpoints': 'combat — trained passively by fighting',
  'melvorD:Ranged': 'combat — reached via fight_monster',
  'melvorD:Magic': 'combat — reached via fight_monster',
  'melvorD:Prayer': 'not implemented: trained by burying bones, needs its own objective',
  'melvorD:Slayer': 'not implemented: needs task assignment and reroll handling',
  'melvorD:Township': 'not implemented: a management interface, not a startable action',
  'melvorAoD:Cartography': 'not implemented: survey/travel on a hex map',
  'melvorAoD:Archaeology': 'not implemented: dig sites with per-site tool selection',
  'melvorItA:Corruption': 'Into the Abyss — refused by realm guard until whitelisted',
};

const [dump, dashboard] = await Promise.all([fetchJson('/agent/dump'), fetchJson('/dashboard')]);

if (dump === null) {
  console.error('No knowledge dump stored. Press "Dump knowledge" in the panel first.');
  process.exit(1);
}

const report = dashboard?.report ?? null;
if (report === null) {
  console.error('The mod has never reported. Load a character with the mod installed.');
  process.exit(1);
}

/** Skills the agent produced a real candidate for, i.e. can act on right now. */
const actionable = new Set(
  report.candidates.filter((c) => c.params.kind === 'gather_resource').map((c) => c.params.skillId),
);

/**
 * Skills the mod has a start path for.
 *
 * Mirrors `STARTABLE_SKILL_IDS` in the adapter. Duplicated rather than imported
 * because this script talks to a running service over HTTP and does not build
 * the mod; the coverage output flags any drift as an unexplained gap.
 */
const STARTABLE = new Set([
  'melvorD:Woodcutting',
  'melvorD:Fishing',
  'melvorD:Mining',
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
  'melvorItA:Harvesting',
]);

const covered = [];
const gaps = [];

for (const skill of dump.skills) {
  if (actionable.has(skill.id)) {
    const count = report.candidates.filter((c) => c.params.skillId === skill.id).length;
    covered.push({ id: skill.id, count });
  } else {
    // A skill the agent *can* start but has no affordable recipe for is not a
    // gap: an empty bank is a legitimate reason to offer nothing. Saying
    // "unexplained" there would send someone hunting a bug that is not present.
    const reason =
      KNOWN_GAPS[skill.id] ??
      (STARTABLE.has(skill.id)
        ? 'supported, but nothing affordable/unlocked right now'
        : 'NO CANDIDATES — unexplained');
    gaps.push({ id: skill.id, reason });
  }
}

console.log(`Game version ${dump.gameVersion} — ${dump.skills.length} skills installed\n`);

console.log(`ACTIONABLE NOW (${covered.length}):`);
for (const entry of covered.sort((a, b) => b.count - a.count)) {
  console.log(`  ${entry.id.padEnd(26)} ${String(entry.count).padStart(3)} candidate(s)`);
}

console.log(`\nNOT ACTIONABLE (${gaps.length}):`);
for (const entry of gaps) {
  console.log(`  ${entry.id.padEnd(26)} ${entry.reason}`);
}

// An unexplained gap is the one worth acting on: it means something the agent
// was supposed to handle silently produced nothing.
const unexplained = gaps.filter((entry) => entry.reason.startsWith('NO CANDIDATES'));

console.log('\nOTHER SYSTEMS:');
console.log(
  `  shop purchases           ${dump.shopPurchases.length} in game, ${report.candidates.filter((c) => c.kind === 'buy_shop_upgrade').length} affordable now`,
);
console.log(`  monsters                 ${dump.monsters.length}`);
console.log(`  dungeons                 ${dump.dungeons.length}`);
console.log(`  realms                   ${dump.realms.map((r) => r.id).join(', ')}`);
// `farm` is absent from snapshots taken by an older bundle; report that rather
// than crashing, since a stale mod build is a normal state mid-development.
console.log(
  `  farming plots            ${report.snapshot.farm?.length ?? '(mod build predates farm support)'}`,
);
console.log(
  `  sellable bank stacks     ${report.candidates.filter((c) => c.kind === 'sell_items').length}`,
);

if (unexplained.length > 0) {
  console.log(`\n${unexplained.length} unexplained gap(s) — these are bugs, not missing features.`);
  process.exitCode = 1;
}

async function fetchJson(path) {
  try {
    const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    console.error(`Could not reach the planner service at ${BASE}. Start it with: pnpm planner`);
    process.exit(1);
  }
}

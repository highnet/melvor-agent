import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkDumpFreshness, knowledgeDumpSchema } from '../dump-schema.js';

/**
 * Verifies a knowledge dump on disk.
 *
 * The dump itself is produced from *inside* the game — only the running game
 * knows its own registries, and they are correct for the exact installed
 * version in a way no offline source is. So this command does not generate
 * anything; it validates what the mod exported and reports what is in it.
 *
 * Usage:
 *   pnpm knowledge:dump                    # validate ./data/dump.json
 *   pnpm knowledge:dump path/to/dump.json  # validate a specific file
 *   pnpm knowledge:dump --expect v1.3.1    # also assert the game version
 *
 * To produce a dump: start the planner service, open the agent panel in-game,
 * and press "Dump knowledge". The mod posts it to the service, which writes it
 * to `$MELVOR_AGENT_DATA/dump.json`.
 */

const args = process.argv.slice(2);
const expectIndex = args.indexOf('--expect');
const expected = expectIndex === -1 ? null : (args[expectIndex + 1] ?? null);
const pathArg = args.find((arg) => !arg.startsWith('--') && arg !== expected);
const path = resolve(pathArg ?? process.env.MELVOR_AGENT_DATA ?? './data', pathArg ? '.' : 'dump.json');

const raw = await readJson(path);

if (raw === null) {
  console.error(`No dump at ${path}`);
  console.error('Produce one from the in-game panel: "Dump knowledge" (planner service must be running).');
  process.exit(1);
}

const parsed = knowledgeDumpSchema.safeParse(raw);
if (!parsed.success) {
  console.error(`Dump at ${path} is malformed:`);
  for (const issue of parsed.error.issues.slice(0, 10)) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

const dump = parsed.data;
const age = Date.now() - dump.capturedAt;

console.log(`Dump: ${path}`);
console.log(`  game version   ${dump.gameVersion}`);
console.log(`  captured       ${new Date(dump.capturedAt).toISOString()} (${Math.round(age / 3_600_000)}h ago)`);
console.log(`  gamemode       ${dump.gamemodeId}`);
console.log(`  realms         ${dump.realms.length}`);
console.log(`  skills         ${dump.skills.length}`);
console.log(`  currencies     ${dump.currencies.length}`);
console.log(`  wc trees       ${dump.woodcuttingTrees.length}`);
console.log(`  monsters       ${dump.monsters.length}`);
console.log(`  dungeons       ${dump.dungeons.length}`);
console.log(`  shop purchases ${dump.shopPurchases.length}`);

if (expected !== null) {
  const freshness = checkDumpFreshness(raw, expected);
  if (!freshness.fresh) {
    console.error(`\nSTALE: ${freshness.reason} — ${freshness.detail}`);
    process.exit(1);
  }
  console.log(`\nFresh for ${expected}.`);
}

async function readJson(target: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

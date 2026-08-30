import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fails the build if a game global is touched outside the adapter.
 *
 * "Every Melvor API touchpoint lives behind a thin adapter" is the property
 * that keeps a game update to one directory, and it is the kind of rule that
 * quietly erodes the first time someone needs `game.bank` in a hurry. So it is
 * checked rather than documented.
 *
 * This is a lexical check, not a type-aware one. It is deliberately crude: the
 * cost of a false positive is renaming a local variable, and the cost of a
 * miss is the architecture rotting.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const modSrc = join(repoRoot, 'packages/mod/src');
const adapterDir = join(modSrc, 'adapter');

/**
 * Ambient game globals. Reading any is an API touchpoint.
 *
 * Two flavours, and the second is easy to forget: object globals accessed with
 * a dot (`game.bank`), and bare *class* references passed as values — most
 * often to `ctx.patch(Game, 'loop')`. The class form does not look like an API
 * call at a glance, which is exactly why it needs catching.
 */
const FORBIDDEN_OBJECTS = ['game', 'sidebar', 'gameVersion', 'cloudManager'];
const FORBIDDEN_CLASSES = [
  'Game',
  'Skill',
  'Player',
  'Enemy',
  'Bank',
  'CombatManager',
  'GatheringSkill',
  'Woodcutting',
];

const patterns = [
  new RegExp(`(?<![\\w.$'"\`])(${FORBIDDEN_OBJECTS.join('|')})\\s*\\.`, 'g'),
  // A bare class identifier used as a value, e.g. `patch(Game, …)` or `new Bank(`.
  new RegExp(`(?<![\\w.$'"\`])(${FORBIDDEN_CLASSES.join('|')})(?=\\s*[,)\\]])`, 'g'),
];

const violations = [];

for (const file of walk(modSrc)) {
  if (file.startsWith(adapterDir)) continue;
  if (!file.endsWith('.ts')) continue;

  const contents = readFileSync(file, 'utf8');
  contents.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    // Comments describe the boundary constantly; they are not calls.
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;

    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        violations.push({
          file: relative(repoRoot, file),
          line: index + 1,
          global: match[1],
          text: trimmed,
        });
      }
    }
  });
}

if (violations.length > 0) {
  console.error('Adapter boundary violated — game APIs may only be touched in src/adapter/:\n');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line}  uses \`${violation.global}.\``);
    console.error(`    ${violation.text}`);
  }
  console.error(`\n${violations.length} violation(s). Move the call into an adapter function.`);
  process.exit(1);
}

console.log('Adapter boundary intact: no game globals outside src/adapter/.');

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

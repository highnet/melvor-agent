import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const watch = process.argv.includes('--watch');

/**
 * Where the built mod is written.
 *
 * Point MELVOR_CT_DIR at the folder linked in the Creator Toolkit's Directory
 * Link mode. It is read from `.env` via `node --env-file-if-exists`; running
 * this file with plain `node` falls back to `dist-local`.
 *
 * Directory Link re-zips that folder on every game reload, so a rebuild still
 * needs a manual game reload to take effect.
 */
const outDir = readEnv('MELVOR_CT_DIR') ?? join(here, 'dist-local');

const options = {
  entryPoints: [join(here, 'src/setup.ts')],
  outfile: join(outDir, 'dist/setup.js'),
  bundle: true,
  platform: 'browser',
  // The loader imports the manifest's `setup` entry as an ES module and looks
  // for a named `setup` export. Any other format loads without an export and
  // fails silently — the mod appears installed and simply never runs.
  format: 'esm',
  target: 'es2022',
  sourcemap: 'inline',
  legalComments: 'none',
  logLevel: 'info',
};

mkdirSync(join(outDir, 'dist'), { recursive: true });
copyStaticAssets(outDir);

if (watch) {
  const context = await esbuild.context({ ...options, plugins: [assertSetupExport()] });
  await context.watch();
  console.log(`[melvor-agent] watching; output -> ${options.outfile}`);
  console.log(
    '[melvor-agent] reload the game to pick up each build (Directory Link re-zips on reload)',
  );
} else {
  await esbuild.build({ ...options, plugins: [assertSetupExport()] });
  console.log(`[melvor-agent] built -> ${options.outfile}`);
}

/**
 * Fails the build if the bundle does not export `setup`.
 *
 * The mod loader imports the entry as a module and looks for a named `setup`
 * export. If the format is wrong, or the export gets tree-shaken, the game
 * loads the mod and silently never runs it — no error, no log line. That is
 * expensive to diagnose from inside the game, so it is caught here instead.
 */
function assertSetupExport() {
  return {
    name: 'assert-setup-export',
    setup(build) {
      build.onEnd((result) => {
        if (result.errors.length > 0) return;
        const bundle = readFileSync(options.outfile, 'utf8');
        if (!/export\s*\{[^}]*\bsetup\b/.test(bundle)) {
          throw new Error(
            `bundle does not export \`setup\`; the mod would load and silently never run. Check that esbuild format is "esm" (currently "${options.format}").`,
          );
        }
      });
    },
  };
}

/** Copies the manifest, stylesheet and .modignore alongside the bundle. */
function copyStaticAssets(target) {
  cpSync(join(here, 'manifest.json'), join(target, 'manifest.json'));
  cpSync(join(here, 'src/ui/style.css'), join(target, 'dist/style.css'));
  cpSync(join(here, 'assets'), join(target, 'assets'), { recursive: true });

  // Ships only what the game needs; without this the Directory Link zip would
  // include node_modules and sources on every reload.
  const modignore = join(repoRoot, '.modignore');
  if (existsSync(modignore)) {
    cpSync(modignore, join(target, '.modignore'));
  }

  // Fail loudly if the manifest and the build output ever disagree about paths.
  const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
  if (manifest.setup !== 'dist/setup.js') {
    throw new Error(`manifest "setup" is ${manifest.setup}, build writes dist/setup.js`);
  }

  // The namespace rules are enforced by the Creator Toolkit at link time, which
  // is a slow place to find out: the mod is already half-configured and the
  // error names the namespace without saying which file it came from.
  const namespace = manifest.namespace;
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9_]+$/.test(namespace)) {
    throw new Error(
      `manifest "namespace" must be alphanumeric plus underscores, got ${JSON.stringify(namespace)}`,
    );
  }
  // The icon path in the manifest has to resolve inside the packaged mod, and a
  // missing one fails silently as a blank sidebar entry.
  if (typeof manifest.icon === 'string' && !existsSync(join(target, manifest.icon))) {
    throw new Error(`manifest "icon" is ${manifest.icon}, which is not in the build output`);
  }

  if (/^melvor/i.test(namespace)) {
    throw new Error(
      `manifest "namespace" is "${namespace}", but a namespace may not start with "melvor" — that prefix is reserved for the game data shipped with Melvor.`,
    );
  }
  writeFileSync(
    join(target, 'BUILD_INFO.txt'),
    `built ${new Date().toISOString()}\nformat ${options.format}\n`,
  );
}

function readEnv(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Uploads a new modfile to the private mod.io entry.
 *
 * This is not distribution. The Creator Toolkit only persists `characterStorage`
 * for a local mod linked to a mod.io entry that has been installed from there,
 * so the entry exists purely to unlock settings persistence for this one
 * machine. It stays hidden, and the script refuses to upload if it is not.
 *
 * The entry itself is created once by hand on the website: mod.io has no API for
 * creating a mod profile, and the visibility toggle is a website setting.
 *
 * Usage:
 *   node scripts/release-modio.mjs                    # version from package.json
 *   node scripts/release-modio.mjs --version 0.2.0
 *   node scripts/release-modio.mjs --changelog "..."
 *   node scripts/release-modio.mjs --dry-run          # build + zip, no upload
 *   node scripts/release-modio.mjs --check            # verify credentials only
 *   node scripts/release-modio.mjs --inactive         # upload without activating
 *
 * Environment (put these in .env, they are secrets):
 *   MODIO_TOKEN    OAuth2 access token with `write` scope. Create one at
 *                  mod.io -> your avatar -> Access -> "Manually create an
 *                  OAuth 2 Access Token". An API key alone cannot write.
 *   MODIO_MOD_ID   Numeric id of your mod, from its mod.io URL.
 *   MODIO_GAME_ID  Melvor Idle's game id. Defaults to 2649; verified at runtime
 *                  against the game name, so a wrong value fails loudly rather
 *                  than uploading somewhere unexpected.
 *
 * Verified against docs.mod.io/restapiref#add-modfile:
 *   POST https://api.mod.io/v1/games/{game_id}/mods/{mod_id}/files
 *   multipart/form-data, `filedata` required; version, changelog, active,
 *   filehash optional. Authorization: Bearer <token>.
 */

const API = 'https://api.mod.io/v1';
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const checkOnly = args.includes('--check');
const active = !args.includes('--inactive');
const version = flag('--version') ?? JSON.parse(read('package.json')).version;
const changelog = flag('--changelog') ?? defaultChangelog();

// An unset variable in a .env file arrives as an empty string, not undefined,
// so a bare `=== undefined` check lets it through and the failure surfaces as a
// 401 stack trace instead of a readable message.
const env = (name) => {
  const value = process.env[name];
  return value === undefined || value.trim() === '' ? null : value.trim();
};

const gameId = env('MODIO_GAME_ID') ?? '2649';
const modId = env('MODIO_MOD_ID');
const token = env('MODIO_TOKEN');

if (checkOnly) {
  // Credentials only: no build, no zip, no upload. Exists so a bad token is
  // found deliberately rather than halfway through a release.
  await verifyCredentials();
  process.exit(0);
}

// Build first, so a release can never ship a stale bundle. The build asserts
// its own output exports `setup`, which is the failure that is silent in-game.
console.log('[release] building…');
execFileSync('pnpm', ['--filter', '@melvor-agent/mod', 'build'], {
  cwd: repoRoot,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

const buildDir = process.env.MELVOR_CT_DIR ?? join(repoRoot, 'packages/mod/dist-local');
const zipPath = join(repoRoot, 'melvor-agent-mod.zip');

console.log(`[release] zipping ${buildDir}`);
rmSync(zipPath, { force: true });
zip(buildDir, zipPath);

// The loader expects manifest.json at the archive root. A zip of the *parent*
// folder is the classic mistake and produces a mod that installs and does
// nothing, so it is checked rather than assumed.
assertManifestAtRoot(zipPath);

const bytes = readFileSync(zipPath);
const md5 = createHash('md5').update(bytes).digest('hex');
console.log(`[release] ${zipPath} — ${(bytes.length / 1024).toFixed(0)}KB, md5 ${md5}`);

if (dryRun) {
  console.log('[release] --dry-run: built and verified, nothing uploaded.');
  process.exit(0);
}

if (token === null || modId === null) {
  console.error('[release] Missing configuration in .env:');
  if (modId === null) {
    console.error('  MODIO_MOD_ID  - the number in the mod.io URL for your mod');
  }
  if (token === null) {
    console.error('  MODIO_TOKEN   - mod.io > avatar > Access > "Manually create an OAuth 2');
    console.error('                  Access Token", with the `write` scope. An API key');
    console.error('                  cannot upload.');
  }
  console.error('[release] Re-run with --dry-run to build and verify the zip without uploading.');
  process.exit(1);
}

// Confirm we are pointed at the right game before uploading anything.
const game = await api(`/games/${gameId}`).catch((error) => {
  console.error(`[release] could not reach mod.io: ${error.message}`);
  console.error('[release] check MODIO_TOKEN is valid and has the `write` scope.');
  process.exit(1);
});
if (!/melvor/i.test(game.name ?? '')) {
  console.error(`[release] MODIO_GAME_ID ${gameId} is "${game.name}", not Melvor Idle. Refusing.`);
  process.exit(1);
}

const mod = await api(`/games/${gameId}/mods/${modId}`);
console.log(`[release] target: ${game.name} / ${mod.name} (visible=${mod.visible})`);

// The mod.io entry is an implementation detail of persistence, not a
// distribution channel: the Creator Toolkit refuses to persist characterStorage
// for an unlinked local mod, and linking requires an entry that can be
// installed. This is a single-user tool on a single machine, so a public entry
// is always a mistake and there is deliberately no override.
if (mod.visible === 1) {
  console.error(`[release] REFUSING: mod ${modId} is PUBLIC on mod.io.`);
  console.error('[release] Set Visibility to hidden on the mod.io edit page and re-run.');
  process.exit(1);
}

const form = new FormData();
form.append('filedata', new Blob([bytes]), 'melvor-agent-mod.zip');
form.append('version', version);
form.append('changelog', changelog);
form.append('active', active ? 'true' : 'false');
form.append('filehash', md5);

console.log(`[release] uploading v${version} (active=${active})…`);
const uploaded = await api(`/games/${gameId}/mods/${modId}/files`, {
  method: 'POST',
  body: form,
});

console.log(`[release] done — modfile ${uploaded.id}, version ${uploaded.version}`);
console.log(`[release] https://mod.io/g/melvoridle/m/${mod.name_id ?? modId}`);
console.log('[release] restart the game for the Mod Manager to pick it up.');

/**
 * Confirms the token works and points at the expected game and mod.
 *
 * Read-only. Distinguishes the failures that all look like a bare 401: no
 * token, a token without `write`, and a token for the wrong account.
 */
async function verifyCredentials() {
  if (token === null || modId === null) {
    console.error('[check] Missing configuration in .env:');
    if (modId === null) {
      console.error('  MODIO_MOD_ID  - the number in the mod.io URL for your mod');
    }
    if (token === null) {
      console.error('  MODIO_TOKEN   - create at https://mod.io/me/access');
      console.error('                  Needs an OAuth 2 Access Token with Read AND Write.');
      console.error('                  An API key from that same page will NOT work.');
    }
    process.exit(1);
  }

  const game = await api(`/games/${gameId}`).catch((error) => {
    console.error(`[check] token rejected, or game ${gameId} unreachable:`);
    console.error(error.message);
    console.error('[check] create a token at https://mod.io/me/access (Read AND Write)');
    process.exit(1);
  });

  if (!/melvor/i.test(game.name ?? '')) {
    console.error(`[check] MODIO_GAME_ID ${gameId} is "${game.name}", not Melvor Idle.`);
    process.exit(1);
  }
  console.log(`[check] game ${gameId} is "${game.name}"`);

  const mod = await api(`/games/${gameId}/mods/${modId}`).catch((error) => {
    console.error(`[check] mod ${modId} unreachable with this token:`);
    console.error(error.message);
    process.exit(1);
  });

  console.log(`[check] mod ${modId} is "${mod.name}"`);
  console.log(
    `[check] visibility: ${mod.visible === 1 ? 'PUBLIC - release will refuse' : 'hidden - good'}`,
  );

  // The write scope cannot be read off the token, so probe an endpoint that
  // requires it. A 401/403 here is specifically the read-only-token case; the
  // empty form body means nothing can be created even if it is authorised.
  const probe = await fetch(`${API}/games/${gameId}/mods/${modId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    body: new FormData(),
  });

  if (probe.status === 401 || probe.status === 403) {
    console.error(`[check] token lacks write access (HTTP ${probe.status}).`);
    console.error('[check] recreate it at https://mod.io/me/access with Read AND Write.');
    process.exit(1);
  }

  console.log(`[check] write access confirmed (upload probe returned ${probe.status})`);
  console.log('[check] credentials look good; pnpm release will work.');
}

/** Calls the mod.io API and throws with the server's own error text. */
async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  if (!response.ok) {
    // mod.io returns structured errors; surfacing them beats a bare status code.
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}\n${text}`);
  }
  return text === '' ? {} : JSON.parse(text);
}

function zip(sourceDir, target) {
  // Zip the *contents* so manifest.json lands at the archive root.
  const items = ['manifest.json', 'dist']
    .map((name) => join(sourceDir, name))
    .filter((path) => exists(path))
    .map((path) => `'${path}'`)
    .join(',');

  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${items} -DestinationPath '${target}' -Force`,
    ],
    { stdio: 'inherit' },
  );
}

function assertManifestAtRoot(target) {
  const listing = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Add-Type -A System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::OpenRead('${target}').Entries | Select-Object -ExpandProperty FullName`,
    ],
    { encoding: 'utf8' },
  );

  if (!/^manifest\.json\s*$/m.test(listing)) {
    throw new Error(
      `manifest.json is not at the root of ${target}. The mod would install and never run.\nContents:\n${listing}`,
    );
  }
}

function defaultChangelog() {
  try {
    return execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'no changelog';
  }
}

function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function exists(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

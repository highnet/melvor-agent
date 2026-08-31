import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

/**
 * Bundles the MCP server to standalone JS.
 *
 * The server is spawned by Claude Code from whatever directory it was launched
 * in, which is not necessarily this repo. Running the TypeScript source needs
 * `tsx` resolved relative to the working directory, and when that directory is
 * outside the workspace the process dies instantly with ERR_MODULE_NOT_FOUND —
 * which Claude Code reports only as "Connection closed".
 *
 * Bundling removes the whole class of problem: `node <abs path>` needs nothing
 * resolvable from the cwd.
 */
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'dist'), { recursive: true });

await esbuild.build({
  entryPoints: [join(here, 'src/server.ts')],
  outfile: join(here, 'dist/server.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Node builtins stay external; everything else is inlined so no node_modules
  // lookup happens at runtime.
  packages: 'bundle',
  // No shebang banner: the source file already carries one, and a second copy
  // lands on line 2 where it is a syntax error rather than a comment. The
  // bundle is always invoked as `node server.js`, so none is needed.
  logLevel: 'info',
});

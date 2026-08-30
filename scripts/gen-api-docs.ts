import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Generates `docs/API.md` from the adapter layer's public surface.
 *
 * This is the anti-hallucination mechanism for the whole project: the adapter
 * is the only code allowed to touch the Melvor API, and its reference is
 * derived from the source rather than written by hand, so it cannot drift out
 * of date. CI runs this with `--check` and fails when the committed file no
 * longer matches the code.
 *
 * Run: `pnpm docs:api` (write) or `pnpm docs:api:check` (verify).
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const entry = join(repoRoot, 'packages/mod/src/adapter/index.ts');
const output = join(repoRoot, 'docs/API.md');
const checkOnly = process.argv.includes('--check');

const program = ts.createProgram({
  rootNames: [entry],
  options: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: [],
  },
});

const checker = program.getTypeChecker();
const source = program.getSourceFile(entry);
if (source === undefined) throw new Error(`could not load ${entry}`);

const moduleSymbol = checker.getSymbolAtLocation(source);
if (moduleSymbol === undefined) throw new Error('adapter entry exports nothing');

interface Entry {
  name: string;
  kind: string;
  signature: string;
  docs: string;
}

const entries: Entry[] = checker
  .getExportsOfModule(moduleSymbol)
  .map(describe)
  .filter((item): item is Entry => item !== null)
  .sort((a, b) => a.name.localeCompare(b.name));

const markdown = renderMarkdown(entries);

if (checkOnly) {
  const existing = safeRead(output);
  if (existing !== markdown) {
    console.error('docs/API.md is out of date. Run `pnpm docs:api` and commit the result.');
    if (existing === null) console.error('  (file is missing entirely)');
    process.exit(1);
  }
  console.log(`docs/API.md is up to date (${entries.length} exports).`);
} else {
  writeFileSync(output, markdown, 'utf8');
  console.log(`Wrote docs/API.md from ${entries.length} adapter exports.`);
}

/** Resolves one exported symbol into a documented entry. */
function describe(symbol: ts.Symbol): Entry | null {
  const resolved =
    (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;

  const declaration = resolved.declarations?.[0];
  if (declaration === undefined) return null;

  const type = checker.getTypeOfSymbolAtLocation(resolved, declaration);
  const docs = ts.displayPartsToString(resolved.getDocumentationComment(checker)).trim();

  return {
    name: symbol.getName(),
    kind: describeKind(resolved, declaration),
    signature: checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation),
    docs,
  };
}

function describeKind(symbol: ts.Symbol, declaration: ts.Declaration): string {
  if ((symbol.flags & ts.SymbolFlags.Class) !== 0) return 'class';
  if ((symbol.flags & ts.SymbolFlags.Interface) !== 0) return 'interface';
  if ((symbol.flags & ts.SymbolFlags.TypeAlias) !== 0) return 'type';
  if ((symbol.flags & ts.SymbolFlags.Function) !== 0) return 'function';
  if (ts.isVariableDeclaration(declaration)) return 'const';
  return 'export';
}

function renderMarkdown(items: readonly Entry[]): string {
  const lines: string[] = [
    '# Adapter API',
    '',
    '<!--',
    '  GENERATED FILE — do not edit by hand.',
    '  Source: packages/mod/src/adapter/index.ts',
    '  Regenerate: pnpm docs:api   Verify: pnpm docs:api:check (CI runs this)',
    '-->',
    '',
    'Every Melvor API touchpoint in this repo lives behind these exports. Nothing',
    'outside `packages/mod/src/adapter/` may call a game function, so a game update',
    'breaks exactly one directory.',
    '',
    'Two invariants hold across the whole surface:',
    '',
    '- **No action returns `void`.** Each returns an `ActionResult` carrying before/after',
    "  evidence, because the game's own return conventions are inconsistent and a",
    '  non-throwing call proves nothing.',
    '- **Nothing acts during offline progress.** Actions take an `isSuspended` guard and',
    '  fail with reason `suspended` rather than acting mid catch-up.',
    '',
    `${items.length} exports.`,
    '',
  ];

  for (const item of items) {
    lines.push(`## \`${item.name}\``, '', `\`${item.kind}\``, '');
    if (item.docs !== '') lines.push(item.docs, '');
    lines.push('```ts', `${item.name}: ${item.signature}`, '```', '');
  }

  return lines.join('\n');
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

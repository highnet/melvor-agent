import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * File-backed memory for the planning agent.
 *
 * Five rules shape this:
 *
 * 1. **No hidden state.** Everything the planner remembers is a markdown file in
 *    the workspace, readable and editable with a text editor.
 * 2. **Writing is the hard part.** Retrieval over plain notes is competitive
 *    with far heavier designs; what degrades memory systems is unreliable
 *    write-time curation. So curation is a dedicated pass, never a side effect
 *    of a planning call.
 * 3. **The write path is the security boundary.** Content scanning cannot
 *    reliably catch a poisoned fact after the event, so provenance is assigned
 *    by code at write time and promotion is gated structurally.
 * 4. **Deterministic gates, model judgment inside them.** Which files load, the
 *    budgets, what may be promoted — all deterministic. The model judges only
 *    *content*, inside those bounds.
 * 5. **Failures never block a decision.** Every read is best-effort. Missing
 *    memory degrades a plan; it never costs the agent a turn.
 *
 * ## Tiers
 *
 * | Tier         | Surface                  | Written by            | Injected                  |
 * |--------------|--------------------------|-----------------------|---------------------------|
 * | Curated core | `MEMORY.md`, `USER.md`   | consolidation, human  | yes, at planning time     |
 * | Episodic     | `memory/YYYY-MM-DD.md`   | agent during work     | **never**; search only    |
 * | Review       | `DREAMS.md`              | consolidation         | never; for human reading  |
 *
 * The boundary between curated and episodic is the one that matters. Daily
 * notes are append-friendly and unvetted, so they are structurally barred from
 * the prompt on ordinary planning calls — that is a security property, not a
 * tuning choice. They are reachable only through {@link searchEpisodic}.
 */

const MEMORY_FILE = 'MEMORY.md';
const USER_FILE = 'USER.md';
const DREAMS_FILE = 'DREAMS.md';
const DAILY_DIR = 'memory';

/**
 * Character budgets, enforced deterministically.
 *
 * Planning runs on every completion, abort and offline exit, so unbounded
 * memory is an unbounded bill. The profile gets its own budget so a long
 * operator file cannot crowd out the facts that stop the agent repeating
 * yesterday's mistake.
 */
const BUDGETS = { user: 4_000, memory: 12_000 } as const;

/**
 * Where a memory came from. A closed set, assigned by code.
 *
 * - `owner` — written by the operator in a trusted channel (a file they edited).
 * - `agent` — derived by the agent from its own observations of the game.
 * - `untrusted` — derived from anything external. Never promotable.
 * - `system` — scaffolding. Never promotable.
 *
 * Classification is conservative: anything whose origin cannot be established
 * is `untrusted` if externally derived and `system` if scaffolding. It is never
 * defaulted to `owner`.
 */
export type Origin = 'owner' | 'agent' | 'untrusted' | 'system';

/** Origins that may never reach the curated core, whatever their score. */
const UNPROMOTABLE: ReadonlySet<Origin> = new Set<Origin>(['untrusted', 'system']);

export interface LoadedMemory {
  /** Operator directives, or null when no `USER.md` exists. */
  user: string | null;
  /** Curated durable facts, or null when `MEMORY.md` is absent. */
  memory: string | null;
  /** Which files were read, for the operator log. */
  sources: string[];
}

/**
 * Loads the curated core only.
 *
 * Deliberately does not read daily notes. Auto-injecting episodic content is
 * exactly the path a poisoned note would take into the prompt, and no amount of
 * relevance justifies it — an observation the agent wrote about a web page or a
 * tool result has no business carrying instruction authority on a later turn.
 *
 * @param root - Workspace directory holding the memory files.
 * @returns What was found. Absent files are null, never an error.
 */
export async function loadMemory(root: string): Promise<LoadedMemory> {
  const sources: string[] = [];

  const user = await readCapped(join(root, USER_FILE), BUDGETS.user);
  if (user !== null) sources.push(USER_FILE);

  const memory = await readCapped(join(root, MEMORY_FILE), BUDGETS.memory);
  if (memory !== null) sources.push(MEMORY_FILE);

  return { user, memory, sources };
}

/**
 * Renders curated memory for a planning prompt.
 *
 * Operator directives come last, nearest the decision. Models stop applying a
 * preference that is merely present in context after a handful of turns, and
 * restating the directive near the query restores adherence better than heavier
 * retrieval machinery.
 */
export function renderMemory(loaded: LoadedMemory): string {
  const parts: string[] = [];

  if (loaded.memory !== null) {
    parts.push(`## Established facts\n\n${loaded.memory}`);
  }
  if (loaded.user !== null) {
    parts.push(`## Operator directives — these are binding\n\n${loaded.user}`);
  }

  return parts.join('\n\n');
}

/**
 * Appends an observation to today's note.
 *
 * The weakest surface by design: a daily note is scratch, not established fact,
 * and nothing written here reaches a planning prompt. Promotion into
 * `MEMORY.md` happens only through {@link consolidate}.
 *
 * Provenance is assigned by the caller *in code* and written as a structured
 * prefix. The note body is sanitised so it cannot forge one: prose claiming to
 * be owner-written does not make it owner content.
 *
 * @param root - Workspace directory.
 * @param origin - Where this claim came from. See {@link Origin}.
 * @param note - One observation.
 */
export async function appendDailyNote(root: string, origin: Origin, note: string): Promise<void> {
  const dir = join(root, DAILY_DIR);
  await mkdir(dir, { recursive: true });

  const line = `- ${new Date().toISOString()} [${origin}] ${sanitise(note)}\n`;
  await appendFile(join(dir, `${dayStamp(0)}.md`), line, 'utf8');
}

export interface EpisodicHit {
  file: string;
  origin: Origin;
  line: string;
}

/**
 * Searches daily notes.
 *
 * The only path from the episodic tier into a prompt, and an explicit one — a
 * caller has to ask. Results carry their origin so an untrusted hit can be
 * framed as untrusted rather than read as fact.
 *
 * @param root - Workspace directory.
 * @param query - Case-insensitive substring.
 * @param limit - Maximum hits, newest first.
 */
export async function searchEpisodic(
  root: string,
  query: string,
  limit = 20,
): Promise<EpisodicHit[]> {
  const dir = join(root, DAILY_DIR);
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const needle = query.toLowerCase();
  const hits: EpisodicHit[] = [];

  for (const file of files) {
    if (hits.length >= limit) break;
    const body = await readCapped(join(dir, file), 200_000);
    if (body === null) continue;

    for (const line of body.split('\n').reverse()) {
      if (hits.length >= limit) break;
      if (!line.toLowerCase().includes(needle)) continue;
      hits.push({ file, origin: parseOrigin(line), line: line.trim() });
    }
  }

  return hits;
}

export interface ConsolidationResult {
  ok: boolean;
  detail: string;
  /** Entries offered to the model after the deterministic gate. */
  gated: number;
  /** Entries excluded because their origin can never be promoted. */
  excluded: number;
}

/**
 * Promotes eligible daily notes into curated memory.
 *
 * Two gates in sequence, and the order matters:
 *
 * 1. **Deterministic.** Candidates with an unpromotable origin are removed
 *    *before any prompt is built*. This is a precondition, not a score penalty:
 *    no amount of repetition promotes untrusted content into the curated core,
 *    so a poisoned note cannot launder itself through frequency.
 * 2. **Model judgment**, inside those bounds — supplied by the caller, which is
 *    the only part that needs language understanding.
 *
 * The rewrite is accepted only if it does not lose more than a bounded fraction
 * of existing entries, and is written under optimistic concurrency: the hash of
 * the file read at the start is re-checked immediately before an atomic rename,
 * so an edit made in the meantime aborts the write rather than clobbering it.
 * The pre-image and a summary are appended to `DREAMS.md` for review.
 *
 * @param root - Workspace directory.
 * @param revise - Given gated candidates and the current file, returns the
 *                 revised contents. This is where the model goes.
 */
export async function consolidate(
  root: string,
  revise: (candidates: string[], current: string) => Promise<string>,
): Promise<ConsolidationResult> {
  const { promotable, excluded } = await gatherCandidates(root);

  if (promotable.length === 0) {
    return { ok: false, detail: 'no promotable candidates', gated: 0, excluded };
  }

  const path = join(root, MEMORY_FILE);
  const before = (await readCapped(path, 1_000_000)) ?? '';
  const beforeHash = hash(before);

  const revised = (await revise(promotable, before)).trim();

  if (revised === '') {
    return { ok: false, detail: 'revision was empty', gated: promotable.length, excluded };
  }

  // A consolidation that drops most of the file is far more likely to be a
  // mistake than a genuinely aggressive tidy-up, so it is refused rather than
  // silently accepted.
  const beforeEntries = countEntries(before);
  const afterEntries = countEntries(revised);
  if (beforeEntries > 0 && afterEntries < beforeEntries * 0.5) {
    return {
      ok: false,
      detail: `revision kept ${afterEntries} of ${beforeEntries} entries; refusing`,
      gated: promotable.length,
      excluded,
    };
  }

  // Optimistic concurrency: anything that edited the file while the model was
  // thinking wins, and this sweep aborts.
  const now = (await readCapped(path, 1_000_000)) ?? '';
  if (hash(now) !== beforeHash) {
    return {
      ok: false,
      detail: 'MEMORY.md changed during consolidation; aborted',
      gated: promotable.length,
      excluded,
    };
  }

  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${revised}\n`, 'utf8');
  await rename(temporary, path);

  await appendFile(
    join(root, DREAMS_FILE),
    [
      `\n## ${new Date().toISOString()}`,
      `Promoted ${promotable.length} candidate(s); excluded ${excluded} by origin.`,
      `Entries: ${beforeEntries} → ${afterEntries}.`,
      '',
      '<details><summary>Pre-image</summary>',
      '',
      '```markdown',
      before,
      '```',
      '',
      '</details>',
      '',
    ].join('\n'),
    'utf8',
  );

  return {
    ok: true,
    detail: `promoted into ${MEMORY_FILE}`,
    gated: promotable.length,
    excluded,
  };
}

/** Splits daily notes into promotable and structurally excluded. */
async function gatherCandidates(root: string): Promise<{ promotable: string[]; excluded: number }> {
  const dir = join(root, DAILY_DIR);
  let files: string[];
  try {
    files = (await readdir(dir))
      .filter((name) => name.endsWith('.md'))
      .sort()
      .reverse();
  } catch {
    return { promotable: [], excluded: 0 };
  }

  const promotable: string[] = [];
  let excluded = 0;

  // Only the last two days: consolidation is a sweep over recent signal, not a
  // rescan of all history, which would re-promote the same facts forever.
  for (const file of files.filter(
    (name) => name.startsWith(dayStamp(0)) || name.startsWith(dayStamp(-1)),
  )) {
    const body = await readCapped(join(dir, file), 100_000);
    if (body === null) continue;

    for (const line of body.split('\n')) {
      if (line.trim() === '') continue;
      if (UNPROMOTABLE.has(parseOrigin(line))) {
        excluded += 1;
        continue;
      }
      promotable.push(line.trim());
    }
  }

  return { promotable, excluded };
}

/**
 * Reads the origin recorded by {@link appendDailyNote}.
 *
 * Anything unrecognised is `untrusted` — a line whose provenance cannot be
 * established is never given the benefit of the doubt.
 */
function parseOrigin(line: string): Origin {
  const match = /^-\s+\S+\s+\[(owner|agent|untrusted|system)\]/.exec(line.trim());
  return match === null ? 'untrusted' : (match[1] as Origin);
}

/**
 * Strips anything that could forge a provenance prefix or a new entry.
 *
 * Newlines are collapsed so one note cannot become several, and a leading
 * `[origin]` marker is neutralised so note text cannot claim to be
 * owner-written.
 */
function sanitise(note: string): string {
  return note
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\[(owner|agent|untrusted|system)\]/gi, '($1)')
    .trim();
}

/** Markdown list entries, used for the bounded-loss check. */
function countEntries(body: string): number {
  return body.split('\n').filter((line) => line.trim().startsWith('- ')).length;
}

function hash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function dayStamp(offsetDays: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function readCapped(path: string, budget: number): Promise<string | null> {
  if (budget <= 0) return null;
  try {
    const body = (await readFile(path, 'utf8')).trim();
    if (body === '') return null;
    if (body.length <= budget) return body;
    return `${body.slice(0, budget)}\n\n[truncated at ${budget} characters]`;
  } catch {
    return null;
  }
}

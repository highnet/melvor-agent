import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import {
  type Dashboard,
  agentReportSchema,
  commandSchema,
  plannerRequestSchema,
} from '@melvor-agent/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { TOOLS } from './mcp-tools.js';
import { appendDailyNote, loadMemory, searchEpisodic } from './memory.js';
import { plan, plannerStatus } from './plan.js';
import { Store } from './store.js';

const PORT = Number(process.env.PORT ?? 8787);

/**
 * Durable state lives at the repo root, not beside whichever package started
 * the process.
 *
 * `pnpm planner` filters into `packages/planner`, so a relative default landed
 * data in `packages/planner/data` while every doc and CLI looked for it at the
 * root. Resolving from this file's location makes the location the same however
 * the service is launched.
 */
/** Where USER.md, MEMORY.md and memory/ live. */
const MEMORY_ROOT = process.env.MELVOR_AGENT_MEMORY ?? process.cwd();

const DATA_DIR =
  process.env.MELVOR_AGENT_DATA ??
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../data');

const store = new Store(DATA_DIR);
await store.init();

const app = new Hono();

/**
 * Chrome's Private Network Access handshake.
 *
 * The Steam client loads the game from https://melvoridle.com — a *public*
 * origin — and this service listens on localhost, which Chrome classifies as
 * the *private* address space. Since Chrome 104 such a request is blocked
 * unless the preflight explicitly opts in, and the page sees only a bare
 * "Failed to fetch": CORS itself passed, so there is no CORS error to read.
 *
 * Registered *before* `cors()` and written on the way back out, because
 * `cors()` answers OPTIONS itself and returns before any later middleware runs.
 *
 * Safe here: the service is local-only, so the only pages that can reach it are
 * already running on this machine.
 */
app.use('/*', async (c, next) => {
  const asked = c.req.header('Access-Control-Request-Private-Network') === 'true';
  await next();
  if (asked) {
    c.res.headers.set('Access-Control-Allow-Private-Network', 'true');
  }
});

/**
 * Wide-open CORS, deliberately.
 *
 * Reflecting the request origin looks tidier but breaks the case that matters:
 * a page on a `file://`-style origin sends `Origin: null`, and reflecting the
 * literal string `null` is rejected by Chrome. `*` is accepted from every
 * origin including opaque ones, and costs nothing here — the service binds
 * localhost and carries no credentials, so the only pages that can reach it are
 * already running on this machine.
 */
app.use('/*', cors({ origin: '*' }));

/**
 * The mod's heartbeat: it posts state and collects queued operator commands.
 * This is the only endpoint the mod calls on a timer.
 */
app.post('/agent/report', async (c) => {
  const parsed = agentReportSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'invalid report', issues: parsed.error.issues }, 400);
  }
  const commands = await store.acceptReport(parsed.data);
  return c.json({ commands });
});

app.post('/agent/save', async (c) => {
  const body = (await c.req.json()) as { save?: string; reason?: string };
  if (typeof body.save !== 'string' || body.save.length === 0) {
    return c.json({ error: 'missing save' }, 400);
  }
  const path = await store.writeSave(body.save, body.reason ?? 'manual');
  return c.json({ ok: true, path });
});

app.post('/agent/dump', async (c) => {
  await store.writeDump(await c.req.json());
  return c.json({ ok: true });
});

/**
 * Agent settings.
 *
 * The mod's durable settings store. `characterStorage` cannot be used because
 * it only persists for a mod installed from mod.io, and Melvor gates mod.io
 * entries behind game-admin approval.
 */
app.get('/agent/settings', async (c) => c.json(await store.readSettings()));

app.put('/agent/settings', async (c) => {
  await store.writeSettings(await c.req.json());
  return c.json({ ok: true });
});

/** The mod fetches this on arm to run its own staleness check against gameVersion. */
app.get('/agent/dump', async (c) => c.json(await store.readDump()));

/** Everything the TUI renders, in one call. */
app.get('/dashboard', (c) => {
  const dashboard: Dashboard = {
    connected: store.reportAgeMs !== null && store.reportAgeMs < 15_000,
    lastReportAgeMs: store.reportAgeMs,
    report: store.report,
    digest: store.digest(),
    ...rates(store),
  };
  return c.json(dashboard);
});

/** Operator commands from the TUI. Delivered on the mod's next report. */
app.post('/command', async (c) => {
  const parsed = commandSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'invalid command', issues: parsed.error.issues }, 400);
  }
  store.enqueue(parsed.data);
  return c.json({ ok: true, queued: parsed.data.type });
});

/**
 * The planning route.
 *
 * Stubbed in Phase 1: schemas are wired end to end and the response is
 * validated exactly as a model response would be, but no model is called.
 */
app.post('/plan', async (c) => {
  const parsed = plannerRequestSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ error: 'invalid planner request', issues: parsed.error.issues }, 400);
  }
  return c.json(await plan(parsed.data));
});

/**
 * Curated memory, for inspection.
 *
 * Daily notes are deliberately not served here: the episodic tier is reachable
 * only through the search endpoint, so nothing can accidentally treat a note as
 * established fact by fetching "memory".
 */
app.get('/memory', async (c) => c.json(await loadMemory(MEMORY_ROOT)));

/** Explicit episodic search. Results carry their origin so callers can weigh it. */
app.get('/memory/search', async (c) => {
  const query = c.req.query('q') ?? '';
  if (query.trim() === '') return c.json({ error: 'q is required' }, 400);
  return c.json({ hits: await searchEpisodic(MEMORY_ROOT, query) });
});

/**
 * Appends an observation to today's note.
 *
 * Origin is assigned here rather than accepted from the caller for anything
 * privileged: a request over HTTP is not the operator typing in a trusted
 * channel, so the most it can claim is `agent`.
 */
app.post('/memory/note', async (c) => {
  const body = (await c.req.json()) as { note?: string; origin?: string };
  if (typeof body.note !== 'string' || body.note.trim() === '') {
    return c.json({ error: 'note is required' }, 400);
  }
  const origin = body.origin === 'untrusted' ? 'untrusted' : 'agent';
  await appendDailyNote(MEMORY_ROOT, origin, body.note);
  return c.json({ ok: true, origin });
});

/**
 * Executes an MCP tool by name.
 *
 * The MCP server is a thin proxy onto this. That split exists because Claude
 * Code spawns the MCP server once per session and keeps the process, so
 * anything implemented there is frozen until a restart — whereas this service
 * runs under `tsx watch` and reloads on save. Tool behaviour therefore lives
 * here and can be changed live; only adding or renaming a tool needs a restart.
 */
app.post('/mcp/:tool', async (c) => {
  const name = c.req.param('tool');
  const handler = TOOLS[name];
  if (handler === undefined) {
    return c.json({ error: `unknown tool "${name}"` }, 404);
  }

  try {
    const args = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return c.json({ text: await handler(args, { store, memoryRoot: MEMORY_ROOT }) });
  } catch (error) {
    // A tool that throws should tell the caller what went wrong rather than
    // presenting as an unreachable service, which is a different fix entirely.
    return c.json({
      text: `Tool "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

app.get('/health', (c) => c.json({ ok: true, dataDir: DATA_DIR, planner: plannerStatus() }));

/**
 * Progress per real-time hour — the one quality metric.
 *
 * The control condition is a single good skill left running and collected every
 * 24h. If the agent is not clearly beating that, its transitions are bad.
 */
function rates(current: Store): Pick<Dashboard, 'levelsPerHour' | 'gpPerHour'> {
  const samples = current.report?.quality ?? [];
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined || last.at <= first.at) {
    return { levelsPerHour: null, gpPerHour: null };
  }
  const hours = (last.at - first.at) / 3_600_000;
  return {
    levelsPerHour: (last.totalLevel - first.totalLevel) / hours,
    gpPerHour: (last.gp - first.gp) / hours,
  };
}

/**
 * Starts the server, tolerating an instance that is already running.
 *
 * Without this, a second `pnpm planner` dies on an unhandled EADDRINUSE with a
 * raw stack trace, and the operator cannot tell whether the port is held by a
 * healthy copy of this service or by something else entirely. Since the service
 * is stateless between requests, a second start is almost always a mistake
 * rather than an intent — so it probes the port and exits quietly if the thing
 * already there is us.
 */
async function start(): Promise<void> {
  const existing = await probeExisting();

  if (existing === 'ours') {
    console.log(`[planner] already running on http://localhost:${PORT} — nothing to do`);
    return;
  }

  if (existing === 'foreign') {
    console.error(`[planner] port ${PORT} is held by something that is not this service.`);
    console.error('[planner] set PORT to use a different one, or stop whatever is there.');
    process.exitCode = 1;
    return;
  }

  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[planner] listening on http://localhost:${info.port}`);
    console.log(`[planner] data dir: ${DATA_DIR}`);
  });

  // Release the port on the way out. Without this a killed terminal can leave
  // the listener holding the port until the process is reaped, which is exactly
  // the confusion this whole function exists to avoid.
  const shutdown = (signal: string) => {
    console.log(`[planner] ${signal} — shutting down`);
    server.close(() => process.exit(0));
    // Do not hang forever on a wedged connection.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** Whether the port is free, held by this service, or held by something else. */
async function probeExisting(): Promise<'free' | 'ours' | 'foreign'> {
  try {
    const response = await fetch(`http://localhost:${PORT}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return 'foreign';
    const body = (await response.json()) as { ok?: boolean; dataDir?: string };
    return body.ok === true && typeof body.dataDir === 'string' ? 'ours' : 'foreign';
  } catch {
    // Nothing answered, so either the port is free or whatever holds it does
    // not speak HTTP. `serve` below will surface the latter.
    return 'free';
  }
}

await start();

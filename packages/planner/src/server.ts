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
import { plan } from './plan.js';
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

// The mod runs inside the game client, a different origin.
app.use('/*', cors({ origin: (origin) => origin ?? '*' }));

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

app.get('/health', (c) => c.json({ ok: true, dataDir: DATA_DIR }));

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

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`[planner] listening on http://localhost:${info.port}`);
  console.log(`[planner] data dir: ${DATA_DIR}`);
});

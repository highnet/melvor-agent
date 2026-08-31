#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/**
 * MCP server that lets a Claude Code session be the agent's planner.
 *
 * The mod already reports its state and a list of objectives it has *proven it
 * can execute* to the local planner service. This exposes that surface as MCP
 * tools so a session can read the game and choose what to do next, instead of
 * the choice being made by a scripted heuristic or a one-shot API call.
 *
 * The safety property from the HTTP design is preserved exactly: `set_objective`
 * takes a **candidate index**, never skill or recipe ids. Choosing by index makes
 * a hallucinated objective structurally impossible rather than merely
 * discouraged — which matters, because a hand-written recipe id is precisely the
 * mistake that produced "no tree registered with id melvorD:Normal_Tree" on the
 * first live run.
 *
 * This is a client of the planner service, not a replacement for it. The service
 * still owns durable state and still plans on its own when no session is
 * attached, which is what keeps the agent playing at 4am.
 */

const BASE = process.env.MELVOR_AGENT_URL ?? 'http://localhost:8787';

const server = new McpServer({ name: 'melvor-agent', version: '0.1.0' });

server.registerTool(
  'get_agent_state',
  {
    title: 'Get agent state',
    description:
      'Current run state, what the agent is doing, its objective, and a summary of the character: levels, bank, farm, combat readiness. Start here.',
    inputSchema: {},
  },
  async () => {
    const dashboard = await get('/dashboard');
    if (dashboard === null) return text(serviceDown());

    const report = dashboard.report;
    if (report === null || report === undefined) {
      return text('The mod has never reported. Is the game running with a character loaded?');
    }

    const s = report.snapshot;
    const gp = s.currencies.find((c: { id: string }) => c.id === 'melvorD:GP')?.amount ?? 0;
    const levelled = s.skills
      .filter((skill: { level: number }) => skill.level > 1)
      .sort((a: { level: number }, b: { level: number }) => b.level - a.level)
      .map((skill: { name: string; level: number }) => `${skill.name} ${skill.level}`)
      .join(', ');

    return text(
      [
        `Run state: ${report.runState}${report.blockedReason === null ? '' : ` — BLOCKED: ${report.blockedReason}`}`,
        `Connected: ${dashboard.connected} (last report ${dashboard.lastReportAgeMs}ms ago)`,
        `Objective: ${report.objective === null ? 'none' : report.objective.rationale}`,
        '',
        `Character ${s.characterName} (${s.gameVersion}) — total level ${s.totalLevel}, completion ${s.completionPercent.toFixed(2)}%, GP ${gp.toLocaleString()}`,
        `Doing: ${s.activeAction === null ? 'nothing' : s.activeAction.name}`,
        `Skills above 1: ${levelled || '(none)'}`,
        `Bank: ${s.bank.slotsUsed}/${s.bank.slotsMax} slots — ${topStacks(s.bank.items)}`,
        `Farm: ${farmSummary(s.farm ?? [])}`,
        `Combat: HP ${s.combat.hitpoints}/${s.combat.maxHitpoints}, auto-eat ${s.combat.autoEatThreshold > 0 ? 'owned' : 'NOT owned (combat will be refused)'}`,
        `Rates: ${dashboard.levelsPerHour === null ? 'warming up' : `${dashboard.levelsPerHour.toFixed(2)} levels/hour`}`,
      ].join('\n'),
    );
  },
);

server.registerTool(
  'list_candidates',
  {
    title: 'List candidate objectives',
    description:
      'Everything the agent has proven it can do right now — requirements met, materials affordable, recipe unlocked — with measured XP/hr and GP/hr. Choose from these by index; nothing outside this list is currently possible.',
    inputSchema: {},
  },
  async () => {
    const dashboard = await get('/dashboard');
    if (dashboard === null) return text(serviceDown());

    const candidates = dashboard.report?.candidates ?? [];
    if (candidates.length === 0) {
      return text('No candidates. The agent cannot act — check get_agent_state for why.');
    }

    return text(
      candidates.map((c: Record<string, unknown>, i: number) => `${i}. ${describe(c)}`).join('\n'),
    );
  },
);

server.registerTool(
  'set_objective',
  {
    title: 'Set the agent objective',
    description:
      'Choose a candidate by index from list_candidates and give it a target and a time budget. The index is the only way to specify what to do — skill and recipe ids are taken from the candidate itself, so they cannot be mistyped or invented.',
    inputSchema: {
      candidateIndex: z
        .number()
        .int()
        .min(0)
        .describe(
          'Index from list_candidates. Re-read that list first; it changes as state changes.',
        ),
      targetLevel: z
        .number()
        .int()
        .min(1)
        .max(120)
        .describe(
          'Skill level to reach. Pick something reachable in the budget, not a distant round number.',
        ),
      abortMinutes: z
        .number()
        .int()
        .min(5)
        .max(720)
        .describe(
          'Give up after this long even if unfinished. Without a real budget the agent grinds into a wall.',
        ),
      rationale: z
        .string()
        .describe('One sentence for the operator log on why this beats the alternatives.'),
    },
  },
  async ({ candidateIndex, targetLevel, abortMinutes, rationale }) => {
    const dashboard = await get('/dashboard');
    if (dashboard === null) return text(serviceDown());

    const candidates = dashboard.report?.candidates ?? [];
    const chosen = candidates[candidateIndex];
    if (chosen === undefined) {
      return text(
        `Index ${candidateIndex} is out of range — there are ${candidates.length} candidates (0..${candidates.length - 1}). Call list_candidates again; the list changes with game state.`,
      );
    }

    // Params come from the candidate verbatim. This is the whole safety story:
    // the session picks *which*, never *what*.
    const objective = {
      id: `session-${Date.now()}`,
      kind: chosen.kind,
      params: chosen.params,
      successWhen: [successFor(chosen, targetLevel)],
      abortWhen: { minutesExceed: abortMinutes },
      expectedDurationMin: Math.min(abortMinutes, 60),
      rationale,
    };

    const result = await post('/command', { type: 'set_objective', objective });
    if (result === null) return text(serviceDown());

    return text(
      `Queued: ${chosen.label}\nTarget: level ${targetLevel}, abort after ${abortMinutes}min.\nApplies on the mod's next report (within a few seconds).`,
    );
  },
);

server.registerTool(
  'get_journal',
  {
    title: 'Get attempt history',
    description:
      'What has been tried, what it cost, and how it ended. Read before choosing, so you do not re-propose something that was abandoned for a reason that still holds.',
    inputSchema: {},
  },
  async () => {
    const dashboard = await get('/dashboard');
    if (dashboard === null) return text(serviceDown());

    const digest = dashboard.digest;
    if (digest.recent.length === 0 && digest.aggregates.length === 0) {
      return text('Nothing attempted yet.');
    }

    const recent = digest.recent.map(
      (e: Record<string, any>) =>
        `- ${e.objective.kind} "${e.objective.rationale}" → ${e.outcome} after ${Math.round((e.endedAt - e.startedAt) / 60_000)}min (levels ${e.deltas.totalLevel >= 0 ? '+' : ''}${e.deltas.totalLevel})`,
    );
    const older = digest.aggregates.map(
      (a: Record<string, any>) =>
        `- earlier: ${a.kind} ×${a.attempts} (${a.completed} completed, ${a.aborted} aborted, median ${Math.round(a.medianMinutes)}min)`,
    );

    return text([...recent, ...older].join('\n'));
  },
);

server.registerTool(
  'get_recent_activity',
  {
    title: 'Get the agent log',
    description:
      'Recent actions and their outcomes, including failures with the reason. Use this to find out why something is not working.',
    inputSchema: {
      limit: z.number().int().min(1).max(100).default(25).describe('How many entries.'),
    },
  },
  async ({ limit }) => {
    const dashboard = await get('/dashboard');
    if (dashboard === null) return text(serviceDown());

    const logs = dashboard.report?.logs ?? [];
    if (logs.length === 0) return text('Log is empty — the mod drains it on each report.');

    return text(
      logs
        .slice(-limit)
        .map(
          (l: Record<string, any>) =>
            `${new Date(l.at).toLocaleTimeString()} [${l.level}] ${l.source}: ${l.message}`,
        )
        .join('\n'),
    );
  },
);

server.registerTool(
  'control_agent',
  {
    title: 'Control the agent',
    description:
      'Arm, disarm, or kill the agent, force a replan, export the save, or regenerate the knowledge dump. Kill is a hard stop that latches until the game reloads.',
    inputSchema: {
      action: z
        .enum(['arm', 'disarm', 'kill', 'replan', 'export_save', 'dump_knowledge'])
        .describe('What to do.'),
    },
  },
  async ({ action }) => {
    const command =
      action === 'replan'
        ? { type: 'replan', reason: 'requested by Claude Code session' }
        : { type: action };

    const result = await post('/command', command);
    if (result === null) return text(serviceDown());
    return text(`Queued "${action}". Applies on the mod's next report.`);
  },
);

/**
 * Success criterion for a chosen candidate.
 *
 * Gathering and farming are measured in skill level; a sale or a purchase is
 * measured in GP, since neither has a level to reach.
 */
function successFor(candidate: Record<string, any>, targetLevel: number) {
  const skillId = candidate.params?.skillId;
  if (typeof skillId === 'string') {
    return { type: 'skill_level_at_least', skillId, level: targetLevel };
  }
  if (candidate.kind === 'tend_farm') {
    return { type: 'skill_level_at_least', skillId: 'melvorD:Farming', level: targetLevel };
  }
  // Deliberately trivial: the point of a sale or purchase is the transition, not
  // a savings goal, and an unreachable target would block every later decision.
  return { type: 'currency_at_least', currencyId: 'melvorD:GP', amount: 1 };
}

function describe(candidate: Record<string, any>): string {
  const parts = [candidate.label];
  if (candidate.xpPerHour > 0)
    parts.push(`${Math.round(candidate.xpPerHour).toLocaleString()} xp/h`);
  if (candidate.gpPerHour > 0)
    parts.push(`${Math.round(candidate.gpPerHour).toLocaleString()} gp/h`);
  if (candidate.requiresLevel !== undefined) parts.push(`needs lvl ${candidate.requiresLevel}`);
  return parts.join(' — ');
}

function topStacks(items: { qty: number; name: string }[]): string {
  if (items.length === 0) return 'empty';
  return [...items]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10)
    .map((i) => `${i.qty}x ${i.name}`)
    .join(', ');
}

function farmSummary(farm: { state: string }[]): string {
  if (farm.length === 0) return 'no plots';
  const counts = farm.reduce<Record<string, number>>((acc, plot) => {
    acc[plot.state] = (acc[plot.state] ?? 0) + 1;
    return acc;
  }, {});
  return Object.entries(counts)
    .map(([state, n]) => `${n} ${state}`)
    .join(', ');
}

function serviceDown(): string {
  return `Cannot reach the planner service at ${BASE}. Start it with: pnpm planner`;
}

function text(body: string) {
  return { content: [{ type: 'text' as const, text: body }] };
}

async function get(path: string): Promise<any | null> {
  return request(path, { method: 'GET' });
}

async function post(path: string, body: unknown): Promise<any | null> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function request(path: string, init: RequestInit): Promise<any | null> {
  try {
    const response = await fetch(`${BASE}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

await server.connect(new StdioServerTransport());

import { evaluateGoals, goalsAdvancedBy, loadGoals, nextRung, renderGoals } from './goals.js';
import { appendDailyNote, loadMemory, searchEpisodic } from './memory.js';
import { controlRate, measureProgress } from './progress.js';
import type { Store } from './store.js';

/**
 * The behaviour behind every MCP tool.
 *
 * This lives in the service, not in the MCP server, for one reason: **Claude
 * Code spawns the MCP server once per session and keeps that process.** Anything
 * implemented there is frozen until the session restarts.
 *
 * The service, by contrast, runs under `tsx watch` and hot-reloads on save. So
 * the split is:
 *
 * - **MCP server** — tool *names* and *schemas* only. Changing these still needs
 *   a restart, which is correct: the client caches the tool list.
 * - **This file** — everything a tool actually does and says. Edit freely; the
 *   next tool call picks it up with no restart.
 *
 * Tools return plain text because the caller is a language model. Structure it
 * can parse matters less than structure it can *read*, and a rendered summary
 * spends far fewer tokens than the JSON it was built from.
 */

const GP = 'melvorD:GP';

/** Named because a literal newline inside a template here is easy to mangle. */
const NEWLINE = String.fromCharCode(10);

export interface ToolContext {
  store: Store;
  memoryRoot: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

/**
 * Every tool the MCP server exposes, keyed by name.
 *
 * The MCP server proxies to these by name, so a tool's behaviour can change
 * without the client knowing. Adding a *new* name here still needs the MCP
 * server to declare it, and therefore a restart.
 */
export const TOOLS: Record<string, ToolHandler> = {
  async get_agent_state(_args, { store, memoryRoot }) {
    const report = store.report;
    if (report === null) {
      return 'The mod has never reported. Is the game running with a character loaded?';
    }

    const s = report.snapshot;
    if (s === null) return `Run state: ${report.runState}. No validated snapshot yet.`;

    const gp = s.currencies.find((c) => c.id === GP)?.amount ?? 0;
    const levelled = [...s.skills]
      .filter((skill) => skill.level > 1)
      .sort((a, b) => b.level - a.level)
      .map((skill) => `${skill.name} ${skill.level}`)
      .join(', ');

    const age = store.reportAgeMs;

    // The project's one quality metric: is this better than leaving a single
    // skill running? Reported wherever state is read, so it cannot quietly rot.
    const progress = measureProgress(
      report.quality,
      controlRate(
        report.candidates,
        new Map(s.skills.map((skill) => [skill.id, skill.xp] as const)),
      ),
    );

    return [
      `Run state: ${report.runState}${report.blockedReason === null ? '' : ` — BLOCKED: ${report.blockedReason}`}`,
      `Connected: ${age !== null && age < 15_000} (last report ${age}ms ago)`,
      progress === null ? 'Progress: not enough samples yet.' : `Progress: ${progress.detail}`,
      `Objective: ${report.objective === null ? 'none' : report.objective.rationale}`,
      '',
      `Character ${s.characterName} (${s.gameVersion}) — total level ${s.totalLevel}, completion ${s.completionPercent.toFixed(2)}%, GP ${gp.toLocaleString()}`,
      `Doing: ${s.activeAction === null ? 'nothing' : s.activeAction.name}`,
      `Skills above 1: ${levelled || '(none)'}`,
      `Bank: ${s.bank.slotsUsed}/${s.bank.slotsMax} slots — ${topStacks(s.bank.items)}`,
      `Combat: HP ${s.combat.hitpoints}/${s.combat.maxHitpoints}, auto-eat ${
        s.combat.autoEatThreshold > 0 ? 'owned' : 'NOT owned (combat will be refused)'
      }`,
      '',
      'Goals (GOALS.md):',
      renderGoals(evaluateGoals(await loadGoals(memoryRoot), s)),
    ].join('\n');
  },

  async list_candidates(_args, { store, memoryRoot }) {
    const candidates = store.report?.candidates ?? [];
    if (candidates.length === 0) {
      return 'No candidates. The agent cannot act — check get_agent_state for why.';
    }

    // Each candidate carries the goals it advances, so "highest rate" and "what
    // matters" are visibly different choices. Without this the list is a
    // leaderboard, and reading down a leaderboard is precisely the greedy
    // behaviour long-term goals exist to counter.
    const snapshot = store.report?.snapshot ?? null;
    const statuses = snapshot === null ? [] : evaluateGoals(await loadGoals(memoryRoot), snapshot);

    const lines = candidates.map((c, i) => {
      const serves = goalsAdvancedBy(c, statuses);
      return `${i}. ${describe(c)}${serves.length === 0 ? '' : `  → ${serves.join(', ')}`}`;
    });

    const blocked = store.report?.blockedOpportunities ?? [];
    if (blocked.length > 0) {
      lines.push('', `Blocked (${blocked.length}) — the best moves often produce one of these:`);
      for (const item of blocked.slice(0, 12)) {
        const missing = item.missing.map((m) => `${m.name} ${m.have}/${m.need}`).join(', ');
        lines.push(`- ${item.label}${missing === '' ? '' : ` — needs ${missing}`}`);
      }
      if (blocked.length > 12) lines.push(`- ...and ${blocked.length - 12} more`);
    }

    return lines.join('\n');
  },

  async set_objective(args, { store }) {
    const index = Number(args.candidateIndex);
    const candidates = store.report?.candidates ?? [];
    const chosen = candidates[index];

    if (chosen === undefined) {
      return `Index ${index} is out of range — there are ${candidates.length} candidates (0..${candidates.length - 1}). Call list_candidates again; the list changes with game state.`;
    }

    const targetLevel = Number(args.targetLevel);
    const abortMinutes = Number(args.abortMinutes);

    // Params are copied from the candidate verbatim. The caller picks *which*,
    // never *what*, so a mistyped or invented recipe id is impossible.
    store.enqueue({
      type: 'set_objective',
      objective: {
        id: `session-${Date.now()}`,
        kind: chosen.kind,
        params: chosen.params,
        successWhen: successFor(chosen, targetLevel),
        abortWhen: { minutesExceed: abortMinutes },
        expectedDurationMin: Math.min(abortMinutes, 60),
        rationale: String(args.rationale ?? 'no rationale given'),
      },
    });

    return `Queued: ${chosen.label}\nTarget: level ${targetLevel}, abort after ${abortMinutes}min.\nApplies on the mod's next report.`;
  },

  async set_plan(args, { store }) {
    const candidates = store.report?.candidates ?? [];
    const steps = Array.isArray(args.steps) ? args.steps : [];

    if (steps.length === 0) {
      return 'Pass steps: [{candidateIndex, targetLevel, abortMinutes, rationale}, ...] — a plan of 2 to 8 objectives.';
    }

    const objectives = [];
    for (const [position, raw] of steps.entries()) {
      const step = raw as Record<string, unknown>;
      const chosen = candidates[Number(step.candidateIndex)];
      if (chosen === undefined) {
        return `Step ${position + 1} names candidate ${String(step.candidateIndex)}, which is out of range — there are ${candidates.length}. Call list_candidates again; the list changes with game state.`;
      }

      const abortMinutes = Number(step.abortMinutes ?? 60);
      objectives.push({
        id: `plan-${Date.now()}-${position}`,
        kind: chosen.kind,
        params: chosen.params,
        successWhen: successFor(chosen, Number(step.targetLevel ?? 0)),
        abortWhen: { minutesExceed: abortMinutes },
        expectedDurationMin: Math.min(abortMinutes, 60),
        rationale: String(step.rationale ?? 'no rationale given'),
      });
    }

    store.enqueue({ type: 'set_plan', objectives });

    // Every step is chosen from *current* candidates, so the further ahead a
    // plan reaches the more of it was written against state that has since
    // moved. Saying so beats letting a six-step plan look like a schedule.
    return [
      `Queued a plan of ${objectives.length} objectives:`,
      ...objectives.map((objective, index) => `  ${index + 1}. ${objective.rationale}`),
      '',
      'Each step starts when the one before it finishes or times out. Later steps were chosen against the candidates available now, so re-plan if the character changes shape.',
    ].join(NEWLINE);
  },

  async get_journal(_args, { store }) {
    const digest = store.digest();
    if (digest.recent.length === 0 && digest.aggregates.length === 0) {
      return 'Nothing attempted yet.';
    }

    const recent = digest.recent.map(
      (e) =>
        `- ${e.objective.kind} "${e.objective.rationale}" → ${e.outcome} after ${Math.round(
          (e.endedAt - e.startedAt) / 60_000,
        )}min (levels ${e.deltas.totalLevel >= 0 ? '+' : ''}${e.deltas.totalLevel})`,
    );
    const older = digest.aggregates.map(
      (a) =>
        `- earlier: ${a.kind} x${a.attempts} (${a.completed} completed, ${a.aborted} aborted, median ${Math.round(a.medianMinutes)}min)`,
    );

    return [...recent, ...older].join('\n');
  },

  async get_recent_activity(args, { store }) {
    const limit = Number(args.limit ?? 25);
    const logs = store.report?.logs ?? [];
    if (logs.length === 0) return 'Log is empty — the mod drains it on each report.';

    return logs
      .slice(-limit)
      .map((l) => `${new Date(l.at).toLocaleTimeString()} [${l.level}] ${l.source}: ${l.message}`)
      .join('\n');
  },

  async control_agent(args, { store }) {
    const action = String(args.action);
    store.enqueue(
      action === 'replan'
        ? { type: 'replan', reason: 'requested by Claude Code session' }
        : ({ type: action } as never),
    );
    return `Queued "${action}". Applies on the mod's next report.`;
  },

  async read_memory(_args, { memoryRoot }) {
    const memory = await loadMemory(memoryRoot);
    if (memory.user === null && memory.memory === null) {
      return 'No curated memory yet. MEMORY.md and USER.md do not exist.';
    }
    const blocks: string[] = [];
    if (memory.memory !== null) blocks.push(`# MEMORY.md\n\n${memory.memory}`);
    if (memory.user !== null) blocks.push(`# USER.md\n\n${memory.user}`);
    return blocks.join('\n\n');
  },

  async search_notes(args, { memoryRoot }) {
    const query = String(args.query ?? '');
    if (query.trim() === '') return 'query is required.';

    const hits = await searchEpisodic(memoryRoot, query);
    if (hits.length === 0) return `No notes matching "${query}".`;
    return hits.map((h) => `[${h.origin}] ${h.file}: ${h.line}`).join('\n');
  },

  async write_note(args, { memoryRoot }) {
    const note = String(args.note ?? '');
    if (note.trim() === '') return 'note is required.';

    // Origin is assigned here, never accepted from the caller: a tool call is
    // the agent observing, not the operator speaking.
    await appendDailyNote(memoryRoot, 'agent', note);
    return "Recorded to today's notes as [agent]. It will not affect planning until a consolidation pass promotes it.";
  },
};

function topStacks(items: { qty: number; name: string }[]): string {
  if (items.length === 0) return 'empty';
  return [...items]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10)
    .map((i) => `${i.qty}x ${i.name}`)
    .join(', ');
}

function describe(candidate: {
  label: string;
  xpPerHour?: number | undefined;
  gpPerHour?: number | undefined;
  requiresLevel?: number | undefined;
}): string {
  const parts = [candidate.label];
  if ((candidate.xpPerHour ?? 0) > 0) {
    parts.push(`${Math.round(candidate.xpPerHour ?? 0).toLocaleString()} xp/h`);
  }
  if ((candidate.gpPerHour ?? 0) > 0) {
    parts.push(`${Math.round(candidate.gpPerHour ?? 0).toLocaleString()} gp/h`);
  }
  if (candidate.requiresLevel !== undefined) parts.push(`needs lvl ${candidate.requiresLevel}`);
  return parts.join(' — ');
}

/** Success criterion for a chosen candidate; skill kinds use the caller's target. */
function successFor(
  candidate: { kind: string; params: Record<string, unknown> },
  targetLevel: number,
) {
  const skillId = candidate.params.skillId;
  if (typeof skillId === 'string') {
    return [{ type: 'skill_level_at_least' as const, skillId, level: targetLevel }];
  }

  // A sale or purchase has no level to reach, and the obvious stand-in — "have
  // at least 1 GP" — is already true, so the objective completed before it ever
  // acted. No criterion at all is the honest answer: the executor knows when a
  // one-shot transition is done, and nothing else does.
  return [];
}

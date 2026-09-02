import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Candidate, Objective, StateSnapshot } from '@melvor-agent/shared';
import { levelsPerHour } from '@melvor-agent/shared';
import { evaluateGoals, goalsAdvancedBy, loadGoals, planRung, renderGoals } from './goals.js';
import { appendDailyNote, loadMemory, searchEpisodic } from './memory.js';
import { controlRate, measureAgainstClaim, measureProgress } from './progress.js';
import { type Store, identityOf } from './store.js';

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
    // Disk plus live, so a reload does not restart the window. The mod ships
    // only its last 120 samples and loses all of them on reload; the persisted
    // series is what makes the metric continuous.
    const persistedQuality = await store.readQuality();
    const quality =
      persistedQuality.length > 0
        ? [
            ...persistedQuality,
            ...report.quality.filter(
              (sample) => !persistedQuality.some((seen) => seen.at === sample.at),
            ),
          ].sort((a, b) => a.at - b.at)
        : report.quality;

    const progress = measureProgress(
      quality,
      controlRate(
        report.candidates,
        new Map(s.skills.map((skill) => [skill.id, skill.xp] as const)),
      ),
    );

    return [
      `Run state: ${report.runState}${report.blockedReason === null ? '' : ` — BLOCKED: ${report.blockedReason}`}`,
      `Connected: ${age !== null && age < 15_000} (last report ${age}ms ago)`,
      progress === null ? 'Progress: not enough samples yet.' : `Progress: ${progress.detail}`,
      // The rate this activity is actually delivering, against the rate its
      // candidate advertised. Every rate error this session was found by an
      // operator noticing a number looked wrong, after hours had been planned
      // around it; the service was already measuring the truth and had no way
      // to line it up against the claim.
      ...(() => {
        const skillId = s.activeAction?.id;
        if (skillId === undefined) return [];

        const claimed =
          report.candidates.find((c) => (c.params as { skillId?: string }).skillId === skillId)
            ?.xpPerHour ?? null;

        const measured = measureAgainstClaim(quality, skillId, claimed);
        if (measured === null) return [];

        const ratio =
          measured.ratio === null
            ? 'nothing was advertised to compare against'
            : `${Math.round(measured.ratio * 100)}% of the ${Math.round(claimed ?? 0).toLocaleString()} xp/h advertised`;

        return [
          `Delivering: ${Math.round(measured.realisedXpPerHour).toLocaleString()} xp/h over ${measured.hours.toFixed(1)}h — ${ratio}`,
        ];
      })(),
      // "none" and "nothing" are what a stalled agent shows and also what a
      // healthy one shows for the second or two between plan steps. Naming the
      // queue separates them; without it, three snapshots this morning were
      // read as stalls and two nearly reverted working code.
      `Objective: ${
        report.objective !== null
          ? `${report.objective.rationale}${describeElapsed(report.objective, report.objectiveStartedAt)}`
          : report.plan.length > 0
            ? `none right now — ${report.plan.length} step(s) still queued, so this is a gap between objectives rather than a stop`
            : 'none, and nothing queued'
      }`,
      ...renderPlan(report.plan, report.candidates),
      '',
      `Character ${s.characterName} (${s.gameVersion}) — total level ${s.totalLevel}, completion ${s.completionPercent.toFixed(2)}%, GP ${gp.toLocaleString()}`,
      // The mod only reloads with the game, so a fix committed minutes ago may
      // not be the code that is running. Saying which build is live turns "is
      // that live yet?" from a guess into a fact.
      `Running mod build: ${store.report?.buildStamp ?? 'unknown (older mod, or not reported)'}${describeStaleBuild(store.report?.buildStamp ?? null)}`,
      `Doing: ${s.activeAction === null ? 'nothing' : s.activeAction.name}`,
      `Skills above 1: ${levelled || '(none)'}`,
      `Bank: ${s.bank.slotsUsed}/${s.bank.slotsMax} slots — ${topStacks(s.bank.items)}`,
      // "combat will be refused" was simply false, and it was in front of the
      // planner on every single turn. The combat gate models the no-Auto-Eat
      // case explicitly — a reflex eats, the way a human clicks food — and
      // penalises it for the two ways it is worse: a fixed HP threshold and a
      // once-a-second look. Fights are offered and taken without Auto Eat.
      //
      // The cost of the wrong line was not theoretical: combat objectives were
      // avoided all session on its say-so, including three Township tasks that
      // want monsters killed and pay the Township XP the last untrained skill
      // in scope is gated behind.
      `Combat: HP ${s.combat.hitpoints}/${s.combat.maxHitpoints}, auto-eat ${
        s.combat.autoEatThreshold > 0
          ? 'owned'
          : 'not owned — fights still allowed, but the gate is stricter and eating is manual'
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
    const skillXp = new Map((snapshot?.skills ?? []).map((skill) => [skill.id, skill.xp] as const));

    const lines = candidates.map((c, i) => {
      const serves = goalsAdvancedBy(c, statuses);
      return `${i}. ${describe(c, skillXp)}${serves.length === 0 ? '' : `  → ${serves.join(', ')}`}`;
    });

    // Remember exactly what was shown, so a later choice can be checked
    // against it rather than trusting an index into a list that moves.
    store.rememberShownCandidates(candidates);

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
    const requested = Number(args.candidateIndex);
    const candidates = store.report?.candidates ?? [];

    if (candidates[requested] === undefined) {
      return `Index ${requested} is out of range — there are ${candidates.length} candidates (0..${candidates.length - 1}). Call list_candidates again; the list changes with game state.`;
    }

    // An index is a position in a list that moves with game state. Acting on a
    // stale one is silent and wrong: a request to equip a dagger built a
    // storehouse, because smithing finished between listing and choosing. The
    // choice is followed to its new position when it has merely moved.
    const resolved = store.resolveChoice(requested, candidates);
    if ('error' in resolved) {
      return `Refused: ${resolved.error}. Call list_candidates and choose again.`;
    }
    const index = resolved.index;
    const chosen = candidates[index];
    if (chosen === undefined) {
      return `Index ${index} is out of range — call list_candidates again.`;
    }

    const targetLevel = Number(args.targetLevel);
    const abortMinutes = Number(args.abortMinutes);

    // Optional: finish when the bank holds this much of an item, rather than at
    // a level. Both must be present to mean anything.
    const stockItemId = typeof args.untilItemId === 'string' ? args.untilItemId : undefined;
    const stockQuantity = Number(args.untilQuantity);
    const stockTarget =
      stockItemId !== undefined && Number.isFinite(stockQuantity) && stockQuantity > 0
        ? { itemId: stockItemId, quantity: stockQuantity }
        : undefined;

    // A target the character has already passed makes an objective that
    // completes on its first tick without acting — it looks like success and
    // does nothing. Live, "fletch bows to level 20" at Fletching 20 finished
    // instantly and produced no bows.
    const snapshot = store.report?.snapshot ?? null;
    const alreadyThere =
      snapshot === null || stockTarget !== undefined
        ? null
        : levelAlreadyReached(chosen, targetLevel, snapshot);
    if (alreadyThere !== null) {
      return `Refused: ${alreadyThere}. Pick a level above it, or a different candidate.`;
    }

    // A target level is a guess until it is checked against the rate and the
    // budget. Unchecked, it lands on one of the two failures nextRung was
    // written to prevent: too far and the objective always ends in
    // `abortMinutes`, too near and it completes in minutes and spends the hour
    // replanning. A stock target has no level, so it skips this entirely.
    const rung =
      stockTarget !== undefined
        ? { level: targetLevel, note: null }
        : rungFor(chosen, targetLevel, abortMinutes, snapshot);

    // Params are copied from the candidate verbatim. The caller picks *which*,
    // never *what*, so a mistyped or invented recipe id is impossible.
    store.enqueue({
      type: 'set_objective',
      objective: {
        id: `session-${Date.now()}`,
        kind: chosen.kind,
        params: chosen.params,
        successWhen: successFor(chosen, rung.level, stockTarget),
        abortWhen: { minutesExceed: abortMinutes },
        expectedDurationMin: Math.min(abortMinutes, 60),
        rationale: String(args.rationale ?? 'no rationale given'),
      },
    });

    return [
      `Queued: ${chosen.label}`,
      `Target: level ${rung.level}, abort after ${abortMinutes}min.`,
      ...(rung.note === null ? [] : [rung.note]),
      ...commitmentWarning(store.report, args.urgent === true),
      "Applies on the mod's next report.",
    ].join(NEWLINE);
  },

  async set_plan(args, { store }) {
    const candidates = store.report?.candidates ?? [];
    const steps = Array.isArray(args.steps) ? args.steps : [];

    if (steps.length === 0) {
      return 'Pass steps: [{candidateIndex, targetLevel, abortMinutes, rationale}, ...] — a plan of 2 to 8 objectives.';
    }

    const objectives = [];
    /** Steps whose candidate merely changed position; reported, not refused. */
    const moved: string[] = [];
    /** Rung adjustments, so a lowered target is never applied silently. */
    const notes: string[] = [];
    for (const [position, raw] of steps.entries()) {
      const step = raw as Record<string, unknown>;
      const stepIndex = Number(step.candidateIndex);
      if (candidates[stepIndex] === undefined) {
        return `Step ${position + 1} names candidate ${String(step.candidateIndex)}, which is out of range — there are ${candidates.length}. Call list_candidates again; the list changes with game state.`;
      }

      const resolvedStep = store.resolveChoice(stepIndex, candidates);
      if ('error' in resolvedStep) {
        return `Refused: step ${position + 1} — ${resolvedStep.error}. Call list_candidates and build the plan again.`;
      }
      const chosen = candidates[resolvedStep.index];
      if (chosen === undefined) {
        return `Step ${position + 1} could not be resolved — call list_candidates again.`;
      }
      if (resolvedStep.moved) moved.push(`step ${position + 1} (${chosen.label})`);

      const abortMinutes = Number(step.abortMinutes ?? 60);

      // A quantity target, same as set_objective has always had.
      //
      // Without it a plan could only end a step at a level, which either stops
      // short of the count the next step needs or runs hours past it -- so
      // "mine 200 Gold Ore, then smelt" was unsayable, and the chain had to be
      // driven by an operator watching for the moment to switch. That is the
      // shape of work a plan exists to remove.
      const stepItemId = typeof step.untilItemId === 'string' ? step.untilItemId : undefined;
      const stepQuantity = Number(step.untilQuantity);
      const stepStock =
        stepItemId !== undefined && Number.isFinite(stepQuantity) && stepQuantity > 0
          ? { itemId: stepItemId, quantity: stepQuantity }
          : undefined;

      // Sized against the rate and the budget, exactly as a single objective
      // is. A plan is where an unreachable rung costs most: the step does not
      // merely fail, it burns its whole budget first and delays every step
      // behind it.
      //
      // Only the first step is projected from *current* XP, which is honest
      // rather than lazy: by the time step three runs the character is several
      // levels further on and any projection made now would be arithmetic
      // dressed up as foresight.
      const stepRung =
        stepStock !== undefined || position > 0
          ? { level: Number(step.targetLevel ?? 0), note: null }
          : rungFor(chosen, Number(step.targetLevel ?? 0), abortMinutes, store.report?.snapshot);
      if (stepRung.note !== null) notes.push(`step ${position + 1}: ${stepRung.note}`);

      objectives.push({
        id: `plan-${Date.now()}-${position}`,
        kind: chosen.kind,
        params: chosen.params,
        successWhen: successFor(chosen, stepRung.level, stepStock),
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
      ...notes,
      ...commitmentWarning(store.report, args.urgent === true),
      ...(moved.length === 0
        ? []
        : [
            `Followed ${moved.length} choice(s) that had moved position since your listing: ${moved.join(', ')}. The candidates themselves are unchanged.`,
          ]),
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

    // Disk first, live report second.
    //
    // The report holds only what the mod drained in the last three seconds, so
    // after any reload it is empty -- which is precisely when a post-mortem is
    // wanted. Every investigation of a death or a stall this session hit "Log
    // is empty" while the records sat in data/logs, written and never read.
    const level = args.level === undefined ? undefined : (String(args.level) as 'warn' | 'error');
    const persisted = await store.readRecentLogs(limit, level);
    const logs = persisted.length > 0 ? persisted : (store.report?.logs ?? []).slice(-limit);

    if (logs.length === 0) return 'No activity recorded yet.';

    return logs
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

/**
 * Sizes a requested level against the rate and the budget.
 *
 * The clamp is deliberately one-directional. A target beyond the budget is
 * lowered, because an objective that *completes* produces a journal entry, a
 * replan and a measured rate, while one that times out produces an abandonment
 * and teaches nothing. A target inside the budget is left exactly as asked and
 * only reported on: raising it would mean the agent grinding further than the
 * caller chose, which is not a correction to make on someone's behalf.
 *
 * @returns The level to commit to, and a line for the caller when it differs
 *          from the request or the projection is worth knowing.
 */
function rungFor(
  candidate: { params: Record<string, unknown>; xpPerHour?: number | undefined },
  targetLevel: number,
  abortMinutes: number,
  snapshot: StateSnapshot | null | undefined,
): { level: number; note: string | null } {
  const skillId = candidate.params.skillId;
  if (snapshot === null || snapshot === undefined || typeof skillId !== 'string') {
    return { level: targetLevel, note: null };
  }

  const skill = snapshot.skills.find((entry) => entry.id === skillId);
  const rate = candidate.xpPerHour ?? 0;
  if (skill === undefined || rate <= 0) return { level: targetLevel, note: null };

  const rung = planRung(skill.level, skill.xp, targetLevel, rate, abortMinutes);
  const minutes = Math.round(rung.estimatedMinutes);

  if (rung.fit === 'clamped') {
    return {
      level: rung.level,
      note: `Target lowered from ${targetLevel} to ${rung.level}: at ${Math.round(rate).toLocaleString()} xp/h, ${skill.name} ${targetLevel} needs far more than the ${abortMinutes}min budget, so the objective would have ended in an abort rather than a completion. ${rung.level} takes about ${minutes}min. Raise abortMinutes if you meant the longer grind.`,
    };
  }

  if (rung.fit === 'short') {
    return {
      level: targetLevel,
      note: `Projected ~${minutes}min of the ${abortMinutes}min budget. That is a short rung: the objective ends early and the agent replans, which is where skill-hopping comes from and what mastery bonuses are lost to. A higher target would fill the budget.`,
    };
  }

  return { level: targetLevel, note: `Projected ~${minutes}min at the advertised rate.` };
}

/**
 * How long an objective should hold before it is worth swapping.
 *
 * Ten minutes. Short enough that a genuine mistake is cheap to correct, long
 * enough that the mastery every candidate's own label mentions has had some
 * time to accrue.
 */
const MIN_COMMIT_MINUTES = 10;

/**
 * Warns when an objective is being replaced almost as soon as it started.
 *
 * A warning and not a refusal, on purpose. The pull is real in both directions:
 * mastery pays for staying, and the ranking a session reads is instantaneous,
 * so there is always a fresher-looking number one tool call away. Neither side
 * is always right, so the operator is told rather than overruled — but the
 * cost has to be visible at the moment the choice is made, which is the one
 * place it never was.
 */
function commitmentWarning(
  report: { objective: Objective | null; objectiveStartedAt?: number | null } | null,
  urgent: boolean,
): string[] {
  if (urgent) return [];
  const objective = report?.objective ?? null;
  const startedAt = report?.objectiveStartedAt ?? null;
  if (objective === null || startedAt === null) return [];

  const minutes = (Date.now() - startedAt) / 60_000;
  // An objective expected to run for less than the floor is not being cut
  // short by definition -- a two-minute purchase is meant to end quickly.
  const floor = Math.min(MIN_COMMIT_MINUTES, objective.expectedDurationMin);
  if (minutes >= floor) return [];

  return [
    `Note: this replaces "${objective.rationale}" after only ${minutes.toFixed(1)}min of an expected ${Math.round(objective.expectedDurationMin)}min. Mastery rewards sustained use of one action and every rate here is quoted instantaneously, so a list read fresh always argues for switching. If the swap is a correction rather than a better number, pass urgent: true and this note goes away.`,
  ];
}

/**
 * How long the current objective has been running, and against what.
 *
 * Elapsed time is what makes churn visible. Mastery rewards staying on one
 * action -- every candidate that mentions it says so -- while ranking is
 * instantaneous and always has a fresher-looking number, so the two pull
 * against each other on every turn. Nothing was measuring the pull: a swap
 * made four minutes into an hour-long objective read exactly like one made
 * after fifty.
 */
function describeElapsed(objective: Objective, startedAt: number | null | undefined): string {
  if (startedAt === null || startedAt === undefined) return '';
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  return ` — ${minutes}min in, of ${Math.round(objective.expectedDurationMin)}min expected (aborts at ${Math.round(objective.abortWhen.minutesExceed)}min)`;
}

/**
 * The queued plan, with any step that no longer matches reality flagged.
 *
 * Every step was chosen from the candidate list as it stood when the plan was
 * written, and that list moves with the character: a recipe stops being
 * affordable, a shop purchase is bought, a fight is outgrown. A count could not
 * express any of that, so a session had two options -- trust the queue blindly
 * or replace it wholesale -- and it replaced it wholesale, all session.
 *
 * Staleness is decided by the same identity the choice guard uses, kind plus
 * params, rather than by comparing labels: labels carry live numbers and would
 * flag every step on every read, which is how a warning becomes noise.
 */
function renderPlan(plan: readonly Objective[], candidates: readonly Candidate[]): string[] {
  if (plan.length === 0) return [];

  const available = new Set(candidates.map((candidate) => identityOf(candidate)));

  const lines = plan.map((step, index) => {
    const stale = available.has(identityOf(step)) ? '' : '  [STALE: no longer a candidate]';
    return `  ${index + 1}. ${step.kind} — ${step.rationale} (${describeTarget(step)}, abort ${Math.round(step.abortWhen.minutesExceed)}min)${stale}`;
  });

  const stale = plan.filter((step) => !available.has(identityOf(step))).length;

  return [
    `Queued (${plan.length} step(s)):`,
    ...lines,
    ...(stale === 0
      ? []
      : [
          `  ${stale} step(s) name work the game is no longer offering. That is not always wrong -- a step that produces its own input is *meant* to be unavailable until the step before it runs -- but it is where a stale plan shows.`,
        ]),
  ];
}

/** A step's finish line, in the terms it was actually written in. */
function describeTarget(objective: Objective): string {
  const criteria = objective.successWhen.map((criterion) => {
    switch (criterion.type) {
      case 'skill_level_at_least':
        return `to level ${criterion.level}`;
      case 'item_qty_at_least':
        return `until ${criterion.qty}x ${criterion.itemId}`;
      case 'currency_at_least':
        return `until ${criterion.amount.toLocaleString()} ${criterion.currencyId}`;
    }
  });
  return criteria.length === 0 ? 'one-shot' : criteria.join(', ');
}

function topStacks(items: { qty: number; name: string }[]): string {
  if (items.length === 0) return 'empty';
  return [...items]
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10)
    .map((i) => `${i.qty}x ${i.name}`)
    .join(', ');
}

function describe(
  candidate: {
    label: string;
    kind?: string;
    params?: unknown;
    xpPerHour?: number | undefined;
    gpPerHour?: number | undefined;
    requiresLevel?: number | undefined;
  },
  skillXp?: ReadonlyMap<string, number>,
): string {
  const parts = [candidate.label];
  if ((candidate.xpPerHour ?? 0) > 0) {
    parts.push(`${Math.round(candidate.xpPerHour ?? 0).toLocaleString()} xp/h`);
  }

  // Levels per hour, not just XP per hour.
  //
  // The two diverge enormously and the goals are written in levels. Mining at
  // 33,600 xp/h from level 43 is worth a fraction of a level an hour; Crafting
  // at 15,600 from level 2 is worth dozens. Ranking a list by XP silently
  // ranks it by "whichever skill is already highest", which is backwards for
  // any total-level goal — and total level 500 was the nearest goal on the
  // board while the plan ground seven expensive Mining levels.
  //
  // Computed here rather than in the mod because it depends on current XP,
  // which the snapshot already carries, and because the same arithmetic
  // already decides the stopgap's fallback.
  const skillId = (candidate.params as { skillId?: string } | undefined)?.skillId;
  if (skillXp !== undefined && skillId !== undefined && (candidate.xpPerHour ?? 0) > 0) {
    const rate = levelsPerHour(skillXp.get(skillId) ?? 0, candidate.xpPerHour ?? 0);
    if (rate > 0) parts.push(`${rate.toFixed(2)} levels/h`);
  }

  if ((candidate.gpPerHour ?? 0) > 0) {
    parts.push(`${Math.round(candidate.gpPerHour ?? 0).toLocaleString()} gp/h`);
  }
  if (candidate.requiresLevel !== undefined) parts.push(`needs lvl ${candidate.requiresLevel}`);
  return parts.join(' — ');
}

/** Success criterion for a chosen candidate; skill kinds use the caller's target. */
/**
 * Whether a level target is already satisfied.
 *
 * @returns A reason to refuse, or null when the target is still ahead.
 */
function levelAlreadyReached(
  candidate: { params: Record<string, unknown> },
  targetLevel: number,
  snapshot: { skills: { id: string; name: string; level: number }[] },
): string | null {
  const skillId = candidate.params.skillId;
  if (typeof skillId !== 'string') return null;

  const skill = snapshot.skills.find((entry) => entry.id === skillId);
  if (skill === undefined) return null;
  if (skill.level < targetLevel) return null;

  return `${skill.name} is already level ${skill.level}, so a target of ${targetLevel} is met before the objective starts and it would finish without acting`;
}

function successFor(
  candidate: { kind: string; params: Record<string, unknown> },
  targetLevel: number,
  stockTarget?: { itemId: string; quantity: number },
) {
  // A quantity target, when one is given, beats a level target outright.
  // Township tasks ask for stock — "give 250 Air Rune", "give 100 Iron
  // Arrows", "give 25 Beef" — and a level is the wrong shape for that: it
  // either stops short of the count or runs hours past it. `item_qty_at_least`
  // has existed in the contract, in `criteria.ts` and in the panel the whole
  // time; nothing could ever set one, so it may as well not have existed.
  if (stockTarget !== undefined) {
    return [
      {
        type: 'item_qty_at_least' as const,
        itemId: stockTarget.itemId,
        qty: stockTarget.quantity,
      },
    ];
  }

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

/**
 * Says when a newer mod has been built but not loaded.
 *
 * The build stamp answers "what is running". It does not answer "is there
 * something better sitting on disk", and that second question is the one that
 * cost the most time today: a bank-deadlock fix, an Agility course fix and a
 * change making a Staff of Air visible to the equip reader all sat built and
 * unloaded for hours while the agent was steered around them by hand.
 *
 * Read from the build artifact rather than from git, because what matters is
 * what `pnpm build` produced — a commit that was never built is not waiting to
 * be loaded, it is waiting to be built, and conflating the two would produce a
 * nag that is wrong exactly when someone is mid-edit.
 *
 * Silent when the two agree, when nothing has been built, or when either stamp
 * cannot be read. A staleness warning that fires on its own uncertainty is
 * noise, and this list already learned what noise costs.
 */
function describeStaleBuild(running: string | null): string {
  if (running === null) return '';

  try {
    // Walked up from cwd rather than assumed. The service is started from the
    // repo root by `pnpm planner` but nothing guarantees that, and a hardcoded
    // join silently produces no warning at all when it is wrong — which is the
    // same failure mode this warning exists to fix.
    let dir = process.cwd();
    let info: string | null = null;
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        info = readFileSync(join(dir, 'packages', 'mod', 'dist-local', 'BUILD_INFO.txt'), 'utf8');
        break;
      } catch {
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    if (info === null) return '';
    const built = /built\s+(\S+)/.exec(info)?.[1];
    if (built === undefined || built === running) return '';

    // Compared to the second, not the millisecond.
    //
    // The mod stamps itself and the build artifact is written moments apart in
    // the same build, so the two differ by a few milliseconds even when they
    // are the same code: 06:22:54.698 running against 06:22:54.705 on disk.
    // A strict compare reported "newer build waiting" immediately after a
    // successful reload, which is the precise way a warning becomes noise and
    // then becomes ignored — the failure this warning exists to prevent.
    const second = (stamp: string): string => stamp.slice(0, 19);
    if (second(built) <= second(running)) return '';

    return ` — NEWER BUILD WAITING (${built}); reload to pick it up`;
  } catch {
    return '';
  }
}

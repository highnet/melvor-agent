import type { Candidate, Objective, StateSnapshot, SuccessCriterion } from '@melvor-agent/shared';
import {
  describeDropped,
  describeSatisfied,
  isMonotonicCriterion,
  levelsPerHour,
  selectBlocked,
} from '@melvor-agent/shared';
import { isNewerBuild, parseBuildInfo, readBuildInfo } from './build-info.js';
import {
  evaluateGoals,
  goalsAdvancedBy,
  loadGoals,
  nextRung,
  planRung,
  renderGoals,
} from './goals.js';
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

/**
 * How many blocked opportunities a listing shows, criticals aside.
 *
 * Twelve, as before. What changed is *which* twelve; see {@link selectBlocked}.
 */
const BLOCKED_SHOWN = 12;

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

        // The recipe actually running, so the claim compared against is the one
        // that was chosen rather than the skill's first listed candidate.
        const recipeId = quality[quality.length - 1]?.activeRecipeId;
        const claimed =
          report.candidates.find((c) => {
            const params = c.params as { skillId?: string; recipeId?: string };
            if (params.skillId !== skillId) return false;
            return recipeId === undefined || params.recipeId === recipeId;
          })?.xpPerHour ?? null;

        const measured = measureAgainstClaim(quality, skillId, claimed, recipeId);
        if (measured === null) return [];

        const ratio =
          measured.ratio === null
            ? 'nothing was advertised to compare against'
            : `${Math.round(measured.ratio * 100)}% of the ${Math.round(claimed ?? 0).toLocaleString()} xp/h advertised`;

        return [
          `Delivering: ${Math.round(measured.realisedXpPerHour).toLocaleString()} xp/h over ${measured.hours.toFixed(1)}h — ${ratio}`,
        ];
      })(),
      // The other half of the line above, and the half it cannot see.
      //
      // "Delivering: N xp/h — X% of advertised" catches a rate that was
      // modelled wrong while the work itself happens. It says nothing when the
      // work happens *and produces nothing*: Agility stopping and restarting
      // every three seconds, each call verified with real before/after
      // evidence, for zero XP across fifteen minutes. The mod now watches the
      // counter the objective's own success condition names, and this is where
      // it says so.
      ...(() => {
        const stalled = report.stalledCounter ?? null;
        if (stalled === null) return [];
        return [
          `Actions verified but nothing moving: ${stalled.successes} successful action rounds over ${stalled.minutes.toFixed(1)}min with ${stalled.counter} still at ${stalled.value.toLocaleString()}. Last observed change: ${stalled.lastChange}. A replan was requested — the game accepts these actions and the objective's own counter cannot see them.`,
        ];
      })(),
      // Guarded adapter reads that threw, cumulative for the run.
      //
      // Placed next to the advertised-vs-realised comparison because it is the
      // answer that line most often needs: a rate sitting at its nominal
      // fallback because a getter was renamed looks identical to a rate that is
      // merely wrong, and the difference decides whether to re-plan or to fix
      // the adapter. Around a hundred bare catches used to swallow these with
      // no signal anywhere.
      // Optional at the read, because the field is newer than some reports:
      // a mod that has not reloaded yet sends none, and an undefined here would
      // take down the whole state summary rather than omit one line of it.
      // Stuck actions, on their own line and ahead of the reads.
      //
      // Same list, different claim, so they cannot share a sentence: a guarded
      // read that fell back leaves a rate looking optimistic, while a stuck
      // action means the agent has been repeating one call for hours and
      // achieving nothing. Describing one as the other would send a reader
      // hunting a renamed getter. Ahead, and outside the five-entry truncation
      // below, because that truncation has already hidden real failures behind
      // noisier sites — and these entries are once per detected loop, never
      // once per pass, so the line cannot become the wallpaper that buried the
      // last two diagnostics here.
      ...(() => {
        const stuck = (report.adapterFailures ?? []).filter((entry) => entry.kind === 'stuck');
        if (stuck.length === 0) return [];
        return [
          `Actions stuck (the call runs, the world does not move): ${stuck
            .map((entry) => `${entry.lastError} [×${entry.count} run(s)]`)
            .join('; ')}`,
        ];
      })(),
      ...(() => {
        const reads = (report.adapterFailures ?? []).filter((entry) => entry.kind !== 'stuck');
        if (reads.length === 0) return [];
        return [
          `Adapter reads failing (rates and candidates may be silently falling back): ${reads
            .slice(0, 5)
            .map((entry) => `${entry.site} ×${entry.count} (${entry.lastError})`)
            .join('; ')}`,
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
      // The town, which had never appeared in this summary at all.
      //
      // Township is the operator's stated first priority and the thing every
      // skilling outfit sits behind, and the only way it reached a planning
      // session was as seventeen build candidates near the bottom of
      // `list_candidates`. Its level, its storage and its happiness were in the
      // snapshot the whole time and rendered nowhere — so "happiness 0" was
      // never once put in front of anything that could act on it.
      //
      // Storage leads because a full town discards everything it produces, and
      // the happiness note is spelled out because the number alone reads as
      // decoration: it is a percentage bonus on population, and population is
      // both the Township XP rate and the taxed figure the town pays GP from.
      ...renderTown(s.township),
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
      // Ranked by severity with slots reserved per tier, rather than by the
      // order the mod happened to concatenate them in. A food-reserve countdown
      // and "Yew unlocks at level 60" used to compete on position alone, and
      // the twelve slots went to whichever reader ran first -- which is how
      // four diagnostics written in one day were shipped, truncated away, and
      // never once read by a planning session.
      const { shown, dropped } = selectBlocked(blocked, BLOCKED_SHOWN);
      lines.push('', `Blocked (${blocked.length}) — the best moves often produce one of these:`);
      for (const item of shown) {
        const missing = item.missing.map((m) => `${m.name} ${m.have}/${m.need}`).join(', ');
        // Criticals are marked: a countdown reads like every other line once it
        // is a bullet in a list of twelve.
        const mark = item.severity === 'critical' ? '[CRITICAL] ' : '';
        lines.push(`- ${mark}${item.label}${missing === '' ? '' : ` — needs ${missing}`}`);
      }
      // Named, not counted. "...and 14 more" says a cut was made and nothing
      // about whether it removed trivia or the one line that would have
      // unblocked the next four hours.
      const overflow = describeDropped(dropped);
      if (overflow !== null) lines.push(`- ${overflow}`);
    }

    return lines.join('\n');
  },

  async set_objective(args, { store, memoryRoot }) {
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
    const requestedStock =
      stockItemId !== undefined && Number.isFinite(stockQuantity) && stockQuantity > 0
        ? { itemId: stockItemId, quantity: stockQuantity }
        : undefined;

    const snapshot = store.report?.snapshot ?? null;

    // A target level is a guess until it is checked against the rate and the
    // budget. Unchecked, it lands on one of the two failures nextRung was
    // written to prevent: too far and the objective always ends in
    // `abortMinutes`, too near and it completes in minutes and spends the hour
    // replanning. A stock target has no level, so it skips this entirely --
    // and is sized by {@link stockRungFor} instead, against the two ceilings a
    // count has. Skipping *both* is what let `untilQuantity: 10000` through
    // against a bank that could reach about 5,400.
    const rung =
      requestedStock !== undefined
        ? { level: targetLevel, note: null }
        : rungFor(chosen, targetLevel, abortMinutes, snapshot);

    const sized =
      requestedStock === undefined
        ? { quantity: 0, note: null }
        : stockRungFor(chosen, requestedStock, abortMinutes, snapshot);
    const stockTarget =
      requestedStock === undefined
        ? undefined
        : { itemId: requestedStock.itemId, quantity: sized.quantity };

    // The criteria are checked *as queued*, after the rung has been sized, and
    // an objective whose criteria already hold is refused rather than accepted.
    //
    // This objective replaces whatever is running the moment the mod reports,
    // so "already satisfied" and "would complete without acting" are the same
    // statement — every criterion type included, a stock target as much as a
    // level. Live, "fletch bows to level 20" at Fletching 20 finished instantly
    // and produced no bows.
    const noOp = noOpReason(snapshot, successFor(chosen, rung.level, stockTarget), 'immediately');
    if (noOp !== null) {
      return `Refused: ${noOp}. It would complete without acting. Pick a target above the figure named, or a different candidate.`;
    }

    // Attached to every objective, whatever it does. Selling is not the job of
    // this objective and must not become it -- the target is a standing
    // authorisation the reflex tier acts on while the objective runs, which is
    // the difference between the agent funding a goal in the background and an
    // operator spending a plan step on a sale.
    const fundingTarget = await fundingTargetFor(memoryRoot, snapshot);

    // Params are copied from the candidate verbatim. The caller picks *which*,
    // never *what*, so a mistyped or invented recipe id is impossible.
    store.enqueue({
      type: 'set_objective',
      objective: {
        id: `session-${Date.now()}`,
        kind: chosen.kind,
        params: chosen.params,
        ...(fundingTarget === undefined ? {} : { fundingTarget }),
        successWhen: successFor(chosen, rung.level, stockTarget),
        abortWhen: { minutesExceed: abortMinutes },
        expectedDurationMin: Math.min(abortMinutes, 60),
        rationale: String(args.rationale ?? 'no rationale given'),
      },
    });

    return [
      `Queued: ${chosen.label}`,
      // The criteria as queued, not a level read off an argument that a stock
      // objective never used. This line said `Target: level NaN` for every
      // stock objective ever set, in the confirmation the caller reads to check
      // they got what they asked for.
      `Target: ${describeCriteria(successFor(chosen, rung.level, stockTarget))}, abort after ${abortMinutes}min.`,
      ...(rung.note === null ? [] : [rung.note]),
      ...(sized.note === null ? [] : [sized.note]),
      ...commitmentWarning(store.report, args.urgent === true),
      "Applies on the mod's next report.",
    ].join(NEWLINE);
  },

  async set_plan(args, { store, memoryRoot }) {
    const candidates = store.report?.candidates ?? [];
    const steps = Array.isArray(args.steps) ? args.steps : [];

    if (steps.length === 0) {
      // Both shapes, at the point of use.
      //
      // This string named only the level-shaped one, so at the single moment a
      // caller is looking for the parameter list, half the tool was invisible.
      // Every goal and every plan step this run has ever set has been
      // level-shaped, and `untilItemId`/`untilQuantity` have been accepted the
      // whole time -- one plan went out as "craft Mind Runes to Runecrafting
      // 49", a level target for a stock problem, which would have stopped at
      // whatever rune count level 49 happened to land on.
      return [
        'Pass steps: [{candidateIndex, abortMinutes, rationale, and a target}, ...] — a plan of 2 to 8 objectives.',
        'A target is one of two shapes, and the step should carry whichever matches what it is for:',
        '  - targetLevel — for training. The step ends at a skill level.',
        '  - untilItemId + untilQuantity — for producing. The step ends when the bank holds that many.',
        'Training toward a level goal wants a level; producing an input something else consumes wants a stock count, because a level target either stops short of the count the next step needs or runs hours past it. They are not exclusive — a step that crafts runes trains Runecrafting too — so pick the one that names the thing you actually want, and read each candidate for a "would fill a shortfall" line, which carries an item and a number ready to pass here.',
      ].join(NEWLINE);
    }

    // Read once for the whole plan rather than per step: it is the operator's
    // standing goal, not a property of any one step, and re-reading it per step
    // would let a six-step plan carry six different authorisations.
    const fundingTarget = await fundingTargetFor(memoryRoot, store.report?.snapshot ?? null);

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
      const requestedStock =
        stepItemId !== undefined && Number.isFinite(stepQuantity) && stepQuantity > 0
          ? { itemId: stepItemId, quantity: stepQuantity }
          : undefined;

      // Sized against the two ceilings a count has, on exactly the terms the
      // level path is sized on -- and only for the first step, for the same
      // reason. What is banked and what a step can reach are both read off the
      // character as it stands now, and by the time step three runs its inputs
      // are whatever step two produced or consumed. Projecting that far would
      // be arithmetic dressed up as foresight, and worse here than for a level:
      // a level cannot go down, and a stock can.
      const stockRung =
        requestedStock === undefined || position > 0
          ? { quantity: requestedStock?.quantity ?? 0, note: null }
          : stockRungFor(chosen, requestedStock, abortMinutes, store.report?.snapshot);
      if (stockRung.note !== null) notes.push(`step ${position + 1}: ${stockRung.note}`);

      const stepStock =
        requestedStock === undefined
          ? undefined
          : { itemId: requestedStock.itemId, quantity: stockRung.quantity };

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

      const stepCriteria = successFor(chosen, stepRung.level, stepStock);

      // A step already satisfied when the plan is queued is not a short rung,
      // it is a no-op, and a plan made of them empties without the agent doing
      // anything at all.
      //
      // Observed twice. A three-step plan asked for Cooking 44 and Fishing 40
      // while Cooking was already 44 and Fishing 42 — the levels had risen since
      // the listing those targets were read off. Both steps completed on their
      // first tick, the plan drained in nine seconds ("plan set: 3 objectives"
      // at 6:13:23, "plan advanced (0 left)" at 6:13:32), and the agent fell
      // through to a stopgap. `rungFor` had the signal and did not use it: it
      // projected "~0min" and called that a short rung.
      //
      // Refused rather than raised. `rungFor` argues at length that lifting a
      // target inside the budget would mean grinding further than the caller
      // chose, "which is not a correction to make on someone's behalf", and
      // that reasoning holds here with more force, not less: the caller read a
      // stale level and every number they might have raised it *to* is equally
      // stale. What they need back is the current figure, which the refusal
      // names, so the retry is a decision rather than a second guess.
      const noOp = noOpReason(
        store.report?.snapshot ?? null,
        stepCriteria,
        position === 0 ? 'immediately' : 'later',
      );
      if (noOp !== null) {
        return `Refused: step ${position + 1} (${chosen.label}) — ${noOp}, so it would complete without acting and drain the plan. Pick a target above the figure named, or drop the step.`;
      }

      objectives.push({
        id: `plan-${Date.now()}-${position}`,
        kind: chosen.kind,
        params: chosen.params,
        ...(fundingTarget === undefined ? {} : { fundingTarget }),
        successWhen: stepCriteria,
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
 * Sizes a requested stock target against what the candidate can actually make.
 *
 * The exact counterpart of {@link rungFor}, and it exists because the asymmetry
 * between the two shapes was a live bug. A level target is sized against the
 * rate and the budget; a stock target was sized against nothing at all --
 * `set_objective` skips `rungFor` outright when one is given, because a stock
 * target has no level to clamp. So the one shape the tools were being taught to
 * use first-class was the one shape with no guard, which is a good part of why
 * it stayed unused: the first caller to try it gets an objective that silently
 * never finishes.
 *
 * Measured live: `untilQuantity: 10000` for Mind Runes, against a bank holding
 * 1,347 Rune Essence at a yield of four runes per essence. The ceiling was
 * about 5,400 and the objective would have run its full 90 minute abort and
 * completed nothing -- exactly the outcome `rungFor` argues against, since an
 * objective that completes "produces a journal entry, a replan and a measured
 * rate, while one that times out produces an abandonment and teaches nothing".
 *
 * Two ceilings, and they are different questions:
 *
 * - **The budget.** `perHour` for `abortMinutes`. The same clamp `rungFor`
 *   applies to a level.
 * - **The materials.** `sustainMinutes` is how long the banked inputs last, so
 *   production stops there whatever the budget says. Absent means no ceiling,
 *   not an unknown one -- a gathering action consumes nothing and is limited
 *   only by time. Note this is *not* "inputs held divided by inputs per craft":
 *   Runecrafting yields four Mind Runes per essence at this mastery, so a naive
 *   count would have been wrong by a factor of four in the pessimistic
 *   direction. `perHour` comes from the mod's `productYieldFor`, which samples
 *   the game's own rolling accessor until it can identify the un-doubled
 *   quantity, so the multiplier is measured rather than assumed.
 *
 * Clamped down, never up, and reported -- the same one-directional rule and for
 * the same reason. Silent about a target it cannot judge: no `produces` means
 * the candidate banks nothing identifiable, and a clamp derived from no rate
 * would be a guess wearing a measurement's clothes.
 *
 * @returns The quantity to commit to, and a line for the caller when it differs
 *          from the request.
 */
function stockRungFor(
  candidate: {
    label: string;
    produces?: { itemId: string; name: string; perHour: number } | undefined;
    sustainMinutes?: number | undefined;
  },
  stockTarget: { itemId: string; quantity: number },
  abortMinutes: number,
  snapshot: StateSnapshot | null | undefined,
): { quantity: number; note: string | null } {
  const produces = candidate.produces;
  if (produces === undefined || produces.itemId !== stockTarget.itemId) {
    return { quantity: stockTarget.quantity, note: null };
  }
  if (!(produces.perHour > 0)) return { quantity: stockTarget.quantity, note: null };

  const have = snapshot?.bank.items.find((item) => item.id === stockTarget.itemId)?.qty ?? 0;

  // The binding ceiling is whichever runs out first. `sustainMinutes` is
  // absent for anything that consumes nothing, and absent is "no limit" —
  // see the field's own note on the candidate schema.
  const materialMinutes = candidate.sustainMinutes ?? Number.POSITIVE_INFINITY;
  const minutes = Math.min(abortMinutes, materialMinutes);
  const reachable = Math.floor(have + (produces.perHour * minutes) / 60);

  if (reachable >= stockTarget.quantity) return { quantity: stockTarget.quantity, note: null };

  // Nothing to clamp *to*. Below one unit above what is already banked there is
  // no target that both fits and asks for work, and a refusal naming the
  // ceiling is more use than a target of `have` that the no-op guard would
  // reject a line later for a reason that sounds unrelated.
  if (reachable <= have) {
    return {
      quantity: stockTarget.quantity,
      note: `WARNING: ${candidate.label} cannot reach ${stockTarget.quantity.toLocaleString()}x ${produces.name} — at ${Math.round(produces.perHour).toLocaleString()}/h it produces under one unit in the ${Math.round(minutes)}min available${describeBinding(abortMinutes, materialMinutes)}. This objective will abort rather than complete.`,
    };
  }

  return {
    quantity: reachable,
    note: `Target lowered from ${stockTarget.quantity.toLocaleString()} to ${reachable.toLocaleString()}x ${produces.name}: ${candidate.label} produces about ${Math.round(produces.perHour).toLocaleString()}/h, and ${Math.round(minutes)}min is all that is available${describeBinding(abortMinutes, materialMinutes)}, against ${have.toLocaleString()} banked. The original target would have run the whole budget and completed nothing. Raise abortMinutes, or gather more input first, if you meant the larger figure.`,
  };
}

/** Which of the two ceilings bound the run, so the caller knows what to change. */
function describeBinding(abortMinutes: number, materialMinutes: number): string {
  if (!Number.isFinite(materialMinutes)) return ` (the ${abortMinutes}min budget)`;
  return materialMinutes < abortMinutes
    ? ` (the banked inputs last about ${Math.round(materialMinutes)}min, less than the ${abortMinutes}min budget)`
    : ` (the ${abortMinutes}min budget, inside the ${Math.round(materialMinutes)}min the banked inputs last)`;
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
 * The town, in the terms a decision about it is actually made in.
 *
 * Nothing rendered the town here before, so the whole of Township reached a
 * planning session as build candidates near the bottom of `list_candidates`,
 * and the operator's stated first priority had no line in the state summary at
 * all.
 *
 * Three facts, chosen because each has an action behind it:
 *
 * - **Storage.** A full town discards everything it produces, so a town at
 *   100% earns nothing per hour however many buildings it has.
 * - **What it pays.** Township XP per hour and GP per hour, so a build can be
 *   weighed against a fishing rate instead of against a wall of prose.
 * - **Happiness, with its consequence spelled out.** The number alone reads as
 *   decoration and was treated as decoration for the entire run. It is a
 *   percentage bonus on population, and population is both the XP rate and the
 *   figure the town taxes GP from — so every point is +1% of both, forever.
 *   Zero is stated as a foregone multiplier rather than as a fault, because the
 *   town is not decaying at zero: it is running at exactly 1.0x.
 *
 * Health is named only when it is costing something. It decays on its own and
 * cannot exceed 100, so a line reporting 100% every read would be the sort of
 * per-pass wallpaper that has twice buried a real diagnostic here.
 */
function renderTown(town: StateSnapshot['township'] | undefined): string[] {
  // Undefined as well as null, and not because the schema allows it -- it
  // defaults to null. A report from a mod build older than this field arrives
  // without the key at all, and the rule this file already follows for
  // `adapterFailures` applies: a missing field must cost one line of the
  // summary, never the whole summary.
  if (town === null || town === undefined) return [];

  const storagePercent =
    town.storageMax > 0 ? Math.round((town.storageUsed / town.storageMax) * 100) : 0;

  const lines = [
    `Town: Township ${town.level}, population ${Math.round(town.population).toLocaleString()}, storage ${storagePercent}% (${Math.round(town.storageUsed).toLocaleString()}/${town.storageMax.toLocaleString()})`,
  ];

  const economy = town.economy ?? null;
  if (economy === null) {
    // An older mod build reports no economy. Saying so beats printing nothing,
    // because the absence otherwise reads as "the town pays nothing".
    lines.push(
      '  Town output: not reported — the running mod build predates it; reload the game to get it.',
    );
    return lines;
  }

  if (economy.modelMismatch !== null) {
    lines.push(
      `  Town output: UNRELIABLE — the adapter's population model disagrees with the game (${economy.modelMismatch}). Treat every build's advertised value as unproven.`,
    );
    return lines;
  }

  lines.push(
    `  Town output: ${Math.round(economy.xpPerHour).toLocaleString()} Township xp/h and ${Math.round(economy.gpPerHour).toLocaleString()} GP/h, unattended and costing no action slot`,
  );

  // Why the GP half is zero, when it is.
  //
  // The first version of this line reported "0 GP/h" and nothing else, and it
  // read as a fault: the town has 165 working citizens and the formula is
  // `currentPopulation * GP_PER_CITIZEN * (taxRate / 100)`, so the only term
  // that can zero it is the tax rate — which sounds exactly like a slider
  // somebody left at zero for the life of the character. There is no slider.
  // `BASE_TAX_RATE` is 0 and the rate is entirely the `townshipTaxPerCitizen`
  // modifier, supplied by a building the town is nowhere near being able to put
  // up. The zero is structural and correct.
  //
  // So this is not an alarm that fires every pass for a normal condition; it is
  // the opposite. An unexplained zero *invites* the investigation on every read,
  // and it has already cost one. Naming the cause is what makes the line cheap.
  const tax = economy.tax;
  if (tax !== undefined && tax.rate === 0) {
    const source = tax.unbuiltSource;
    lines.push(
      source === null
        ? // Honest about the gap rather than repeating the diagnosis from
          // memory: if no registered building supplies the modifier, something
          // has changed and the explanation above no longer applies.
          '  0 GP/h because the town tax rate is 0, and no building the game registers supplies it — the usual cause no longer applies, so this one is worth looking at.'
        : `  0 GP/h is structural, not a setting left wrong: the tax rate is 0% and there is nothing to set it with. It is entirely the townshipTaxPerCitizen modifier, and ${source.name} (tier ${source.tier}, +${source.perBuilding}% each) is the only building that supplies it — gated on Township ${source.requiresTownshipLevel} and ${source.requiresPopulation.toLocaleString()} population. Until then the town pays XP and no GP however many citizens it has.`,
    );
  }

  // What a point of happiness is worth, in the terms that are actually true
  // right now.
  //
  // This said "+1% of both figures above" and that was an overstatement the
  // moment the tax finding landed: one percent of a zero GP rate is zero, so
  // while the town is untaxed happiness buys Township XP and nothing else. The
  // claim is scoped to whichever figures the town is really being paid in
  // rather than restated from the formula, because a rate that is right in
  // general and wrong today is the kind of number this repo keeps planning
  // hours around.
  const paidInGp = tax === undefined || tax.rate > 0;
  const bothFigures = paidInGp ? 'both figures above' : 'the XP figure above (the GP one is 0)';
  lines.push(
    economy.happiness === 0
      ? `  Happiness 0: not a fault, a foregone multiplier. Happiness is a percentage bonus on population, and population is what the Township XP rate is measured in — so the town is running at exactly 1.0x, and every +1 happiness is +1% of ${bothFigures}, permanently. Buildings that provide it say so in their build candidate.`
      : `  Happiness ${economy.happiness}: +${economy.happiness}% population, which is +${economy.happiness}% on ${bothFigures}`,
  );

  if (economy.health < 100) {
    lines.push(
      `  Health ${economy.health}%: the town is producing at ${economy.health}% of what it could. It decays on its own and is restored by spending a town resource.`,
    );
  }

  return lines;
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
  return describeCriteria(objective.successWhen);
}

/**
 * A finish line in the shape it was actually written in.
 *
 * Extracted from {@link describeTarget} because `set_objective` was printing
 * `Target: level NaN` for every stock objective it queued. The level was never
 * read for a stock target -- the branch above deliberately skips `rungFor` --
 * so the confirmation was reporting a number nothing had computed, live, at the
 * one moment a caller can still tell they meant something else. A tool whose
 * confirmation cannot name the thing it just did teaches the caller that the
 * shape does not really work, which is a fair summary of why the stock path sat
 * unused with every layer beneath it built.
 */
function describeCriteria(criteria: readonly SuccessCriterion[]): string {
  const described = criteria.map((criterion) => {
    switch (criterion.type) {
      case 'skill_level_at_least':
        return `to level ${criterion.level}`;
      case 'item_qty_at_least':
        return `until the bank holds ${criterion.qty.toLocaleString()}x ${criterion.itemId}`;
      case 'currency_at_least':
        return `until ${criterion.amount.toLocaleString()} ${criterion.currencyId}`;
    }
  });
  return described.length === 0 ? 'one-shot' : described.join(', ');
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
    suggestedStock?: { itemId: string; name: string; quantity: number; why: string } | undefined;
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

  // The stock figure something else is short of, on the candidate that makes
  // it. This is the sentence the blocked list has been printing for months --
  // "needs Earth Rune 1/3", with the producer named -- turned into a number
  // and a parameter, so it can be passed to untilQuantity instead of invented.
  //
  // Phrased as an offer rather than an instruction: which producer to run, and
  // whether to produce at all, is the caller's decision. See `suggestedStock`
  // on the candidate schema.
  const suggested = candidate.suggestedStock;
  if (suggested !== undefined) {
    parts.push(
      `STOCK SHORTFALL: pass untilItemId "${suggested.itemId}", untilQuantity ${suggested.quantity} to run this until the bank holds ${suggested.quantity.toLocaleString()}x ${suggested.name} (${suggested.why})`,
    );
  }

  return parts.join(' — ');
}

/** Success criterion for a chosen candidate; skill kinds use the caller's target. */
/**
 * Whether an objective's criteria are satisfied before it has done anything.
 *
 * The check is at the criterion level rather than at the level target, because
 * the shape being caught is not "the level was wrong" — it is "this objective
 * has nothing to do". `item_qty_at_least` for a stack already banked drains a
 * plan exactly as `skill_level_at_least` for a level already passed does, and a
 * guard written around levels alone would have to be written again the next
 * time `successFor` learns to emit something new.
 *
 * `when` is what keeps the check from breaking the case the plan tool
 * advertises. A step behind another step does not start now, and its criteria
 * are judged against a character that has since done the work in front of it —
 * "mine 200 Gold Ore, then smelt" is precisely a plan whose second step
 * consumes what its first produced, so a stock target met today can be real
 * work tomorrow. Only criteria that cannot regress are decidable that far
 * ahead; see {@link isMonotonicCriterion}. Anything else is left to the moment
 * the step actually starts, where the mod's own completion test reads it.
 *
 * @param snapshot - The observation to judge against; null means no judgement.
 * @param criteria - The criteria as they would be queued.
 * @param when - Whether the objective starts on the mod's next report, or only
 *   after the steps ahead of it have run.
 * @returns A reason to refuse, naming the readings, or null.
 */
function noOpReason(
  snapshot: StateSnapshot | null,
  criteria: readonly SuccessCriterion[],
  when: 'immediately' | 'later',
): string | null {
  if (snapshot === null) return null;

  // An empty list is a one-shot — buying, equipping, toggling — whose executor
  // decides when it is done. It is the *opposite* of a no-op: nothing here can
  // say whether it has work to do, and refusing it would refuse every purchase.
  if (criteria.length === 0) return null;

  if (when === 'later' && !criteria.every(isMonotonicCriterion)) return null;

  const readings = criteria.map((criterion) => describeSatisfied(snapshot, criterion));
  if (readings.some((reading) => reading === null)) return null;

  return readings.join('; and ');
}

/**
 * The currency goal an objective should be allowed to sell surplus toward.
 *
 * Read from `GOALS.md` rather than asked of the caller, deliberately. A sale is
 * the one irreversible thing the agent does, so what authorises it must be a
 * number the operator wrote down — not a threshold this repo invented, and not
 * something a planning session has to remember to pass. Sessions forget: the
 * whole reason this exists is that GP sat frozen for hours while an operator
 * re-issued a `Sell` objective by hand four times, each one eating a plan step.
 *
 * The **nearest** unmet goal, by target, so the authorisation is the smallest
 * one that is currently true. With Auto Eat at 1,000,000 and nothing nearer,
 * that is 1,000,000; with a 50,000 rung still open it is 50,000, and the agent
 * stops there rather than selling on toward a destination it has not reached
 * the first step of.
 *
 * Only `active` goals. A `done` goal authorises nothing because it is finished,
 * and a `blocked` one authorises nothing because the operator's own ordering
 * says it is not the work in front of the agent yet.
 *
 * @returns The goal to fund, or undefined — which leaves the objective with no
 *          funding target at all, and the mod then never sells for money.
 */
async function fundingTargetFor(
  memoryRoot: string,
  snapshot: StateSnapshot | null,
): Promise<{ goalId: string; currencyId: string; amount: number } | undefined> {
  // No snapshot means no evaluation: `evaluateGoals` measures against one, and
  // a goal that cannot be measured cannot be shown to be unmet.
  if (snapshot === null) return undefined;

  const statuses = evaluateGoals(await loadGoals(memoryRoot), snapshot);

  let nearest: { goalId: string; currencyId: string; amount: number } | undefined;
  for (const status of statuses) {
    if (status.state !== 'active') continue;
    const done = status.goal.done;
    if (done?.type !== 'currency_at_least') continue;
    if (nearest !== undefined && done.amount >= nearest.amount) continue;

    nearest = { goalId: status.goal.id, currencyId: done.currencyId, amount: done.amount };
  }

  return nearest;
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

  // A fight has no `skillId`, and until now that dropped it through to the `[]`
  // below — the branch written for one-shot sales and purchases. `targetLevel:
  // 22` was accepted and discarded without a word, the objective was queued
  // with `successWhen: []`, and the confirmation described it as "one-shot".
  //
  // A fight is the opposite of one-shot. It is the *only* way this character
  // can reach `hp-40`, `defence-20` or `prayer-20`, and it trains for as long
  // as it runs.
  //
  // Hitpoints rather than the attack style's own skill, deliberately. Every
  // fight trains Hitpoints whatever the style; which of Attack, Strength,
  // Defence, Ranged or Magic it also trains depends on the equipped weapon and
  // the selected attack style, and the candidate carries neither. Naming one
  // would be guessing at a fact the planner cannot see, and this repo has paid
  // for guessed ids before. Hitpoints is the criterion that is true by
  // construction.
  if (isCombatKind(candidate.kind)) {
    return [{ type: 'skill_level_at_least' as const, skillId: HITPOINTS_ID, level: targetLevel }];
  }

  // A sale or purchase has no level to reach, and the obvious stand-in — "have
  // at least 1 GP" — is already true, so the objective completed before it ever
  // acted. No criterion at all is the honest answer: the executor knows when a
  // one-shot transition is done, and nothing else does.
  return [];
}

/** Hitpoints, the one skill every fight trains regardless of attack style. */
const HITPOINTS_ID = 'melvorD:Hitpoints';

/** Objective kinds that run a fight, and therefore train Hitpoints. */
function isCombatKind(kind: string): boolean {
  return kind === 'fight_monster' || kind === 'run_dungeon';
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

  const info = readBuildInfo();
  if (info === null) return '';

  const built = parseBuildInfo(info);
  if (!isNewerBuild(built, running)) return '';

  return ` — NEWER BUILD WAITING (${built}); reload to pick it up`;
}

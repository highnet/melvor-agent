import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Candidate, type StateSnapshot, xpForLevel } from '@melvor-agent/shared';

/**
 * Long-horizon goals, and what currently advances them.
 *
 * A flat candidate list makes greed the only available strategy. Every replan
 * starts from the same menu of rates with no memory of intent, so the best
 * available answer is always "the biggest number right now" — and that is how
 * an agent ends up cutting trees to burn them for hours while its GP stays at
 * zero and combat stays locked behind an Auto Eat it never saves for.
 *
 * Goals fix that by giving each candidate a *reason* beyond its rate. The
 * planner still chooses among things the mod has proven it can do — that safety
 * property is untouched — but each option now carries which goal it serves and
 * how far along that goal is. "13,500 xp/h" and "13,500 xp/h, and it is the only
 * thing funding the Auto Eat that unlocks combat" are different decisions.
 *
 * Goals are a DAG, not a list: a goal blocked by an unmet prerequisite is not
 * offered, so the agent works on reachable things rather than stalling against
 * a wall. Terminal goals are operator-authored — this file only reads them.
 */

/** A condition checkable against a snapshot. No model judgement involved. */
export type GoalCondition =
  | { type: 'skill_level_at_least'; skillId: string; level: number }
  | { type: 'currency_at_least'; currencyId: string; amount: number }
  | { type: 'item_qty_at_least'; itemId: string; qty: number }
  | { type: 'total_level_at_least'; level: number };

export interface Goal {
  id: string;
  description: string;
  /** Goal ids that must be complete first. Blocks this one until they are. */
  requires?: string[];
  /**
   * When this holds, the goal is done.
   *
   * Optional: a goal written as prose with no machine-checkable condition is
   * still useful intent for the planner. It is reported as unmeasurable rather
   * than assumed incomplete, because those are different things.
   */
  done?: GoalCondition;
  /**
   * What moves this goal forward: skill ids, and/or the literal `"gp"` for
   * anything that earns money. Used to tag candidates with the goal they serve.
   */
  advancedBy?: string[];
}

export type GoalStatus =
  | { goal: Goal; state: 'done'; detail: string }
  | { goal: Goal; state: 'blocked'; detail: string }
  | { goal: Goal; state: 'active'; detail: string; progress: number };

/**
 * Reads `GOALS.md`.
 *
 * Markdown rather than JSON because goals are something the operator writes, and
 * the rest of the memory surfaces (`USER.md`, `MEMORY.md`) are already prose.
 * One file, editable in any text editor, no syntax to get wrong.
 *
 * Completion still has to be *deterministic* — a model that decides for itself
 * whether it has finished something will decide it has. So machine-checkable
 * conditions ride along in HTML comments, the same convention the memory design
 * uses for triggers and importance:
 *
 * ```markdown
 * - Own Auto Eat so combat is possible.
 *   <!-- done: currency melvorD:GP >= 50000 --> <!-- advances: gp -->
 * - Woodcutting to 50 for better logs.
 *   <!-- done: skill melvorD:Woodcutting >= 50 --> <!-- advances: melvorD:Woodcutting -->
 * - Unlock a second combat style. <!-- requires: auto-eat -->
 * ```
 *
 * A goal with no `done:` annotation is still read by the planner as intent — it
 * simply cannot be measured, and is reported as such rather than guessed at.
 * That is the honest failure mode: unmeasurable is not the same as incomplete.
 *
 * Absent or malformed means "no goals", never an error.
 */
export async function loadGoals(root: string): Promise<Goal[]> {
  let body: string;
  try {
    body = await readFile(join(root, 'GOALS.md'), 'utf8');
  } catch {
    return [];
  }

  const goals: Goal[] = [];

  for (const line of body.split('\n')) {
    const trimmed = line.trim();

    // Annotations may sit on continuation lines beneath the bullet. Three
    // annotations do not fit on one readable line, and a file meant to be
    // edited by hand has to tolerate wrapping — silently dropping a wrapped
    // `done:` makes every goal unmeasurable, which looks identical to the
    // parser working and the goals simply being vague.
    if (!trimmed.startsWith('- ') && trimmed.startsWith('<!--')) {
      const previous = goals[goals.length - 1];
      if (previous !== undefined) {
        const carried = parseCondition(annotation(trimmed, 'done'));
        const alsoRequires = splitList(annotation(trimmed, 'requires'));
        const alsoAdvances = splitList(annotation(trimmed, 'advances'));
        const explicitId = annotation(trimmed, 'id');

        if (carried !== null) previous.done = carried;
        if (alsoRequires.length > 0) {
          previous.requires = [...(previous.requires ?? []), ...alsoRequires];
        }
        if (alsoAdvances.length > 0) {
          previous.advancedBy = [...(previous.advancedBy ?? []), ...alsoAdvances];
        }
        if (explicitId !== null) previous.id = explicitId;
      }
      continue;
    }

    if (!trimmed.startsWith('- ')) continue;

    // Everything before the first annotation is the human-readable intent.
    const description = trimmed.slice(2).split('<!--')[0]?.trim() ?? '';
    if (description === '') continue;

    const done = parseCondition(annotation(trimmed, 'done'));
    const requires = splitList(annotation(trimmed, 'requires'));
    const advancedBy = splitList(annotation(trimmed, 'advances'));

    goals.push({
      id: annotation(trimmed, 'id') ?? slug(description),
      description,
      ...(requires.length > 0 ? { requires } : {}),
      ...(advancedBy.length > 0 ? { advancedBy } : {}),
      ...(done === null ? {} : { done }),
    });
  }

  return goals;
}

/** Reads one `<!-- key: value -->` annotation from a line. */
function annotation(line: string, key: string): string | null {
  // `[^>]` is the obvious character class here and is wrong: every condition
  // contains `>=`, so the match could never reach the closing `-->` and every
  // goal parsed as unmeasurable — indistinguishable from goals written without
  // conditions at all, which is why it survived unnoticed.
  const pattern = new RegExp(`<!--\\s*${key}\\s*:\\s*(.*?)\\s*-->`, 'i');
  const match = pattern.exec(line);
  return match === null ? null : (match[1] ?? '').trim();
}

function splitList(value: string | null): string[] {
  if (value === null) return [];
  return value
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** A stable id derived from the text, so most goals need no explicit one. */
function slug(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/**
 * Parses a condition annotation.
 *
 * Deliberately a tiny grammar — `skill <id> >= <n>`, `currency <id> >= <n>`,
 * `item <id> >= <n>`, `total >= <n>`. Anything else is unparseable and the goal
 * becomes unmeasurable rather than silently wrong.
 */
function parseCondition(value: string | null): GoalCondition | null {
  if (value === null) return null;

  const match = /^(skill|currency|item|total)\s*(\S+)?\s*>=\s*(\d+)$/i.exec(value.trim());
  if (match === null) return null;

  const [, kind, id, amountText] = match;
  const amount = Number(amountText);

  switch ((kind ?? '').toLowerCase()) {
    case 'skill':
      return id === undefined ? null : { type: 'skill_level_at_least', skillId: id, level: amount };
    case 'currency':
      return id === undefined ? null : { type: 'currency_at_least', currencyId: id, amount };
    case 'item':
      return id === undefined ? null : { type: 'item_qty_at_least', itemId: id, qty: amount };
    case 'total':
      return { type: 'total_level_at_least', level: amount };
    default:
      return null;
  }
}

/**
 * Appends a goal proposed by the agent.
 *
 * `GOALS.md` is machine-editable as well as human-editable, but not
 * symmetrically. The agent may *propose* a goal; it may not decide one is
 * finished, and it may not quietly rewrite what the operator wrote:
 *
 * - Appends only. An existing line is never touched, so a goal you wrote
 *   cannot be reworded, weakened, or deleted by the agent.
 * - Proposals are marked `<!-- proposed: <iso> -->`, so a glance at the file
 *   separates your intent from the agent's suggestions.
 * - Completion is still measured by {@link evaluateGoals} against the snapshot.
 *   Writing "done" into the file changes nothing.
 *
 * That asymmetry is the same one the memory design uses: the agent contributes
 * evidence and suggestions, and the deterministic layer decides what they mean.
 *
 * @param root - Workspace directory.
 * @param description - The goal, in plain language.
 * @param condition - Optional machine-checkable completion, e.g.
 *                    `skill melvorD:Woodcutting >= 50`. Unparseable conditions
 *                    are written as prose so the goal is unmeasurable rather
 *                    than silently wrong.
 * @param advances - Skill ids, or `gp`, that move this goal forward.
 */
export async function proposeGoal(
  root: string,
  description: string,
  condition?: string,
  advances?: string[],
): Promise<void> {
  const flat = description.replace(/\s*\n\s*/g, ' ').trim();

  const parts = [`- ${flat}`];
  if (condition !== undefined && condition.trim() !== '') {
    parts.push(`<!-- done: ${condition.trim()} -->`);
  }
  if (advances !== undefined && advances.length > 0) {
    parts.push(`<!-- advances: ${advances.join(', ')} -->`);
  }
  parts.push(`<!-- proposed: ${new Date().toISOString()} -->`);

  const path = join(root, 'GOALS.md');
  let existing = '';
  try {
    existing = await readFile(path, 'utf8');
  } catch {
    existing = [
      '# Goals',
      '',
      '<!--',
      '  Long-horizon goals for the planning agent. Plain markdown; one goal per',
      '  bullet. Annotations in HTML comments make completion machine-checkable:',
      '',
      '    <!-- done: skill melvorD:Woodcutting >= 50 -->',
      '    <!-- done: currency melvorD:GP >= 50000 -->',
      '    <!-- advances: melvorD:Woodcutting, gp -->',
      '    <!-- requires: some-other-goal-id -->',
      '',
      '  A goal with no `done:` is read as intent but cannot be measured.',
      '  The agent may append proposals; it never edits or completes your lines.',
      '-->',
      '',
    ].join('\n');
  }

  const separator = existing.endsWith('\n') || existing === '' ? '' : '\n';
  await appendFile(path, `${separator}${parts.join(' ')}\n`, 'utf8');
}

/**
 * The next rung on the ladder toward a goal.
 *
 * Two failure modes sit either side of good planning, and they need different
 * fixes:
 *
 * - **Milestones that are too far** ("Woodcutting 99") never complete, so the
 *   agent gets no feedback for days. Nothing tells it the approach is working or
 *   wrong, the journal records one endless attempt, and every replan re-litigates
 *   the same distant target from scratch.
 * - **Objectives that are too near** ("+1 level") complete constantly, so the
 *   agent spends its time replanning instead of playing, and thrashes between
 *   skills because each new decision is made fresh with no commitment.
 *
 * The resolution is to stop conflating them. A **goal** is direction and stays
 * far away. An **objective** is a rung, sized to finish inside one planning
 * horizon. The planner keeps proposing rungs toward a goal it has already
 * committed to, rather than re-picking a destination every few minutes.
 *
 * This computes the rung: the highest level reachable in roughly
 * `budgetMinutes` at `xpPerHour`, clamped so it is always at least one level of
 * progress and never overshoots the goal itself.
 *
 * @param currentLevel - Where the skill is now.
 * @param currentXp - Total XP in that skill.
 * @param goalLevel - The distant target the goal names.
 * @param xpPerHour - Measured rate for the candidate under consideration.
 * @param budgetMinutes - How long one objective should plausibly run.
 * @returns The rung to aim at, and the estimate behind it.
 */
export function nextRung(
  currentLevel: number,
  currentXp: number,
  goalLevel: number,
  xpPerHour: number,
  budgetMinutes: number,
): { level: number; estimatedMinutes: number } {
  if (currentLevel >= goalLevel) {
    return { level: goalLevel, estimatedMinutes: 0 };
  }
  if (xpPerHour <= 0) {
    return { level: Math.min(goalLevel, currentLevel + 1), estimatedMinutes: Number.NaN };
  }

  const affordableXp = (xpPerHour * budgetMinutes) / 60;

  let level = currentLevel;
  while (level < goalLevel && xpForLevel(level + 1) - currentXp <= affordableXp) {
    level += 1;
  }

  // Always advance: a rung that does not move is not a rung, and an objective
  // that is already satisfied completes instantly and burns a planning call.
  const target = Math.min(goalLevel, Math.max(level, currentLevel + 1));
  const neededXp = Math.max(0, xpForLevel(target) - currentXp);

  return { level: target, estimatedMinutes: (neededXp / xpPerHour) * 60 };
}

/**
 * The rung to actually aim at, given a target somebody asked for.
 *
 * {@link nextRung} was exported, imported and never called, so every target
 * level was a guess — and the two failure modes its doc comment describes were
 * both live. A target too far always ends in `abortMinutes`, which records an
 * abandonment rather than a completion and teaches the journal nothing; a
 * target too near completes in minutes and spends the hour replanning.
 *
 * So the requested level is checked against the rate and the budget before it
 * is committed to:
 *
 * - `clamped` — unreachable in the budget. The level is lowered to what fits,
 *   because an objective that finishes is worth more than one that times out.
 * - `short` — reachable with time to spare, which is where thrash comes from.
 *   Reported, never raised: grinding further than asked is the caller's call.
 * - `fits` — the requested level is about a budget's worth of work.
 *
 * @param currentLevel - Where the skill is now.
 * @param currentXp - Total XP in that skill.
 * @param requestedLevel - The level the caller asked for.
 * @param xpPerHour - The candidate's advertised rate.
 * @param budgetMinutes - The objective's abort budget.
 * @param maxLevel - Ceiling for the reachability probe; the tool caps at 120.
 */
export function planRung(
  currentLevel: number,
  currentXp: number,
  requestedLevel: number,
  xpPerHour: number,
  budgetMinutes: number,
  maxLevel = 120,
): { level: number; estimatedMinutes: number; fit: 'fits' | 'clamped' | 'short' } {
  // No rate means nothing can be projected. Saying so beats inventing a
  // number, and a candidate with no xpPerHour is usually a one-shot action
  // whose target level is ignored anyway.
  if (!Number.isFinite(xpPerHour) || xpPerHour <= 0) {
    return { level: requestedLevel, estimatedMinutes: Number.NaN, fit: 'fits' };
  }

  // How far the budget actually reaches, asked without the requested level in
  // the way — `nextRung` clamps to the goal it is given, so passing the
  // request would make every request look exactly reachable.
  const reachable = nextRung(currentLevel, currentXp, maxLevel, xpPerHour, budgetMinutes);

  if (reachable.level < requestedLevel) {
    return { level: reachable.level, estimatedMinutes: reachable.estimatedMinutes, fit: 'clamped' };
  }

  const minutes = ((xpForLevel(requestedLevel) - currentXp) / xpPerHour) * 60;
  return {
    level: requestedLevel,
    estimatedMinutes: Math.max(0, minutes),
    fit: reachable.level > requestedLevel ? 'short' : 'fits',
  };
}

/**
 * Evaluates every goal against the current state.
 *
 * Deterministic: whether a goal is done, blocked or active is arithmetic, and
 * the model never gets to decide it has finished something it has not.
 */
export function evaluateGoals(goals: readonly Goal[], snapshot: StateSnapshot): GoalStatus[] {
  const done = new Set<string>();
  const measurable = new Set<string>();

  // Two passes so a goal can depend on one declared after it.
  for (const goal of goals) {
    if (goal.done === undefined) continue;
    measurable.add(goal.id);
    if (measure(goal.done, snapshot).satisfied) done.add(goal.id);
  }

  return goals.map((goal): GoalStatus => {
    const required = goal.requires ?? [];
    // A prerequisite with no `done:` -- or one naming a goal id that does not
    // exist -- can never enter `done`, so enforcing it blocks every dependent
    // for the life of the file. The prerequisite may well be finished; nothing
    // can say. Unmeasurable and unmet are different states and only the second
    // is a reason to withhold work, so the first is reported and stepped over.
    const unmet = required.filter((id) => measurable.has(id) && !done.has(id));
    const unverifiable = required.filter((id) => !measurable.has(id));

    const measured = goal.done === undefined ? null : measure(goal.done, snapshot);
    if (measured?.satisfied === true) {
      return { goal, state: 'done', detail: measured.detail };
    }

    // Checked before the unmeasurable case below, not after it. A goal with no
    // `done:` used to return `active` immediately, so `requires:` was ignored
    // for exactly the goals whose prose the operator could not pin down — the
    // ones most likely to need ordering.
    if (unmet.length > 0) {
      return { goal, state: 'blocked', detail: `needs ${unmet.join(', ')} first` };
    }

    const caveat =
      unverifiable.length === 0
        ? ''
        : ` (not waiting on ${unverifiable.join(', ')}: no measurable completion, so it can never be confirmed)`;

    if (measured === null) {
      return {
        goal,
        state: 'active',
        detail: `no measurable completion condition${caveat}`,
        progress: 0,
      };
    }

    return {
      goal,
      state: 'active',
      detail: `${measured.detail}${caveat}`,
      progress: measured.progress,
    };
  });
}

/**
 * Which active goals a candidate advances.
 *
 * Matching is deliberately coarse — a skill id, or the fact that something earns
 * GP. A precise model of "does this help" would be guesswork dressed as
 * arithmetic; a coarse tag that is *always right* is more useful to a planner
 * than a fine one that is sometimes wrong.
 */
export function goalsAdvancedBy(candidate: Candidate, statuses: readonly GoalStatus[]): string[] {
  const active = statuses.filter((s) => s.state === 'active');
  // Every namespaced id the candidate carries, not `skillId` alone. Matching
  // on skillId only meant an `item_qty_at_least` goal tagged nothing at all --
  // its condition names an item, and no candidate has an `itemId` field called
  // `skillId` -- so "hold 250 Air Rune" served no candidate and read as a goal
  // nothing in the game advanced.
  const ids = namespacedIds(candidate.params);
  // Money received, not output that would fetch money if sold. An hour of
  // mining gems moves the GP balance by exactly zero unless something sells
  // them, so tagging it as advancing a GP goal is a false report -- and it is
  // the report a planner uses to decide it is already working on the goal.
  const earnsGp = candidate.gpIsEarned === true && (candidate.gpPerHour ?? 0) > 0;
  const isCombat = COMBAT_KINDS.has(candidate.kind);

  return active
    .filter((status) => {
      // The goal's own condition is a tag whether or not the operator wrote
      // one: "skill melvorD:Woodcutting >= 50" says what advances it as
      // plainly as `<!-- advances: -->` would, and an annotation nobody
      // remembered to add is the ordinary case.
      for (const tag of [...(status.goal.advancedBy ?? []), ...impliedTags(status.goal.done)]) {
        if (ids.has(tag)) return true;
        if (tag === 'gp' && earnsGp) return true;
        // A fight carries a monster and an area and no skill: which skill it
        // trains is chosen by the attack style, which the candidate does not
        // know. So combat is matched as a class, the way `gp` is. Coarse, and
        // the alternative is what was there before -- four combat goals that
        // nothing in the list ever advanced.
        if (isCombat && (tag === 'combat' || COMBAT_SKILL_IDS.has(tag))) return true;
      }
      return false;
    })
    .map((status) => status.goal.id);
}

/** Objective kinds that put the character in a fight. */
const COMBAT_KINDS = new Set([
  'fight_monster',
  'run_dungeon',
  'run_golbin_raid',
  'start_combat_event',
  'new_slayer_task',
]);

/** Skills a fight can train. Hitpoints always; the rest via the attack style. */
const COMBAT_SKILL_IDS = new Set([
  'melvorD:Attack',
  'melvorD:Strength',
  'melvorD:Defence',
  'melvorD:Hitpoints',
  'melvorD:Ranged',
  'melvorD:Magic',
  'melvorD:Slayer',
]);

/** Every namespaced id in a candidate's params, whatever the field is called. */
function namespacedIds(params: unknown): Set<string> {
  const ids = new Set<string>();
  if (typeof params !== 'object' || params === null) return ids;
  for (const value of Object.values(params)) {
    if (typeof value === 'string' && value.includes(':')) ids.add(value);
  }
  return ids;
}

/** What a goal's own completion condition says advances it. */
function impliedTags(done: GoalCondition | undefined): string[] {
  if (done === undefined) return [];
  switch (done.type) {
    case 'skill_level_at_least':
      return [done.skillId];
    case 'item_qty_at_least':
      return [done.itemId];
    case 'currency_at_least':
      // `gp` rather than the id, so the `gpIsEarned` distinction above still
      // applies: producing something sellable is not earning money. Any other
      // currency keeps its id and matches on the params like anything else.
      return done.currencyId === 'melvorD:GP' ? ['gp'] : [done.currencyId];
    case 'total_level_at_least':
      // Every skilling candidate advances total level, so tagging them all
      // would say nothing. Left untagged deliberately.
      return [];
  }
}

/** Renders goal status for a planning prompt or an MCP tool. */
export function renderGoals(statuses: readonly GoalStatus[]): string {
  if (statuses.length === 0) {
    return 'No goals configured. Write some in GOALS.md so planning has a direction beyond the best current rate.';
  }

  const lines: string[] = [];

  for (const status of statuses.filter((s) => s.state === 'active')) {
    const pct = Math.round(status.progress * 100);
    lines.push(
      `- ACTIVE  ${status.goal.id}: ${status.goal.description} — ${status.detail} (${pct}%)`,
    );
  }
  for (const status of statuses.filter((s) => s.state === 'blocked')) {
    lines.push(`- blocked ${status.goal.id}: ${status.goal.description} — ${status.detail}`);
  }
  for (const status of statuses.filter((s) => s.state === 'done')) {
    lines.push(`- done    ${status.goal.id}: ${status.goal.description}`);
  }

  return lines.join('\n');
}

/** Measures a condition, returning both the verdict and how far along it is. */
function measure(
  condition: GoalCondition,
  snapshot: StateSnapshot,
): { satisfied: boolean; progress: number; detail: string } {
  switch (condition.type) {
    case 'skill_level_at_least': {
      const skill = snapshot.skills.find((s) => s.id === condition.skillId);
      const level = skill?.level ?? 0;
      return {
        satisfied: level >= condition.level,
        progress: clamp(level / condition.level),
        detail: `${skill?.name ?? condition.skillId} ${level}/${condition.level}`,
      };
    }
    case 'currency_at_least': {
      const amount = snapshot.currencies.find((c) => c.id === condition.currencyId)?.amount ?? 0;
      return {
        satisfied: amount >= condition.amount,
        progress: clamp(amount / condition.amount),
        detail: `${amount.toLocaleString()}/${condition.amount.toLocaleString()} GP`,
      };
    }
    case 'item_qty_at_least': {
      const qty = snapshot.bank.items.find((i) => i.id === condition.itemId)?.qty ?? 0;
      return {
        satisfied: qty >= condition.qty,
        progress: clamp(qty / condition.qty),
        detail: `${qty}/${condition.qty}`,
      };
    }
    case 'total_level_at_least':
      return {
        satisfied: snapshot.totalLevel >= condition.level,
        progress: clamp(snapshot.totalLevel / condition.level),
        detail: `total level ${snapshot.totalLevel}/${condition.level}`,
      };
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(1, value);
}

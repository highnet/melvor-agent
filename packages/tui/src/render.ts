import type { Dashboard, LogRecord, RunState } from '@melvor-agent/shared';

/** ANSI SGR codes. Kept literal rather than pulling in a colour dependency. */
const C = {
  reset: '[0m',
  dim: '[2m',
  bold: '[1m',
  red: '[31m',
  green: '[32m',
  yellow: '[33m',
  blue: '[34m',
  cyan: '[36m',
  grey: '[90m',
} as const;

const STATE_COLOUR: Record<RunState, string> = {
  idle: C.grey,
  running: C.green,
  suspended: C.yellow,
  blocked: C.red,
  killed: C.red,
};

/**
 * Renders the whole dashboard as an array of lines.
 *
 * Pure: it takes state and returns strings, so the layout is testable without a
 * terminal and the redraw loop stays trivial.
 *
 * @param dashboard - Latest state from the service, or null when unreachable.
 * @param error - Transport error to surface instead of stale data.
 * @param width - Terminal columns, used for truncation and rules.
 * @param height - Terminal rows, used to size the log pane.
 */
export function render(
  dashboard: Dashboard | null,
  error: string | null,
  width: number,
  height: number,
): string[] {
  const lines: string[] = [];
  const w = Math.max(40, width);

  lines.push(
    `${C.bold}${C.cyan} Melvor Play Agent ${C.reset}${C.grey}${'─'.repeat(Math.max(0, w - 20))}${C.reset}`,
  );

  if (error !== null) {
    lines.push(`${C.red} planner service unreachable: ${error}${C.reset}`);
    lines.push(`${C.grey} start it with: pnpm planner${C.reset}`);
    return lines;
  }

  if (dashboard === null) {
    lines.push(`${C.grey} connecting…${C.reset}`);
    return lines;
  }

  lines.push(...renderStatus(dashboard, w));
  lines.push('');
  lines.push(...renderSnapshot(dashboard));
  lines.push('');
  lines.push(...renderLog(dashboard, Math.max(4, height - lines.length - 4), w));
  lines.push('');
  lines.push(renderKeys());

  return lines;
}

function renderStatus(dashboard: Dashboard, width: number): string[] {
  const report = dashboard.report;
  const state = report?.runState ?? 'idle';
  const colour = STATE_COLOUR[state];

  const link = dashboard.connected
    ? `${C.green}mod connected${C.reset}`
    : `${C.red}mod silent${dashboard.lastReportAgeMs === null ? ' (never reported)' : ` (${fmtAge(dashboard.lastReportAgeMs)})`}${C.reset}`;

  const lines = [` ${colour}${C.bold}${state.toUpperCase()}${C.reset}   ${link}`];

  if (report?.blockedReason != null) {
    lines.push(` ${C.red}refusing to arm: ${truncate(report.blockedReason, width - 20)}${C.reset}`);
  }

  const objective = report?.objective;
  lines.push(
    ` objective: ${objective === null || objective === undefined ? `${C.grey}none${C.reset}` : truncate(objective.rationale, width - 14)}`,
  );

  // The one quality metric. The control condition is a single skill left
  // running and collected every 24h; if this does not beat that, transitions
  // are bad and the planner is not earning its keep.
  const lvl = dashboard.levelsPerHour;
  const gp = dashboard.gpPerHour;
  lines.push(
    ` ${C.dim}rate:${C.reset} ${lvl === null ? '—' : `${lvl.toFixed(2)} levels/h`}   ${gp === null ? '—' : `${Math.round(gp).toLocaleString()} gp/h`}`,
  );

  return lines;
}

function renderSnapshot(dashboard: Dashboard): string[] {
  const snapshot = dashboard.report?.snapshot;
  if (snapshot === null || snapshot === undefined) {
    return [` ${C.grey}no validated snapshot yet${C.reset}`];
  }

  const gp = snapshot.currencies.find((entry) => entry.id === 'melvorD:GP')?.amount ?? 0;
  const active = snapshot.skills.filter((skill) => skill.isActive).map((skill) => skill.name);

  return [
    ` ${C.bold}${snapshot.characterName}${C.reset} ${C.grey}${snapshot.gameVersion}${C.reset}`,
    ` total level ${pad(snapshot.totalLevel, 6)}  completion ${snapshot.completionPercent.toFixed(2)}%  gp ${gp.toLocaleString()}`,
    ` bank ${snapshot.bank.slotsUsed}/${snapshot.bank.slotsMax}   hp ${snapshot.combat.hitpoints}/${snapshot.combat.maxHitpoints}   ${autoEat(snapshot.combat)}`,
    ` action ${snapshot.activeAction?.name ?? `${C.grey}none${C.reset}`}   active ${active.length > 0 ? active.join(', ') : `${C.grey}none${C.reset}`}`,
    snapshot.isOfflineLoop
      ? ` ${C.yellow}offline progress resolving — all tiers suspended${C.reset}`
      : ` ${C.grey}online loop${C.reset}`,
  ];
}

/** Auto Eat reads as "not owned" rather than a bare 0, which is misleading. */
function autoEat(combat: { autoEatThreshold: number; autoEatEfficiency: number }): string {
  if (combat.autoEatThreshold <= 0) return `${C.grey}auto-eat none${C.reset}`;
  return `auto-eat ${combat.autoEatThreshold}@${combat.autoEatEfficiency}%`;
}

function renderLog(dashboard: Dashboard, rows: number, width: number): string[] {
  const records = dashboard.report?.logs ?? [];
  const lines = [` ${C.dim}recent activity${C.reset}`];

  if (records.length === 0) {
    lines.push(` ${C.grey}(quiet)${C.reset}`);
    return lines;
  }

  for (const record of records.slice(-rows).reverse()) {
    lines.push(
      ` ${logColour(record)}${fmtTime(record.at)} ${record.source.padEnd(7)} ${truncate(record.message, width - 22)}${C.reset}`,
    );
  }
  return lines;
}

function logColour(record: LogRecord): string {
  if (record.level === 'error') return C.red;
  if (record.level === 'warn') return C.yellow;
  if (record.source === 'planner') return C.blue;
  return C.grey;
}

function renderKeys(): string {
  return ` ${C.dim}[a]rm  [d]isarm  [k]ill  shift-[K] revive  [r]eplan  [e]xport save  [q]uit${C.reset}`;
}

function fmtTime(at: number): string {
  return new Date(at).toLocaleTimeString('en-GB', { hour12: false });
}

function fmtAge(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}

function pad(value: number, width: number): string {
  return String(value).padEnd(width);
}

/** Truncates on visible length; input here never contains ANSI codes. */
function truncate(text: string, max: number): string {
  if (max <= 1) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

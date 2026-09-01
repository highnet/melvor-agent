import type { Objective, RunState, StateSnapshot } from '@melvor-agent/shared';
import type { Agent } from '../runtime/agent.js';
import type { Logger } from '../runtime/logger.js';

const PANEL_ID = 'melvor-agent-panel';
/** Where the operator last dragged the panel, and whether it was collapsed. */
const LAYOUT_KEY = 'melvor-agent:panel-layout';

/** Maps run state to the game's own contextual text classes. */
const STATE_CLASS: Record<RunState, string> = {
  idle: 'text-muted',
  running: 'text-success',
  suspended: 'text-warning',
  blocked: 'text-danger',
  killed: 'text-danger',
};

export interface PanelHandles {
  /** Shows or hides the panel. */
  toggle(): void;
  /** Re-renders from current agent state. */
  render(): void;
  /** Removes the panel from the DOM. */
  destroy(): void;
}

/** Panel position and disclosure state, persisted across reloads. */
interface Layout {
  left: number;
  top: number;
  showDiagnostics: boolean;
  showLog: boolean;
}

const DEFAULT_LAYOUT: Layout = {
  left: -1,
  top: 64,
  showDiagnostics: false,
  showLog: true,
};

/**
 * Reads the saved layout, falling back to defaults on anything unexpected.
 *
 * Wrapped in try/catch because a panel that throws on a corrupt preference is
 * a panel the operator cannot open to fix the preference.
 */
function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw === null) return DEFAULT_LAYOUT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_LAYOUT;
    const layout = parsed as Partial<Layout>;
    return {
      left: typeof layout.left === 'number' ? layout.left : DEFAULT_LAYOUT.left,
      top: typeof layout.top === 'number' ? layout.top : DEFAULT_LAYOUT.top,
      showDiagnostics: layout.showDiagnostics === true,
      showLog: layout.showLog !== false,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function saveLayout(layout: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    // A panel that cannot remember where it was put still works.
  }
}

/**
 * Keeps the panel on screen.
 *
 * A window resized smaller than it was when the panel was dragged would
 * otherwise strand it off-screen with no way back short of clearing storage.
 */
function clampToViewport(left: number, top: number, width: number): { left: number; top: number } {
  const maxLeft = Math.max(0, window.innerWidth - width);
  // Never past the bottom edge; the header must stay grabbable.
  const maxTop = Math.max(0, window.innerHeight - 48);
  return {
    left: Math.min(Math.max(0, left), maxLeft),
    top: Math.min(Math.max(0, top), maxTop),
  };
}

/**
 * Builds the operator panel.
 *
 * Plain DOM on purpose, reusing the game's existing Bootstrap classes rather
 * than shipping a design system. It is anchored to `document.body` as a fixed
 * overlay instead of injecting into the game's own page containers, because
 * those container ids are not part of the documented mod API and would be a
 * silent breakage on any UI change.
 *
 * The panel is draggable by its header and remembers where it was put. It
 * covers part of a game that the operator is also trying to watch, and the
 * right place to put it depends entirely on which page they are looking at —
 * a fixed corner is a guess that is wrong roughly half the time.
 */
export function createPanel(agent: Agent, log: Logger): PanelHandles {
  const layout = loadLayout();

  const root = document.createElement('div');
  root.id = PANEL_ID;
  root.className = 'block block-rounded';

  const width = 340;
  const initial = clampToViewport(
    layout.left < 0 ? window.innerWidth - width - 16 : layout.left,
    layout.top,
    width,
  );

  Object.assign(root.style, {
    position: 'fixed',
    left: `${initial.left}px`,
    top: `${initial.top}px`,
    width: `${width}px`,
    maxHeight: '85vh',
    overflowY: 'auto',
    // Below Bootstrap's dropdown layer (1000), not above it. At 1050 this
    // panel sat on top of the game's own menus — including the Creator
    // Toolkit's reload button, which is how mods are reloaded during
    // development. An accessory overlay that covers the game's controls is
    // worse than one that yields to them.
    zIndex: '900',
    display: 'none',
    boxShadow: '0 0.5rem 1rem rgba(0,0,0,.4)',
  } satisfies Partial<CSSStyleDeclaration>);

  document.body.appendChild(root);

  const render = (): void => {
    if (root.style.display === 'none') return;
    root.replaceChildren(...renderContent(agent, log, layout, render));
    attachDrag(root, layout);
  };

  const unsubscribeAgent = agent.onChange(render);
  const unsubscribeLog = log.subscribe(render);

  return {
    toggle(): void {
      root.style.display = root.style.display === 'none' ? 'block' : 'none';
      render();
    },
    render,
    destroy(): void {
      unsubscribeAgent();
      unsubscribeLog();
      root.remove();
    },
  };
}

/**
 * Makes the header a drag handle.
 *
 * Pointer events rather than mouse events, so a pen or touch works, and
 * `setPointerCapture` so a fast drag that outruns the cursor does not drop the
 * panel mid-move. Re-attached on every render because the header is rebuilt.
 */
function attachDrag(root: HTMLElement, layout: Layout): void {
  const header = root.querySelector<HTMLElement>('[data-drag-handle]');
  if (header === null) return;

  header.style.cursor = 'move';
  header.style.userSelect = 'none';

  header.addEventListener('pointerdown', (event: PointerEvent) => {
    // Let the buttons in the header behave like buttons.
    if ((event.target as HTMLElement).closest('button') !== null) return;
    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const originLeft = root.offsetLeft;
    const originTop = root.offsetTop;
    header.setPointerCapture(event.pointerId);

    const move = (moveEvent: PointerEvent): void => {
      const next = clampToViewport(
        originLeft + (moveEvent.clientX - startX),
        originTop + (moveEvent.clientY - startY),
        root.offsetWidth,
      );
      root.style.left = `${next.left}px`;
      root.style.top = `${next.top}px`;
    };

    const up = (): void => {
      header.releasePointerCapture(event.pointerId);
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', up);
      layout.left = root.offsetLeft;
      layout.top = root.offsetTop;
      saveLayout(layout);
    };

    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', up);
  });
}

/**
 * Turns a transport failure into the fix for it.
 *
 * A rejected request and an unanswered one look identical in the panel and have
 * opposite remedies. An HTTP status means the service is running and refused
 * what it was sent — in practice, that the mod and the service disagree about
 * the snapshot, because the service reloads on save while the mod only reloads
 * with the game. Telling the operator to start a service that is already
 * running sends them to fix the wrong thing.
 */
function describeServiceError(error: string, serviceUrl: string): string {
  if (/HTTP [0-9]{3}/.test(error)) {
    return `Planner service at ${serviceUrl} rejected the request — ${error}. The service is running, so this is usually the mod being older than it: reload the game to pick up the current build.`;
  }
  return `Planner service unreachable at ${serviceUrl} — ${error}. Start it with: pnpm planner`;
}

function renderContent(
  agent: Agent,
  log: Logger,
  layout: Layout,
  render: () => void,
): HTMLElement[] {
  const header = el('div', 'block-header block-header-default');
  header.dataset.dragHandle = 'true';
  header.appendChild(el('h3', 'block-title', 'Play Agent'));
  header.appendChild(
    el('span', `badge ${STATE_CLASS[agent.runState]}`, agent.runState.toUpperCase()),
  );

  const content = el('div', 'block-content');

  // A connection failure masquerades as a missing dump, a missing objective, or
  // silence. Say so plainly and first.
  if (agent.serviceError !== null) {
    content.appendChild(
      el(
        'div',
        'alert alert-danger',
        describeServiceError(agent.serviceError, agent.currentSettings.serviceUrl),
      ),
    );
  }

  if (agent.blocked !== null) {
    content.appendChild(el('div', 'alert alert-danger', `Refusing to arm: ${agent.blocked}`));
  }

  // What it is doing and how far along, before anything else. This is the
  // question a glance at the panel should answer, and it used to be four rows
  // below the character's name and version.
  content.appendChild(renderNow(agent));

  for (const warning of warnings(agent)) {
    content.appendChild(
      el('div', `alert ${warning.severity} py-2 mb-2 font-size-sm`, warning.text),
    );
  }

  content.appendChild(renderVitals(agent));
  content.appendChild(renderControls(agent));
  content.appendChild(
    renderDisclosure(
      'Diagnostics',
      layout.showDiagnostics,
      () => renderDiagnostics(agent),
      () => {
        layout.showDiagnostics = !layout.showDiagnostics;
        saveLayout(layout);
        render();
      },
    ),
  );
  content.appendChild(
    renderDisclosure(
      'Recent activity',
      layout.showLog,
      () => renderLog(log),
      () => {
        layout.showLog = !layout.showLog;
        saveLayout(layout);
        render();
      },
    ),
  );

  return [header, content];
}

/**
 * The current objective, its progress, and what is queued behind it.
 *
 * The rationale is the agent's reasoning and can run to a paragraph; it is kept
 * small and secondary to the target, because "Mining 24 → 26" is what the
 * operator is checking and the paragraph is what they read once.
 */
function renderNow(agent: Agent): HTMLElement {
  const wrapper = el('div', 'mb-3');
  const snapshot = agent.snapshot;
  const objective = agent.currentSettings.objective ?? null;

  const action = snapshot?.activeAction?.name ?? 'nothing';
  wrapper.appendChild(el('div', 'font-size-sm text-muted', 'Doing now'));
  wrapper.appendChild(el('div', `font-w600 ${action === 'nothing' ? 'text-warning' : ''}`, action));

  if (objective !== null && snapshot !== null) {
    const target = describeTarget(objective, snapshot);
    wrapper.appendChild(el('div', 'font-size-sm text-success mt-1', `→ ${target}`));
    wrapper.appendChild(el('div', 'font-size-sm text-muted mt-1', objective.rationale));
  } else {
    wrapper.appendChild(el('div', 'font-size-sm text-warning mt-1', 'No objective set'));
  }

  const queued = agent.currentSettings.plan.length;
  if (queued > 0) {
    const next = agent.currentSettings.plan[0];
    wrapper.appendChild(
      el(
        'div',
        'font-size-sm text-muted mt-1',
        `Then ${queued} more — next: ${next?.rationale ?? 'unknown'}`,
      ),
    );
  }

  return wrapper;
}

/**
 * Conditions that need the operator, shown only while they are true.
 *
 * The old panel had a row reading "Offline loop: no" at all times, which spent
 * a line to say nothing every second of every session. A warning that is always
 * present is not a warning; these appear when they mean something and are
 * absent otherwise.
 */
function warnings(agent: Agent): { text: string; severity: string }[] {
  const snapshot = agent.snapshot;
  if (snapshot === null) return [];
  const out: { text: string; severity: string }[] = [];

  if (snapshot.isOfflineLoop) {
    out.push({
      text: 'Offline progress resolving — the agent is suspended.',
      severity: 'alert-warning',
    });
  }

  const free = snapshot.bank.slotsMax - snapshot.bank.slotsUsed;
  if (free <= 0) {
    out.push({
      text: 'Bank is FULL — new item types are being discarded silently.',
      severity: 'alert-danger',
    });
  } else if (free <= 3) {
    out.push({ text: `Bank has ${free} slot(s) left.`, severity: 'alert-warning' });
  }

  const hpFraction = snapshot.combat.hitpoints / Math.max(1, snapshot.combat.maxHitpoints);
  if (snapshot.combat.inCombat && hpFraction < 0.4) {
    out.push({
      text: `HP ${snapshot.combat.hitpoints}/${snapshot.combat.maxHitpoints} in combat.`,
      severity: 'alert-danger',
    });
  }

  if (!agent.currentSettings.characterAllowlist.includes(snapshot.characterName)) {
    out.push({
      text: `"${snapshot.characterName}" is not allowlisted — the agent will not act.`,
      severity: 'alert-warning',
    });
  }

  return out;
}

/**
 * The handful of numbers worth a permanent line.
 *
 * Chosen by asking what changes a decision. Completion percent moved 0.01% in
 * an entire session and told the operator nothing; the progress rate answers
 * the only question the brief actually asks.
 */
function renderVitals(agent: Agent): HTMLElement {
  const wrapper = el('div', 'mb-3');
  const snapshot = agent.snapshot;

  if (snapshot === null) {
    wrapper.appendChild(el('div', 'text-muted', 'No validated snapshot yet.'));
    return wrapper;
  }

  const gp = snapshot.currencies.find((entry) => entry.id === 'melvorD:GP')?.amount ?? 0;
  const free = snapshot.bank.slotsMax - snapshot.bank.slotsUsed;
  const rate = agent.progressRate;

  const rows: Array<[string, string, string]> = [
    ['Total level', String(snapshot.totalLevel), ''],
    ['GP', gp.toLocaleString(), ''],
    [
      'Bank',
      `${snapshot.bank.slotsUsed} / ${snapshot.bank.slotsMax}`,
      free <= 0 ? 'text-danger' : free <= 3 ? 'text-warning' : '',
    ],
    [
      'HP',
      `${snapshot.combat.hitpoints} / ${snapshot.combat.maxHitpoints}`,
      snapshot.combat.hitpoints < snapshot.combat.maxHitpoints * 0.4 ? 'text-warning' : '',
    ],
  ];

  if (rate !== null) {
    rows.push([
      `Rate (${rate.hours.toFixed(1)}h)`,
      `${rate.levelsPerHour.toFixed(1)} lvl/h, ${Math.round(rate.gpPerHour).toLocaleString()} gp/h`,
      rate.levelsPerHour <= 0 ? 'text-danger' : 'text-success',
    ]);
  }

  // Auto Eat's absence changes how combat is fought, so it earns a line only
  // while it is missing.
  if (snapshot.combat.autoEatThreshold <= 0) {
    rows.push(['Auto Eat', 'not owned', 'text-warning']);
  }

  const table = el('table', 'table table-sm table-borderless mb-0');
  const body = el('tbody', '');
  for (const [label, value, tone] of rows) {
    const tr = el('tr', '');
    tr.appendChild(el('td', 'text-muted py-1', label));
    tr.appendChild(el('td', `font-w600 text-right py-1 ${tone}`, value));
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

/** The rows that matter when something is wrong, and never otherwise. */
function renderDiagnostics(agent: Agent): HTMLElement {
  const wrapper = el('div', 'mb-2');
  const snapshot = agent.snapshot;
  if (snapshot === null) return wrapper;

  const activeSkills = snapshot.skills.filter((skill) => skill.isActive).map((skill) => skill.name);

  const rows: Array<[string, string]> = [
    ['Character', `${snapshot.characterName} (${snapshot.gameVersion})`],
    ['Completion', `${snapshot.completionPercent.toFixed(2)}%`],
    ['Active skills', activeSkills.length > 0 ? activeSkills.join(', ') : 'none'],
    ['Realm', snapshot.currentRealmId],
    ['Auto Eat', autoEatSummary(snapshot.combat)],
    ['Service', agent.serviceError === null ? (agent.serviceBase ?? 'connected') : 'UNREACHABLE'],
    ['Transport', agent.transportKind],
  ];

  const table = el('table', 'table table-sm table-borderless mb-0 font-size-sm');
  const body = el('tbody', '');
  for (const [label, value] of rows) {
    const tr = el('tr', '');
    tr.appendChild(el('td', 'text-muted py-1', label));
    tr.appendChild(el('td', 'font-w600 text-right py-1', value));
    body.appendChild(tr);
  }
  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

/**
 * A titled section the operator can fold away.
 *
 * The body is built lazily so a collapsed section costs nothing to render, which
 * matters because the panel re-renders on every agent change and every log line.
 */
function renderDisclosure(
  title: string,
  open: boolean,
  body: () => HTMLElement,
  onToggle: () => void,
): HTMLElement {
  const wrapper = el('div', 'mb-2');
  const toggle = el('div', 'font-size-sm text-muted mb-1', `${open ? '▾' : '▸'} ${title}`);
  toggle.style.cursor = 'pointer';
  toggle.style.userSelect = 'none';
  toggle.addEventListener('click', onToggle);
  wrapper.appendChild(toggle);
  if (open) wrapper.appendChild(body());
  return wrapper;
}

function renderControls(agent: Agent): HTMLElement {
  const row = el('div', 'row row-deck mb-3');

  const arm = button(agent.runState === 'running' ? 'Disarm' : 'Arm', 'btn-primary', () => {
    if (agent.runState === 'running') agent.disarm();
    else void agent.arm();
  });
  arm.disabled = agent.runState === 'killed';

  // The kill switch stays enabled in every state; it is the operator's exit.
  // Once pulled it becomes Revive, because a switch with no way back is a
  // reload disguised as a button.
  const kill =
    agent.runState === 'killed'
      ? button('Revive', 'btn-success', () => agent.revive())
      : button('Kill', 'btn-danger', () => agent.kill());

  for (const control of [arm, kill]) {
    const cell = el('div', 'col-6');
    cell.appendChild(control);
    row.appendChild(cell);
  }

  // The allowlist fails closed on an empty list, which is correct but leaves no
  // way in without hand-editing JSON. One click adds the loaded character:
  // explicit, and impossible to typo into the wrong save.
  const snapshot = agent.snapshot;
  const characterName = snapshot?.characterName ?? null;
  const allowed =
    characterName !== null && agent.currentSettings.characterAllowlist.includes(characterName);

  if (characterName !== null && !allowed) {
    const allow = button(`Allow "${characterName}"`, 'btn-info', () => {
      agent.updateSettings({
        ...agent.currentSettings,
        characterAllowlist: [...agent.currentSettings.characterAllowlist, characterName],
      });
    });
    const allowCell = el('div', 'col-12 mt-2');
    allowCell.appendChild(allow);
    row.appendChild(allowCell);
  }

  // Revoke and Dump are maintenance, not operation: they were taking two full
  // rows above the state the operator is actually watching. Kept, made small,
  // and put last.
  if (allowed && characterName !== null) {
    const revoke = button(`Revoke "${characterName}"`, 'btn-secondary', () => {
      agent.updateSettings({
        ...agent.currentSettings,
        characterAllowlist: agent.currentSettings.characterAllowlist.filter(
          (name) => name !== characterName,
        ),
      });
      // Revoking while armed would otherwise leave it running on a save it is
      // no longer permitted to touch.
      agent.disarm();
    });
    revoke.className = 'btn btn-sm btn-secondary w-100 font-size-sm';
    const revokeCell = el('div', 'col-6 mt-2');
    revokeCell.appendChild(revoke);
    row.appendChild(revokeCell);
  }

  // The dump must be produced from inside the game: only the running game
  // knows its own registries for the exact installed version.
  const dump = button('Dump knowledge', 'btn-secondary', () => void agent.dumpKnowledge());
  dump.className = 'btn btn-sm btn-secondary w-100 font-size-sm';
  const dumpCell = el('div', `${allowed ? 'col-6' : 'col-12'} mt-2`);
  dumpCell.appendChild(dump);
  row.appendChild(dumpCell);

  return row;
}

/**
 * The objective's target, with progress, in the operator's terms.
 *
 * The rationale says *why*; this says *what and how far*. Watching an agent
 * work without it means reading a paragraph of reasoning and still not knowing
 * whether it is nearly done — which is the one thing a glance at the panel
 * should answer.
 *
 * One-shot objectives carry no criteria on purpose, so they are named for what
 * they do rather than shown as a bar that would only ever read 0% or 100%.
 */
function describeTarget(objective: Objective | null, snapshot: StateSnapshot): string {
  if (objective === null) return 'none';
  if (objective.successWhen.length === 0) return `${objective.kind.replace(/_/g, ' ')} (one-shot)`;

  return objective.successWhen
    .map((criterion) => {
      switch (criterion.type) {
        case 'skill_level_at_least': {
          const skill = snapshot.skills.find((entry) => entry.id === criterion.skillId);
          const name = skill?.name ?? criterion.skillId;
          return `${name} ${skill?.level ?? '?'} → ${criterion.level}`;
        }
        case 'item_qty_at_least': {
          const item = snapshot.bank.items.find((entry) => entry.id === criterion.itemId);
          return `${item?.name ?? criterion.itemId} ${item?.qty ?? 0} → ${criterion.qty}`;
        }
        case 'currency_at_least': {
          const currency = snapshot.currencies.find((entry) => entry.id === criterion.currencyId);
          return `${currency?.name ?? criterion.currencyId} ${(currency?.amount ?? 0).toLocaleString()} → ${criterion.amount.toLocaleString()}`;
        }
      }
    })
    .join(', ');
}

function autoEatSummary(combat: { autoEatThreshold: number; autoEatEfficiency: number }): string {
  if (combat.autoEatThreshold <= 0) return 'not owned';
  return `threshold ${combat.autoEatThreshold}, efficiency ${combat.autoEatEfficiency}`;
}

function renderLog(log: Logger): HTMLElement {
  const list = el('div', 'font-size-sm');
  Object.assign(list.style, {
    maxHeight: '200px',
    overflowY: 'auto',
  } satisfies Partial<CSSStyleDeclaration>);

  for (const record of log.tail(40).reverse()) {
    const line = el('div', levelClass(record.level));
    const time = new Date(record.at).toLocaleTimeString();
    line.textContent = `${time} [${record.source}] ${record.message}`;
    list.appendChild(line);
  }

  return list;
}

function levelClass(level: string): string {
  if (level === 'error') return 'text-danger';
  if (level === 'warn') return 'text-warning';
  return 'text-muted';
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, variant: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', `btn btn-sm ${variant} w-100`, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

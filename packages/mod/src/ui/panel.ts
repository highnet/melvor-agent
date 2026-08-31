import type { RunState } from '@melvor-agent/shared';
import type { Agent } from '../runtime/agent.js';
import type { Logger } from '../runtime/logger.js';

const PANEL_ID = 'melvor-agent-panel';

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

/**
 * Builds the operator panel.
 *
 * Plain DOM on purpose, reusing the game's existing Bootstrap classes rather
 * than shipping a design system. It is anchored to `document.body` as a fixed
 * overlay instead of injecting into the game's own page containers, because
 * those container ids are not part of the documented mod API and would be a
 * silent breakage on any UI change.
 */
export function createPanel(agent: Agent, log: Logger): PanelHandles {
  const root = document.createElement('div');
  root.id = PANEL_ID;
  root.className = 'block block-rounded';
  Object.assign(root.style, {
    position: 'fixed',
    top: '64px',
    right: '16px',
    width: '380px',
    maxHeight: '75vh',
    overflowY: 'auto',
    zIndex: '1050',
    display: 'none',
    boxShadow: '0 0.5rem 1rem rgba(0,0,0,.4)',
  } satisfies Partial<CSSStyleDeclaration>);

  document.body.appendChild(root);

  const render = (): void => {
    if (root.style.display === 'none') return;
    root.replaceChildren(...renderContent(agent, log));
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

function renderContent(agent: Agent, log: Logger): HTMLElement[] {
  const header = el('div', 'block-header block-header-default');
  header.appendChild(el('h3', 'block-title', 'Play Agent'));
  const state = el('span', `badge ${STATE_CLASS[agent.runState]}`, agent.runState.toUpperCase());
  header.appendChild(state);

  const content = el('div', 'block-content');

  // A connection failure masquerades as a missing dump, a missing objective, or
  // silence. Say so plainly and first.
  if (agent.serviceError !== null) {
    content.appendChild(
      el(
        'div',
        'alert alert-danger',
        `Planner service unreachable at ${agent.currentSettings.serviceUrl} — ${agent.serviceError}. Start it with: pnpm planner`,
      ),
    );
  }

  if (agent.blocked !== null) {
    const alert = el('div', 'alert alert-danger', `Refusing to arm: ${agent.blocked}`);
    content.appendChild(alert);
  }

  content.appendChild(renderControls(agent));
  content.appendChild(renderSnapshot(agent));
  content.appendChild(renderLog(log));

  return [header, content];
}

function renderControls(agent: Agent): HTMLElement {
  const row = el('div', 'row row-deck mb-3');

  const arm = button(agent.runState === 'running' ? 'Disarm' : 'Arm', 'btn-primary', () => {
    if (agent.runState === 'running') agent.disarm();
    else void agent.arm();
  });
  arm.disabled = agent.runState === 'killed';

  // The kill switch stays enabled in every state; it is the operator's exit.
  const kill = button('Kill', 'btn-danger', () => agent.kill());

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
    const revokeCell = el('div', 'col-12 mt-2');
    revokeCell.appendChild(revoke);
    row.appendChild(revokeCell);
  }

  // The dump must be produced from inside the game: only the running game
  // knows its own registries for the exact installed version.
  const dump = button('Dump knowledge', 'btn-secondary', () => void agent.dumpKnowledge());
  const dumpCell = el('div', 'col-12 mt-2');
  dumpCell.appendChild(dump);
  row.appendChild(dumpCell);

  return row;
}

function renderSnapshot(agent: Agent): HTMLElement {
  const wrapper = el('div', 'mb-3');
  const snapshot = agent.snapshot;

  if (snapshot === null) {
    wrapper.appendChild(el('div', 'text-muted', 'No validated snapshot yet.'));
    return wrapper;
  }

  const table = el('table', 'table table-sm table-borderless mb-0');
  const body = el('tbody', '');

  const gp = snapshot.currencies.find((entry) => entry.id === 'melvorD:GP')?.amount ?? 0;
  const activeSkills = snapshot.skills.filter((skill) => skill.isActive).map((skill) => skill.name);

  const rows: Array<[string, string]> = [
    ['Character', `${snapshot.characterName} (${snapshot.gameVersion})`],
    ['Total level', String(snapshot.totalLevel)],
    ['Completion', `${snapshot.completionPercent.toFixed(2)}%`],
    ['GP', gp.toLocaleString()],
    ['Bank', `${snapshot.bank.slotsUsed} / ${snapshot.bank.slotsMax} slots`],
    ['Active action', snapshot.activeAction?.name ?? 'none'],
    ['Active skills', activeSkills.length > 0 ? activeSkills.join(', ') : 'none'],
    ['HP', `${snapshot.combat.hitpoints} / ${snapshot.combat.maxHitpoints}`],
    ['Auto Eat', autoEatSummary(snapshot.combat)],
    ['Realm', snapshot.currentRealmId],
    ['Offline loop', snapshot.isOfflineLoop ? 'YES — suspended' : 'no'],
    ['Objective', agent.currentSettings.objective?.rationale ?? 'none'],
    ['Service', agent.serviceError === null ? 'connected' : 'UNREACHABLE'],
    [
      'Allowlisted',
      agent.currentSettings.characterAllowlist.includes(snapshot.characterName) ? 'yes' : 'NO',
    ],
  ];

  for (const [label, value] of rows) {
    const tr = el('tr', '');
    tr.appendChild(el('td', 'text-muted', label));
    tr.appendChild(el('td', 'font-w600 text-right', value));
    body.appendChild(tr);
  }

  table.appendChild(body);
  wrapper.appendChild(table);
  return wrapper;
}

/** Auto Eat is off entirely when the threshold is zero, which reads better than "0". */
function autoEatSummary(combat: { autoEatThreshold: number; autoEatEfficiency: number }): string {
  if (combat.autoEatThreshold <= 0) return 'not owned';
  return `threshold ${combat.autoEatThreshold}, efficiency ${combat.autoEatEfficiency}`;
}

function renderLog(log: Logger): HTMLElement {
  const wrapper = el('div', '');
  wrapper.appendChild(el('div', 'font-size-sm text-muted mb-1', 'Recent activity'));

  const list = el('div', 'font-size-sm');
  Object.assign(list.style, {
    maxHeight: '220px',
    overflowY: 'auto',
  } satisfies Partial<CSSStyleDeclaration>);

  for (const record of log.tail(40).reverse()) {
    const line = el('div', levelClass(record.level));
    const time = new Date(record.at).toLocaleTimeString();
    line.textContent = `${time} [${record.source}] ${record.message}`;
    list.appendChild(line);
  }

  wrapper.appendChild(list);
  return wrapper;
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

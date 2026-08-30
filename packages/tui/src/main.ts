import { emitKeypressEvents } from 'node:readline';
import type { Command, Dashboard } from '@melvor-agent/shared';
import { dashboardSchema } from '@melvor-agent/shared';
import { render } from './render.js';

const BASE_URL = process.env.MELVOR_AGENT_URL ?? 'http://localhost:8787';
const POLL_INTERVAL_MS = 1000;

/** Keys the operator can press, mapped to commands the service queues. */
const KEY_COMMANDS: Record<string, Command> = {
  a: { type: 'arm' },
  d: { type: 'disarm' },
  k: { type: 'kill' },
  r: { type: 'replan', reason: 'operator requested from TUI' },
  e: { type: 'export_save' },
};

let dashboard: Dashboard | null = null;
let error: string | null = null;
let status: string | null = null;
let running = true;

/**
 * Terminal dashboard for the play agent.
 *
 * Hand-rolled ANSI with no runtime dependencies: the usual choice, Ink, is
 * React-based and React is out of scope for this project. It is a read-mostly
 * dashboard plus five keybinds, which does not justify a framework.
 *
 * Commands are queued on the service and delivered on the mod's next report,
 * so the TUI never talks to the game directly and works fine when the game is
 * closed.
 */
async function main(): Promise<void> {
  enterAltScreen();
  wireInput();

  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  await poll();

  // Redraw on resize so the log pane resizes with the window.
  process.stdout.on('resize', draw);

  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (!running) {
        clearInterval(check);
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });

  leaveAltScreen();
}

async function poll(): Promise<void> {
  try {
    const response = await fetch(`${BASE_URL}/dashboard`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      error = `HTTP ${response.status}`;
    } else {
      const parsed = dashboardSchema.safeParse(await response.json());
      if (parsed.success) {
        dashboard = parsed.data;
        error = null;
      } else {
        error = `malformed dashboard: ${parsed.error.issues[0]?.message ?? 'unknown'}`;
      }
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  draw();
}

async function send(command: Command): Promise<void> {
  try {
    const response = await fetch(`${BASE_URL}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(3000),
    });
    status = response.ok
      ? `queued ${command.type} — applies on the mod's next report`
      : `command rejected: HTTP ${response.status}`;
  } catch (cause) {
    status = `command failed: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
  draw();
}

function wireInput(): void {
  emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) process.stdin.setRawMode(true);

  process.stdin.on('keypress', (_str, key: { name?: string; ctrl?: boolean }) => {
    // Ctrl-C must always work, including while a request is in flight.
    if (key.ctrl === true && key.name === 'c') {
      running = false;
      return;
    }
    if (key.name === 'q') {
      running = false;
      return;
    }
    const command = key.name === undefined ? undefined : KEY_COMMANDS[key.name];
    if (command !== undefined) void send(command);
  });
}

function draw(): void {
  const width = process.stdout.columns ?? 80;
  const height = process.stdout.rows ?? 24;
  const lines = render(dashboard, error, width, height);
  if (status !== null) lines.push(` ${status}`);

  // Clear and repaint. The dashboard is small enough that a full repaint is
  // cheaper to reason about than diffing, and it cannot desync.
  process.stdout.write('[H[2J');
  process.stdout.write(lines.slice(0, height - 1).join('\n'));
}

function enterAltScreen(): void {
  process.stdout.write('[?1049h[?25l');
}

function leaveAltScreen(): void {
  process.stdout.write('[?25h[?1049l');
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.stdin.pause();
}

// Restore the terminal even on an unexpected exit; a mangled terminal after a
// crash is a bad way to end a long unattended session.
process.on('exit', leaveAltScreen);
process.on('SIGINT', () => {
  running = false;
});

await main();

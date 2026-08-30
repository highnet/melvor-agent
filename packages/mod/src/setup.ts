import { addSidebarPanel, CharacterSettings, dumpRegistries } from './adapter/index.js';
import { Agent, DEFAULT_SETTINGS, type AgentSettings } from './runtime/agent.js';
import { Logger } from './runtime/logger.js';
import { Transport } from './runtime/transport.js';
import { createPanel } from './ui/panel.js';

const SETTINGS_KEY = 'agent';

/**
 * Mod entry point.
 *
 * The loader imports this file as an ES module and calls the exported `setup`.
 * Note the split across lifecycle hooks, which is the single most important
 * thing in this file:
 *
 * - `onCharacterLoaded` fires **before** offline progress is calculated, so it
 *   is used only for reading settings and building UI. Nothing may act here.
 * - `onInterfaceReady` fires **after** offline progress has resolved. That is
 *   the only point at which automation may be installed.
 *
 * Getting these backwards means acting on a character that is about to have up
 * to 24 hours of progress applied to it.
 */
export function setup(ctx: Modding.ModContext): void {
  const log = new Logger();
  const storage = new CharacterSettings<AgentSettings>(ctx, SETTINGS_KEY, DEFAULT_SETTINGS);

  let agent: Agent | null = null;
  let panel: ReturnType<typeof createPanel> | null = null;

  ctx.onCharacterLoaded(() => {
    // characterStorage is unusable before this hook, so settings are read here
    // and nowhere earlier.
    const settings = storage.read();
    const transport = new Transport(settings.serviceUrl);
    agent = new Agent(ctx, log, transport, settings);

    const health = storage.checkHealth();
    if (!health.working) {
      // Silent setting loss across a days-long run is the worst failure mode
      // available, so this is surfaced loudly rather than logged at debug.
      log.error('runtime', `settings will NOT persist: ${health.detail}`);
    } else {
      log.info('runtime', `settings persist ok (${health.bytesUsed}/${health.bytesLimit} bytes)`);
    }

    panel = createPanel(agent, log);

    const sidebarHandle = addSidebarPanel({
      categoryId: 'Modding',
      itemId: 'Play Agent',
      name: 'Play Agent',
      onClick: () => panel?.toggle(),
    });

    agent.onChange(() => {
      const current = agent;
      if (current === null) return;
      sidebarHandle.setAside(current.runState, asideClass(current.runState));
      const error = storage.write(current.currentSettings);
      if (error !== null) log.warn('runtime', error);
    });

    // The reflex tier runs off the game's own loop rather than a timer, so it
    // is genuinely per-tick. `function` rather than an arrow: patch hooks are
    // invoked with `this` bound to the patched instance, and an arrow would
    // silently capture module scope instead.
    ctx.patch(Game, 'loop').after(function () {
      agent?.onGameTick();
    });

    log.info('runtime', 'character loaded; waiting for offline progress to resolve');
  });

  ctx.onInterfaceReady(() => {
    const current = agent;
    if (current === null) {
      log.error('runtime', 'interface ready but no agent was constructed');
      return;
    }

    // Offline progress has now been calculated. Only from here is it safe to
    // install listeners and clocks.
    current.install();
    log.info('runtime', 'offline progress resolved; agent installed');

    // Every game start is a mandatory replan: hours may have passed, so the
    // stored objective is re-validated against a fresh snapshot before it resumes.
    current.requestReplan('game_start');

    if (current.currentSettings.enabled) {
      void current.arm();
    }
  });

  // Exposed for the knowledge dump and for other mods; `mod.api.melvorAgent`.
  ctx.api({
    dumpRegistries,
    getRunState: () => agent?.runState ?? 'idle',
    getSnapshot: () => agent?.snapshot ?? null,
    kill: () => agent?.kill(),
  });
}

function asideClass(state: string): string {
  if (state === 'running') return 'text-success';
  if (state === 'blocked' || state === 'killed') return 'text-danger';
  if (state === 'suspended') return 'text-warning';
  return 'text-muted';
}

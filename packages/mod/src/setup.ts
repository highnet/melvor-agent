import {
  CharacterSettings,
  addSidebarPanel,
  dumpRegistries,
  loadCharacterByName,
  onGameLoop,
} from './adapter/index.js';
import { Agent, type AgentSettings, DEFAULT_SETTINGS } from './runtime/agent.js';
import { Logger } from './runtime/logger.js';
import { SettingsStore } from './runtime/settings-store.js';
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
  let settingsStore: SettingsStore | null = null;

  // A reload lands on the character-select screen and stops there: the agent is
  // not running, the service hears nothing, and the run idles until a person
  // clicks. Overnight that is the whole night. This hook proves the mod is
  // alive on that screen, so the click is automatable.
  //
  // The character to enter is the service's to decide, not this file's. The
  // allowlist already states which character the agent is permitted to play, so
  // it is reused rather than adding a second, quietly divergent setting; the
  // service is asked directly because characterStorage does not exist yet here.
  ctx.onCharacterSelectionLoaded(async () => {
    try {
      const settings = await new Transport(DEFAULT_SETTINGS.serviceUrl).loadSettings();
      const allowlist = (settings as { characterAllowlist?: string[] } | null)?.characterAllowlist;

      // Exactly one, deliberately. An allowlist naming several characters does
      // not say which one to resume, and entering the wrong save would mean the
      // agent quietly playing someone else's run.
      const only = allowlist?.length === 1 ? allowlist[0] : undefined;
      if (only === undefined) return;

      const result = loadCharacterByName(only);
      if (!result.ok) log.warn('runtime', `character select: ${result.detail}`);
    } catch (error) {
      // Leaving the screen up for a human is exactly where this started, and a
      // safe place to stop.
      log.warn('runtime', `character select: ${String(error)}`);
    }
  });

  ctx.onCharacterLoaded(() => {
    // characterStorage is unusable before this hook, and nothing may await here,
    // so the cached copy seeds the agent and the service corrects it later.
    const cached = storage.read();
    const transport = new Transport(cached.serviceUrl);
    settingsStore = new SettingsStore(storage, transport, log, DEFAULT_SETTINGS);
    agent = new Agent(ctx, log, transport, cached);

    const health = storage.checkHealth();
    if (!health.working) {
      // Not fatal any more: the local service is the authoritative store, so
      // this only means settings will not also travel with the save.
      log.warn(
        'runtime',
        `character storage is not persisting (${health.detail}); relying on the planner service`,
      );
    } else {
      log.info('runtime', `character storage ok (${health.bytesUsed}/${health.bytesLimit} bytes)`);
    }

    panel = createPanel(agent, log);

    const sidebarHandle = addSidebarPanel({
      categoryId: 'Modding',
      itemId: 'Play Agent',
      name: 'Play Agent',
      ctx,
      iconPath: 'assets/icon.svg',
      onClick: () => panel?.toggle(),
    });

    agent.onChange(() => {
      const current = agent;
      if (current === null) return;
      sidebarHandle.setAside(current.runState, asideClass(current.runState));
      void settingsStore?.write(current.currentSettings);
    });

    // The reflex tier runs off the game's own loop rather than a timer, so it
    // is genuinely per-tick. The patch itself lives in the adapter, like every
    // other game touchpoint.
    onGameLoop(ctx, () => agent?.onGameTick());

    log.info('runtime', 'character loaded; waiting for offline progress to resolve');
  });

  ctx.onInterfaceReady(async () => {
    const current = agent;
    if (current === null) {
      log.error('runtime', 'interface ready but no agent was constructed');
      return;
    }

    // Now that awaiting is allowed, replace the seeded cache with the
    // authoritative settings from the service.
    if (settingsStore !== null) {
      current.updateSettings(await settingsStore.hydrate());
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

  // Console handle for debugging from devtools: `mod.api.playAgent`. Not an
  // integration surface — this is a single-user tool and nothing else consumes it.
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

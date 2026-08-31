import { checkDumpFreshness } from '@melvor-agent/knowledge';
import type {
  ActionResult,
  Candidate,
  Command,
  Objective,
  QualitySample,
  RunState,
  StateSnapshot,
} from '@melvor-agent/shared';
import { fail, stateSnapshotSchema } from '@melvor-agent/shared';
import {
  Subscriptions,
  advanceGolbinRaid,
  buildAgilityObstacle,
  buildTownshipBuilding,
  buyShopPurchase,
  changeEquipmentSet,
  checkCharacterAllowed,
  checkRealmAllowed,
  chooseEventPassive,
  claimCasualTask,
  claimTownshipTask,
  compostFarmPlot,
  disengageCombat,
  dumpRegistries,
  engageMonster,
  equipFood,
  equipItem,
  excavateDigSite,
  exportSave,
  harvestFarmPlot,
  increaseTownHealth,
  newSlayerTask,
  onGameEvent,
  plantFarmPlot,
  readAgilityCandidates,
  readAstrologyCandidates,
  readBankPressure,
  readBlockedOpportunities,
  readCombatGateInputs,
  readCombatTargets,
  readCompostCandidates,
  readDigSiteSetupCandidates,
  readEquipCandidates,
  readEventCandidates,
  readExplorationCandidates,
  readGameVersion,
  readGatherCandidates,
  readLevelCapCandidates,
  readLoadoutCandidates,
  readMasteryCandidates,
  readPaperCandidates,
  readPassiveCookingCandidates,
  readRaidCandidates,
  readSellCandidates,
  readShopObjectiveCandidates,
  readSkillTreeCandidates,
  readSnapshot,
  readSpellCandidates,
  readSynergyCandidates,
  readTaskCandidates,
  readTownHealthCandidates,
  readTownshipCandidates,
  readUpgradeCandidates,
  readWorshipCandidates,
  repairTownshipBuilding,
  selectAttackSpell,
  selectDigSiteMap,
  selectDigSiteTool,
  selectLevelCapIncrease,
  selectTownshipWorship,
  sellItem,
  setAttackStyle,
  spendMasteryPool,
  startCombatEvent,
  startDungeon,
  startGathering,
  startGolbinRaid,
  startPaperMaking,
  startPassiveCooking,
  stopGathering,
  stopGolbinRaid,
  surveyBestHex,
  toggleAurora,
  toggleBankLock,
  toggleCurse,
  togglePrayer,
  unlockSkillTreeNode,
  upgradeBankItem,
  upgradeConstellation,
  usePotion,
} from '../adapter/index.js';
import { assessSurvivability, normaliseFraction } from '../policy/combat-gate.js';
import { executorFor, isSupportedKind } from '../policy/index.js';
import { STOPGAP_DELAY_MS, chooseStopgap } from '../policy/stopgap.js';
import type { PolicyAction } from '../policy/types.js';
import { refillFood } from './combat-reflex.js';
import type { Logger } from './logger.js';
import type { Transport } from './transport.js';

/** How often the policy tier evaluates the objective. */
const POLICY_INTERVAL_MS = 3000;
/** Minimum gap between reflex passes, throttling the per-tick hook. */
const REFLEX_THROTTLE_MS = 1000;
/** How often a quality sample is taken for the progress-per-hour metric. */
const QUALITY_SAMPLE_INTERVAL_MS = 60_000;
/** Flat progress for this long with automation on means we are stuck. */
const STUCK_AFTER_MS = 15 * 60_000;

/**
 * Consecutive failed actions before an objective is abandoned.
 *
 * A precondition that fails once may clear on its own — a bank slot frees, a
 * timer ticks over. One that fails repeatedly will not, and retrying it every
 * three seconds is the "grinds into a wall" failure in a different costume: the
 * time budget would eventually fire, but only after hours of no-ops. Observed
 * live: `firemaking.burn` refused "no melvorD:Oak_Logs in the bank" once per
 * tick for over ten minutes without escalating.
 */
const ACTION_FAILURE_LIMIT = 5;

const GP_CURRENCY_ID = 'melvorD:GP';

/**
 * Triggers the planner request schema accepts.
 *
 * An unrecognised trigger would fail validation at the service and cost a
 * planning round trip, so anything else is reported as `operator`.
 */
const KNOWN_TRIGGERS = new Set([
  'game_start',
  'offline_loop_exited',
  'objective_completed',
  'objective_aborted',
  'unlock_acquired',
  'death',
  'resource_exhausted',
  'budget_exceeded',
  'stuck_detected',
  'operator',
]);

export interface AgentSettings extends Record<string, unknown> {
  enabled: boolean;
  characterAllowlist: string[];
  serviceUrl: string;
  objective: Objective | null;
  /**
   * Objectives to take up, in order, as the current one ends.
   *
   * Persisted with everything else, so a plan survives a reload — which is the
   * point: the session that wrote it is usually long gone by the time the
   * second entry starts.
   */
  plan: Objective[];
}

export const DEFAULT_SETTINGS: AgentSettings = {
  enabled: false,
  characterAllowlist: [],
  serviceUrl: 'http://localhost:8787',
  objective: null,
  plan: [],
};

/**
 * Owns the run state and drives the three clocks.
 *
 * The state machine is the safety spine. Every tier is gated on it, and the
 * `suspended` state exists because offline progress is not a startup-only
 * event: `Game.MIN_OFFLINE_TIME` is 60s, so any stalled loop drops a running
 * game into the offline loop mid-session. Acting during that window produces
 * nonsense, so all three tiers stop until `offlineLoopExited`.
 */
/**
 * How long a fight enumeration stays fresh.
 *
 * A minute: long enough that probing every monster is a rounding error against
 * tick cost, short enough that a level-up or a gear change shows up as new
 * options while the agent is still in the same objective.
 */
const COMBAT_ENUMERATION_TTL_MS = 60_000;

/**
 * How often to repeat the "no objectives available" line.
 *
 * Once a minute rather than every tick. The message is worth having — it is how
 * an operator learns the agent is waiting rather than broken — but repeating it
 * every three seconds turns the journal into a wall of one sentence.
 */
const NO_OBJECTIVES_LOG_INTERVAL_MS = 60_000;

export class Agent {
  private state: RunState = 'idle';
  private blockedReason: string | null = null;
  private readonly subscriptions = new Subscriptions();
  private policyTimer: ReturnType<typeof setInterval> | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private lastReflexAt = 0;
  private lastSnapshot: StateSnapshot | null = null;
  /** Cached fight enumeration; see {@link combatEnumeration}. */
  /** Rate limit for the "no objectives" line; see {@link replan}. */
  private lastNoObjectivesLogAt = 0;

  /** When the agent last found itself with no objective. Null while it has one. */
  private objectivelessSince: number | null = null;

  private combatCache: {
    at: number;
    candidates: Candidate[];
    blocked: ReturnType<typeof readBlockedOpportunities>;
  } | null = null;
  private objectiveStartedAt = Date.now();
  private deathsSinceStart = 0;
  private quality: QualitySample[] = [];
  private lastProgressAt = Date.now();
  private lastProgressMarker = -1;
  private replanPending: string | null = null;
  /** Guards against overlapping planner calls while one is in flight. */
  private replanning = false;
  /** Consecutive failed actions for the current objective. */
  private consecutiveActionFailures = 0;
  private readonly changeListeners = new Set<() => void>();

  constructor(
    private readonly ctx: Modding.ModContext,
    private readonly log: Logger,
    private readonly transport: Transport,
    private settings: AgentSettings,
  ) {}

  get runState(): RunState {
    return this.state;
  }

  get blocked(): string | null {
    return this.blockedReason;
  }

  get snapshot(): StateSnapshot | null {
    return this.lastSnapshot;
  }

  get currentSettings(): AgentSettings {
    return this.settings;
  }

  /**
   * Most recent planner-service error, or null while healthy.
   *
   * Surfaced in the panel because a mod that cannot reach the service fails in
   * ways that look like something else entirely — an absent knowledge dump, an
   * objective that never arrives — and the real cause is invisible from inside
   * the game without this.
   */
  get serviceError(): string | null {
    return this.transport.error;
  }

  /** Which host the transport actually reached, once one works. */
  get serviceBase(): string | null {
    return this.transport.resolvedBase;
  }

  /** Whether requests go through Node or Chromium's fetch. */
  get transportKind(): 'node' | 'fetch' {
    return this.transport.transportKind;
  }

  /** Whether the service has failed enough times to be considered down. */
  get serviceDegraded(): boolean {
    return this.transport.isDegraded;
  }

  /** Subscribes to state changes so the panel re-renders. Returns a disposer. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.changeListeners) listener();
  }

  /**
   * Wires the offline-progress listeners.
   *
   * Called once, after `onInterfaceReady`. These two events are what make the
   * agent safe to leave running for days, so they are subscribed before the
   * agent can ever be armed.
   */
  install(): void {
    this.subscriptions.add(
      onGameEvent('offlineLoopEntered', () => {
        if (this.state === 'killed') return;
        this.log.info('runtime', 'offline loop entered; suspending all tiers');
        this.state = 'suspended';
        this.notify();
      }),
    );

    this.subscriptions.add(
      onGameEvent('offlineLoopExited', () => {
        if (this.state !== 'suspended') return;
        // Hours may have passed. The stored objective's success and abort
        // conditions are re-validated against a fresh snapshot before resuming;
        // this is the normal path, not an edge case.
        this.log.info('runtime', 'offline loop exited; re-snapshotting and replanning');
        this.requestReplan('offline_loop_exited');
        this.state = this.settings.enabled ? 'running' : 'idle';
        this.tickPolicy();
        this.notify();
      }),
    );

    this.startClocks();
  }

  /**
   * The reflex tier, called from the game loop.
   *
   * Throttled internally because the game loop ticks far faster than any reflex
   * needs to run. Kept deliberately small: reflexes are deterministic and never
   * involve the planner.
   */
  onGameTick(): void {
    if (this.state !== 'running') return;
    const now = Date.now();
    if (now - this.lastReflexAt < REFLEX_THROTTLE_MS) return;
    this.lastReflexAt = now;
    this.detectStuck(now);
    this.runCombatReflexes();
  }

  /**
   * Mid-fight reactions, run from the tick loop.
   *
   * These cannot wait for the policy tier: auto-eat can empty a food slot in
   * seconds, and the survivability gate's argument — "this fight is winnable
   * because there is food" — stops being true the moment it does. Topping the
   * slot back up keeps that argument true instead of abandoning the fight.
   *
   * Failures are logged and swallowed. A reflex that cannot fire must never
   * take the tick loop down with it; the policy tier's HP and food floors are
   * still there, and they end the fight safely on their own.
   */
  private runCombatReflexes(): void {
    const snapshot = this.lastSnapshot;
    if (snapshot === null || !snapshot.combat.inCombat) return;

    const isSuspended = (): boolean => this.state === 'suspended';
    const slot =
      snapshot.combat.food[snapshot.combat.selectedEquipmentSet] ?? snapshot.combat.food[0];

    const outcomes = [
      refillFood(
        {
          inCombat: snapshot.combat.inCombat,
          equippedFoodId: slot?.itemId ?? null,
          equippedFoodQty: slot?.qty ?? 0,
          bankQuantityOf: (itemId) =>
            snapshot.bank.items.find((entry) => entry.id === itemId)?.qty ?? 0,
        },
        (itemId, quantity) => equipFood(itemId, quantity, isSuspended),
      ),
    ];

    for (const outcome of outcomes) {
      if (outcome === null) continue;
      if (outcome.result.ok) {
        this.log.info('reflex', `${outcome.name} fired`);
      } else {
        this.log.warn('reflex', `${outcome.name}: ${outcome.result.detail}`);
      }
    }
  }

  private startClocks(): void {
    this.policyTimer = setInterval(() => this.tickPolicy(), POLICY_INTERVAL_MS);
    this.qualityTimer = setInterval(() => this.sampleQuality(), QUALITY_SAMPLE_INTERVAL_MS);
    this.subscriptions.add(() => {
      if (this.policyTimer !== null) clearInterval(this.policyTimer);
      if (this.qualityTimer !== null) clearInterval(this.qualityTimer);
      this.policyTimer = null;
      this.qualityTimer = null;
    });
  }

  /**
   * Attempts to arm automation.
   *
   * Refuses rather than degrades when a guard fails: a stale dump means the
   * planner would reason over numbers that no longer describe the game, and the
   * wrong character means days of unattended play on a save that matters.
   */
  async arm(): Promise<void> {
    if (this.state === 'killed') {
      this.log.warn('runtime', 'kill switch is latched; reload the game to arm again');
      return;
    }

    const reason = await this.checkGuards();
    if (reason !== null) {
      this.state = 'blocked';
      this.blockedReason = reason;
      this.log.error('runtime', `refusing to arm: ${reason}`);
      this.notify();
      return;
    }

    this.blockedReason = null;
    this.state = 'running';
    this.settings = { ...this.settings, enabled: true };
    this.objectiveStartedAt = Date.now();
    this.deathsSinceStart = 0;
    this.log.info('runtime', 'armed');
    this.notify();
  }

  /** Stops acting but keeps listeners installed, so it can be re-armed. */
  disarm(): void {
    if (this.state === 'killed') return;
    this.state = 'idle';
    this.settings = { ...this.settings, enabled: false };
    this.log.info('operator', 'disarmed');
    this.notify();
  }

  /**
   * The kill switch.
   *
   * Synchronous and total: every listener and timer is disposed and the state
   * latches. Only a game reload leaves this state, which is the point — it is
   * for the operator, not for the agent.
   */
  kill(): void {
    this.state = 'killed';
    this.settings = { ...this.settings, enabled: false };
    this.subscriptions.disposeAll();
    this.log.warn('operator', 'kill switch pulled; all listeners and timers disposed');
    this.notify();
  }

  /**
   * Undoes the kill switch.
   *
   * Kill disposes every listener and timer, so this reinstalls them and
   * returns to idle — *not* to running. Pulling the switch is how an operator
   * stops an agent they do not trust in that moment; putting it back should
   * hand control over, not immediately resume acting.
   *
   * Reviving used to require reloading the game, which was defensible for a
   * latch and useless in practice: the panel offered a button that could not be
   * undone from the panel.
   */
  revive(): void {
    if (this.state !== 'killed') return;

    this.state = 'idle';
    this.blockedReason = null;
    this.install();
    this.startClocks();
    this.log.info('operator', 'kill switch released; idle and ready to arm');
    this.notify();
  }

  /**
   * Acts anyway when no planning session has answered.
   *
   * The agent is planned, not scored — that stays true. What this fixes is the
   * failure mode when nobody is listening: an unplanned agent stood still, so
   * every gap in planner coverage became hours of nothing. A short, clearly
   * labelled stopgap makes the floor "some progress", and expires on its own so
   * a session that arrives later takes over.
   *
   * The wait is what makes this safe to have at all. Acting immediately would
   * race every planning session and make the stopgap the normal path rather
   * than the exception.
   */
  private adoptStopgap(): Objective | null {
    const now = Date.now();

    // A plan the session left behind outranks anything chosen by score. This is
    // the whole reason plans exist: the next step was decided by something that
    // could see the goals, and the stopgap cannot.
    const [next, ...rest] = this.settings.plan;
    if (next !== undefined) {
      this.settings = { ...this.settings, objective: next, plan: rest };
      this.objectiveStartedAt = now;
      this.objectivelessSince = null;
      this.deathsSinceStart = 0;
      this.consecutiveActionFailures = 0;
      this.log.info('planner', `plan advanced (${rest.length} left): ${next.rationale}`);
      this.notify();
      return next;
    }

    if (this.objectivelessSince === null) {
      this.objectivelessSince = now;
      return null;
    }
    if (now - this.objectivelessSince < STOPGAP_DELAY_MS) return null;

    const objective = chooseStopgap(this.safeCandidates(), now);
    if (objective === null) {
      // Nothing sustained is available — usually mid offline catch-up, or a
      // character with no unlocked skills. Saying so beats silence, but only
      // once per wait period, which resetting the clock achieves.
      this.log.warn('policy', 'no planning session and nothing sustained to fall back on');
      this.objectivelessSince = now;
      return null;
    }

    this.settings = { ...this.settings, objective };
    this.objectiveStartedAt = now;
    this.objectivelessSince = null;
    this.deathsSinceStart = 0;
    this.consecutiveActionFailures = 0;
    this.log.warn('policy', `stopgap adopted: ${objective.rationale}`);
    this.requestReplan('objective_completed');
    this.notify();

    return objective;
  }

  /** Records that a replan is owed, with the trigger that caused it. */
  requestReplan(trigger: string): void {
    this.replanPending = trigger;
  }

  /**
   * Asks the planner for a new objective and adopts the first one it returns.
   *
   * This is what closes the autonomy loop. Without it an objective completes,
   * clears itself, and the agent sits idle forever — which is exactly what
   * happened on the first live run.
   *
   * Two guards, both load-bearing:
   *
   * - The response is schema-parsed by the transport, then every objective's
   *   kind is checked against the capability registry here. An objective the
   *   policy layer cannot execute is rejected at the door rather than failing
   *   later against a game function.
   * - A failed or empty plan leaves the current objective untouched. Degrade,
   *   never halt.
   */
  private async replan(trigger: string): Promise<void> {
    const snapshot = this.lastSnapshot;
    if (snapshot === null) return;

    const response = await this.transport.plan({
      snapshot,
      candidates: this.safeCandidates(),
      blockedOpportunities: this.safeBlocked(),
      digest: { recent: [], aggregates: [] },
      trigger: KNOWN_TRIGGERS.has(trigger) ? trigger : 'operator',
    });

    if (response === null) {
      this.log.warn('planner', `replan (${trigger}) failed; keeping the current objective`);
      return;
    }

    const usable = response.objectives.find((objective) => isSupportedKind(objective.kind));

    if (usable === undefined) {
      if (response.objectives.length > 0) {
        // The planner proposed something the policy layer cannot perform. That
        // is a planner bug, and saying so is more useful than silently idling.
        this.log.error(
          'planner',
          `rejected ${response.objectives.length} objective(s): no executor for ${response.objectives.map((o) => o.kind).join(', ')}`,
        );
      } else {
        // Throttled: with no session attached this fires on every policy tick,
        // and twenty identical lines a minute bury the entries that explain
        // what the agent actually did. The journal is the only way to diagnose
        // an unattended run, so it has to stay readable.
        const now = Date.now();
        if (now - this.lastNoObjectivesLogAt > NO_OBJECTIVES_LOG_INTERVAL_MS) {
          this.lastNoObjectivesLogAt = now;
          this.log.info('planner', `no objectives available (${response.reasoning})`);
        }
      }
      return;
    }

    this.settings = { ...this.settings, objective: usable };
    this.objectiveStartedAt = Date.now();
    // A real plan arrived, so the stopgap clock starts again from scratch next
    // time rather than firing immediately after this objective ends.
    this.objectivelessSince = null;
    this.deathsSinceStart = 0;
    this.consecutiveActionFailures = 0;
    this.log.info('planner', `new objective (${trigger}): ${usable.rationale}`, {
      reasoning: response.reasoning,
    });
    this.notify();
  }

  private async checkGuards(): Promise<string | null> {
    const realmRefusal = checkRealmAllowed();
    if (realmRefusal !== null) return realmRefusal;

    const characterRefusal = checkCharacterAllowed(
      this.lastSnapshot?.characterName ?? readSnapshot().characterName,
      this.settings.characterAllowlist,
    );
    if (characterRefusal !== null) return characterRefusal;

    // A stale dump is worse than no dump: the planner would reason over numbers
    // that no longer describe the installed game.
    const dump = await this.transport.fetchDump();

    // `fetchDump` answers null both when the service has no dump and when it
    // could not be reached, and those need completely different fixes. Reporting
    // "no dump" for a connection failure sends the operator to press a button
    // that cannot possibly work.
    if (this.transport.error !== null) {
      return `planner service unreachable at ${this.settings.serviceUrl} (${this.transport.error}). Start it with: pnpm planner`;
    }

    const freshness = checkDumpFreshness(dump, readGameVersion());
    if (freshness.fresh) return null;

    // Regenerate rather than refuse. The dump is derived entirely from the
    // running game, so the agent is always able to produce a correct one — and
    // "press a button in the panel" is a chore no unattended agent should need a
    // human for. This is the whole reason a game update or a first run does not
    // require intervention.
    this.log.info(
      'runtime',
      `knowledge dump ${freshness.reason} (${freshness.detail}); regenerating automatically`,
    );

    if (!(await this.dumpKnowledge())) {
      // Only now is it a refusal: the dump could not be produced or stored, so
      // there is no trustworthy game data to plan against.
      return `knowledge dump ${freshness.reason} and could not be regenerated: ${freshness.detail}`;
    }

    const regenerated = checkDumpFreshness(await this.transport.fetchDump(), readGameVersion());
    if (!regenerated.fresh) {
      return `regenerated dump is still ${regenerated.reason}: ${regenerated.detail}`;
    }

    return null;
  }

  /** The policy tier. Takes a snapshot, evaluates, and performs intents. */
  private tickPolicy(): void {
    if (this.state === 'killed' || this.state === 'suspended') return;

    const snapshot = this.takeSnapshot();
    if (snapshot === null) return;

    if (this.state !== 'running') {
      void this.pushReport();
      return;
    }

    // An objective that completed or aborted cleared itself; ask for another
    // rather than idling. This is the loop that makes the agent autonomous.
    if (this.settings.objective === null && this.replanPending === null) {
      this.requestReplan('objective_completed');
    }

    if (this.replanPending !== null && !this.replanning) {
      const trigger = this.replanPending;
      this.replanPending = null;
      this.replanning = true;
      void this.replan(trigger).finally(() => {
        this.replanning = false;
      });
    }

    const objective = this.settings.objective ?? this.adoptStopgap();
    if (objective === null) {
      void this.pushReport();
      return;
    }

    if (!isSupportedKind(objective.kind)) {
      // Reaching here means something bypassed the parse boundary.
      this.log.error('policy', `objective kind ${objective.kind} has no executor; disarming`);
      this.disarm();
      return;
    }

    const executor = executorFor(objective);
    if (executor === null) return;

    const decision = executor({
      snapshot,
      objective,
      now: Date.now(),
      objectiveStartedAt: this.objectiveStartedAt,
      deathsSinceStart: this.deathsSinceStart,
    });

    switch (decision.kind) {
      case 'idle':
        break;
      case 'complete':
        this.log.info('policy', `objective complete: ${decision.detail}`);
        this.settings = { ...this.settings, objective: null };
        this.requestReplan('objective_completed');
        break;
      case 'abort':
        this.log.warn('policy', `objective aborted (${decision.outcome}): ${decision.detail}`);
        this.settings = { ...this.settings, objective: null };
        this.requestReplan('objective_aborted');
        break;
      case 'act': {
        const performed = this.perform(decision.actions, decision.reason);
        // A one-shot decision is finished once its actions are verified.
        // Without this the policy tier re-issues it every tick, which for a
        // prayer toggle would flip it on and off forever.
        if (performed && decision.completeAfter === true) {
          this.log.info('policy', `objective complete: ${decision.reason}`);
          this.settings = { ...this.settings, objective: null };
          this.requestReplan('objective_completed');
        }
        break;
      }
    }

    void this.pushReport();
    this.notify();
  }

  /**
   * Translates policy intents into adapter actions and verifies each one.
   *
   * Stops at the first failure rather than continuing: the intents are ordered
   * (select, then start), so performing a later one after an earlier one failed
   * would act on a state the policy layer never saw.
   */
  private perform(actions: readonly PolicyAction[], reason: string): boolean {
    const isSuspended = (): boolean => this.state === 'suspended';

    for (const action of actions) {
      const result = this.dispatch(action, isSuspended);

      if (!result.ok) {
        // Being suspended is not the objective's fault — the tier is simply
        // paused, and counting it would abandon a fine objective mid catch-up.
        if (result.reason === 'suspended') return false;

        this.consecutiveActionFailures += 1;
        this.log.warn(
          'adapter',
          `${result.action} failed (${result.reason}) [${this.consecutiveActionFailures}/${ACTION_FAILURE_LIMIT}]`,
          result,
        );

        if (this.consecutiveActionFailures >= ACTION_FAILURE_LIMIT) {
          this.log.error(
            'policy',
            `abandoning objective after ${this.consecutiveActionFailures} consecutive failures: ${result.detail}`,
          );
          this.settings = { ...this.settings, objective: null };
          this.consecutiveActionFailures = 0;
          this.requestReplan('objective_aborted');
        }
        return false;
      }

      // Any success clears the run: the objective is making progress again.
      this.consecutiveActionFailures = 0;
      this.log.info('adapter', `${result.action} ok`, result);
    }
    return true;
  }

  private dispatch(action: PolicyAction, isSuspended: () => boolean): ActionResult<unknown> {
    switch (action.type) {
      case 'gather':
        return startGathering(action.skillId, action.recipeId, isSuspended);
      case 'stop_gathering':
        return stopGathering(action.skillId, isSuspended);
      case 'sell':
        return sellItem(action.itemId, action.quantity, isSuspended);
      case 'buy':
        return buyShopPurchase(action.purchaseId, action.quantity, isSuspended);
      case 'engage':
        return this.engageIfSurvivable(action.monsterId, action.areaId, isSuspended);
      case 'disengage':
        return disengageCombat(isSuspended);
      case 'equip':
        return equipItem(action.itemId, action.slotId, isSuspended);
      case 'equip_food':
        return equipFood(action.itemId, action.quantity, isSuspended);
      case 'spend_mastery':
        return spendMasteryPool(action.skillId, action.actionId, action.levels, isSuspended);
      case 'set_attack_style':
        return setAttackStyle(action.attackTypeId, action.styleId, isSuspended);
      case 'toggle_prayer':
        return togglePrayer(action.prayerId, isSuspended);
      case 'use_potion':
        return usePotion(action.itemId, isSuspended);
      case 'new_slayer_task':
        return newSlayerTask(action.categoryId, action.payWithCoins, isSuspended);
      case 'run_dungeon':
        return this.enterDungeonIfSurvivable(action.dungeonId, isSuspended);
      case 'select_spell':
        return selectAttackSpell(action.spellId, isSuspended);
      case 'build_township':
        return buildTownshipBuilding(action.buildingId, action.biomeId, isSuspended);
      case 'repair_township':
        return repairTownshipBuilding(action.buildingId, action.biomeId, isSuspended);
      case 'survey_hex':
        return surveyBestHex(isSuspended);
      case 'excavate_dig_site':
        return excavateDigSite(action.digSiteId, isSuspended);
      case 'select_dig_map':
        return selectDigSiteMap(action.digSiteId, action.mapIndex, isSuspended);
      case 'select_dig_tool':
        return selectDigSiteTool(action.digSiteId, action.toolId, isSuspended);
      case 'advance_raid': {
        // Start and advance are one intent: whichever does not apply is refused
        // by the adapter, which is cheaper than mirroring the raid's state
        // machine in a tier that cannot see the game.
        const started = startGolbinRaid(action.difficulty, isSuspended);
        return started.ok ? started : advanceGolbinRaid(isSuspended);
      }
      case 'stop_raid':
        return stopGolbinRaid(isSuspended);
      case 'build_obstacle':
        return buildAgilityObstacle(action.obstacleId, isSuspended);
      case 'upgrade_constellation':
        return upgradeConstellation(
          action.constellationId,
          action.modifierKind,
          action.index,
          isSuspended,
        );
      case 'unlock_skill_node':
        return unlockSkillTreeNode(action.skillId, action.treeId, action.nodeId, isSuspended);
      case 'change_equipment_set':
        return changeEquipmentSet(action.setIndex, isSuspended);
      case 'compost_plot':
        return compostFarmPlot(action.plotId, action.compostId, action.amount, isSuspended);
      case 'passive_cook':
        return startPassiveCooking(action.categoryId, isSuspended);
      case 'restore_town_health':
        return increaseTownHealth(action.resourceId, action.amount, isSuspended);
      case 'upgrade_item':
        return upgradeBankItem(
          action.upgradedItemId,
          action.quantity,
          action.allowDowngrade,
          isSuspended,
        );
      case 'select_worship':
        return selectTownshipWorship(action.worshipId, isSuspended);
      case 'make_paper':
        return startPaperMaking(action.recipeId, isSuspended);
      case 'claim_township_task':
        return claimTownshipTask(action.taskId, isSuspended);
      case 'claim_casual_task':
        return claimCasualTask(action.taskId, isSuspended);
      case 'start_combat_event':
        return startCombatEvent(action.eventId, isSuspended);
      case 'choose_event_passive':
        return chooseEventPassive(action.passiveId, isSuspended);
      case 'toggle_curse':
        return toggleCurse(action.curseId, isSuspended);
      case 'toggle_aurora':
        return toggleAurora(action.auroraId, isSuspended);
      case 'toggle_bank_lock':
        return toggleBankLock(action.itemId, isSuspended);
      case 'select_level_cap':
        return selectLevelCapIncrease(action.capIncreaseId, action.skillId, isSuspended);
      case 'harvest_plot':
        return harvestFarmPlot(action.plotId, isSuspended);
      case 'plant_plot':
        return plantFarmPlot(action.plotId, action.recipeId, isSuspended);
    }
  }

  /**
   * Engages only if deterministic code proves the fight survivable.
   *
   * This is the hard gate. It sits between the policy intent and the game call,
   * so no policy bug and no planner output can reach `engageMonster` without a
   * passing verdict. The planner gets no vote here by construction — it cannot
   * even express an override.
   *
   * The verdict and its full workings are logged either way, so a refusal is
   * always diagnosable after the fact.
   */
  private engageIfSurvivable(
    monsterId: string,
    areaId: string,
    isSuspended: () => boolean,
  ): ActionResult<unknown> {
    const refusal = this.assessTarget(monsterId);
    if (refusal !== null) return refusal;
    return engageMonster(monsterId, areaId, isSuspended);
  }

  /**
   * Enters a dungeon only if the same gate proves it survivable.
   *
   * It matters more here than for a single monster: a dungeon cannot be left
   * partway without losing the run, so the gate — which judges a dungeon by its
   * hardest monster, not its first — is the only thing standing between the
   * agent and an hour of wasted progress.
   */
  private enterDungeonIfSurvivable(
    dungeonId: string,
    isSuspended: () => boolean,
  ): ActionResult<unknown> {
    const refusal = this.assessTarget(dungeonId);
    if (refusal !== null) return refusal;
    return startDungeon(dungeonId, isSuspended);
  }

  /**
   * The gate itself, shared by monsters and dungeons.
   *
   * Two copies would drift, and the copy that drifted would be the one that
   * lets the agent die.
   *
   * @param targetId - A monster id or a dungeon id.
   * @returns A refusal to hand back to the caller, or null when it is safe.
   */
  private assessTarget(targetId: string): ActionResult<unknown> | null {
    const sessionMinutes = this.settings.objective?.abortWhen.minutesExceed ?? 30;

    const gathered = readCombatGateInputs(targetId, sessionMinutes);
    if (!gathered.ok) {
      // Could not measure means could not prove, which is a refusal — never an
      // assumption that the fight is fine.
      this.log.warn('policy', `combat gate: cannot assess ${targetId} — ${gathered.detail}`);
      return fail('combat.gate', 'precondition', gathered.detail);
    }

    // The auto-eat getters are documented only by name; normalising guards
    // against them being percentages rather than fractions.
    const verdict = assessSurvivability({
      ...gathered.inputs,
      autoEatThresholdFraction: normaliseFraction(gathered.inputs.autoEatThresholdFraction),
      autoEatHpLimitFraction: normaliseFraction(gathered.inputs.autoEatHpLimitFraction),
      autoEatEfficiencyFraction: normaliseFraction(gathered.inputs.autoEatEfficiencyFraction),
    });

    if (!verdict.safe) {
      const reasons = verdict.refusals.map((refusal) => refusal.detail).join('; ');
      this.log.warn(
        'policy',
        `combat gate REFUSED ${gathered.inputs.targetName}: ${reasons}`,
        verdict,
      );
      return fail('combat.gate', 'precondition', reasons);
    }

    this.log.info('policy', `combat gate passed ${gathered.inputs.targetName}`, verdict);
    return null;
  }

  /** Reads and validates a snapshot. Invalid snapshots block, never pass through. */
  private takeSnapshot(): StateSnapshot | null {
    let raw: unknown;
    try {
      raw = readSnapshot();
    } catch (error) {
      this.log.error('adapter', `snapshot read threw: ${String(error)}`);
      return null;
    }

    const parsed = stateSnapshotSchema.safeParse(raw);
    if (!parsed.success) {
      this.state = 'blocked';
      this.blockedReason = `snapshot failed validation: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`;
      this.log.error('adapter', this.blockedReason);
      this.notify();
      return null;
    }

    this.lastSnapshot = parsed.data;
    return parsed.data;
  }

  private sampleQuality(): void {
    const snapshot = this.lastSnapshot;
    if (snapshot === null) return;
    this.quality.push({
      at: snapshot.capturedAt,
      totalLevel: snapshot.totalLevel,
      completionPercent: snapshot.completionPercent,
      gp: snapshot.currencies.find((entry) => entry.id === GP_CURRENCY_ID)?.amount ?? 0,
    });
    // 48h of minute samples is plenty to compare a planner change against the
    // control condition of one skill left running.
    if (this.quality.length > 2880) this.quality.shift();
  }

  /**
   * Escalates when nothing is moving.
   *
   * Tracks total level and GP; flat for `STUCK_AFTER_MS` while armed means the
   * objective is not progressing and the planner needs the failure context.
   */
  private detectStuck(now: number): void {
    const snapshot = this.lastSnapshot;
    if (snapshot === null) return;

    const gp = snapshot.currencies.find((entry) => entry.id === GP_CURRENCY_ID)?.amount ?? 0;
    const marker = snapshot.totalLevel * 1e9 + gp + snapshot.completionPercent;

    if (marker !== this.lastProgressMarker) {
      this.lastProgressMarker = marker;
      this.lastProgressAt = now;
      return;
    }

    if (now - this.lastProgressAt > STUCK_AFTER_MS && this.replanPending === null) {
      this.log.warn('reflex', 'no XP, GP or completion movement for 15min; escalating');
      this.requestReplan('stuck_detected');
    }
  }

  /** Ships state to the service and applies any commands it returns. */
  private async pushReport(): Promise<void> {
    const logs = this.log.drain();
    const reply = await this.transport.report({
      runState: this.state,
      snapshot: this.lastSnapshot,
      objective: this.settings.objective,
      candidates: this.state === 'killed' ? [] : this.safeCandidates(),
      blockedOpportunities: this.state === 'killed' ? [] : this.safeBlocked(),
      logs,
      quality: this.quality.slice(-120),
      blockedReason: this.blockedReason,
    });

    if (reply === null) {
      // Degrade, never halt: keep the logs for the next attempt and carry on
      // with the last valid objective.
      this.log.requeue(logs);
      return;
    }

    for (const command of reply.commands) {
      await this.applyCommand(command);
    }
  }

  /**
   * Everything the agent can currently do, with real numbers attached.
   *
   * Enumeration is wrapped because a single malformed registry entry must not
   * take the whole report down — a planner with a short menu still works, a
   * planner with no report does not.
   */
  /**
   * Blocked opportunities, or nothing if enumeration throws.
   *
   * Never fatal: this is planning context, and losing it should not cost the
   * agent its report.
   */
  private safeBlocked(): ReturnType<typeof readBlockedOpportunities> {
    try {
      return [...readBankPressure(), ...readBlockedOpportunities(), ...this.blockedCombat()];
    } catch {
      return [];
    }
  }

  private safeCandidates(): Candidate[] {
    const candidates: Candidate[] = [];
    for (const [name, read] of [
      ['gather', readGatherCandidates],
      ['sell', readSellCandidates],
      ['shop', readShopObjectiveCandidates],
      ['equip', readEquipCandidates],
      ['mastery', readMasteryCandidates],
      ['spell', readSpellCandidates],
      ['township', readTownshipCandidates],
      ['township tasks', readTaskCandidates],
      ['combat event', readEventCandidates],
      ['worship', readWorshipCandidates],
      ['exploration', readExplorationCandidates],
      ['paper', readPaperCandidates],
      ['loadout', readLoadoutCandidates],
      ['dig site setup', readDigSiteSetupCandidates],
      ['synergy', readSynergyCandidates],
      ['raid', readRaidCandidates],
      ['agility', readAgilityCandidates],
      ['astrology', readAstrologyCandidates],
      ['compost', readCompostCandidates],
      ['passive cooking', readPassiveCookingCandidates],
      ['item upgrades', readUpgradeCandidates],
      ['town health', readTownHealthCandidates],
      ['skill tree', readSkillTreeCandidates],
      ['level cap', readLevelCapCandidates],
      ['combat', () => this.combatCandidates()],
    ] as const) {
      try {
        candidates.push(...read());
      } catch (error) {
        this.log.warn('adapter', `${name} candidate enumeration failed: ${String(error)}`);
      }
    }
    return candidates;
  }

  /**
   * Fights the agent may take, each already judged by the survivability gate.
   *
   * The gate runs here as well as at execution time, for different reasons: at
   * execution it *refuses*, and here it *filters*. A candidate is by definition
   * something the mod has proven it can execute right now, so an unsafe fight is
   * not one — it is reported through {@link safeBlocked} instead, where "you
   * cannot fight this yet, and here is why" is the most useful thing the planner
   * can learn about combat progression.
   */
  private combatCandidates(): Candidate[] {
    return this.combatEnumeration().candidates;
  }

  /** Fights that are enterable but that the gate refuses, with the reason. */
  private blockedCombat(): ReturnType<typeof readBlockedOpportunities> {
    return this.combatEnumeration().blocked;
  }

  /**
   * Enumerates and gates every reachable fight, cached.
   *
   * The gate probes a throwaway `Enemy` per monster — and per *every* monster of
   * a dungeon — so this is far too expensive to redo on each tick. Nothing it
   * depends on (levels, gear, food) changes faster than the cache window, and a
   * fight that becomes unsafe within it is still refused at execution time by
   * {@link assessTarget}, which never uses the cache.
   */
  private combatEnumeration(): {
    candidates: Candidate[];
    blocked: ReturnType<typeof readBlockedOpportunities>;
  } {
    const now = Date.now();
    if (this.combatCache !== null && now - this.combatCache.at < COMBAT_ENUMERATION_TTL_MS) {
      return this.combatCache;
    }

    const candidates: Candidate[] = [];
    const blocked: ReturnType<typeof readBlockedOpportunities> = [];

    for (const target of readCombatTargets()) {
      const refusal = this.gateRefusal(target.id);
      if (refusal !== null) {
        blocked.push({
          label: `Fight ${target.name} (combat level ${target.combatLevel}) — ${refusal}`,
          xpPerHour: 0,
          missing: [],
        });
        continue;
      }

      const where =
        target.kind === 'run_dungeon'
          ? `dungeon, hardest monster combat level ${target.combatLevel}`
          : `${target.areaName}, combat level ${target.combatLevel}`;
      const label = `Fight ${target.name} (${where})`;

      if (target.kind === 'run_dungeon') {
        candidates.push({
          kind: 'run_dungeon',
          params: { kind: 'run_dungeon', dungeonId: target.id },
          label,
          available: true,
        });
        continue;
      }

      candidates.push({
        kind: 'fight_monster',
        params: { kind: 'fight_monster', monsterId: target.id, areaId: target.areaId ?? '' },
        label,
        available: true,
      });
    }

    this.combatCache = { at: now, candidates, blocked };
    return this.combatCache;
  }

  /**
   * Runs the survivability gate silently, for enumeration.
   *
   * Shares {@link readCombatGateInputs} and `assessSurvivability` with the
   * enforcing path in {@link assessTarget}, but logs nothing: enumerating every
   * fight in the game on each snapshot would otherwise bury the journal.
   *
   * @returns The refusal reason, or null when the fight is safe.
   */
  private gateRefusal(targetId: string): string | null {
    const sessionMinutes = this.settings.objective?.abortWhen.minutesExceed ?? 30;

    const gathered = readCombatGateInputs(targetId, sessionMinutes);
    if (!gathered.ok) return gathered.detail;

    const verdict = assessSurvivability({
      ...gathered.inputs,
      autoEatThresholdFraction: normaliseFraction(gathered.inputs.autoEatThresholdFraction),
      autoEatHpLimitFraction: normaliseFraction(gathered.inputs.autoEatHpLimitFraction),
      autoEatEfficiencyFraction: normaliseFraction(gathered.inputs.autoEatEfficiencyFraction),
    });

    if (verdict.safe) return null;
    return verdict.refusals.map((refusal) => refusal.detail).join('; ');
  }

  /** Applies one operator command from the TUI or the panel. */
  private async applyCommand(command: Command): Promise<void> {
    switch (command.type) {
      case 'arm':
        await this.arm();
        break;
      case 'disarm':
        this.disarm();
        break;
      case 'kill':
        this.kill();
        break;
      case 'revive':
        this.revive();
        break;
      case 'replan':
        this.requestReplan(command.reason);
        break;
      case 'set_plan': {
        const usable = command.objectives.filter((objective) => isSupportedKind(objective.kind));
        if (usable.length === 0) {
          this.log.error('planner', 'rejected plan: no objective in it has an executor');
          return;
        }
        if (usable.length < command.objectives.length) {
          // Partial acceptance beats refusal: the executable prefix is still a
          // better night than the stopgap, and saying which parts were dropped
          // is more useful than discarding the lot.
          this.log.warn(
            'planner',
            `plan: dropped ${command.objectives.length - usable.length} objective(s) with no executor`,
          );
        }

        const [first, ...rest] = usable;
        this.settings = { ...this.settings, objective: first ?? null, plan: rest };
        this.objectiveStartedAt = Date.now();
        this.objectivelessSince = null;
        this.deathsSinceStart = 0;
        this.consecutiveActionFailures = 0;
        this.log.info(
          'operator',
          `plan set: ${usable.length} objectives, starting with ${first?.rationale ?? 'nothing'}`,
        );
        break;
      }
      case 'set_objective':
        // Already parsed by the schema; the kind check is the capability gate.
        if (!isSupportedKind(command.objective.kind)) {
          this.log.error(
            'planner',
            `rejected objective: no executor for ${command.objective.kind}`,
          );
          return;
        }
        this.settings = { ...this.settings, objective: command.objective };
        this.objectiveStartedAt = Date.now();
        this.objectivelessSince = null;
        this.deathsSinceStart = 0;
        this.consecutiveActionFailures = 0;
        this.log.info('operator', `objective set: ${command.objective.rationale}`);
        break;
      case 'dump_knowledge':
        await this.dumpKnowledge();
        break;
      case 'export_save': {
        const result = exportSave();
        if (result.ok) {
          await this.transport.uploadSave(result.save, 'commanded');
          this.log.info('operator', 'save exported');
        } else {
          this.log.error('operator', `save export failed: ${result.detail}`);
        }
        break;
      }
    }
    this.notify();
  }

  /**
   * Exports the game's registries and ships them to the service.
   *
   * Runs from inside the game because only the running game knows its own
   * registries, and they are correct for the exact installed version in a way
   * no offline source is. The service writes the file; the mod cannot.
   *
   * @returns Whether the dump was captured and stored.
   */
  async dumpKnowledge(): Promise<boolean> {
    let dump: ReturnType<typeof dumpRegistries>;
    try {
      dump = dumpRegistries();
    } catch (error) {
      this.log.error('adapter', `knowledge dump failed to read registries: ${String(error)}`);
      return false;
    }

    const stored = await this.transport.uploadDump(dump);
    if (!stored) {
      this.log.error(
        'runtime',
        `dump captured for ${dump.gameVersion} (${dump.skills.length} skills) but could not be sent to ${this.settings.serviceUrl}: ${this.transport.error ?? 'unreachable'}. Is the planner service running?`,
      );
      return false;
    }

    this.log.info(
      'runtime',
      `knowledge dump stored for ${dump.gameVersion} (${dump.skills.length} skills, ${dump.monsters.length} monsters)`,
    );
    // A fresh dump may clear a version_mismatch block, so let the operator retry.
    if (this.state === 'blocked') {
      this.blockedReason = null;
      this.state = 'idle';
    }
    return true;
  }

  /** Replaces settings wholesale, e.g. after a panel edit. */
  updateSettings(next: AgentSettings): void {
    this.settings = next;
    this.notify();
  }
}

import { checkDumpFreshness } from '@melvor-agent/knowledge';
import type {
  ActionResult,
  BlockedOpportunity,
  Candidate,
  Command,
  DamageRisk,
  DamageRiskBasis,
  JournalEntry,
  Objective,
  Outcome,
  QualitySample,
  RunState,
  StalledCounter,
  StateSnapshot,
} from '@melvor-agent/shared';
import {
  checkArmHealth,
  describeDamageRisk,
  fail,
  orderDamagingCandidates,
  stateSnapshotSchema,
  stockTargetsOf,
  summariseResult,
} from '@melvor-agent/shared';
import {
  type StockDemand,
  Subscriptions,
  THIEVING_ID,
  advanceGolbinRaid,
  annotateStockDemand,
  buildAgilityObstacle,
  buildTownshipBuilding,
  buryBones,
  buyShopPurchase,
  changeEquipmentSet,
  checkCharacterAllowed,
  checkRealmAllowed,
  chooseEventPassive,
  claimCasualTask,
  claimMasteryToken,
  claimTownshipTask,
  collectCookedStockpile,
  collectLoot,
  compostFarmPlot,
  convertItemToTownship,
  convertTownshipToItem,
  createDigSiteMap,
  describeMatchup,
  disengageCombat,
  dumpRegistries,
  eatFood,
  engageMonster,
  equipFood,
  equipItem,
  excavateDigSite,
  exportSave,
  harvestFarmPlot,
  hasAutoEat,
  hasStashedValuables,
  increaseTownHealth,
  mergeDemands,
  newSlayerTask,
  onGameEvent,
  openItem,
  plantFarmPlot,
  readActivatablePrayers,
  readActivePrayerIds,
  readActiveRecipeIds,
  readAdapterFailures,
  readAgilityCandidates,
  readAstrologyCandidates,
  readBankExpansion,
  readBankPressure,
  readBankQuantity,
  readBankedFood,
  readBlockedOpportunities,
  readBoneCandidates,
  readBuriableBones,
  readCheapPermanentUpgrades,
  readCheapestExpendableStack,
  readClaimableTasks,
  readCombatGateInputs,
  readCombatLevelScreenInputs,
  readCombatSetupCandidates,
  readCombatTargets,
  readCompostCandidates,
  readCookedStockpile,
  readDeathCount,
  readDigSiteSetupCandidates,
  readDungeonPricing,
  readEquipCandidates,
  readEquipmentSetCandidates,
  readEquippedFood,
  readEquippedFoodHealing,
  readEventCandidates,
  readExplorationCandidates,
  readFarmCandidates,
  readFarmPlots,
  readFightPricing,
  readGameVersion,
  readGatherCandidates,
  readGearUpgrades,
  readHeldCompost,
  readInCombat,
  readLapsingPotions,
  readLevelCapCandidates,
  readLoadoutCandidates,
  readLockedActions,
  readMasteryCandidates,
  readMasteryTokenCandidates,
  readMealCount,
  readModifierGearNotice,
  readMonsterDropsOfInterest,
  readMostValuableExpendableStack,
  readNextContainer,
  readOpenableCandidates,
  readPaperCandidates,
  readPassiveCookingCandidates,
  readPenalisingGear,
  readPlantableSeeds,
  readPlayerHitpoints,
  readRaidCandidates,
  readRefillableAmmo,
  readRepairableBuildings,
  readSellCandidates,
  readShopGoalNotice,
  readShopObjectiveCandidates,
  readShortSeedIds,
  readSkillTreeCandidates,
  readSlayerCandidates,
  readSnapshot,
  readSpellCandidates,
  readSpentChargesNotice,
  readStrippableValuables,
  readSynergyCandidates,
  readTaskCandidates,
  readTaskOpportunities,
  readTaskStockDemands,
  readTaskWantedItemIds,
  readTownHealthCandidates,
  readTownshipCandidates,
  readTownshipGoodsCandidates,
  readTraderCandidates,
  readTravelCandidates,
  readTriangleMatchup,
  readUnfightableCombat,
  readUnsellableNotice,
  readUpgradeCandidates,
  readWorshipCandidates,
  reloadGame,
  repairAllTownshipBuildings,
  repairTownshipBuilding,
  restoreStashedValuables,
  selectAttackSpell,
  selectDigSiteMap,
  selectDigSiteTool,
  selectLevelCapIncrease,
  selectTownshipWorship,
  sellItem,
  setAttackStyle,
  setPotionAutoReuse,
  shouldCollectLoot,
  spendMasteryPool,
  startCombatEvent,
  startDungeon,
  startGathering,
  startGolbinRaid,
  startPaperMaking,
  startPassiveCooking,
  stashValuablesForCombat,
  stopGathering,
  stopGolbinRaid,
  surveyBestHex,
  toggleAurora,
  toggleBankLock,
  toggleCurse,
  togglePrayer,
  travelToPointOfInterest,
  unequipItem,
  unlockFarmPlot,
  unlockSkillTreeNode,
  upgradeBankItem,
  upgradeConstellation,
  usePotion,
} from '../adapter/index.js';
import {
  assessSurvivability,
  levelScreenPressure,
  normaliseFraction,
  screenByCombatSkillLevels,
  survivabilityPressure,
} from '../policy/combat-gate.js';
import { progressMarker } from '../policy/criteria.js';
import { executorFor, isSupportedKind } from '../policy/index.js';
import { STOPGAP_DELAY_MS, chooseStopgap } from '../policy/stopgap.js';
import type { PolicyAction } from '../policy/types.js';
import { readBuildStamp } from './build-stamp.js';
import {
  abandonIfOutmatched,
  activateCheapestPrayer,
  buryBonesWhenHeld,
  buyTrivialUpgrades,
  claimFinishedTasks,
  claimMasteryTokens,
  collectPendingLoot,
  collectStockpiledFood,
  compostBeforePlanting,
  cookWhenFoodLow,
  dropUnpayablePrayers,
  eatWhenLow,
  expandBankWhenFull,
  fillEmptySlots,
  harvestReadyPlots,
  keepPotionsActive,
  liquidateSurplus,
  openPendingContainers,
  plantEmptyPlots,
  refillFood,
  refillQuiver,
  removePenalisingGear,
  repairDegradedBuildings,
  restoreValuablesAfterCombat,
  sellToEscapeFullBank,
  stopWhenStarving,
  stripValuablesForFight,
  unlockAffordablePlots,
} from './combat-reflex.js';
import { DeathWatch } from './death-watch.js';
import { JournalBuffer } from './journal.js';
import type { Logger } from './logger.js';
import { LoopStallWatch } from './loop-stall.js';
import {
  type ObjectiveMetrics,
  fundingStanding,
  objectiveDeltas,
  objectiveMetrics,
  snapshotGp,
} from './metrics.js';
import { NoMovementWatch, readObjectiveCounter } from './no-movement.js';
import { QualityWindow } from './quality-window.js';
import { type LaunchOutcome, canLaunchService, launchPlannerService } from './service-launcher.js';
import { recallRepoPath } from './service-url-cache.js';
import { StuckEquipWatch } from './stuck-equip.js';
import { describeStuckAttention, stuckReplanDelayMs } from './stuck.js';
import type { Transport } from './transport.js';

/** How often the policy tier evaluates the objective. */
const POLICY_INTERVAL_MS = 3000;
/** Minimum gap between reflex passes, throttling the per-tick hook. */
/**
 * Consecutive unreadable snapshots before the agent stops.
 *
 * More than one, because a single malformed read can be a value caught
 * mid-transition. Few, because acting on a snapshot that does not parse is
 * acting blind.
 */
const SNAPSHOT_FAILURES_BEFORE_BLOCK = 5;

const REFLEX_THROTTLE_MS = 1000;
/**
 * How long a reflex stays quiet after a call that changed nothing.
 *
 * Long enough that an unchanging refusal is a line a minute rather than one a
 * second, short enough that a genuinely stuck agent still says so while anyone
 * is reading. The reflex keeps running; only the complaining pauses.
 */
const REFLEX_BACKOFF_MS = 60_000;
/** How often a quality sample is taken for the progress-per-hour metric. */
const QUALITY_SAMPLE_INTERVAL_MS = 60_000;
/** Flat progress for this long with automation on means we are stuck. */
const STUCK_AFTER_MS = 15 * 60_000;

/**
 * How long a suspension may last before the agent forces its way out.
 *
 * Offline progress is a bounded calculation -- the game caps it at 24 hours of
 * simulated time and resolves it in seconds -- so a suspension outlasting this
 * is not catch-up in progress, it is an `offlineLoopExited` that never arrived.
 * And that is a total failure: `tickPolicy` returns immediately while
 * suspended, so all three tiers stop, no report is pushed, and the service sees
 * only `connected: false` with no reason attached. Nothing recovers on its own.
 *
 * Ten minutes is generous against a calculation measured in seconds, and short
 * enough that an unattended night loses minutes rather than all of it.
 */
const SUSPEND_TIMEOUT_MS = 600_000;

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

/**
 * Under this, a completion happened before the objective could have acted.
 *
 * Ten seconds against a policy tier that ticks every three: an objective that
 * satisfies its criteria this fast satisfied them on adoption. It is not a
 * threshold on how much work counts, it is the gap between "the criteria were
 * met by doing the work" and "the criteria were met already" — which the log
 * could not tell apart while a three-step plan emptied in nine seconds.
 */
const NO_OP_COMPLETION_MS = 10_000;

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
  /**
   * Absolute path to the repository, so the panel can start the planner.
   *
   * Empty by default and never guessed: a wrong path spawns a process that
   * fails somewhere the operator cannot see it.
   */
  repoPath: string;
  objective: Objective | null;
  /**
   * Objectives to take up, in order, as the current one ends.
   *
   * Persisted with everything else, so a plan survives a reload — which is the
   * point: the session that wrote it is usually long gone by the time the
   * second entry starts.
   */
  plan: Objective[];
  /**
   * The game's lifetime death counter as of the last run, or null on a first
   * boot.
   *
   * Persisted so a death that happened while the mod was not loaded can be
   * detected at all. Offline progression replays elapsed time before any reflex
   * exists -- that is how this character died last time, mid-Thieving during a
   * reload -- and by the time the arming path runs, the only evidence left is
   * that this number is higher than it was.
   */
  lastDeathCount: number | null;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  enabled: false,
  characterAllowlist: [],
  serviceUrl: 'http://localhost:8787',
  repoPath: '',
  objective: null,
  plan: [],
  lastDeathCount: null,
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

/**
 * Intents that abandon work already running, rather than starting some.
 *
 * These are the ones whose *reason* is worth a line: "the game stopped doing
 * the thing it was doing" is never self-explanatory, and the reason is the only
 * thing that distinguishes a safety floor from a slot handover from an
 * operator's replan. See the use in {@link Agent.perform}.
 */
const STOPS_WORK_IN_PROGRESS: ReadonlySet<PolicyAction['type']> = new Set([
  'disengage',
  'stop_gathering',
  'stop_raid',
]);

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

  /**
   * Deaths, and the baseline they are counted from.
   *
   * `null` until the first reading, so arming does not report the character's
   * entire history as deaths that just happened. See {@link DeathWatch}.
   */
  private readonly deaths = new DeathWatch();

  /** Game-loop ticks since load. The only evidence the loop is alive. */
  private tickCount = 0;

  /** The state suspension interrupted, so resuming restores rather than promotes. */
  private stateBeforeSuspend: RunState | null = null;

  /** Objectives finished since the last report, shipped and then cleared. */
  private readonly journal = new JournalBuffer();

  /** Metrics captured when the current objective began, for measured deltas. */
  private objectiveStartMetrics: ObjectiveMetrics | null = null;

  /** Consecutive snapshot validation failures; reset by any success. */
  private snapshotFailures = 0;

  /**
   * Whether the loop is still ticking, compared from the policy timer.
   *
   * Holds the previous tick count, when the loop was first seen not to tick,
   * and whether the current stall has already been reported. See
   * {@link LoopStallWatch}.
   */
  private readonly loopStall = new LoopStallWatch();
  private readonly quality = new QualityWindow();
  /**
   * When a reflex that changed nothing may complain again, keyed by name and
   * detail. See runReflexes: an unchanging refusal repeated every tick is how a
   * real warning gets buried.
   */
  private readonly reflexBackoff = new Map<string, number>();
  private lastProgressAt = Date.now();
  private lastProgressMarker = -1;
  /** Whether the current stuck episode has already been reported; see detectStuck. */
  private stuckReported = false;
  /** Replans issued for the current stuck episode; drives the backoff. */
  private stuckEscalations = 0;
  /** When the next stuck replan may be issued. Zero while nothing is stuck. */
  private nextStuckReplanAt = 0;
  /** When the offline loop suspended the agent, or null while it is not suspended. */
  private suspendedAt: number | null = null;
  /**
   * A condition only a human can clear, shipped on every report.
   *
   * See the `needsAttention` field on the report schema: the agent has three
   * ways to end up going nowhere and, before this, two of them were silent.
   */
  private attention: string | null = null;
  /** The blocked opportunities last shipped, so the panel can show the urgent ones. */
  private lastBlocked: BlockedOpportunity[] = [];

  /**
   * Stock shortfalls from the last blocked enumeration, keyed by item.
   *
   * Held here rather than recomputed by {@link safeCandidates} because the
   * blocked walk is what produces them and it covers every recipe of every
   * skill -- doing it twice a report to answer the same question would be the
   * expensive half of enumeration paid twice. See {@link stockDemands} for why
   * the two calls are ordered.
   */
  private lastDemands: ReadonlyMap<string, StockDemand> = new Map();
  private replanPending: string | null = null;
  /** Guards against overlapping planner calls while one is in flight. */
  private replanning = false;
  /** Consecutive failed actions for the current objective. */
  private consecutiveActionFailures = 0;

  /**
   * Watches the counter the current objective's success condition names.
   *
   * Sits beside `detectStuck` rather than inside it: that one asks whether the
   * character is going anywhere at all over fifteen minutes, this one asks
   * whether the specific number this objective was chosen to move is moving
   * while its actions all report success. Agility answered yes to the first and
   * no to the second for fifteen minutes, at zero XP.
   */
  private readonly noMovement = new NoMovementWatch();

  /**
   * Catches an equip that verifies and is then undone; see StuckEquipWatch.
   *
   * Paired with `lastEquipAttempt`, because the check has to happen a tick
   * later than the call -- the adapter's `ok` was truthful at the moment it
   * looked, and the reversion happens after that.
   */
  private readonly stuckEquip = new StuckEquipWatch();

  private lastEquipAttempt: { itemId: string; slotId: string } | null = null;

  /** The stall last detected, with the objective it belongs to. Null while healthy. */
  private stalled: { objectiveId: string; evidence: StalledCounter } | null = null;
  /** Plan steps already retried once, so a refused step cannot loop forever. */
  private readonly requeuedSteps = new Set<string>();

  /** The last refusal, surfaced to the planner so it does not re-choose it. */
  private lastRefusal: { action: string; detail: string; at: number } | null = null;
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

  /** A condition needing a person, or null. See the report's `needsAttention`. */
  get needsAttention(): string | null {
    return this.attention;
  }

  /**
   * Blocked opportunities from the last report.
   *
   * Exposed so the panel can promote the urgent ones instead of shipping them
   * exclusively to a planning session that may not be attached. Read from the
   * cache rather than recomputed: enumeration walks every recipe of every
   * skill, and the panel re-renders on every state change.
   */
  get blockedOpportunities(): BlockedOpportunity[] {
    return this.lastBlocked;
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
  /** Levels and GP per hour across the sample window; see {@link QualityWindow}. */
  get progressRate(): { hours: number; levelsPerHour: number; gpPerHour: number } | null {
    return this.quality.progressRate;
  }

  /** Whether this build could start the planner; see the service launcher. */
  get canLaunchService(): boolean {
    return canLaunchService();
  }

  /**
   * Starts the planner service from the game.
   *
   * Only ever called from the panel, and only offered while the service is
   * actually unreachable — see the launcher for why this is a button and not a
   * supervisor.
   */
  startPlannerService(): LaunchOutcome {
    // The remembered path, falling back to the configured one.
    //
    // `settings.repoPath` arrives *from* the planner service, and this button
    // exists precisely for when that service is unreachable -- so on the boot
    // after a crash the configured value is `''` and the launcher refuses. The
    // remembered copy is written whenever settings do arrive, which makes the
    // relaunch possible in the one case it is for. See service-url-cache.
    const outcome = launchPlannerService(recallRepoPath(this.settings.repoPath));
    if (outcome.ok) this.log.info('operator', `planner service: ${outcome.detail}`);
    else this.log.error('operator', `planner service: ${outcome.detail}`);
    this.notify();
    return outcome;
  }

  /** When the running bundle was built; see the build stamp module. */
  get buildStamp(): string | null {
    return readBuildStamp();
  }

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
        // Remembered so resuming restores what was suspended rather than
        // promoting it; see offlineLoopExited.
        this.stateBeforeSuspend = this.state;
        this.state = 'suspended';
        // Timed, because nothing else here is. `offlineLoopExited` is the only
        // way out and it is an event the mod does not control; if it never
        // fires the agent stays suspended forever with every tier stopped.
        this.suspendedAt = Date.now();
        this.notify();
      }),
    );

    this.subscriptions.add(
      onGameEvent('offlineLoopExited', () => {
        if (this.state !== 'suspended') return;
        this.resumeFromSuspension('offline_loop_exited', 'offline loop exited');
      }),
    );

    this.startClocks();
  }

  /**
   * Leaves the suspended state, whether the game said so or the clock did.
   *
   * A blocked agent must come back blocked.
   *
   * Resuming to `running` on `settings.enabled` alone was a guard that failed
   * open on a timer. `enabled` stays true when arming fails -- arm() only
   * clears it on success -- so an agent blocked on the wrong character, a stale
   * dump or an unreachable planner needed only a sixty-second stall to be
   * promoted straight back to running, with none of the checks re-run. The
   * character allowlist exists precisely to stop days of unattended play on the
   * wrong save, and an idle window defeated it.
   *
   * @param trigger - Replan trigger; the forced exit uses `stuck_detected`
   *                  because the resume is a recovery, not a normal catch-up.
   * @param reason - How the suspension ended, for the log line.
   */
  private resumeFromSuspension(trigger: string, reason: string): void {
    this.suspendedAt = null;

    if (this.stateBeforeSuspend === 'blocked') {
      this.state = 'blocked';
      this.stateBeforeSuspend = null;
      this.log.warn('runtime', `${reason}; still blocked: ${this.blockedReason ?? 'unknown'}`);
      this.notify();
      return;
    }

    this.stateBeforeSuspend = null;
    // Hours may have passed. The stored objective's success and abort
    // conditions are re-validated against a fresh snapshot before resuming;
    // this is the normal path, not an edge case.
    this.log.info('runtime', `${reason}; re-snapshotting and replanning`);
    this.requestReplan(trigger);
    this.state = this.settings.enabled ? 'running' : 'idle';
    this.tickPolicy();
    this.notify();
  }

  /**
   * The policy tick while suspended: report, and time the suspension out.
   *
   * Two failures met in the old early return. Nothing was reported at all, so
   * the service could only observe `connected: false` -- which is also what a
   * closed game looks like, and what a dead machine looks like. And nothing
   * bounded the wait, so a missing `offlineLoopExited` left every tier stopped
   * with no route back except a person noticing.
   *
   * The report is state-only. Reading the game mid catch-up is exactly what
   * suspension exists to prevent (`readSnapshot` says so), so the snapshot and
   * both enumerations are omitted rather than being sent stale. Saying "I am
   * suspended, since 03:11" is the entire point.
   */
  private tickSuspended(): void {
    const since = this.suspendedAt;
    const elapsed = since === null ? 0 : Date.now() - since;

    if (since !== null && elapsed > SUSPEND_TIMEOUT_MS) {
      const minutes = Math.round(elapsed / 60_000);
      this.attention = `offline progress has been resolving for ${minutes}min; the game never signalled that it finished. Forcing the agent back out — check that the game loop is running.`;
      this.log.error('runtime', this.attention);
      // `stuck_detected` rather than `offline_loop_exited`: the agent is being
      // recovered from a stall, and the trigger the planner sees should say so.
      this.resumeFromSuspension('stuck_detected', `suspension timed out after ${minutes}min`);
      return;
    }

    void this.pushReport({ stateOnly: true });
  }

  /**
   * The reflex tier, called from the game loop.
   *
   * Throttled internally because the game loop ticks far faster than any reflex
   * needs to run. Kept deliberately small: reflexes are deterministic and never
   * involve the planner.
   */
  onGameTick(): void {
    // Counted before the throttle, and before anything that can throw.
    //
    // This is the only proof the game loop is alive. Reporting runs on an
    // independent setInterval, so when the loop dies the agent goes on shipping
    // `running` with a snapshot naming the last skill -- indistinguishable from
    // healthy idling, which is exactly how a crash spent an hour looking like a
    // working character.
    this.tickCount += 1;

    if (this.state !== 'running') return;
    const now = Date.now();
    if (now - this.lastReflexAt < REFLEX_THROTTLE_MS) return;
    this.lastReflexAt = now;

    // Nothing may escape into the patched Game.loop.
    //
    // The doc on runReflexes says failures are logged and swallowed, and that
    // was only ever true of failures inside act(): the reflex list is built by
    // calling every reader eagerly, and several of those readers walk the bank
    // with no guard of their own. So one corrupt entry -- the "ids don't match"
    // class of crash -- threw before eatWhenLow, stopWhenStarving and
    // refillFood were even reached, and if the condition persisted the
    // character had no eating and no starvation stop for the rest of the run
    // while the policy tier reported a healthy skill.
    try {
      this.detectStuck(now);
      this.runReflexes();
    } catch (error) {
      this.log.error('reflex', `reflex tier threw, skipping this tick: ${String(error)}`);
    }
  }

  /**
   * Reactions that cannot wait for the policy tier, run from the tick loop.
   *
   * Not restricted to fights: auto-eat can empty a food slot in
   * seconds, and the survivability gate's argument — "this fight is winnable
   * because there is food" — stops being true the moment it does. Topping the
   * slot back up keeps that argument true instead of abandoning the fight.
   *
   * Failures are logged and swallowed. A reflex that cannot fire must never
   * take the tick loop down with it; the policy tier's HP and food floors are
   * still there, and they end the fight safely on their own.
   */
  private runReflexes(): void {
    const snapshot = this.lastSnapshot;
    // Deliberately not gated on combat. Damage is not exclusive to it — a
    // failed pickpocket hurts — and loot outlives the fight that produced it.
    // This gate is what silently disabled eating during Thieving: fixing the
    // reflex alone changed nothing, because it was never called.
    if (snapshot === null) return;

    const isSuspended = (): boolean => this.state === 'suspended';
    // The slot the game will actually eat from. Indexing by
    // `selectedEquipmentSet` read an empty slot while food sat in the next one,
    // so every reflex concluded there was nothing to eat and the character
    // died with 33 chickens equipped.
    // The slot the game will eat from, or any slot that actually holds food.
    //
    // Two mistakes lived here. The first indexed by `selectedEquipmentSet`,
    // which is a different number entirely. The second used `??`, which does
    // not fire for an *empty* slot — the entry exists, it just has a quantity
    // of zero — so a character with 33 chickens in slot 1 and a selected slot
    // of 0 still read as having nothing to eat, and died.
    const selected = snapshot.combat.food[snapshot.combat.selectedFoodSlot];
    const slot =
      selected !== undefined && selected.qty > 0
        ? selected
        : (snapshot.combat.food.find((entry) => entry.qty > 0) ?? selected);

    const liveFood = readEquippedFood();
    // Judge last tick's equip before choosing this tick's. The adapter's `ok`
    // was honest about the moment it looked; only a later tick can show that
    // the slot was put back. See StuckEquipWatch.
    const attempted = this.lastEquipAttempt;
    this.lastEquipAttempt = null;
    if (attempted !== null) {
      const worn =
        snapshot.combat.equipment.find((entry) => entry.slot === attempted.slotId)?.itemId ?? null;
      const wasStuck = this.stuckEquip.isStuck(attempted.itemId);
      this.stuckEquip.record(attempted.itemId, worn);

      // Once, on the transition. A line every tick for a condition that
      // persists is the noise that has twice buried real diagnostics here.
      if (!wasStuck && this.stuckEquip.isStuck(attempted.itemId)) {
        this.log.error(
          'policy',
          // Names the suspects rather than blaming the game. The first version
          // of this line said "the game is reverting it", and it was wrong: the
          // loop it was written for was this agent's own objective tier and
          // reflex tier equipping different weapons into one slot on different
          // clocks. Whatever took the slot back is worth looking for before it
          // is assumed.
          `equipping ${attempted.itemId} into ${attempted.slotId} verified and was then undone three times running (slot now holds ${worn ?? 'nothing'}); something is taking the slot back between ticks — check whether the running objective wants a different item there before suspecting the game — so it will not be retried`,
        );
      }
    }

    // Nothing while a fight's stripped valuables are still set aside.
    //
    // Two reasons, and the second is the one that bites. Offering the stashed
    // item itself would have the fill reflex undo the strip between the engage
    // and the first punch. And offering anything *else* for those slots is
    // acting on a picture that this very tick is about to invalidate: the
    // restore below runs first and fills them, so an equip chosen from the
    // empty view would displace the item that just went back on — two tiers
    // trading one slot, which is the shape that produced forty verified equips
    // a minute for forty minutes.
    //
    // Standing down for the tick that restores is free; the fill reflex runs
    // every tick and the slots are honest again on the next one.
    const gearUpgrades = hasStashedValuables()
      ? { emptySlot: [], replacement: [] }
      : readGearUpgrades();

    // Read live rather than from the snapshot. The snapshot refreshes only on
    // report, so a reflex could not see the effect of its own previous tick and
    // retried a plot it had just finished — "already fully composted", once a
    // second. Every farm reflex below shares this, so they compose correctly
    // within a single tick too.
    const livePlots = readFarmPlots();

    const outcomes = [
      refillFood(
        {
          inCombat: snapshot.combat.inCombat,
          // Live, like the hitpoints above. Reading the slot and the bank from
          // the snapshot meant acting on a picture that refreshes only on
          // report, which produced hundreds of harmless-but-loud failures.
          equippedFoodId: liveFood.itemId,
          equippedFoodQty: liveFood.quantity,
          bankQuantityOf: liveFood.bankQuantityOf,
          // Any food in the bank, so an empty slot can be refilled rather than
          // only topped up. Named by the snapshot's own item list, which is
          // already filtered to what the character actually holds.
          bankedFood: readBankedFood(),
          equippedFoodHeals: readEquippedFoodHealing(),
        },
        (itemId, quantity) => equipFood(itemId, quantity, isSuspended),
      ),
      // Runs after the refill, so a slot that just emptied is topped up before
      // the eat is attempted rather than failing on an empty slot.
      eatWhenLow(
        {
          // Live, not from the snapshot. A snapshot refreshes on report, so the
          // reflex was both retrying an eat it had already made and — the half
          // that actually matters — able to read a healthy figure for a
          // character that had since been hurt, and decline to eat at all.
          ...readPlayerHitpoints(),
          equippedFoodQty: slot?.qty ?? 0,
          autoEatThresholdFraction: normaliseFraction(snapshot.combat.autoEatThreshold),
        },
        () => eatFood(isSuspended),
      ),
      // Same shape as opening a container: holding a token does nothing, and
      // there is no judgement between holding and claiming.
      claimMasteryTokens(
        {
          tokens: readMasteryTokenCandidates().map((candidate) => ({
            itemId: String((candidate.params as { itemId?: unknown }).itemId ?? ''),
            quantity: Number((candidate.params as { quantity?: unknown }).quantity ?? 0),
          })),
        },
        (itemId, quantity) => claimMasteryToken(itemId, quantity, isSuspended),
      ),
      // Bones, for the same reason and in the same tier: nothing else consumes
      // them, they occupy a bank slot the bank is always short of, and burying
      // is the only thing that produces the points Prayer is trained by
      // spending. Both halves of Prayer were candidates nobody ever picked.
      buryBonesWhenHeld(
        {
          prayerPoints: snapshot.combat.prayerPoints,
          bones: readBuriableBones(),
          // What the running objective is trying to bank, so this reflex cannot
          // destroy the thing the objective tier is working towards. A Township
          // task wanting 10,000 Bones held the bank at 0 through a whole grind;
          // see buryBonesWhenHeld for why the reserve is the *adopted*
          // objective rather than every task the game could ever offer.
          reserved: stockTargetsOf(this.settings.objective),
        },
        (itemId, quantity) => buryBones(itemId, quantity, isSuspended),
      ),
      // An active potion that lapses mid-objective is a decision the planner
      // made expiring silently. The reader offers nothing unless a replacement
      // is already banked, so this can never enable a re-use with nothing to
      // re-use.
      keepPotionsActive({ lapsing: readLapsingPotions() }, (actionId) =>
        setPotionAutoReuse(actionId, true, isSuspended),
      ),
      // Before every gear reflex below, and unconditionally on the fight being
      // over. This is what pays back the strip that happens at the engage
      // gate, and the ending it must not miss is death: `applyDeathPenalty`
      // (player.d.ts:410) is the whole reason anything came off, so the fight
      // that ends by dying is the fight whose restore matters most.
      restoreValuablesAfterCombat(
        {
          // Read live, not from the snapshot. On the throttled snapshot this
          // fired one second into every fight and put the valuables straight
          // back on -- undoing the protection the strip exists for, at the one
          // moment `applyDeathPenalty` can charge for it. See readInCombat.
          inCombat: readInCombat(),
          hasStashedValuables: hasStashedValuables(),
        },
        () => restoreStashedValuables(isSuspended),
      ),
      // Gear the character is plainly missing. An empty slot has nothing on the
      // other side of the trade; a replacement must clear a margin.
      fillEmptySlots(
        {
          inCombat: snapshot.combat.inCombat,
          emptySlotGear: gearUpgrades.emptySlot,
          replacements: gearUpgrades.replacement,
          stuckEquipIds: this.stuckEquip.ids(),
        },
        (itemId, slotId) => {
          this.lastEquipAttempt = { itemId, slotId };
          return equipItem(itemId, slotId, isSuspended);
        },
      ),
      // Food, before anything that spends it. Passive cooking does not take the
      // action slot, so this is free alongside whatever is running.
      cookWhenFoodLow(
        {
          meals: readMealCount(),
          hasAutoEat: hasAutoEat(),
          idleCategoryIds: readPassiveCookingCandidates().map((candidate) =>
            String((candidate.params as { categoryId?: unknown }).categoryId ?? ''),
          ),
        },
        (categoryId) => startPassiveCooking(categoryId, isSuspended),
      ),
      // Before every food reflex below, deliberately. Passive cooking leaves
      // its output in a stockpile that readMealCount cannot see, so collecting
      // first is what makes the meal count those reflexes read a true one.
      collectStockpiledFood({ stockpiled: readCookedStockpile() }, (categoryId) =>
        collectCookedStockpile(categoryId, isSuspended),
      ),
      // And the last line: stop paying health for XP when the health cannot be
      // bought back. This character starved to death without it.
      stopWhenStarving(
        {
          meals: readMealCount(),
          hasAutoEat: hasAutoEat(),
          ...readPlayerHitpoints(),
          damagingSkillId:
            snapshot.activeAction?.id === THIEVING_ID ? (snapshot.activeAction?.id ?? null) : null,
          inCombat: snapshot.combat.inCombat,
        },
        (damaging) =>
          damaging.kind === 'combat'
            ? disengageCombat(isSuspended)
            : stopGathering(damaging.skillId, isSuspended),
      ),
      openPendingContainers({ hasContainer: readNextContainer() !== null }, () => {
        const container = readNextContainer();
        return container === null
          ? fail('bank.openItem', 'precondition', 'no container to open')
          : openItem(container.itemId, container.quantity, isSuspended);
      }),
      collectPendingLoot(
        { inCombat: snapshot.combat.inCombat, hasLootWorthTaking: shouldCollectLoot() },
        () => collectLoot(isSuspended),
      ),
      // Before the farm reflexes, because a full bank loses whatever they
      // harvest just as surely as it loses an artefact.
      expandBankWhenFull(
        {
          freeSlots: snapshot.bank.slotsMax - snapshot.bank.slotsUsed,
          expansion: readBankExpansion(),
        },
        (purchaseId) => buyShopPurchase(purchaseId, 1, isSuspended),
      ),
      // Before the last-resort sale below, and above zero free slots: selling
      // the most valuable surplus while there is still headroom is the
      // profitable trade, where selling the cheapest stack at zero is only
      // damage control. See liquidateSurplus.
      liquidateSurplus(
        {
          freeSlots: snapshot.bank.slotsMax - snapshot.bank.slotsUsed,
          best: readMostValuableExpendableStack(),
          // The objective's own funding target, not a figure invented here. It
          // is what lets the agent finish a GP goal unattended, and it is
          // absent unless the operator wrote one -- so with no goal the reflex
          // behaves exactly as it did before. See fundingStanding.
          funding: fundingStanding(snapshot, this.settings.objective),
        },
        (itemId, quantity) => sellItem(itemId, quantity, isSuspended),
      ),
      // Last resort, after the slot purchase above has had its chance: a full
      // bank with no affordable slot is a permanent stop, and one cheap stack
      // is cheaper than that. See sellToEscapeFullBank.
      sellToEscapeFullBank(
        {
          freeSlots: snapshot.bank.slotsMax - snapshot.bank.slotsUsed,
          canBuySlot: (() => {
            const slot = readBankExpansion();
            return slot !== null && slot.gpCost <= slot.held;
          })(),
          expendable: readCheapestExpendableStack(),
        },
        (itemId, quantity) => sellItem(itemId, quantity, isSuspended),
      ),
      // After the bank slot, which is the one purchase that pays for itself
      // immediately, and before anything that spends time: a permanent -5%
      // interval is worth more the earlier it is bought.
      buyTrivialUpgrades(
        {
          gp: snapshotGp(snapshot),
          upgrades: readCheapPermanentUpgrades(),
        },
        (purchaseId) => buyShopPurchase(purchaseId, 1, isSuspended),
      ),
      // After the bank reflexes above, deliberately: unequipping puts the item
      // back in the bank, so a slot must exist before the gear can come off.
      removePenalisingGear(
        {
          inCombat: snapshot.combat.inCombat,
          penalising: readPenalisingGear(),
        },
        (slotId) => unequipItem(slotId, isSuspended),
      ),
      // Its sibling, sharing this position for the same bank-slot reason. That
      // one takes off gear which actively hurts the style in use; this one
      // takes off gear the fight has no use for at all, which is the case
      // nothing covered — a Jeweled Necklace hurts nothing, so it rode into
      // all 55 deaths while `applyDeathPenalty` rolled for it every time.
      stripValuablesForFight(
        {
          // Live, for the reason its partner above documents: on the snapshot
          // this fired one second *after* each disengage, stripping a
          // character who had stopped fighting.
          inCombat: readInCombat(),
          strippable: readStrippableValuables().length,
        },
        () => stashValuablesForCombat(isSuspended),
      ),
      // Farming does not occupy the action slot, so a ready plot can be
      // cleared without interrupting anything. Left to the objective tier it
      // would idle a whole growth cycle waiting.
      harvestReadyPlots(
        {
          readyPlotIds: livePlots
            .filter((plot) => plot.state === 'grown' || plot.state === 'dead')
            .map((plot) => plot.id),
        },
        (plotId) => harvestFarmPlot(plotId, isSuspended),
      ),
      // Finished work the town is sitting on. Free, and it unblocks the slot
      // so the next task can start.
      claimFinishedTasks({ claimable: readClaimableTasks() }, (kind, taskId) =>
        kind === 'casual'
          ? claimCasualTask(taskId, isSuspended)
          : claimTownshipTask(taskId, isSuspended),
      ),
      // A decayed building produces less every tick it stays decayed, and the
      // resources that pay for the repair are generated passively by the town
      // itself. Waiting for a planning session to notice is pure loss.
      repairDegradedBuildings({ repairable: readRepairableBuildings() }, (buildingId, biomeId) =>
        repairTownshipBuilding(buildingId, biomeId, isSuspended),
      ),
      // Ahead of every other farm reflex: a plot that does not exist cannot be
      // composted, planted or harvested.
      unlockAffordablePlots(
        { unlockablePlotIds: livePlots.filter((plot) => plot.canUnlock).map((plot) => plot.id) },
        (plotId) => unlockFarmPlot(plotId, isSuspended),
      ),
      // Before planting: compost laid down first protects the entire growth
      // cycle, and an uncomposted crop has only a 50% chance to grow.
      compostBeforePlanting(
        {
          bareplotIds: livePlots
            .filter((plot) => plot.state === 'empty' && plot.compostLevel < 100)
            .map((plot) => plot.id),
          compost: readHeldCompost(),
        },
        (plotId, compostId) => compostFarmPlot(plotId, compostId, 5, isSuspended),
      ),
      // Runs after the harvest, so a plot cleared this tick is available to be
      // replanted on the next rather than being read as still occupied.
      plantEmptyPlots(
        {
          // Both readers have always carried categoryId; the call site dropped
          // it, and the reflex then paired plots with seeds that cannot go in
          // them.
          emptyPlots: livePlots
            .filter((plot) => plot.state === 'empty')
            .map((plot) => ({ plotId: plot.id, categoryId: plot.categoryId })),
          plentifulSeeds: readPlantableSeeds()
            .map((seed) => ({
              recipeId: seed.recipeId,
              categoryId: seed.categoryId,
              held: seed.seedsHeld,
              cost: seed.seedCost,
            }))
            .sort((a, b) => b.held - a.held),
        },
        (plotId, recipeId) => plantFarmPlot(plotId, recipeId, isSuspended),
      ),
      // Prayer's two halves, in the order that keeps them from arguing. Dropping
      // fires only at zero points and activating only above zero, so the
      // conditions are disjoint and neither can undo the other.
      dropUnpayablePrayers(
        {
          inCombat: snapshot.combat.inCombat,
          prayerPoints: snapshot.combat.prayerPoints,
          activePrayerIds: readActivePrayerIds(),
        },
        (prayerId) => togglePrayer(prayerId, isSuspended),
      ),
      // Spending points in combat is the only source of Prayer XP there is, so
      // this is not a buff decision -- it is the whole training method, and
      // Prayer 20 was unreachable while nothing ever turned a prayer on.
      activateCheapestPrayer(
        {
          inCombat: snapshot.combat.inCombat,
          prayerPoints: snapshot.combat.prayerPoints,
          activePrayerIds: readActivePrayerIds(),
          available: readActivatablePrayers(),
        },
        (prayerId) => togglePrayer(prayerId, isSuspended),
      ),
      // The live check that makes the pre-fight screen safe: outside combat the
      // game cannot compute enemy stats, so the screen guesses from combat
      // level; here the game has computed the real max hit and the guess is
      // checked against it.
      // Before the outmatched check: a fight landing nothing is not a fight
      // being lost on the numbers, and the two want different responses.
      refillQuiver(
        {
          inCombat: snapshot.combat.inCombat,
          quiverEmpty: (() => {
            const quiver = snapshot.combat.equipment.find((slot) => slot.slot === 'melvorD:Quiver');
            return readRefillableAmmo() !== null && (quiver?.qty ?? 0) <= 0;
          })(),
          available: readRefillableAmmo(),
        },
        (itemId) => equipItem(itemId, 'melvorD:Quiver', isSuspended),
        () => disengageCombat(isSuspended),
      ),
      abandonIfOutmatched(
        {
          inCombat: snapshot.combat.inCombat,
          maxHitpoints: snapshot.combat.maxHitpoints,
          enemyMaxHit: snapshot.combat.enemy?.maxHit ?? null,
        },
        () => disengageCombat(isSuspended),
      ),
    ];

    for (const outcome of outcomes) {
      if (outcome === null) continue;
      if (outcome.result.ok) {
        this.reflexBackoff.delete(outcome.name);
        this.log.info('reflex', `${outcome.name} fired`);
        continue;
      }

      // A reflex whose call changed nothing will be handed the same state next
      // tick and make the same call, forever. Seen twice today: refillFood
      // topping up a slot that would not grow, once a second for hours, and
      // again at four-second intervals with eight Beef equipped. Nothing was
      // ever done wrong — every attempt was refused by a precondition — but the
      // noise buried the one warning that mattered, which was Thieving refusing
      // to release the action slot.
      //
      // Backing off is not a fix for the underlying refusal; it is a refusal to
      // shout about it. The reflex resumes as soon as anything changes, because
      // success clears the entry and the detail is part of the key.
      if (outcome.result.reason === 'no_state_change') {
        const key = `${outcome.name}:${outcome.result.detail}`;
        const until = this.reflexBackoff.get(key) ?? 0;
        const now = Date.now();
        if (now < until) continue;
        this.reflexBackoff.set(key, now + REFLEX_BACKOFF_MS);
      }

      this.log.warn('reflex', `${outcome.name}: ${outcome.result.detail}`);
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
  async arm(options: { auto?: boolean } = {}): Promise<void> {
    if (this.state === 'killed') {
      this.log.warn('runtime', 'kill switch is latched; reload the game to arm again');
      return;
    }

    const reason = await this.checkGuards(options.auto === true);
    if (reason !== null) {
      this.state = 'blocked';
      this.blockedReason = reason;
      this.log.error('runtime', `refusing to arm: ${reason}`);
      this.notify();
      return;
    }

    this.blockedReason = null;
    this.state = 'running';
    // The baseline every later boot is compared against. Recorded on the way
    // in rather than on the way out, because there is no clean way out: a
    // browser tab closing runs no shutdown path.
    this.settings = { ...this.settings, enabled: true, lastDeathCount: readDeathCount() };
    this.objectiveStartedAt = Date.now();
    this.objectiveStartMetrics = this.captureMetrics();
    this.deaths.resetRun();
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
    // `install()` starts the clocks itself; calling startClocks() again here
    // left two policy timers and two quality timers running, because the
    // disposer only ever clears the latest pair. Every objective was then
    // evaluated and dispatched twice per interval -- including irreversible
    // actions like buying, selling and engaging -- and quality samples were
    // duplicated, skewing the one metric the run is judged by. A second revive
    // tripled it.
    this.install();
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
      this.deaths.resetRun();
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

    // Skill XP so the stopgap can compare candidates in levels rather than in
    // XP; see chooseStopgap.
    const skillXp = new Map(
      (this.lastSnapshot?.skills ?? []).map((skill) => [skill.id, skill.xp] as const),
    );
    const objective = chooseStopgap(this.safeCandidates(), skillXp, now);
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
    this.deaths.resetRun();
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

    // Same ordering as the report path, and for the same reason: the blocked
    // walk computes the shortfalls that `safeCandidates` attaches.
    const blockedOpportunities = this.safeBlocked();

    const response = await this.transport.plan({
      snapshot,
      candidates: this.safeCandidates(),
      blockedOpportunities,
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
    this.objectiveStartMetrics = this.captureMetrics();
    // A real plan arrived, so the stopgap clock starts again from scratch next
    // time rather than firing immediately after this objective ends.
    this.objectivelessSince = null;
    this.deaths.resetRun();
    this.consecutiveActionFailures = 0;
    this.log.info('planner', `new objective (${trigger}): ${usable.rationale}`, {
      reasoning: response.reasoning,
    });
    this.notify();
  }

  private async checkGuards(auto: boolean): Promise<string | null> {
    const realmRefusal = checkRealmAllowed();
    if (realmRefusal !== null) return realmRefusal;

    // What offline progression did, checked before anything acts on it.
    //
    // Only for the automatic path. Every other guard here is about
    // configuration -- the realm, the allowlist, the dump's freshness -- and
    // none of them looks at the character. But arming on boot happens from
    // `onInterfaceReady`, which is *after* up to 24 hours have been applied
    // with no reflex loaded, so the one thing the boot path most needs to know
    // is the one thing nothing asked: what state did that leave the character
    // in. An operator arming by hand is present and can judge for themselves;
    // nobody is present for this path, which is exactly why it needs a floor.
    if (auto) {
      const healthRefusal = this.checkAutoArmHealth();
      if (healthRefusal !== null) return healthRefusal;
    }

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

  /**
   * Reads what offline progression left behind, for the automatic arm.
   *
   * Every input is read here rather than taken from the last snapshot, because
   * on the boot path there is no last snapshot: `install()` has only just run
   * and the first policy tick has not happened. Reading directly is also the
   * honest thing to do for a check whose whole purpose is to observe the
   * character as it is *now*, immediately after the game changed it.
   *
   * @returns A refusal to report as `blockedReason`, or null when it looks safe.
   */
  private checkAutoArmHealth(): string | null {
    try {
      const { hitpoints, maxHitpoints } = readPlayerHitpoints();
      const refusal = checkArmHealth({
        hpFraction: maxHitpoints > 0 ? hitpoints / maxHitpoints : 1,
        meals: readMealCount(),
        hasAutoEat: hasAutoEat(),
        deathCount: readDeathCount(),
        deathCountBefore: this.settings.lastDeathCount,
      });

      return refusal === null ? null : `${refusal} Arm from the panel once it is dealt with.`;
    } catch (error) {
      // An unreadable character is not evidence of a healthy one, but refusing
      // on a failed read would make every reader change a silent no-arm. The
      // policy tier's HP and food floors still run, so this degrades to the
      // behaviour that existed before the check.
      this.log.warn('runtime', `auto-arm health check could not read the character: ${error}`);
      return null;
    }
  }

  /**
   * Notices that the game loop has stopped ticking.
   *
   * Deliberately checked from the policy clock, which is a plain setInterval,
   * and never from the tick loop itself. The stuck detector already had this
   * backwards: it rode the very clock whose failure it was meant to catch, so a
   * dead loop took its own alarm with it.
   *
   * The failure this exists for looked perfectly healthy from outside. Reports
   * kept arriving on the independent timer, `runState` stayed `running`, and
   * the snapshot went on naming whatever skill was last active -- so the
   * service, the panel and every MCP reading agreed the character was working
   * while nothing had happened for an hour.
   *
   * Reported rather than acted on. A stalled loop is not something the agent
   * can fix from inside; what it can do is stop claiming to be fine.
   */
  private detectDeadLoop(): void {
    const event = this.loopStall.observe(this.tickCount, this.state === 'running', Date.now());
    if (event === null) return;

    if (event.kind === 'resumed') {
      this.log.info('runtime', 'game loop is ticking again');
      return;
    }

    this.log.error(
      'runtime',
      `game loop has not ticked for ${Math.round(
        event.stalledMs / 1000,
      )}s; reflexes are not running, so eating and the starvation stop are both inactive`,
    );
  }

  /**
   * Notices that the character died.
   *
   * There was no death detection of any kind. `deathsSinceStart` was only ever
   * assigned zero, never incremented, so `abortWhen.deathsExceed` could never
   * fire and the `death` replan trigger was never sent -- and the run that died
   * overnight went on choosing objectives as though nothing had happened,
   * because nothing in the agent could tell the two states apart.
   *
   * Polling a counter rather than listening for an event is deliberate. There
   * is no death event to subscribe to, and a counter that only rises also
   * catches a death that happened while the mod was not loaded at all -- during
   * offline progression, which is exactly how this character died last time.
   * An event would have missed the one case that matters most.
   *
   * The objective is cleared as well as counted. Whatever was being attempted
   * was being attempted by a character who could survive it, and that premise
   * is now known to be false.
   */
  private detectDeath(): void {
    const deaths = readDeathCount();
    const died = this.deaths.observe(deaths);
    if (died === 0) return;

    this.log.error(
      'runtime',
      `character died (${died} since last check, ${this.deaths.deathsSinceStart} this run); clearing the objective`,
    );

    // The baseline moves with it. A death the agent has already seen, reported
    // and replanned around must not also block the next boot's automatic arm —
    // that check exists for the deaths nobody was there for.
    this.settings = { ...this.settings, objective: null, lastDeathCount: deaths };
    this.objectiveStartedAt = Date.now();
    this.objectiveStartMetrics = this.captureMetrics();
    this.requestReplan('death');
    this.notify();
  }

  /** The policy tier. Takes a snapshot, evaluates, and performs intents. */
  private tickPolicy(): void {
    if (this.state === 'killed') return;
    if (this.state === 'suspended') {
      this.tickSuspended();
      return;
    }

    const snapshot = this.takeSnapshot();
    if (snapshot === null) return;

    this.detectDeath();
    this.detectDeadLoop();

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
      deathsSinceStart: this.deaths.deathsSinceStart,
    });

    switch (decision.kind) {
      case 'idle':
        break;
      case 'complete':
        // A completion this fast is not a completion, and saying so is the only
        // way it is ever visible.
        //
        // The planner refuses to queue a step whose criteria already hold, but
        // it can only refuse what it can see: a stock target for something the
        // step before it was going to spend is legitimately undecidable when the
        // plan is written, and reads as satisfied only at the moment the step
        // starts. Live, the same shape at the level end produced "objective
        // complete: all 1 criteria met" twice in six seconds and an empty plan,
        // logged at info, indistinguishable from an hour of work paying off.
        if (Date.now() - this.objectiveStartedAt < NO_OP_COMPLETION_MS) {
          this.log.warn(
            'policy',
            `objective completed without acting: its criteria were already met when it started (${decision.detail}). The plan advances having done nothing`,
          );
        } else {
          this.log.info('policy', `objective complete: ${decision.detail}`);
        }
        this.recordJournal(objective, 'completed', snapshot, decision.detail);
        this.settings = { ...this.settings, objective: null };
        this.requestReplan('objective_completed');
        break;
      case 'abort': {
        this.log.warn('policy', `objective aborted (${decision.outcome}): ${decision.detail}`);

        // An abort on the health floor has to stop the thing doing the damage.
        //
        // The criteria say "stopping rather than continuing to take damage with
        // no way to heal", and the handler emitted no action at all -- it
        // cleared the objective and asked for a replan while the character went
        // on fighting or pickpocketing. At 14% health with no food that is not
        // a safety floor, it is a note in a log.
        //
        // Only for the health outcomes. A budget or GP-floor abort is a
        // scheduling decision and stopping the activity there would throw away
        // work for no reason.
        if (decision.outcome === 'aborted_stuck') {
          const suspended = (): boolean => this.state === 'suspended';
          const active = snapshot.activeAction;
          const stopped = snapshot.combat.inCombat
            ? disengageCombat(suspended)
            : active === undefined || active === null
              ? null
              : stopGathering(active.id, suspended);

          if (stopped !== null && !stopped.ok) {
            this.log.error('runtime', `abort could not stop the damage: ${stopped.detail}`);
          }
        }

        this.recordJournal(objective, decision.outcome, snapshot, decision.detail);
        this.settings = { ...this.settings, objective: null };
        this.requestReplan('objective_aborted');
        break;
      }
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
    /** What the last verified action of this round actually moved, if anything. */
    let lastChange: string | null = null;

    for (const action of actions) {
      const result = this.dispatch(action, isSuspended);

      if (!result.ok) {
        // "Succeeding and going nowhere" is a different claim from "failing",
        // and failures have their own escalation (ACTION_FAILURE_LIMIT). Mixing
        // the two would let a run of refusals count towards an alarm that is
        // specifically about the game accepting everything it is asked.
        this.noMovement.reset();
        // Being suspended is not the objective's fault — the tier is simply
        // paused, and counting it would abandon a fine objective mid catch-up.
        if (result.reason === 'suspended') return false;

        // A refusal the passage of time will lift is not a failure at all. The
        // town regenerates resources every hour and crops finish growing, so
        // "cannot afford this building yet" must not be counted the way "no
        // such building" is — counting them alike abandoned every objective
        // that had to wait, and the town stopped growing for the rest of a run
        // within a minute of dipping below its reserve.
        if (result.reason === 'not_yet') {
          this.consecutiveActionFailures = 0;
          this.log.info('adapter', `${result.action} waiting: ${result.detail}`);
          return false;
        }

        // A precondition refusal is a *judgement about current state*, not a
        // mishap: the same call against the same state will refuse identically.
        // Retrying it four more times only delays the replan by fifteen seconds
        // and buries the reason under repeated warnings.
        const isDeterministic = result.reason === 'precondition';
        this.consecutiveActionFailures = isDeterministic
          ? ACTION_FAILURE_LIMIT
          : this.consecutiveActionFailures + 1;

        this.log.warn(
          'adapter',
          isDeterministic
            ? `${result.action} refused: ${result.detail}`
            : `${result.action} failed (${result.reason}) [${this.consecutiveActionFailures}/${ACTION_FAILURE_LIMIT}]`,
          result,
        );

        if (this.consecutiveActionFailures >= ACTION_FAILURE_LIMIT) {
          this.log.error(
            'policy',
            isDeterministic
              ? `abandoning objective; the game refuses it in this state: ${result.detail}`
              : `abandoning objective after ${this.consecutiveActionFailures} consecutive failures: ${result.detail}`,
          );
          // Kept for the next planning call: "this was offered and the game
          // refused it, for this reason" is the most useful thing a planner can
          // be told, and it is exactly what was lost before.
          this.lastRefusal = { action: result.action, detail: result.detail, at: Date.now() };
          // A step the game refuses *right now* may simply be early: "smith
          // bronze bars" is impossible until the ore is mined, and a plan that
          // orders mining before smithing is correct rather than broken. So a
          // refused step goes to the back of the plan once, and is dropped if
          // it is refused again. Retrying forever would spin; dropping
          // immediately would make ordered chains impossible to express.
          const objective = this.settings.objective;
          const requeue =
            isDeterministic && objective !== null && !this.requeuedSteps.has(objective.id);

          if (requeue && objective !== null) {
            this.requeuedSteps.add(objective.id);
            this.settings = {
              ...this.settings,
              objective: null,
              plan: [...this.settings.plan, objective],
            };
            this.log.info(
              'planner',
              `step refused as too early; moved to the back of the plan: ${result.detail}`,
            );
          } else {
            this.settings = { ...this.settings, objective: null };
          }

          this.consecutiveActionFailures = 0;
          this.requestReplan('objective_aborted');
        }
        return false;
      }

      // Any success clears the run: the objective is making progress again.
      this.consecutiveActionFailures = 0;
      // The evidence, read rather than logged whole. `ok` on its own is what
      // the adapter's `changed()` closure believed; the magnitude is what it
      // observed, and a line that says "ok — level +0, active false -> true"
      // is the difference between a verified action and a productive one.
      const delta = summariseResult(result);
      if (delta !== null) lastChange = delta.detail;
      // The policy's reason, carried onto the line for the actions that *stop*
      // something.
      //
      // `reason` was accepted by this function and never used. So the log said
      // `combat.disengage ok — inCombat true -> false` and nothing else, and
      // the fight thrash was diagnosed wrongly three times partly on the
      // strength of "a floor disengage would have logged its reason" — which it
      // would not, because this line dropped it. The reason is the only record
      // of *which* of several branches fired, and for a stop it is the whole
      // content of the decision.
      //
      // Only the stopping actions, and only on success: they are rare (eight
      // `mining.stop` in a full day against 174 engages), each one is a
      // deliberate abandonment of work in progress, and every other action's
      // reason is already recoverable from its own arguments.
      const why = STOPS_WORK_IN_PROGRESS.has(action.type) ? ` — ${reason}` : '';
      this.log.info(
        'adapter',
        `${result.action} ok${delta === null ? '' : ` — ${delta.detail}`}${why}`,
        result,
      );
    }

    // Only a round that actually performed something is evidence about the
    // objective; an empty intent list says nothing about whether the game is
    // accepting calls that achieve nothing.
    if (actions.length > 0) this.checkCounterMovement(lastChange);
    return true;
  }

  /**
   * Escalates an objective whose actions all verify and whose counter is flat.
   *
   * The failure this catches is the one `ok` cannot express: every call
   * accepted, every before/after diff real, and the number the objective exists
   * to move sitting exactly where it started. Agility ran that way for fifteen
   * minutes — `Agility.stop ok`, `agility.run ok`, alternating every three
   * seconds, zero XP — and nothing above the adapter could tell it apart from
   * work.
   *
   * @param lastChange - What the round's last verified action moved, if the
   *                     projection allowed the comparison at all.
   */
  private checkCounterMovement(lastChange: string | null): void {
    const objective = this.settings.objective;
    const snapshot = this.lastSnapshot;
    if (objective === null || snapshot === null) return;

    // No criteria means a one-shot action whose executor decides completion.
    // There is no counter to watch, and inventing one would replan the very
    // objectives that are meant to finish after a single verified action.
    const counter = readObjectiveCounter(snapshot, objective.successWhen);
    if (counter === null) return;

    const verdict = this.noMovement.recordSuccess(objective.id, counter, Date.now());
    if (verdict.kind === 'moved' || verdict.kind === 'restarted') {
      this.stalled = null;
      return;
    }
    if (verdict.kind === 'watching') return;

    const minutes = verdict.forMs / 60_000;
    const evidence: StalledCounter = {
      counter: verdict.label,
      value: verdict.value,
      successes: verdict.successes,
      minutes,
      lastChange: lastChange ?? 'the projection reported nothing comparable',
    };
    this.stalled = { objectiveId: objective.id, evidence };

    this.log.error(
      'policy',
      `${verdict.successes} verified actions over ${minutes.toFixed(1)}min and ${verdict.label} is still ${verdict.value}: the game accepts every call and the objective's own success counter has not moved (last change: ${evidence.lastChange}); replanning`,
    );
    // The same trigger `detectStuck` uses, deliberately: this is the same
    // condition observed sooner and with the counter named, so it goes through
    // the same backoff and the same planner path rather than a parallel one.
    this.requestReplan('stuck_detected');
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
      case 'repair_all_township':
        return repairAllTownshipBuildings(isSuspended);
      case 'survey_hex':
        return surveyBestHex(isSuspended);
      case 'excavate_dig_site':
        return excavateDigSite(action.digSiteId, isSuspended);
      case 'select_dig_map':
        return selectDigSiteMap(action.digSiteId, action.mapIndex, isSuspended);
      case 'create_dig_map':
        return createDigSiteMap(action.digSiteId, isSuspended);
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
      case 'convert_from_township':
        return convertTownshipToItem(
          action.resourceId,
          action.itemId,
          action.quantity,
          isSuspended,
        );
      case 'convert_to_township':
        return convertItemToTownship(
          action.itemId,
          action.resourceId,
          action.quantity,
          isSuspended,
        );
      case 'bury_bones':
        return buryBones(action.itemId, action.quantity, isSuspended);
      case 'open_item':
        return openItem(action.itemId, action.quantity, isSuspended);
      case 'claim_mastery_token':
        return claimMasteryToken(action.itemId, action.quantity, isSuspended);
      case 'toggle_curse':
        return toggleCurse(action.curseId, isSuspended);
      case 'toggle_aurora':
        return toggleAurora(action.auroraId, isSuspended);
      case 'toggle_bank_lock':
        return toggleBankLock(action.itemId, isSuspended);
      case 'select_level_cap':
        return selectLevelCapIncrease(action.capIncreaseId, action.skillId, isSuspended);
      case 'travel_to_poi':
        return travelToPointOfInterest(action.poiId, isSuspended);
      case 'unlock_plot':
        return unlockFarmPlot(action.plotId, isSuspended);
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
      // The same fallback the enumeration uses. Without it here, a fight could
      // be offered as a candidate and then refused when chosen — the candidate
      // and the executor disagreeing, which is the failure this whole
      // constrained-selection design exists to prevent.
      const screenInputs = readCombatLevelScreenInputs(targetId);
      if (screenInputs === null) {
        this.log.warn('policy', `combat gate: cannot assess ${targetId} — ${gathered.detail}`);
        return fail('combat.gate', 'precondition', gathered.detail);
      }

      const screen = screenByCombatSkillLevels(screenInputs);
      if (!screen.ok) {
        this.log.warn('policy', `combat gate REFUSED ${targetId}: ${screen.detail}`, screen);
        return fail('combat.gate', 'precondition', screen.detail);
      }

      // Logged with its uncertainties, not just its verdict. The screen compares
      // levels and nothing else, so a pass means "nothing here looks lethal" —
      // and the previous screen's real defect was presenting a bare verdict as
      // if it were a proof.
      this.log.info(
        'policy',
        `combat screen passed ${targetId}: ${screen.detail}. Not measured: ${screen.uncertainties.join('; ')}`,
        screen,
      );
      return null;
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
      // A run of bad snapshots blocks; a single one does not.
      //
      // This latched on the first failure with no way back: nothing clears
      // `blocked` except an operator arming again, so one malformed snapshot at
      // two in the morning ended the night. And a snapshot can be malformed for
      // reasons that pass on their own -- a value read mid-transition, a
      // registry momentarily inconsistent while the game mutates it -- which is
      // exactly the case where stopping for good is the wrong response.
      //
      // Stopping is still right when the state is *persistently* unreadable,
      // because acting on a snapshot that does not parse is acting blind. So
      // the difference between a blip and a fault is how long it lasts.
      this.snapshotFailures += 1;
      const detail = `snapshot failed validation: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`;

      if (this.snapshotFailures < SNAPSHOT_FAILURES_BEFORE_BLOCK) {
        this.log.warn('adapter', `${detail} (${this.snapshotFailures} in a row; continuing)`);
        return null;
      }

      this.state = 'blocked';
      this.blockedReason = detail;
      this.log.error('adapter', detail);
      this.notify();
      return null;
    }

    // Recovery is automatic, because the condition that justified blocking has
    // demonstrably passed: a snapshot just parsed.
    if (this.snapshotFailures > 0) {
      this.snapshotFailures = 0;
      if (this.state === 'blocked' && this.blockedReason?.startsWith('snapshot failed') === true) {
        this.state = this.settings.enabled ? 'running' : 'idle';
        this.blockedReason = null;
        this.log.info('runtime', 'snapshots are parsing again; resuming');
        this.notify();
      }
    }

    this.lastSnapshot = parsed.data;
    return parsed.data;
  }

  private sampleQuality(): void {
    const snapshot = this.lastSnapshot;
    if (snapshot === null) return;
    this.quality.add({
      at: snapshot.capturedAt,
      totalLevel: snapshot.totalLevel,
      completionPercent: snapshot.completionPercent,
      gp: snapshotGp(snapshot),
      // What produced the progress, so a realised rate can be compared against
      // the rate the candidate advertised. Without it a sample records that
      // progress happened and not what caused it.
      activeSkillId: snapshot.activeAction?.id,
      activeSkillXp: snapshot.skills.find((skill) => skill.id === snapshot.activeAction?.id)?.xp,
      activeRecipeId: readActiveRecipeIds()[0],
    });
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

    const gp = snapshotGp(snapshot);
    // Deliberately *not* completionPercent, which was in this marker and is why
    // the detector never fired on a dead objective. Township ticks in the
    // background and nudges completion on its own, so a fight producing
    // absolutely nothing still looked like progress: GP frozen at exactly
    // 30,816 and total level at 391 for seventeen minutes, while completion
    // drifted 2.98 to 2.99 and reset the clock.
    //
    // Total level and GP are what the *current objective* is supposed to move.
    // Completion is what the character accumulates by existing, and mixing the
    // two makes the check unable to tell working from merely running.
    const marker = progressMarker(snapshot.totalLevel, gp);

    if (marker !== this.lastProgressMarker) {
      this.lastProgressMarker = marker;
      this.lastProgressAt = now;
      this.stuckReported = false;
      // The episode is over, so the next one starts asking promptly again.
      this.stuckEscalations = 0;
      this.nextStuckReplanAt = 0;
      if (this.attention !== null) {
        this.log.info('runtime', 'progress resumed; clearing the escalation');
        this.attention = null;
      }
      return;
    }

    const stuckFor = now - this.lastProgressAt;
    if (stuckFor <= STUCK_AFTER_MS || this.replanPending !== null) return;

    // Once per episode. This warning fired 1,237 times in a day at
    // three-second intervals — the same drown-the-signal failure the reflex
    // backoff was written for, in the one place whose entire job is to be
    // noticed.
    if (!this.stuckReported) {
      this.stuckReported = true;
      this.log.warn(
        'reflex',
        `no total level or GP movement for 15min while running "${this.settings.objective?.rationale ?? 'no objective'}"; escalating`,
      );
    }

    // Backed off, because the answer is empty by construction until a session
    // attaches. `plan()` returns no objectives unconditionally — planning
    // happens in a Claude Code session or it does not happen — so replanning on
    // every tick was an HTTP round trip every three seconds, all night, for a
    // response that could not change. Retrying is still right; a session may
    // attach at any moment and the first request after it does is the one that
    // ends the stall. The rate was the mistake, not the retry.
    if (now < this.nextStuckReplanAt) return;

    this.nextStuckReplanAt = now + stuckReplanDelayMs(this.stuckEscalations);
    this.stuckEscalations += 1;
    this.requestReplan('stuck_detected');

    // And once asking has demonstrably stopped helping, say so somewhere a
    // check outside the game can see it. An agent that is running, reporting
    // healthily and achieving nothing is the one failure this project has no
    // other signal for.
    const escalation = describeStuckAttention(
      this.stuckEscalations,
      stuckFor,
      this.settings.objective?.rationale ?? null,
    );
    if (escalation !== null && this.attention !== escalation) {
      this.attention = escalation;
      this.log.error('runtime', escalation);
    }
  }

  /** Metrics an objective's cost is measured against. Null when unreadable. */
  private captureMetrics(): ObjectiveMetrics | null {
    const snapshot = this.lastSnapshot;
    if (snapshot === null) return null;

    return objectiveMetrics(snapshot, this.deaths.deathsSinceStart);
  }

  /**
   * Records how an objective ended, with deltas measured rather than assumed.
   *
   * The journal has had a schema, a store method and a digest the planner reads
   * since the beginning, and nothing ever wrote to it: `addJournalEntry` had
   * one caller, a test. So `get_journal` could only answer "Nothing attempted
   * yet", and the property the digest exists to provide -- do not re-propose
   * what was already abandoned -- simply was not there. The mod knew every
   * outcome and threw it away as a log line.
   *
   * Deltas come from metrics captured when the objective began, so the cost of
   * an attempt is observed. An objective that ran for an hour and moved nothing
   * is the single most useful thing a planner can be told, and it is invisible
   * from the outcome alone: "aborted on time budget" reads the same whether it
   * earned 200,000 GP or nothing at all.
   */
  private recordJournal(
    objective: Objective,
    outcome: Outcome,
    snapshot: StateSnapshot,
    note: string,
  ): void {
    const started = this.objectiveStartMetrics;
    this.objectiveStartMetrics = null;
    if (started === null) return;

    this.journal.record({
      objective,
      startedAt: this.objectiveStartedAt,
      endedAt: Date.now(),
      outcome,
      deltas: objectiveDeltas(started, objectiveMetrics(snapshot, this.deaths.deathsSinceStart)),
      note,
    });
  }

  /**
   * Ships state to the service and applies any commands it returns.
   *
   * @param options - `stateOnly` omits the snapshot and both enumerations, for
   *                  the suspended path where reading the game is unsafe.
   */
  private async pushReport(options: { stateOnly?: boolean } = {}): Promise<void> {
    const logs = this.log.drain();
    const journalEntries = this.journal.drain();
    const quiet = options.stateOnly === true || this.state === 'killed';

    // Blocked first, deliberately: the blocked walk is what computes the stock
    // shortfalls, and `safeCandidates` puts them on the producers. Left to the
    // object literal's own evaluation order below, candidates ran first and
    // every suggestion would have been one report stale -- which is exactly the
    // failure this feature exists to end, a number arriving too late to be
    // acted on.
    const blockedOpportunities = quiet ? [] : this.safeBlocked();
    const candidates = quiet ? [] : this.safeCandidates();

    const reply = await this.transport.report({
      runState: this.state,
      snapshot: options.stateOnly === true ? null : this.lastSnapshot,
      objective: this.settings.objective,
      // The queue itself, not a count of it. A session that can only see "3
      // steps" cannot tell whether any of the three still matches the game.
      plan: this.settings.plan,
      objectiveStartedAt: this.settings.objective === null ? null : this.objectiveStartedAt,
      candidates,
      blockedOpportunities,
      buildStamp: readBuildStamp(),
      logs,
      quality: this.quality.recent(),
      journalEntries,
      // Cumulative, not drained: a guarded read that has been failing all night
      // is the signal, and a per-tick counter cannot express it.
      adapterFailures: readAdapterFailures(),
      blockedReason: this.blockedReason,
      needsAttention: this.attention,
      // Only while it still describes the objective that is running. A stall
      // detected on a step that has since been replaced would read as a live
      // complaint about the objective that replaced it, which is precisely the
      // wrong diagnosis to hand a planning session.
      stalledCounter:
        this.stalled !== null && this.stalled.objectiveId === this.settings.objective?.id
          ? this.stalled.evidence
          : null,
    });

    if (reply === null) {
      // Degrade, never halt: keep the logs for the next attempt and carry on
      // with the last valid objective.
      this.log.requeue(logs);
      // Entries survive a failed send for the same reason logs do: an outcome
      // that is never recorded is one the planner will propose again.
      this.journal.requeue(journalEntries);
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
  private safeBlocked(): BlockedOpportunity[] {
    try {
      const refusal = this.lastRefusal;
      // Ten minutes: long enough to reach the next planning call, short enough
      // that a refusal the character has since grown out of stops being advice.
      const recent = refusal !== null && Date.now() - refusal.at < 600_000;

      // Order here no longer decides what a planning session sees: every entry
      // carries a severity and the renderer ranks by it, with slots reserved
      // per tier. That ordering had been rewritten twice -- once to lift
      // Township task needs above locked actions, once to lift the diagnostics
      // above them too -- because a `push` position was the only lever anyone
      // had, and twelve slots were filled by whichever reader ran first.
      const blocked: ReturnType<typeof readBlockedOpportunities> = [
        ...(recent && refusal !== null
          ? [
              {
                label: `Last refusal: ${refusal.action} — ${refusal.detail}. It was offered as a candidate and the game refused it, so do not simply re-choose it.`,
                xpPerHour: 0,
                // The action the game has just refused is the one thing a
                // planner must not re-choose, and it expires in ten minutes.
                severity: 'high' as const,
                missing: [],
              },
            ]
          : []),
        ...readBankPressure(),
        // Ordinary severity, and that is the point of the field: "this task
        // wants 5,000 Fishing XP, and pays the Township XP the last untrained
        // skill in scope is gated behind" is a job that can be started now, so
        // it outranks a locked-action fact without anyone having to keep it
        // above one in this array.
        ...readTaskOpportunities(),
        // Above the rest of the diagnostics, because a spent charge is the one
        // failure on this list with no symptom at all: the item stays worn, the
        // slot stays full, every reading looks right, and the rate simply drops
        // forever. Nothing else can surface it.
        ...readSpentChargesNotice(),
        // Owned gear that every scorer here values at zero. Not ranked, because
        // pricing a modifier is a judgement about what the run is doing; see
        // readModifierGear for why a number would be a guess dressed up.
        ...readModifierGearNotice(),
        ...readUnsellableNotice(),
        ...readShopGoalNotice(),
        ...readBlockedOpportunities(),
        // A level requirement is the least urgent thing on this list and there
        // are around twenty of them, one per skill. Marked low rather than
        // moved: they used to fill every slot from wherever they sat in this
        // array, and six task needs plus six unlock facts once filled the
        // window exactly -- so the food reserve running out, a better recipe
        // unlocking in the running skill and a seed shortfall were all
        // written, shipped, and never once read.
        ...readLockedActions().map((entry) => ({ ...entry, severity: 'low' as const })),
        // "You cannot fight this yet, and here is why" is progression context,
        // not a countdown.
        //
        // Unless the entry set its own severity, which exactly one of them
        // does: `readUnfightableCombat` reports that *no* fight can be taken,
        // and forcing that to `low` would have dropped it. There are around
        // twenty low lines competing for twelve slots, so a flat override is a
        // decision about what gets read, and this line is the only thing
        // standing between five combat goals and the silence that blocked them.
        ...this.blockedCombat().map((entry) => ({ ...entry, severity: entry.severity ?? 'low' })),
      ];

      // Severity is filled in here rather than left to the schema's default, so
      // the panel and the report rank the same list. The default only applies
      // at the service, which is one hop too late for anything in the game.
      const ranked = blocked.map((entry) => ({
        ...entry,
        severity: entry.severity ?? ('normal' as const),
      }));

      // The shortfalls, as numbers, for the candidates that would fill them.
      //
      // Taken from the entries this pass built rather than from `ranked`, so a
      // demand is not lost to the twelve-slot cut: the cut decides what a
      // *person* reads, and this is read by the code that sizes an objective.
      // Township tasks are folded in here because they are the one demand
      // source that states its own quantity -- see readTaskStockDemands.
      this.lastDemands = mergeDemands([
        ...blocked.flatMap((entry) => entry.demands ?? []),
        ...readTaskStockDemands(readBankQuantity),
      ]);

      // Cached for the panel, which must not recompute this on every render.
      this.lastBlocked = ranked;
      return ranked;
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
      ['slayer', readSlayerCandidates],
      ['farm', readFarmCandidates],
      ['travel', readTravelCandidates],
      ['townGoods', readTownshipGoodsCandidates],
      ['combat setup', readCombatSetupCandidates],
      ['equipment sets', readEquipmentSetCandidates],
      ['spell', readSpellCandidates],
      ['township', readTownshipCandidates],
      ['township tasks', readTaskCandidates],
      ['township trader', readTraderCandidates],
      ['combat event', readEventCandidates],
      ['bones', readBoneCandidates],
      ['containers', readOpenableCandidates],
      ['masteryTokens', readMasteryTokenCandidates],
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
    // Each producer told what is short of the thing it produces, and how much.
    //
    // The join has to happen here rather than inside any one enumerator: the
    // shortfall belongs to a *consumer* in some other skill -- bars from
    // Smithing for a Fletching recipe, runes from Runecrafting for a spell --
    // and no enumerator can see across the boundary. See annotateStockDemand.
    return annotateStockDemand(candidates, this.lastDemands);
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

    const targets = readCombatTargets();

    // Asked once, before anything is priced, because the answer does not depend
    // on the target: whether the character can throw a punch at all.
    //
    // `readUnfightableCombat` wraps the very precondition `combat.engage` and
    // `combat.startDungeon` refuse on, so when it answers, every fight below is
    // a candidate the game is certain to reject. A candidate is defined here as
    // something the mod has proven it can execute right now, and offering two
    // hundred guaranteed refusals — `Fight Leech ... ~84 kills/h` among them,
    // priced to four significant figures — breaks that guarantee outright.
    //
    // Withheld and *explained*, never withheld silently: the returned line
    // names the selected spell, the rune the bank is short of and the
    // Runecrafting recipe that makes it. Silence here is what cost the evening,
    // and it would cost it again one level down.
    const unfightable = readUnfightableCombat(targets.length);
    if (unfightable.length > 0) {
      this.combatCache = { at: now, candidates: [], blocked: unfightable };
      return this.combatCache;
    }

    // Items the agent already knows it wants: what an open Township task asks
    // for, plus seeds it holds too few of to plant. Computed once rather than
    // per monster.
    const wantedItemIds = new Set<string>([...readTaskWantedItemIds(), ...readShortSeedIds()]);

    const candidates: Candidate[] = [];
    const blocked: ReturnType<typeof readBlockedOpportunities> = [];

    for (const target of targets) {
      // The Slayer task says so in both lists. A refused task monster is not
      // "one more fight we cannot take": it is the only fight that can clear the
      // task blocking every other Slayer candidate, so the planner needs to see
      // it as the deadlock it is rather than as a line among two hundred.
      const slayer =
        target.slayerKillsLeft === undefined
          ? ''
          : ` — SLAYER TASK, ${target.slayerKillsLeft} kill(s) left, and no new task can be taken until it is done`;

      // Priced before the gate is consulted, so that a *refused* fight can say
      // how big it was as well as why it was refused. "Fight Sweaty Monster —
      // could be one-shot" and "Fight Chicken — could be one-shot" are the same
      // line about two wildly different propositions, and the scale is what
      // tells a planner whether the answer is better gear or a smaller target.
      //
      // Pricing is emphatically not a permit: the refusal below still returns
      // before any candidate is built, and nothing in the pricing path touches
      // the gate's verdict.
      const pricing =
        target.kind === 'run_dungeon' ? readDungeonPricing(target.id) : readFightPricing(target.id);
      const priced = pricing?.note ?? '';

      const verdict = this.gateVerdict(target.id);
      if (verdict.refusal !== null) {
        blocked.push({
          label: `Fight ${target.name} (combat level ${target.combatLevel})${priced}${slayer} — ${verdict.refusal}`,
          xpPerHour: 0,
          missing: [],
        });
        continue;
      }

      // How narrowly the gate passed, carried onto the candidate so the board
      // can be ordered safest-first. Absent when the fight could not be priced,
      // because the tie-break inside a danger band is damage/hour and a fight
      // with no rate would sort as zero -- last among equals, which is a
      // judgement nobody made. Absent leaves it where it arrived instead.
      const damageRisk: DamageRisk | undefined =
        pricing === null
          ? undefined
          : {
              pressure: verdict.pressure,
              basis: verdict.basis,
              guard: verdict.guard,
              ratePerHour: pricing.damagePerHour,
              rateUnit: 'damage_per_hour',
              why: verdict.why,
            };

      const where =
        target.kind === 'run_dungeon'
          ? `dungeon, hardest monster combat level ${target.combatLevel}`
          : `${target.areaName}, combat level ${target.combatLevel}`;
      // Say what a fight is *for*, when it is for something. Without this every
      // fight candidate reads the same and the planner picks by combat level,
      // which measures danger rather than value.
      const drops =
        target.kind === 'run_dungeon' ? [] : readMonsterDropsOfInterest(target.id, wantedItemIds);
      const wanted =
        drops.length === 0 ? '' : ` — drops ${drops.join(', ')}, which you are short of`;
      // Which way the combat triangle points, which nothing has ever said.
      //
      // The kill rate in `priced` and the combat level in `where` are both
      // computed before the triangle is applied, so on an unfavourable matchup
      // they overstate the fight in the two places a planner looks. Six of this
      // character's thirty-two fight candidates are ranged monsters against a
      // Magic caster, and their labels are currently indistinguishable from the
      // melee ones the triangle rewards.
      //
      // Monsters only. A dungeon holds monsters of several attack types and no
      // single clause is true of the run, so `run_dungeon` deliberately gets
      // nothing rather than an average nobody can act on.
      const triangle =
        target.kind === 'run_dungeon'
          ? ''
          : describeMatchup(readTriangleMatchup(target.id, target.areaId));

      // Risk before the triangle: the operator's rule is never to be greedy
      // with combat, so how hard it hits reads ahead of how the matchup leans.
      const label = `Fight ${target.name} (${where})${slayer}${priced}${
        damageRisk === undefined ? '' : describeDamageRisk(damageRisk)
      }${wanted}${triangle}`;

      // Coins into the balance, not items that would fetch coins. What the
      // drops are worth is in the label and deliberately not in this number:
      // an hour of banking gems moves the balance by exactly zero, and a GP
      // goal was once reported as advanced by exactly that.
      const earnings =
        pricing === null || pricing.gpPerHour <= 0
          ? {}
          : { gpPerHour: pricing.gpPerHour, gpIsEarned: true as const };

      if (target.kind === 'run_dungeon') {
        candidates.push({
          kind: 'run_dungeon',
          params: { kind: 'run_dungeon', dungeonId: target.id },
          label,
          ...earnings,
          ...(damageRisk === undefined ? {} : { damageRisk }),
          ...(target.requiresLevel === undefined ? {} : { requiresLevel: target.requiresLevel }),
          available: true,
        });
        continue;
      }

      candidates.push({
        kind: 'fight_monster',
        params: { kind: 'fight_monster', monsterId: target.id, areaId: target.areaId ?? '' },
        label,
        ...earnings,
        ...(damageRisk === undefined ? {} : { damageRisk }),
        // Bones are the only input Prayer has, and `prayer-20` is open at
        // Prayer 2. Carried as `produces` and not only as a phrase in the label
        // so a stock objective can name the item and be sized against the rate
        // -- the same gap `suggestedStock` closed for crafting materials.
        ...(pricing?.bonesPerHour == null
          ? {}
          : {
              produces: {
                itemId: pricing.bonesPerHour.itemId,
                name: pricing.bonesPerHour.name,
                perHour: pricing.bonesPerHour.perHour,
              },
            }),
        ...(target.requiresLevel === undefined ? {} : { requiresLevel: target.requiresLevel }),
        available: true,
      });
    }

    // Safest first, then rate among the comparably safe. The list used to come
    // out in enumeration order and be read as a leaderboard on the damage rates
    // in the labels, which is how `Sweaty Monster` at ~17,085 damage/h was
    // queued over `Chicken` at ~12,000 and killed the character twice in eight
    // minutes -- deaths 56 and 57, and a Jeweled Necklace to
    // `applyDeathPenalty`. See `orderDamagingCandidates`: this is an ordering
    // and never a refusal, because refusing combat would starve `hp-40`,
    // `defence-20` and `prayer-20`, which only combat advances.
    this.combatCache = { at: now, candidates: orderDamagingCandidates(candidates), blocked };
    return this.combatCache;
  }

  /**
   * Runs the survivability gate silently, for enumeration.
   *
   * Shares {@link readCombatGateInputs} and `assessSurvivability` with the
   * enforcing path in {@link assessTarget}, but logs nothing: enumerating every
   * fight in the game on each snapshot would otherwise bury the journal.
   *
   * @returns The refusal reason, or null when the fight is safe, together with
   *   how narrowly it passed and on what evidence. The second half used to be
   *   thrown away: the gate answered a boolean, sixty fights all answered yes,
   *   and the board could not tell a Chicken from the Sweaty Monster that
   *   killed the character twice. See {@link survivabilityPressure} and
   *   {@link levelScreenPressure}, which turn the workings both verdicts
   *   already carried into the number that ranks them.
   */
  private gateVerdict(targetId: string): {
    refusal: string | null;
    pressure: number;
    basis: DamageRiskBasis;
    guard: string;
    why: string;
  } {
    const sessionMinutes = this.settings.objective?.abortWhen.minutesExceed ?? 30;

    const gathered = readCombatGateInputs(targetId, sessionMinutes);
    if (!gathered.ok) {
      // The probe cannot measure an enemy outside combat — the game's own
      // computation returns NaN — so fall back to the level screen. Refusing
      // everything instead would mean the agent never fights at all, and
      // reimplementing the damage formulas to avoid that is exactly what the
      // brief forbids. This must stay the same call the enforcing path makes,
      // or a fight is offered as a candidate and then refused when chosen.
      const screenInputs = readCombatLevelScreenInputs(targetId);
      if (screenInputs === null) {
        return {
          refusal: gathered.detail,
          // A target that cannot be screened at all is refused above and never
          // reaches an ordering, so the band here is only what a caller that
          // ignored the refusal would see. It is the most dangerous one.
          pressure: 1,
          basis: 'levels_only',
          guard: 'unmeasurable',
          why: gathered.detail,
        };
      }

      const screen = screenByCombatSkillLevels(screenInputs);
      return {
        refusal: screen.ok ? null : screen.detail,
        pressure: levelScreenPressure(screen),
        basis: 'levels_only',
        guard: 'combat_level_screen',
        why:
          `attacks at combat skill level ${screen.workings.monsterOffensiveLevel} ` +
          `against a ceiling of ${screen.workings.ceiling.toFixed(1)}`,
      };
    }

    const verdict = assessSurvivability({
      ...gathered.inputs,
      autoEatThresholdFraction: normaliseFraction(gathered.inputs.autoEatThresholdFraction),
      autoEatHpLimitFraction: normaliseFraction(gathered.inputs.autoEatHpLimitFraction),
      autoEatEfficiencyFraction: normaliseFraction(gathered.inputs.autoEatEfficiencyFraction),
    });

    return {
      refusal: verdict.safe ? null : verdict.refusals.map((refusal) => refusal.detail).join('; '),
      pressure: survivabilityPressure(verdict),
      basis: 'measured',
      guard: 'survivability_gate',
      why:
        `hits ${verdict.workings.effectiveEnemyMaxHit.toFixed(1)} against a one-shot ceiling of ` +
        `${verdict.workings.oneShotCeiling.toFixed(1)}`,
    };
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
        this.objectiveStartMetrics = this.captureMetrics();
        this.objectivelessSince = null;
        this.deaths.resetRun();
        this.consecutiveActionFailures = 0;
        this.log.info(
          'operator',
          `plan set: ${usable.length} objectives, starting with ${first?.rationale ?? 'nothing'}`,
        );
        break;
      }
      case 'set_objective': {
        // Already parsed by the schema; the kind check is the capability gate.
        if (!isSupportedKind(command.objective.kind)) {
          this.log.error(
            'planner',
            `rejected objective: no executor for ${command.objective.kind}`,
          );
          return;
        }
        // The displaced objective goes back on the front of the plan.
        //
        // It used to be dropped on the floor: setting a one-off objective
        // overwrote `objective` and left `plan` untouched, so the step being
        // interrupted was simply lost. In practice that meant every manual
        // sell -- the one action nothing automates, run every forty minutes to
        // convert gathered ore into GP -- silently cost a mining step, and the
        // plan quietly shortened each time an operator did the necessary thing.
        //
        // An interruption is not a cancellation. Selling a stack does not mean
        // the mining that produced it was a mistake, and the agent has no way
        // to tell the difference, so it should assume the cheaper error:
        // resuming a step that is no longer wanted costs one replan, while
        // losing one costs however long it takes somebody to notice.
        const displaced = this.settings.objective;

        // Re-issuing the objective already running is not an interruption, and
        // treating it as one did two wrong things at once: it pushed a copy of
        // the objective onto the plan, and it restarted the clock — so an
        // objective re-sent every few minutes could never reach its own abort
        // budget, and the elapsed time a commitment floor is measured against
        // reset to zero each time. Identity is kind and params, the same test
        // the planner uses to recognise a candidate.
        if (displaced !== null && isSameWork(displaced, command.objective)) {
          this.settings = { ...this.settings, objective: command.objective };
          this.log.info(
            'operator',
            `objective re-stated (unchanged work, clock kept): ${command.objective.rationale}`,
          );
          break;
        }

        this.settings = {
          ...this.settings,
          objective: command.objective,
          plan: displaced === null ? this.settings.plan : [displaced, ...this.settings.plan],
        };
        this.objectiveStartedAt = Date.now();
        this.objectiveStartMetrics = this.captureMetrics();
        this.objectivelessSince = null;
        this.deaths.resetRun();
        this.consecutiveActionFailures = 0;
        this.log.info(
          'operator',
          displaced === null
            ? `objective set: ${command.objective.rationale}`
            : `objective set: ${command.objective.rationale} (interrupting, will resume: ${displaced.rationale})`,
        );
        break;
      }
      case 'dump_knowledge':
        await this.dumpKnowledge();
        break;
      case 'reload_game': {
        this.log.info('operator', 'saving and reloading to pick up the mod on disk');
        const reload = reloadGame();
        if (!reload.ok) this.log.error('operator', `reload refused: ${reload.detail}`);
        break;
      }
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

/**
 * Whether two objectives are the same work.
 *
 * Kind and params, which are what actually reaches a game call. Rationale and
 * budget are the caller's framing of the same job — a session that re-states an
 * objective in a fresh sentence has not changed what the agent is doing, and
 * treating it as new restarts a clock that exists to bound it.
 */
function isSameWork(a: Objective, b: Objective): boolean {
  return a.kind === b.kind && JSON.stringify(a.params) === JSON.stringify(b.params);
}

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
  buyShopPurchase,
  checkCharacterAllowed,
  checkRealmAllowed,
  disengageCombat,
  dumpRegistries,
  engageMonster,
  exportSave,
  onGameEvent,
  readCombatGateInputs,
  readGameVersion,
  readGatherCandidates,
  readSellCandidates,
  readShopObjectiveCandidates,
  readSnapshot,
  sellItem,
  startGathering,
  stopGathering,
} from '../adapter/index.js';
import { assessSurvivability, normaliseFraction } from '../policy/combat-gate.js';
import { executorFor, isSupportedKind } from '../policy/index.js';
import type { PolicyAction } from '../policy/types.js';
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

const GP_CURRENCY_ID = 'melvorD:GP';

export interface AgentSettings extends Record<string, unknown> {
  enabled: boolean;
  characterAllowlist: string[];
  serviceUrl: string;
  objective: Objective | null;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  enabled: false,
  characterAllowlist: [],
  serviceUrl: 'http://localhost:8787',
  objective: null,
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
export class Agent {
  private state: RunState = 'idle';
  private blockedReason: string | null = null;
  private readonly subscriptions = new Subscriptions();
  private policyTimer: ReturnType<typeof setInterval> | null = null;
  private qualityTimer: ReturnType<typeof setInterval> | null = null;
  private lastReflexAt = 0;
  private lastSnapshot: StateSnapshot | null = null;
  private objectiveStartedAt = Date.now();
  private deathsSinceStart = 0;
  private quality: QualitySample[] = [];
  private lastProgressAt = Date.now();
  private lastProgressMarker = -1;
  private replanPending: string | null = null;
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

  /** Records that a replan is owed, with the trigger that caused it. */
  requestReplan(trigger: string): void {
    this.replanPending = trigger;
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
    if (!freshness.fresh) {
      return `knowledge dump ${freshness.reason}: ${freshness.detail}`;
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

    const objective = this.settings.objective;
    if (objective === null) {
      this.log.info('policy', 'no objective set; nothing to execute');
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
      case 'act':
        this.perform(decision.actions, decision.reason);
        break;
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
  private perform(actions: readonly PolicyAction[], reason: string): void {
    const isSuspended = (): boolean => this.state === 'suspended';

    for (const action of actions) {
      const result = this.dispatch(action, isSuspended);
      if (!result.ok) {
        this.log.warn('adapter', `${result.action} failed (${result.reason})`, result);
        return;
      }
      this.log.info('adapter', `${result.action} ok`, result);
    }
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
    const sessionMinutes = this.settings.objective?.abortWhen.minutesExceed ?? 30;

    const gathered = readCombatGateInputs(monsterId, sessionMinutes);
    if (!gathered.ok) {
      // Could not measure means could not prove, which is a refusal — never an
      // assumption that the fight is fine.
      this.log.warn('policy', `combat gate: cannot assess ${monsterId} — ${gathered.detail}`);
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
    return engageMonster(monsterId, areaId, isSuspended);
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
  private safeCandidates(): Candidate[] {
    const candidates: Candidate[] = [];
    for (const [name, read] of [
      ['gather', readGatherCandidates],
      ['sell', readSellCandidates],
      ['shop', readShopObjectiveCandidates],
    ] as const) {
      try {
        candidates.push(...read());
      } catch (error) {
        this.log.warn('adapter', `${name} candidate enumeration failed: ${String(error)}`);
      }
    }
    return candidates;
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
      case 'replan':
        this.requestReplan(command.reason);
        break;
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
        this.deathsSinceStart = 0;
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

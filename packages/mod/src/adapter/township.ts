import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';
import { townHealthPercent } from './passive.js';

/**
 * The town.
 *
 * Township is the game's one genuinely *managed* system: it ticks on its own,
 * but the ticks are worth almost nothing unless somebody builds, repairs and
 * keeps storage from overflowing. That makes it the purest case of the thesis
 * this project is built on — the idle hours are free, the transitions are where
 * the value is. An agent that cannot touch Township leaves an entire skill, and
 * every reward gated behind it, permanently at level 1.
 *
 * Nothing here destroys anything. Building removal, worship changes (50M GP)
 * and resource yeeting are all reachable in the game and deliberately absent:
 * they are the irreversible decisions the brief reserves for a human.
 */

/** What building or repairing claims to change. */
export interface TownshipProjection {
  buildingId: string;
  biomeId: string;
  count: number;
  efficiency: number;
}

function findBuilding(buildingId: string): TownshipBuilding | undefined {
  return game.township.buildings.getObjectByID(buildingId);
}

function findBiome(biomeId: string): TownshipBiome | undefined {
  return game.township.biomes.getObjectByID(biomeId);
}

function projectBuilding(building: TownshipBuilding, biome: TownshipBiome): TownshipProjection {
  return {
    buildingId: building.id,
    biomeId: biome.id,
    count: biome.getBuildingCount(building),
    efficiency: biome.getBuildingEfficiency(building),
  };
}

/**
 * Builds one building in a biome.
 *
 * `buildBuilding` takes no biome argument: it builds into whichever biome the
 * town page is currently showing. That is a UI-driven API, so the biome is set
 * first and restored afterwards — leaving it changed would silently redirect a
 * human's next click to a biome they did not choose.
 *
 * It returns `void` and refuses silently when resources are short, so the only
 * evidence that holds is the building count either side.
 *
 * @param buildingId - Namespaced `TownshipBuilding` id.
 * @param biomeId - Namespaced `TownshipBiome` id it goes in.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
/**
 * How many of a building the town must be able to afford before one is built.
 *
 * Four means a quarter of the cost is left untouched. Cheap to state, and it
 * turns "build until broke" into "build while comfortable".
 */
const BUILD_RESERVE_MULTIPLE = 4;

export function buildTownshipBuilding(
  buildingId: string,
  biomeId: string,
  isSuspended: () => boolean,
): ActionResult<TownshipProjection> {
  const township = game.township;
  const building = findBuilding(buildingId);
  if (building === undefined) {
    return fail('township.build', 'precondition', `no township building ${buildingId}`);
  }
  const biome = findBiome(biomeId);
  if (biome === undefined) {
    return fail('township.build', 'precondition', `no township biome ${biomeId}`);
  }

  return act(
    {
      name: 'township.build',
      observe: () => projectBuilding(building, biome),
      precondition: () => {
        if (isRefusedRealm(biome.realm.id)) return `biome ${biomeId} is in refused realm`;
        if (!township.townData.townCreated) return 'the town has not been created yet';
        if (!township.isBiomeUnlocked(biome)) return `biome ${biomeId} is locked`;
        if (!township.isBuildingAvailable(building, biome)) {
          return `${buildingId} is not available in ${biomeId}`;
        }
        if (township.isBuildingMaxed(building, biome))
          return `${buildingId} is maxed in ${biomeId}`;
        // Tier requirements are separate from availability: a building can be
        // available in a biome and still refuse to build because the town lacks
        // the population or Township level its tier demands. Without this,
        // Market, Gardens and Library were all offered and all did nothing.
        if (!township.canBuildTierOfBuilding(building, false)) {
          return `${buildingId} is a tier the town cannot build yet (population or Township level)`;
        }
        if (!township.canAffordBuilding(building, biome, 1)) {
          return `cannot afford ${buildingId} in ${biomeId}`;
        }
        // A reserve, so repeated building stops before the town is stripped.
        // Building is repeatable work rather than a one-shot decision, which is
        // the only way a town grows unattended — but "build until broke" is the
        // failure the one-shot was guarding against. Keeping a quarter of each
        // required resource preserves both: a batch goes up each time the town
        // is comfortable, and it stops while there is still something to build
        // the next thing with.
        if (!township.canAffordBuilding(building, biome, BUILD_RESERVE_MULTIPLE)) {
          // `not_yet`, not a refusal: the town regenerates every hour, so this
          // resolves itself without anyone intervening.
          return {
            wait: `building ${buildingId} would leave the town without a reserve; the town regenerates hourly`,
          };
        }
        return null;
      },
      perform: () => {
        const previousBiome = township.currentTownBiome;
        township.currentTownBiome = biome;
        try {
          township.buildBuilding(building);
        } finally {
          // `exactOptionalPropertyTypes` makes "absent" and "undefined"
          // different things, and the game treats absent as "viewing all
          // biomes" — so restoring it has to delete rather than assign.
          // Assigning undefined is not the same as removing the property: the
          // game reads an absent `currentTownBiome` as "viewing all biomes",
          // which is the state a human who never opened a specific biome is in.
          // biome-ignore lint/performance/noDelete: its suggested fix reintroduces exactly that bug.
          if (previousBiome === undefined) delete township.currentTownBiome;
          else township.currentTownBiome = previousBiome;
        }
      },
      changed: (before, after) => after.count > before.count,
    },
    isSuspended,
  );
}

/**
 * Repairs a degraded building.
 *
 * Buildings lose efficiency over time, and a town of half-broken buildings
 * produces half the resources while costing the same upkeep. Repair is the
 * cheapest progress in the skill and the easiest thing for an idle player to
 * neglect, which makes it exactly the kind of transition worth automating.
 */
export function repairTownshipBuilding(
  buildingId: string,
  biomeId: string,
  isSuspended: () => boolean,
): ActionResult<TownshipProjection> {
  const township = game.township;
  const building = findBuilding(buildingId);
  if (building === undefined) {
    return fail('township.repair', 'precondition', `no township building ${buildingId}`);
  }
  const biome = findBiome(biomeId);
  if (biome === undefined) {
    return fail('township.repair', 'precondition', `no township biome ${biomeId}`);
  }

  return act(
    {
      name: 'township.repair',
      observe: () => projectBuilding(building, biome),
      precondition: () => {
        if (biome.getBuildingCount(building) <= 0) return `no ${buildingId} built in ${biomeId}`;
        if (biome.getBuildingEfficiency(building) >= 100) return `${buildingId} is not degraded`;
        if (!township.canAffordRepair(building, biome)) {
          return `cannot afford to repair ${buildingId}`;
        }
        return null;
      },
      // `render: false` — the agent is not looking at the town page.
      perform: () => township.repairBuilding(building, false),
      changed: (before, after) => after.efficiency > before.efficiency,
    },
    isSuspended,
  );
}

/** Efficiency below which a building is worth spending resources to repair. */
const REPAIR_THRESHOLD = 90;

/**
 * What the town could usefully do right now.
 *
 * Repairs are offered alongside new construction, and the distinction is a real
 * judgement for the planner: a degraded building already costs its upkeep and
 * produces less, so restoring it usually beats adding another one that will
 * degrade alongside it.
 *
 * Only affordable work is offered. Township resources cannot be bought, so an
 * unaffordable building is not a "save up for it" decision the way a shop
 * purchase is — it is simply not a move yet.
 */
export function readTownshipCandidates(): Candidate[] {
  const township = game.township;
  if (!township.townData.townCreated) return [];

  const candidates: Candidate[] = [];

  for (const biome of township.biomes.allObjects) {
    if (isRefusedRealm(biome.realm.id)) continue;

    let unlocked = false;
    try {
      unlocked = township.isBiomeUnlocked(biome);
    } catch {
      continue;
    }
    if (!unlocked) continue;

    for (const building of biome.availableBuildings) {
      try {
        const count = biome.getBuildingCount(building);
        const efficiency = biome.getBuildingEfficiency(building);

        if (
          count > 0 &&
          efficiency < REPAIR_THRESHOLD &&
          township.canAffordRepair(building, biome)
        ) {
          candidates.push({
            kind: 'repair_township',
            params: { kind: 'repair_township', buildingId: building.id, biomeId: biome.id },
            label: `Repair ${building.name} in ${biome.name} (${Math.round(efficiency)}% efficiency)`,
            available: true,
          });
        }

        if (township.isBuildingMaxed(building, biome)) continue;
        if (!township.isBuildingAvailable(building, biome)) continue;
        // Availability and tier are different questions; see the precondition.
        if (!township.canBuildTierOfBuilding(building, false)) continue;
        // Matches the precondition's reserve, so nothing is offered that the
        // action will immediately refuse.
        if (!township.canAffordBuilding(building, biome, BUILD_RESERVE_MULTIPLE)) continue;

        const provides = township.getProvidesForBiome(building, biome);
        const effect =
          provides === undefined
            ? ''
            : `, +${provides.population} pop, +${provides.happiness} happiness, +${provides.education} education`;

        candidates.push({
          kind: 'build_township',
          params: { kind: 'build_township', buildingId: building.id, biomeId: biome.id },
          label: `Build ${building.name} in ${biome.name} (${count} built${effect})`,
          available: true,
        });
      } catch {
        // A building whose costs or provides cannot be read is not a candidate.
      }
    }
  }

  return candidates;
}

/** The town's state, for the planner to reason about. */
export interface TownshipSummary {
  /** Always true: an uncreated town is reported as null, not as a summary. */
  created: true;
  level: number;
  population: number;
  happiness: number;
  education: number;
  healthPercent: number;
  storageUsed: number;
  storageMax: number;
  worship: string;
  season: string | null;
  resources: { id: string; name: string; amount: number; cap: number }[];
}

/**
 * Reads the town.
 *
 * Storage is the number that matters most and the one a human checks first: a
 * full town discards everything it produces, so a town at 100% storage earns
 * nothing per hour no matter how many buildings it has.
 *
 * @returns The town, or null when it has never been created.
 */
export function readTownshipSummary(): TownshipSummary | null {
  const township = game.township;
  if (!township.townData.townCreated) return null;

  const data = township.townData;

  return {
    created: true,
    level: township.level,
    population: data.population,
    happiness: data.happiness,
    education: data.education,
    // Not `data.healthPercent`, which reads 0 on a town the game's own page
    // shows at 100%. That was already discovered once and fixed in the reflex
    // path (see townHealthPercent), while this reader -- the one the planner
    // actually sees -- kept reporting a permanently dying town. Two readings of
    // the same fact disagreeing is worse than either being wrong alone: the
    // repair reflex correctly did nothing while the summary said the town was
    // at zero.
    healthPercent: townHealthPercent(),
    storageUsed: township.getUsedStorage(),
    storageMax: township.getMaxStorage(),
    worship: township.currentWorshipName,
    season: data.season?.name ?? null,
    resources: township.resources.allObjects.map((resource) => ({
      id: resource.id,
      name: resource.name,
      amount: resource.amount,
      cap: township.getMaxResourceAmount(resource),
    })),
  };
}

/**
 * Chooses the town's worship.
 *
 * Worship is a set of permanent modifiers for the whole town, and the first
 * choice is free. Changing it afterwards costs 50,000,000 GP *and destroys
 * every worship building*, which is why the cost is stated plainly in the
 * candidate label rather than hidden behind a confirmation the agent would
 * click through.
 *
 * Nothing here refuses on the operator's behalf. A town left on no worship
 * forever is a real loss, and an agent that cannot choose one cannot play
 * Township properly.
 *
 * `selectWorship` only stages the choice; `confirmWorship` applies it. Both are
 * called, and the town's actual worship is observed either side.
 */
export function selectTownshipWorship(
  worshipId: string,
  isSuspended: () => boolean,
): ActionResult<{ worshipId: string }> {
  const township = game.township;
  const worship = township.worships.getObjectByID(worshipId);
  if (worship === undefined) {
    return fail('township.worship', 'precondition', `no township worship ${worshipId}`);
  }

  // Founding is two things at once: the worship is chosen *and* the town comes
  // into existence. Both are observed, because the first can succeed while the
  // second silently does not — which is exactly what happened the first time.
  const project = (): { worshipId: string; created: boolean } => ({
    worshipId: township.townData.worship.id,
    created: township.townData.townCreated,
  });

  return act(
    {
      name: 'township.worship',
      observe: project,
      precondition: () => {
        // Deliberately no townCreated check: choosing a worship and confirming
        // it is *how a town is created*. Requiring a town first made every
        // Township capability unreachable — the skill could never be started at
        // all, which is how it sat at level 1 while everything else advanced.
        const current = project();
        if (current.created && current.worshipId === worshipId) {
          return `${worshipId} is already the town's worship`;
        }
        // `isWorshipUnlocked` lives on the Township *UI* class, not the skill,
        // so the requirement check is the reachable equivalent.
        if (!game.checkRequirements(worship.unlockRequirements, false)) {
          return `${worshipId} is not unlocked`;
        }
        // Only a *change* costs anything; the first choice is free. It is a
        // change only once the town exists — a worship staged on the founding
        // screen is still the first choice, and treating it as a change made
        // founding refuse itself for 50,000,000 GP the character does not need
        // to spend.
        const isChange =
          township.townData.townCreated && township.townData.worship !== township.noWorship;
        if (isChange && !township.canAffordWorshipChange) {
          return `changing worship costs ${township.WORSHIP_CHANGE_COST.toLocaleString()} GP and destroys every worship building`;
        }
        return null;
      },
      perform: () => {
        township.selectWorship(worship);
        if (township.townData.townCreated) {
          // An established town is only changing its deity.
          township.confirmWorship();
          return;
        }
        // A new town needs the creation confirmed as well. `confirmWorship`
        // alone leaves the game sitting on the selection screen with the
        // worship set and no town — the skill stays unusable and nothing says
        // why.
        township.confirmTownCreation();
      },
      changed: (before, after) =>
        after.worshipId === worshipId && (before.created || after.created),
    },
    isSuspended,
  );
}

/**
 * Worship choices available to the town.
 *
 * Only offered while the town has none. Once a worship is set, switching is a
 * 50M GP decision that also destroys buildings, and putting that in the same
 * list as "build a hut" invites it to be chosen by a planner skimming labels.
 * An operator who wants the switch can still ask for it directly.
 */
export function readWorshipCandidates(): Candidate[] {
  const township = game.township;
  // An uncreated town always offers this, even when a worship is already
  // staged: the selection screen keeps the choice across a reload, so filtering
  // on "has a worship" strands the character with a deity, no town, and no
  // candidate that can finish founding it.
  if (township.townData.townCreated && township.townData.worship !== township.noWorship) {
    return [];
  }

  const candidates: Candidate[] = [];

  for (const worship of township.worships.allObjects) {
    try {
      if (worship === township.noWorship) continue;
      if (!game.checkRequirements(worship.unlockRequirements, false)) continue;

      candidates.push({
        kind: 'select_worship',
        params: { kind: 'select_worship', worshipId: worship.id },
        label: township.townData.townCreated
          ? `Worship ${worship.name} — ${describeWorship(worship)}. Free now, 50,000,000 GP to change later`
          : `Found the town under ${worship.name} — creates the town and unlocks Township, its tasks and every building. Bonuses: ${describeWorship(worship)}. Free now, 50,000,000 GP to change later`,
        available: true,
      });
    } catch {
      // A worship that cannot report its unlock state is not a candidate.
    }
  }

  return candidates;
}

// --- township tasks --------------------------------------------------------

/**
 * Claims a completed Township task.
 *
 * Tasks are the town's reward loop: they complete themselves as the character
 * plays, and then sit there paying nothing until someone presses claim. A human
 * collects them in passing; an agent that never does accumulates finished tasks
 * indefinitely, which is a pure loss — the work is already done.
 *
 * `completeTask` takes `giveRewards` and `forceComplete` flags. Rewards are
 * requested and forcing is not: forcing would claim a task whose goals are
 * unmet, which is cheating the game rather than playing it.
 *
 * @param taskId - Namespaced `TownshipTask` id.
 */
export function claimTownshipTask(
  taskId: string,
  isSuspended: () => boolean,
): ActionResult<{ taskId: string; claimed: boolean }> {
  const tasks = game.township.tasks;
  const task = tasks.tasks.getObjectByID(taskId);
  if (task === undefined) {
    return fail('township.claimTask', 'precondition', `no township task ${taskId}`);
  }

  const project = (): { taskId: string; claimed: boolean } => ({
    taskId,
    claimed: tasks.completedTasks.has(task),
  });

  return act(
    {
      name: 'township.claimTask',
      observe: project,
      precondition: () => {
        if (project().claimed) return `${taskId} has already been claimed`;
        if (!task.goals.checkIfMet()) return `the goals for ${taskId} are not met yet`;
        return null;
      },
      // Rewards yes, force no: forcing claims a task whose goals are unmet,
      // which is cheating the game rather than playing it.
      perform: () => tasks.completeTask(task, true, false),
      changed: (_before, after) => after.claimed,
    },
    isSuspended,
  );
}

/**
 * Claims a completed casual (daily) task.
 *
 * Separate registry, separate completion call, and a five-task limit that
 * *blocks new ones* — an unclaimed casual task does not just withhold its own
 * reward, it stops the next task from arriving. That makes claiming these more
 * urgent than the permanent ones.
 */
export function claimCasualTask(
  taskId: string,
  isSuspended: () => boolean,
): ActionResult<{ taskId: string; remaining: number }> {
  const casual = game.township.casualTasks;
  const task = casual.allCasualTasks.getObjectByID(taskId);
  if (task === undefined) {
    return fail('township.claimCasualTask', 'precondition', `no casual task ${taskId}`);
  }

  const project = (): { taskId: string; remaining: number } => ({
    taskId,
    remaining: casual.currentCasualTasks.length,
  });

  return act(
    {
      name: 'township.claimCasualTask',
      observe: project,
      precondition: () => {
        if (!casual.currentCasualTasks.includes(task)) return `${taskId} is not an active task`;
        if (!casual.isTaskComplete(task)) return `the goals for ${taskId} are not met yet`;
        return null;
      },
      perform: () => casual.completeTask(task),
      // The claimed task leaves the active list, which is the observable change.
      changed: (before, after) => after.remaining < before.remaining,
    },
    isSuspended,
  );
}

/**
 * Tasks whose goals are met and whose rewards are waiting.
 *
 * Casual tasks are listed first: the five-slot limit means an unclaimed one
 * blocks the next task from arriving, so it costs more than its own reward.
 */
/**
 * Items an unfinished Township task is asking for.
 *
 * Selling one of these throws away a task cycle. It happened: 500 Potatoes
 * were sold as "free from a Point of Interest, not food the character needs
 * and not something the town accepts" — true when written, and wrong an hour
 * later when a task appeared wanting 100 Potatoes. Tasks rotate, so today's
 * junk is tomorrow's requirement, and task cycles are currently the fastest
 * Township XP there is.
 *
 * Casual tasks count too: they hold the same kind of item goal.
 */
export function readTaskWantedItemIds(): Set<string> {
  const wanted = new Set<string>();
  const township = game.township;
  if (!township.townData.townCreated) return wanted;

  const collect = (goals: { itemGoals: { item: { id: string } }[] }): void => {
    for (const goal of goals.itemGoals) wanted.add(goal.item.id);
  };

  for (const task of township.tasks.tasks.allObjects) {
    try {
      if (township.tasks.completedTasks.has(task)) continue;
      collect(task.goals);
    } catch {
      // A task that cannot describe its goals protects nothing.
    }
  }

  for (const task of township.casualTasks.currentCasualTasks) {
    try {
      if (township.casualTasks.isTaskComplete(task)) continue;
      collect(task.goals);
    } catch {
      // Same.
    }
  }

  return wanted;
}

/**
 * Finished tasks the town is sitting on, ready to claim.
 *
 * Separate from the candidate reader because this is for the reflex tier: a
 * task whose work is already done pays out rewards and Township XP, costs
 * nothing, and cannot be claimed wrongly. Leaving it unclaimed also blocks the
 * slot it occupies, so the next task never starts.
 *
 * That matters more than it sounds. Township XP is what gates the biome the
 * Herb producer lives in, and Herblore is behind that — so an unclaimed task is
 * not tidy-up, it is the critical path standing still.
 */
export function readClaimableTasks(): { kind: 'casual' | 'township'; taskId: string }[] {
  const township = game.township;
  if (!township.townData.townCreated) return [];

  const claimable: ReturnType<typeof readClaimableTasks> = [];

  for (const task of township.casualTasks.currentCasualTasks) {
    try {
      if (township.casualTasks.isTaskComplete(task)) {
        claimable.push({ kind: 'casual', taskId: task.id });
      }
    } catch {
      // A task that cannot report completion is not claimable.
    }
  }

  for (const task of township.tasks.tasks.allObjects) {
    try {
      if (township.tasks.completedTasks.has(task)) continue;
      if (task.goals.checkIfMet()) claimable.push({ kind: 'township', taskId: task.id });
    } catch {
      // Same.
    }
  }

  return claimable;
}

export function readTaskCandidates(): Candidate[] {
  const township = game.township;
  if (!township.townData.townCreated) return [];

  const candidates: Candidate[] = [];

  for (const task of township.casualTasks.currentCasualTasks) {
    try {
      if (!township.casualTasks.isTaskComplete(task)) continue;
      candidates.push({
        kind: 'claim_casual_task',
        params: { kind: 'claim_casual_task', taskId: task.id },
        label: `Claim the casual task ${task.name} — done, and it is holding one of five slots`,
        available: true,
      });
    } catch {
      // A task that cannot report completion is not a candidate.
    }
  }

  for (const task of township.tasks.tasks.allObjects) {
    try {
      if (township.tasks.completedTasks.has(task)) continue;
      if (!task.goals.checkIfMet()) continue;
      candidates.push({
        kind: 'claim_township_task',
        params: { kind: 'claim_township_task', taskId: task.id },
        label: `Claim the Township task ${task.name} — the work is already done`,
        available: true,
      });
    } catch {
      // A task that cannot report completion is not a candidate.
    }
  }

  return candidates;
}

/**
 * What a worship actually does, in words.
 *
 * Choosing between five names is not a choice, it is a guess — and this
 * particular guess is permanent until 50,000,000 GP says otherwise. The
 * modifiers are the only thing that distinguishes them, so they belong in the
 * label where the decision is made.
 */
function describeWorship(worship: TownshipWorship): string {
  // `modifiers` holds only what is always active, which for every deity is its
  // *penalties*. The bonuses live in `checkpoints`, unlocked as worship
  // accumulates. Describing only `modifiers` therefore listed nothing but
  // downsides and made the deity with no bonuses at all look like the safest
  // pick — the exact opposite of the truth.
  const always = describeModifiers(worship.modifiers);
  const unlocked = worship.checkpoints.flat();
  const later = describeModifiers(unlocked);

  const parts: string[] = [];
  if (always.length > 0) parts.push(`always: ${always.join(', ')}`);
  if (later.length > 0) parts.push(`as worship accumulates: ${later.join(', ')}`);

  return parts.length === 0 ? 'no modifiers of its own' : parts.join('; ');
}

/** Renders modifiers as text, skipping any that cannot describe themselves. */
function describeModifiers(modifiers: readonly ModifierValue[]): string[] {
  const described: string[] = [];

  for (const modifier of modifiers) {
    try {
      // `print()` returns a StatDescription, not a string: the text is what the
      // game shows, and `isDisabled` marks one that is not in effect.
      const description = modifier.print();
      if (!description.isDisabled && description.text.length > 0) {
        described.push(description.text);
      }
    } catch {
      // One unreadable modifier must not remove the option from the list.
    }
  }

  return described;
}

/** How many unfinished tasks to describe. Enough to plan around, not a dump. */
const TASK_OPPORTUNITY_LIMIT = 6;

/**
 * What the unfinished Township tasks are asking for.
 *
 * Claiming finished tasks is only half of playing them. The tasks are also the
 * game's own advice about what to do next: they pay GP, items and Township XP
 * for spreading across skills — "earn 5,000 Fishing XP", "defeat 25 Chickens",
 * "give 25 Beef to your town" — which is exactly the breadth a single-skill
 * grinder never develops.
 *
 * Without this the agent could only ever notice a task after it had accidentally
 * completed one. Reported as opportunities rather than candidates because a
 * task is not an action: it is a reason to choose among the actions there are.
 */
export function readTaskOpportunities(): {
  label: string;
  xpPerHour: number;
  missing: { itemId: string; name: string; need: number; have: number }[];
}[] {
  const township = game.township;
  if (!township.townData.townCreated) return [];

  const opportunities: ReturnType<typeof readTaskOpportunities> = [];

  for (const task of township.tasks.tasks.allObjects) {
    if (opportunities.length >= TASK_OPPORTUNITY_LIMIT) break;

    try {
      if (township.tasks.completedTasks.has(task)) continue;
      if (task.goals.checkIfMet()) continue;

      const unmet = task.goals.allGoals
        .filter((goal) => !goal.checkIfMet())
        .map((goal) => describeGoal(goal));

      if (unmet.length === 0) continue;

      opportunities.push({
        label: `Township task ${task.name} wants: ${unmet.join(', ')} — pays GP, items and Township XP`,
        xpPerHour: 0,
        missing: [],
      });
    } catch {
      // A task that cannot describe itself is not an opportunity.
    }
  }

  return opportunities;
}

/**
 * One goal, in plain words.
 *
 * `getDescriptionHTML` is the game's own text and covers every goal type, so it
 * is used rather than re-deriving descriptions per subclass — but it is HTML
 * aimed at a browser, and the planner reads text.
 */
function describeGoal(goal: { getDescriptionHTML(): string }): string {
  try {
    return goal
      .getDescriptionHTML()
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return 'an unreadable goal';
  }
}

/**
 * Degraded buildings the town can afford to repair.
 *
 * Reads only, and deliberately unordered: which one to repair first is a
 * decision, and decisions live in the reflex tier where they can be tested
 * without a live game.
 */
export function readRepairableBuildings(): {
  buildingId: string;
  biomeId: string;
  efficiency: number;
}[] {
  const township = game.township;
  const out: { buildingId: string; biomeId: string; efficiency: number }[] = [];

  try {
    for (const biome of township.biomes.allObjects) {
      if (!township.isBiomeUnlocked(biome)) continue;

      for (const building of biome.availableBuildings) {
        try {
          if (biome.getBuildingCount(building) <= 0) continue;
          const efficiency = biome.getBuildingEfficiency(building);
          if (efficiency >= REPAIR_THRESHOLD) continue;
          if (!township.canAffordRepair(building, biome)) continue;

          out.push({ buildingId: building.id, biomeId: biome.id, efficiency });
        } catch {
          // A building that will not report its efficiency is left alone.
        }
      }
    }
  } catch {
    return [];
  }

  return out;
}

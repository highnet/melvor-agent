import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';
import { townHealthPercent } from './passive.js';
import { noteSwallowed, recordFallback, safeNumber } from './safe.js';

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
 * Runs a per-building town call with the town page pointed at one biome.
 *
 * Neither `buildBuilding` (township.d.ts:722) nor `repairBuilding` (:723) takes
 * a biome. Both are the game's own button callbacks, and both read
 * `Township.currentTownBiome` (:423) instead — `repairBuilding` opening with a
 * bare `if (biome === undefined) return;`, so with no biome selected it spends
 * nothing, changes nothing and reports nothing.
 *
 * The agent never opens the town page, so `currentTownBiome` is absent and that
 * early return is the *normal* path for us. It cost a day of:
 *
 *   reflex.repairTownship: state unchanged after call:
 *   {"buildingId":"melvorF:Miners_Pit","biomeId":"melvorF:Mountains","count":1,"efficiency":85}
 *   -> {...,"efficiency":85}
 *
 * once a minute, forever, with `canAffordRepair(building, biome)` (:691)
 * truthfully answering yes about a biome the call itself would never look at.
 *
 * Scoping is temporary in both directions: leaving the biome changed would
 * silently redirect a human's next click to a biome they did not choose.
 *
 * @typeParam T - Whatever the wrapped call returns; passed straight back.
 */
function withTownBiome<T>(township: typeof game.township, biome: TownshipBiome, call: () => T): T {
  const previousBiome = township.currentTownBiome;
  township.currentTownBiome = biome;
  try {
    return call();
  } finally {
    // `exactOptionalPropertyTypes` makes "absent" and "undefined" different
    // things, and the game treats absent as "viewing all biomes" — so restoring
    // it has to delete rather than assign. Assigning undefined is not the same
    // as removing the property: the game reads an absent `currentTownBiome` as
    // "viewing all biomes", which is the state a human who never opened a
    // specific biome is in.
    // biome-ignore lint/performance/noDelete: its suggested fix reintroduces exactly that bug.
    if (previousBiome === undefined) delete township.currentTownBiome;
    else township.currentTownBiome = previousBiome;
  }
}

/**
 * Runs a build call with the town page's quantity dropdown pinned.
 *
 * The biome is not the only thing `buildBuilding` takes off the screen. The
 * shipped v1.3.1 source — read from the nw.js cache, see `learnings/mod-api.md`
 * — opens with:
 *
 *   const upgradeQty = this.upgradeQty > 0 ? this.upgradeQty : this.getMaxAffordableBuildingQty(building, biome);
 *   const qtyToBuild = Math.min(this.getBuildingCountRemainingForLevelUp(building, biome), upgradeQty);
 *
 * `upgradeQty` (township.d.ts:439) is the town page's 1 / 5 / MAX dropdown, and
 * MAX is stored as `-1` — so a human who ever clicks MAX turns every later
 * agent build into "spend everything affordable". That is precisely the
 * outcome `BUILD_RESERVE_MULTIPLE` exists to prevent, and the reserve check
 * could not see it coming: it proves the town can afford four and the call
 * would then buy as many as it liked.
 *
 * Nothing has been observed doing this — the field defaults to 1 and the agent
 * never touches it — so this is the prophylactic half of the same audit that
 * found the biome. It is the identical shape: a button callback reading a
 * selection it does not take. `shop.buyItemOnClick` had already cost a real
 * objective for the same reason and `shop.ts` sets `buyQuantity` for it.
 *
 * @typeParam T - Whatever the wrapped call returns; passed straight back.
 */
function withBuildQuantity<T>(township: typeof game.township, quantity: number, call: () => T): T {
  const previousQuantity = township.upgradeQty;
  township.upgradeQty = quantity;
  try {
    return call();
  } finally {
    township.upgradeQty = previousQuantity;
  }
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
      // One at a time: the precondition proved the town can afford one and
      // still keep its reserve, and that is the only claim it made. See
      // `withBuildQuantity`.
      perform: () =>
        withTownBiome(township, biome, () =>
          withBuildQuantity(township, 1, () => township.buildBuilding(building)),
        ),
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
      // Scoped to the biome for the same reason building is: `repairBuilding`
      // reads `currentTownBiome` and returns without doing anything when it is
      // absent. See `withTownBiome`.
      //
      // `render: false` — the agent is not looking at the town page. It also
      // keeps `onBuildingRepair` (township.d.ts:724) out of the way, and that
      // call ends in `setTownBiome`, which would move the human's view.
      perform: () => withTownBiome(township, biome, () => township.repairBuilding(building, false)),
      changed: (before, after) => after.efficiency > before.efficiency,
    },
    isSuspended,
  );
}

/** Efficiency below which a building is worth spending resources to repair. */
const REPAIR_THRESHOLD = 90;

/** Total efficiency across every built building, and how many are degraded. */
interface RepairProjection {
  degraded: number;
  totalEfficiency: number;
}

/**
 * Sums efficiency across the town.
 *
 * A total rather than an average, because an average moves when a building is
 * added as well as when one is repaired, and this is the evidence a repair
 * actually happened.
 */
function projectRepairs(): RepairProjection {
  const township = game.township;
  let degraded = 0;
  let totalEfficiency = 0;

  for (const biome of township.biomes.allObjects) {
    if (!township.isBiomeUnlocked(biome)) continue;
    for (const building of biome.availableBuildings) {
      if (biome.getBuildingCount(building) <= 0) continue;
      const efficiency = biome.getBuildingEfficiency(building);
      totalEfficiency += efficiency;
      if (efficiency < REPAIR_THRESHOLD) degraded += 1;
    }
  }

  return { degraded, totalEfficiency };
}

/**
 * Repairs every degraded building the town can pay for, in one call.
 *
 * Repairing one building at a time is how this was reachable before, and it
 * scales badly in exactly the wrong direction: the town grows, so the number of
 * decisions grows, while each one costs a policy tick and the buildings not yet
 * reached keep producing at reduced efficiency the whole time. The game ships
 * the batch operation its own UI uses.
 *
 * `getTotalRepairCosts` prices the whole batch and `canAffordRepairAllCosts`
 * answers whether the town can pay for it — asked in that order, so nothing is
 * attempted that the town cannot complete.
 *
 * One thing the typings do not state: `repairAllBuildings` is documented as
 * "Callback function for the Repair All button", and there is a separate
 * `onRepairAllBuildings` beside it, so which of the two raises a confirmation
 * is unknown from the typings alone. That is precisely why the verdict here is
 * the efficiency total either side rather than the call returning — a
 * confirmation nobody answers shows up as `no_state_change` and is reported,
 * not believed.
 */
export function repairAllTownshipBuildings(
  isSuspended: () => boolean,
): ActionResult<RepairProjection> {
  const township = game.township;

  return act(
    {
      name: 'township.repairAll',
      observe: projectRepairs,
      precondition: () => {
        if (!township.townData.townCreated) return 'the town has not been created yet';

        const costs = township.getTotalRepairCosts();
        if (costs.size === 0) return 'nothing in the town is degraded';
        if (!township.canAffordRepairAllCosts(costs)) {
          // `not_yet`, not a refusal: the town regenerates every hour, so this
          // resolves without anyone intervening.
          return { wait: 'the town cannot yet afford to repair everything; it regenerates hourly' };
        }
        return null;
      },
      perform: () => township.repairAllBuildings(),
      changed: (before, after) => after.totalEfficiency > before.totalEfficiency,
    },
    isSuspended,
  );
}

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
  // Builds are collected apart from repairs so they can be ordered against each
  // other before they are appended. See the sort below.
  const builds: { candidate: Candidate; worth: number }[] = [];
  // Read once for the whole pass; every build is priced against it.
  const economy = readTownshipEconomy();

  for (const biome of township.biomes.allObjects) {
    if (isRefusedRealm(biome.realm.id)) continue;

    let unlocked = false;
    try {
      unlocked = township.isBiomeUnlocked(biome);
    } catch (error) {
      noteSwallowed('township.readTownshipCandidates', error);
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

        const value = valueOfBuilding(building, biome, economy);

        builds.push({
          candidate: {
            kind: 'build_township',
            params: { kind: 'build_township', buildingId: building.id, biomeId: biome.id },
            label: `Build ${building.name} in ${biome.name} (${count} built${effect}${describeBuildTarget(building, biome, value)})`,
            available: true,
          },
          // Township XP is the goal (`township-20`) and the gate on the biomes
          // and skilling outfits the skill is played for, so it leads; GP
          // separates buildings the XP figure ties, which the many +0 ones do.
          worth: value === null ? 0 : value.xpPerHour * 1000 + value.gpPerHour,
        });
      } catch (error) {
        noteSwallowed('township.readTownshipCandidates', error);
        // A building whose costs or provides cannot be read is not a candidate.
      }
    }
  }

  // Best build first, within the town's own candidates.
  //
  // Seventeen build candidates came off this reader in registry order, every
  // one of them labelled "20 more here reaches the next Township level", and
  // nothing anywhere chose between them — not the planner, which had no number
  // to choose on, and not the stopgap, which only ever adopts gathering. So
  // whichever building the registry happened to list first was the town's
  // strategy.
  //
  // This is deliberately a sort *within* the township reader and not a change
  // to how candidates rank globally: the two questions are different, and the
  // global ordering is settled. A tie keeps registry order, so the many
  // buildings worth exactly nothing to the town's output are left exactly where
  // they were rather than shuffled by a comparator with nothing to compare.
  builds.sort((a, b) => b.worth - a.worth);
  for (const build of builds) candidates.push(build.candidate);

  // One entry for the whole town, offered only when there is more than one
  // building to fix. Below that it is the same action as the single repair
  // above with a vaguer label, and two ways to say the same thing is how a
  // planner ends up choosing by wording.
  try {
    const degraded = projectRepairs().degraded;
    const costs = township.getTotalRepairCosts();
    if (degraded > 1 && costs.size > 0 && township.canAffordRepairAllCosts(costs)) {
      candidates.push({
        kind: 'repair_all_township',
        params: { kind: 'repair_all_township' },
        label: `Repair all ${degraded} degraded buildings at once — a degraded building costs its full upkeep and produces less, and repairing them one at a time leaves the rest producing at a discount meanwhile`,
        available: true,
      });
    }
  } catch {
    // A town that cannot price a full repair is not offered one.
  }

  return candidates;
}

// --- what the town is worth per hour, and what a build adds to it -----------

/**
 * The town's actual output per hour, and the two multipliers that set it.
 *
 * Happiness had been read, reported and rendered since the summary existed, and
 * nothing in the agent had ever asked what it *does*. The typings do not say —
 * `currentHappiness` (township.d.ts:479) is a number with no documentation —
 * so this was settled from the shipped v1.3.1 source in the nw.js cache
 * (`learnings/mod-api.md`). Three lines of township.js are the whole answer:
 *
 *   computeTownPopulation() { ... this.townData.population = applyModifier(population, this.townData.happiness); }
 *   get currentPopulation() { return applyModifier(this.townData.population, this.townData.health, 3); }
 *   get baseXPRate() { return this.currentPopulation; }
 *
 * and, for money:
 *
 *   getGPGainRate() {
 *       const gain = this.currentPopulation * this.GP_PER_CITIZEN * (this.taxRate / 100);
 *       ...
 *   }
 *
 * with `applyModifier(base, mod, 0)` = `floor(base * (1 + mod/100))` and type 3
 * = `floor(base * (mod/100))` (f_000195.js:42, the shared helper).
 *
 * So the chain is: **happiness is a percentage bonus on population, population
 * times health percent is Township XP per tick, and the same figure times 15
 * times the tax rate is GP — real GP, credited to the character** (`addResources`
 * calls `this.game.gp.add(gpToAdd)`, not merely the town's own GP resource).
 *
 * That makes happiness the one town statistic that scales everything at once,
 * and it makes zero happiness a foregone multiplier rather than a fault: the
 * town is not decaying at 0, it is simply running at exactly 1.0x. Every point
 * is +1% Township XP and +1% GP, permanently and unattended.
 *
 * `basePopulation` is recomputed here rather than read, because the game keeps
 * only the post-happiness figure and the delta a build is worth needs the
 * pre-happiness one. The recomputation is checked against the game's own
 * `townData.population` and a disagreement is reported through `safe.ts` —
 * a transcribed formula that silently drifts from the engine is the exact
 * failure this repo keeps paying for, so it is made to prove itself every read.
 */
export interface TownshipEconomy {
  /** Raw population from buildings and flat modifiers, before happiness. */
  basePopulation: number;
  /** The game's `townData.population`: `basePopulation` scaled by happiness. */
  population: number;
  /** `currentPopulation`: population scaled by health. XP per tick, and taxed. */
  workingPopulation: number;
  happiness: number;
  /** `townData.health`, 20..100. Decays on its own; see `passive.ts`. */
  health: number;
  /** Township XP per hour at the current town, through the game's `modifyXP`. */
  xpPerHour: number;
  /** GP per hour the town pays the character, through `getGPGainRate`. */
  gpPerHour: number;
  /** Town ticks per hour, from `TICK_LENGTH` (300s -> 12). */
  ticksPerHour: number;
  /** Why `gpPerHour` is what it is. See {@link TownshipTaxStanding}. */
  tax: TownshipTaxStanding;
  /**
   * Set when the transcribed population formula disagreed with the game.
   *
   * Null is the normal case. A sentence here means every derived figure below
   * is suspect, and it is also recorded as an adapter failure so it is visible
   * without anyone reading this field.
   */
  modelMismatch: string | null;
}

/**
 * The tax rate, and what supplies it.
 *
 * The town reported `0 GP/h` against 165 working citizens, and the formula has
 * exactly one term that can zero it — so the obvious reading was that the tax
 * slider had been left at zero for the life of the character. **There is no
 * slider.** From the shipped v1.3.1 source (township.js, nw.js cache):
 *
 *   get taxRate() {
 *       const baseRate = this.BASE_TAX_RATE;
 *       const modifier = this.game.modifiers.townshipTaxPerCitizen;
 *       return Math.min(baseRate + modifier, 80);
 *   }
 *
 * `BASE_TAX_RATE` is 0 — the typings state the literal (township.d.ts:405) — so
 * the tax rate *is* the modifier, and the modifier comes from a building. The
 * game data (f_00000c.js) gives Town Hall `"modifiers": {
 * "townshipTaxPerCitizen": 10 }` with `maxUpgrades: 8`, which is where the 80
 * cap in the getter comes from.
 *
 * Three consequences, and each one closes a question rather than opening it.
 *
 * **Nothing sets this.** There is no setter in the typings and no callback in
 * the source. It is not the "button callback reads a selection it does not
 * take" class that `withTownBiome` and `withBuildQuantity` exist for, and it is
 * not one of the operator's UI selections either. It is a stat, earned by
 * building.
 *
 * **There is no trade-off to get wrong.** The worry was that tax would trade
 * against happiness — which multiplies population, which is already the thing
 * this town is short of. It does not. Town Hall's `provides` entry is
 * `population: 0, happiness: 0, education: 0, storage: 0, resources: []`: it
 * costs resources and supplies nothing but the tax modifier. So there is no
 * optimum to find and no greedy mistake available.
 *
 * **Zero GP/h is structural, not a misconfiguration.** Town Hall is tier 5,
 * which `populationForTier` (township.d.ts:418) gates on Township level 80 and
 * 40,000 population against this town's 33 and 184. Reporting the zero without
 * that is how a correct number costs every future reader the same hour: this
 * exact figure sent an operator hunting a setting that does not exist.
 */
export interface TownshipTaxStanding {
  /** `Township.taxRate` (township.d.ts:544) — capped at 80. */
  rate: number;
  /**
   * The building that would supply the rate, when none is built yet.
   *
   * Found from the registry rather than named here: hardcoding "Town Hall"
   * would be a fact about today's game data written into code that outlives it.
   * Null once tax is being collected, or if no registered building provides it.
   */
  unbuiltSource: {
    buildingId: string;
    name: string;
    tier: number;
    /** Percentage points of tax each one of these adds. */
    perBuilding: number;
    /** From `populationForTier[tier]`, the game's own tier gate. */
    requiresTownshipLevel: number;
    requiresPopulation: number;
  } | null;
}

/**
 * The modifier the tax rate is made of.
 *
 * A literal rather than `ModifierIDs.townshipTaxPerCitizen` (idEnums.d.ts:8967)
 * for the reason this repo has now paid for three times: those are ambient
 * `declare const enum`s, which compile to a global reference the mod bundle does
 * not have.
 */
const TAX_MODIFIER_ID = 'melvorD:townshipTaxPerCitizen';

/**
 * Reads the tax rate, and finds what would raise it while it is zero.
 *
 * The search is over every registered building's own `stats.modifiers`
 * (statProvider.d.ts:21, `ModifierValue[]`), taking the lowest tier that
 * provides the modifier — the cheapest route rather than the first listed.
 */
function readTaxStanding(township: typeof game.township): TownshipTaxStanding {
  const rate = safeNumber('township.taxRate', () => township.taxRate, 0);
  if (rate > 0) return { rate, unbuiltSource: null };

  let best: TownshipTaxStanding['unbuiltSource'] = null;

  for (const building of township.buildings.allObjects) {
    try {
      const provides = building.stats.modifiers?.find(
        (modifier) => modifier.modifier.id === TAX_MODIFIER_ID,
      );
      if (provides === undefined || provides.value <= 0) continue;
      if (best !== null && building.tier >= best.tier) continue;

      const gate = township.populationForTier[building.tier];
      best = {
        buildingId: building.id,
        name: building.name,
        tier: building.tier,
        perBuilding: provides.value,
        requiresTownshipLevel: gate?.level ?? 0,
        requiresPopulation: gate?.population ?? 0,
      };
    } catch (error) {
      noteSwallowed('township.readTaxStanding', error);
      // A building that cannot describe its modifiers is not the answer.
    }
  }

  return { rate, unbuiltSource: best };
}

/**
 * Population before happiness, summed the way `computeTownPopulation` does.
 *
 * Every biome and every building, not just unlocked biomes and available
 * buildings: the game's own loop is `this.biomes.forEach` over
 * `this.buildings.forEach`, and narrowing it would undercount a town whose
 * biome later locked behind a requirement.
 */
function sumBasePopulation(township: typeof game.township): number {
  let population = 0;

  for (const biome of township.biomes.allObjects) {
    for (const building of township.buildings.allObjects) {
      try {
        const count = biome.getBuildingCount(building);
        if (count <= 0) continue;
        population += count * township.getPopulationProvidesForBiome(building, biome);
      } catch (error) {
        noteSwallowed('township.sumBasePopulation', error);
        // One unreadable building understates the total, which the mismatch
        // check below turns into a report rather than a quiet wrong answer.
      }
    }
  }

  return population + game.modifiers.flatTownshipPopulation;
}

/** `applyModifier(base, modifier, 0)` — the game's percentage bonus. */
function applyPercentBonus(base: number, modifier: number): number {
  return Math.floor(base * (1 + modifier / 100));
}

/** `applyModifier(base, modifier, 3)` — the game's percentage *of* base. */
function applyPercentOf(base: number, modifier: number): number {
  return Math.floor(base * (modifier / 100));
}

export function readTownshipEconomy(): TownshipEconomy | null {
  const township = game.township;
  if (!township.townData.townCreated) return null;

  const happiness = township.townData.happiness;
  const health = township.townData.health;
  const basePopulation = sumBasePopulation(township);

  // The proof that the transcription still matches the engine. Off-by-one is
  // tolerated because `getPopulationProvidesForBiome` is unfloored (applyModifier
  // type 4) and the game floors only once at the end, so summing per-building
  // can land a fraction either side of the game's single rounding.
  const modelled = applyPercentBonus(basePopulation, happiness);
  const actual = township.townData.population;
  let modelMismatch: string | null = null;
  if (Math.abs(modelled - actual) > 1) {
    modelMismatch = `modelled population ${modelled} against the game's ${actual} (base ${basePopulation}, happiness ${happiness})`;
    recordFallback('township.populationModel', modelMismatch);
  }

  const ticksPerHour = safeNumber(
    'township.ticksPerHour',
    () => 3600 / township.TICK_LENGTH,
    // 300s ticks are the game's own default; a zero here would erase the rate
    // rather than fall back to it.
    12,
  );

  return {
    basePopulation,
    population: actual,
    workingPopulation: township.currentPopulation,
    happiness,
    health,
    xpPerHour: safeNumber(
      'township.xpPerHour',
      () => township.modifyXP(township.baseXPRate) * ticksPerHour,
      0,
    ),
    gpPerHour: safeNumber('township.gpPerHour', () => township.getGPGainRate() * ticksPerHour, 0),
    ticksPerHour,
    tax: readTaxStanding(township),
    modelMismatch,
  };
}

/** What building some of a building adds to the town's permanent output. */
export interface BuildValue {
  /** How many this figure is for. See {@link valueOfBuilding} on why not one. */
  quantity: number;
  /** Extra Township XP per hour, forever, with no action slot spent. */
  xpPerHour: number;
  /** Extra GP per hour the town pays the character, forever. */
  gpPerHour: number;
  /** Raw population the batch provides, before the happiness multiplier. */
  populationGain: number;
  /** Happiness the batch provides — a percentage bonus on the whole town. */
  happinessGain: number;
}

/**
 * Prices a building by the only two things Township pays in.
 *
 * This is the number that answers "which building", and until now nothing
 * computed it: every build candidate carried a count and an affordability, and
 * the two figures that decide the question — Township XP and GP — appeared
 * nowhere. So a Wooden Hut (+1 population each) and a Tailor (+0 of everything
 * the town is scored on) read identically, and a planner picking off a list of
 * seventeen had nothing to pick on but the wording.
 *
 * Both halves are derived from the game's own accessors rather than replicated:
 *
 * - **XP** through `modifyXP` (skill.d.ts:371), which carries whatever mastery
 *   and modifier terms the game applies, evaluated at the projected population
 *   instead of the current one. `baseXPRate` *is* `currentPopulation`, so
 *   substituting the projection is exact.
 * - **GP** by scaling the live `getGPGainRate()` by the population ratio.
 *   `getGPGainRate` is linear in `currentPopulation` — `pop * GP_PER_CITIZEN *
 *   taxRate/100` — so the ratio needs neither the tax rate nor the GP modifier,
 *   both of which would have had to be read and could each be wrong.
 *
 * The one thing genuinely transcribed is the two nested roundings between raw
 * population and `currentPopulation`, and {@link readTownshipEconomy} checks
 * that transcription against the game every time it is read.
 *
 * ## Why a batch and not one
 *
 * This priced one building first, and one building is the wrong unit — not for
 * neatness, but because the flooring makes it answer *zero* for the single most
 * valuable thing the town can currently do.
 *
 * Gardens provide +0.5 happiness each. Against this town's 184 population,
 * `floor(184 × 1.005)` is 184: one Garden is worth literally nothing, two are
 * worth as much as a Wooden Hut, and the twelve the town can afford are worth
 * +6% of everything. A per-building figure would have ranked the only source of
 * happiness in reach below buildings that provide nothing at all, with the
 * arithmetic impeccable the whole way.
 *
 * So the unit is the batch a build candidate actually stands for. A build
 * objective repeats — the adapter builds one per action and keeps going while
 * the town holds its reserve — so "how many could go up" is the honest
 * question, and it is the game's own clamp:
 * `min(getMaxAffordableBuildingQty, getBuildingCountRemainingForLevelUp)`,
 * which is exactly what `buildBuilding` computes before it spends anything.
 *
 * @returns Null when the town does not exist or the projection cannot be
 *   trusted — never a zero standing in for "unknown", because zero is a real
 *   and common answer here and the two must not be confused.
 */
export function valueOfBuilding(
  building: TownshipBuilding,
  biome: TownshipBiome,
  /**
   * The town read once by the caller. Passed rather than re-read because the
   * candidate loop prices every building and `readTownshipEconomy` walks every
   * biome and building to do it — re-reading it per candidate is that walk
   * squared for an answer that cannot change within one pass.
   */
  economy: TownshipEconomy | null = readTownshipEconomy(),
): BuildValue | null {
  const township = game.township;
  if (economy === null) return null;
  // A projection built on a formula the game just contradicted is worse than no
  // projection: it would rank builds against each other on a wrong scale and
  // nothing downstream could tell.
  if (economy.modelMismatch !== null) return null;

  // The game's own clamp, from `buildBuilding` in the shipped v1.3.1 source:
  //   const qtyToBuild = Math.min(this.getBuildingCountRemainingForLevelUp(building, biome), upgradeQty);
  // with `upgradeQty` resolving to `getMaxAffordableBuildingQty` at MAX. At
  // least one, so a building the town cannot yet afford is still priced for
  // what it would be worth rather than silently reading as worthless.
  const affordable = safeNumber(
    'township.buildAffordableQty',
    () => township.getMaxAffordableBuildingQty(building, biome),
    1,
  );
  const remaining = safeNumber(
    'township.buildRemainingQty',
    () => township.getBuildingCountRemainingForLevelUp(building, biome),
    1,
  );
  const quantity = Math.max(1, Math.min(affordable, remaining));

  const populationGain =
    safeNumber(
      'township.buildPopulationGain',
      () => township.getPopulationProvidesForBiome(building, biome),
      0,
    ) * quantity;
  const happinessGain =
    safeNumber(
      'township.buildHappinessGain',
      () => township.getHappinessProvidesForBiome(building, biome),
      0,
    ) * quantity;

  const projectedPopulation = applyPercentBonus(
    economy.basePopulation + populationGain,
    economy.happiness + happinessGain,
  );
  const projectedWorking = applyPercentOf(projectedPopulation, economy.health);

  const xpPerHour =
    safeNumber('township.projectedXp', () => township.modifyXP(projectedWorking), 0) *
      economy.ticksPerHour -
    economy.xpPerHour;

  // Zero working population makes the ratio undefined rather than infinite, and
  // a town that taxes nobody earns nothing whatever is built, so the honest
  // answer for the GP half is zero and not a division.
  //
  // Note what the ratio can and cannot see. It scales the town's live GP rate
  // by the projected population, which is exact for a building that supplies
  // citizens. It is *blind* to a building that changes `taxRate` instead — the
  // rate is `min(BASE_TAX_RATE + townshipTaxPerCitizen, 80)` and a modifier is
  // not a population term, so Town Hall prices at zero here despite being the
  // single largest GP change the town can make. That is invisible today because
  // Town Hall is tier 5 against a tier-1 town and is never a candidate, which is
  // exactly why it is written down rather than left to be discovered at level
  // 80. See IMPROVEMENTS.md.
  const gpPerHour =
    economy.workingPopulation > 0
      ? (economy.gpPerHour * projectedWorking) / economy.workingPopulation - economy.gpPerHour
      : 0;

  return {
    quantity,
    xpPerHour: Math.max(0, xpPerHour),
    gpPerHour: Math.max(0, gpPerHour),
    populationGain,
    happinessGain,
  };
}

/**
 * What one more of this building actually buys.
 *
 * "Build a hut" is not a decision anyone can weigh; "one more hut is +12 town
 * XP an hour and +54 GP an hour, forever" is.
 *
 * This label used to open with *"N more here reaches the next Township level"*,
 * and that sentence was false. `getBuildingCountRemainingForLevelUp` says
 * nothing about Township level; the shipped v1.3.1 source (township.js, read
 * from the nw.js cache — see `learnings/mod-api.md`) is one line:
 *
 *   getBuildingCountRemainingForLevelUp(building, biome) {
 *       return building.maxUpgrades - biome.getBuildingCount(building);
 *   }
 *
 * It is the count remaining until this building is *maxed in this biome*, which
 * is what `isBuildingAvailable` (:1051) gates the next building in the upgrade
 * chain on — a real and useful number, and not the one the label named. Every
 * build candidate advertised "20 more here reaches the next Township level"
 * because `maxUpgrades` is 20 for most buildings, and Gardens advertised 100.
 * Nothing about the town levelled up when a building maxed.
 *
 * The operator hit the consequence by hand: three Schools went up on the
 * strength of "3 more reaches the next Township level", the fourth was refused
 * with `melvorF:School is maxed in melvorF:Grasslands`, and the plan advanced.
 * The count was right about maxing and the sentence was wrong about why.
 *
 * The real answer to "what does this build buy" is {@link valueOfBuilding},
 * which is arithmetic on the game's own accessors rather than a name taken at
 * face value.
 *
 * The affordable quantity rides along because it bounds the answer: three more
 * needed and one affordable is a different plan from three and three.
 */
function describeBuildTarget(
  building: TownshipBuilding,
  biome: TownshipBiome,
  value: BuildValue | null,
): string {
  const township = game.township;
  const parts: string[] = [];

  if (value !== null && (value.xpPerHour > 0 || value.gpPerHour > 0)) {
    parts.push(
      `building the ${value.quantity} the town can afford is +${value.xpPerHour.toFixed(0)} Township xp/h and +${value.gpPerHour.toFixed(0)} GP/h forever, unattended`,
    );
    if (value.happinessGain > 0) {
      // Named separately because happiness is not additive with population, it
      // multiplies it — so a building that provides only happiness still moves
      // both numbers above, and a reader comparing "+0 pop" against a non-zero
      // rate would otherwise think the rate was invented.
      parts.push(
        `+${value.happinessGain} happiness across the batch, which is +${value.happinessGain}% population for the whole town`,
      );
    }
  } else if (value !== null) {
    // Explicit, because "no line" and "worth nothing" are the same silence and
    // most of this town's buildings are genuinely the second. A planner reading
    // a list of seventeen needs to see which ones the town is not paid for.
    parts.push('worth no Township xp/h or GP/h — it produces a resource, not citizens');
  }

  try {
    const remaining = township.getBuildingCountRemainingForLevelUp(building, biome);
    if (Number.isFinite(remaining) && remaining > 0) {
      parts.push(`${remaining} more maxes it here and unlocks its upgrade`);
    }
  } catch {
    // A building that cannot answer contributes nothing to the label.
  }

  try {
    const affordable = township.getMaxAffordableBuildingQty(building, biome);
    if (Number.isFinite(affordable) && affordable > 0) {
      parts.push(`${affordable} affordable now`);
    }
  } catch {
    // Same.
  }

  return parts.length === 0 ? '' : `, ${parts.join(', ')}`;
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
  /**
   * What the town pays per hour, and what happiness is doing to it.
   *
   * The summary already carried `happiness` and had done for as long as it has
   * existed. What it could not carry is the consequence, so a planner reading
   * "happiness 0" had no way to know whether that was a fault, a cost, or
   * nothing at all — and for a whole run nothing acted on it. See
   * {@link TownshipEconomy}.
   */
  economy: TownshipEconomy | null;
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
    economy: readTownshipEconomy(),
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
    } catch (error) {
      noteSwallowed('township.readWorshipCandidates', error);
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
  return new Set(readTaskWantedQuantities().keys());
}

/**
 * How many of each item the town's uncompleted tasks still want.
 *
 * The quantity matters as much as the identity, and treating the two as the
 * same thing was expensive. This walks every task in the game, not merely the
 * ones currently offered, because tasks rotate -- which is right. But paired
 * with a guard that excluded the whole stack, it meant a single future task
 * wanting one Gold Bar protected all 1,056 of them, and about 216,000 GP of
 * bars sat unsellable while the run was short of GP for Auto Eat.
 *
 * Keeping what the tasks ask for and releasing the surplus preserves the guard
 * completely: the reason it exists is that 500 Potatoes were sold an hour
 * before a task appeared wanting 100, and keeping 100 would have covered that
 * exactly.
 */
export function readTaskWantedQuantities(): Map<string, number> {
  const wanted = new Map<string, number>();
  const township = game.township;
  if (!township.townData.townCreated) return wanted;

  const collect = (goals: { itemGoals: { item: { id: string }; quantity: number }[] }): void => {
    for (const goal of goals.itemGoals) {
      // The largest single ask, not the sum: tasks are completed one at a time,
      // so holding the biggest requirement covers any of them.
      const need = Math.max(wanted.get(goal.item.id) ?? 0, goal.quantity);
      wanted.set(goal.item.id, need);
    }
  };

  for (const task of township.tasks.tasks.allObjects) {
    try {
      if (township.tasks.completedTasks.has(task)) continue;
      collect(task.goals);
    } catch (error) {
      noteSwallowed('township.readTaskWantedQuantities', error);
      // A task that cannot describe its goals protects nothing.
    }
  }

  for (const task of township.casualTasks.currentCasualTasks) {
    try {
      if (township.casualTasks.isTaskComplete(task)) continue;
      collect(task.goals);
    } catch (error) {
      noteSwallowed('township.readTaskWantedQuantities', error);
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
    } catch (error) {
      noteSwallowed('township.readClaimableTasks', error);
      // A task that cannot report completion is not claimable.
    }
  }

  for (const task of township.tasks.tasks.allObjects) {
    try {
      if (township.tasks.completedTasks.has(task)) continue;
      if (task.goals.checkIfMet()) claimable.push({ kind: 'township', taskId: task.id });
    } catch (error) {
      noteSwallowed('township.readClaimableTasks', error);
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
    } catch (error) {
      noteSwallowed('township.readTaskCandidates', error);
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
    } catch (error) {
      noteSwallowed('township.readTaskCandidates', error);
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
    } catch (error) {
      noteSwallowed('township.describeModifiers', error);
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
    } catch (error) {
      noteSwallowed('township.readTaskOpportunities', error);
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
  } catch (error) {
    noteSwallowed('township.describeGoal', error);
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
        } catch (error) {
          noteSwallowed('township.readRepairableBuildings', error);
          // A building that will not report its efficiency is left alone.
        }
      }
    }
  } catch (error) {
    noteSwallowed('township.readRepairableBuildings', error);
    return [];
  }

  return out;
}

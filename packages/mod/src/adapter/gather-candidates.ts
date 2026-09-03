import type { Candidate } from '@melvor-agent/shared';
import { readShortSeedIds } from './farming.js';
import { FISHING_ID, MINING_ID, THIEVING_ID, WOODCUTTING_ID } from './gathering.js';
import { gpValue } from './pricing.js';
import {
  MS_PER_HOUR,
  masteryNote,
  miningIntervalFor,
  productYieldFor,
  xpMultiplierFor,
} from './rates.js';
import { type RecipeLike, isRecipeRealmUnlocked, recipeRequirement } from './recipes.js';
import { noteSwallowed, recordFallback, safeNumber } from './safe.js';
import { readTaskWantedQuantities } from './township.js';

/**
 * The four gathering skills that price themselves better than the generic
 * enumeration can.
 *
 * Woodcutting, Mining, Fishing and Thieving each have a selection API and a
 * rate model of their own -- a tree cut limit, a rock that empties and
 * respawns, an interval drawn from a range, a payout in `currencyDrops` rather
 * than a product -- and each was scored wrongly at some point by being folded
 * into the shared path. They are enumerated here, one function apiece, and
 * `readGatherCandidates` runs each behind its own isolation wrapper.
 */

function candidate(
  skillId: string,
  skillName: string,
  recipe: RecipeLike,
  intervalMs: number,
  productGp: number,
  skill?: AnySkill,
  /** Per-action GP that is not the priced product, e.g. a mining gem roll. */
  extraGpPerAction = 0,
  /** Appended to the label; used to name an uncertainty rather than price it. */
  note = '',
): Candidate {
  const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;
  const requirement = recipeRequirement(recipe);

  // Yield and XP both scale with mastery, and both come from the game's own
  // accessors rather than a multiplier assembled here.
  const yielded =
    skill === undefined ? 1 : productYieldFor(skill, recipe, recipe.baseQuantity ?? 1);
  const xpMultiplier = skill === undefined ? 1 : xpMultiplierFor(skill, recipe);
  const salePerHour = actionsPerHour * (productGp * yielded + extraGpPerAction);
  return {
    kind: 'gather_resource',
    params: { kind: 'gather_resource', skillId, recipeId: recipe.id },
    // "gp/h" means two different things across this list and the label never
    // said which. Thieving pays coins directly, so its figure is money in
    // pocket. Gathering produces *items*, so its figure is what those items
    // would fetch if sold — and nothing sells them automatically.
    //
    // The difference is not cosmetic. Crystal was picked as "120,000 GP/h, two
    // and a half times Thieving" to fund a 1,000,000 GP purchase, and an hour
    // of it moves GP by exactly zero: the ore piles up in a bank that is
    // already near full, which is how the last deadlock started. A plan aimed
    // at a GP goal has to sell, and that step is invisible if the list calls
    // both things the same name.
    label:
      (salePerHour > 0
        ? `${skillName}: ${recipe.name} — output worth ${Math.round(salePerHour).toLocaleString()} GP/h if sold, not GP earned`
        : `${skillName}: ${recipe.name}`) +
      (skill === undefined ? '' : masteryNote(skill, recipe)) +
      note,
    xpPerHour: actionsPerHour * requirement.xp * xpMultiplier,
    gpPerHour: salePerHour,
    requiresLevel: requirement.level,
    available: true,
  };
}

export function woodcuttingCandidates(): Candidate[] {
  const skill = game.woodcutting;
  return skill.actions.allObjects
    .filter((tree) => skill.isTreeUnlocked(tree) && isRecipeRealmUnlocked(tree))
    .map((tree) =>
      candidate(
        WOODCUTTING_ID,
        skill.name,
        tree,
        // Already accounts for gear, mastery and modifiers.
        //
        // Divided by the cut limit because the executor now fills every slot:
        // two trees cut at once produce two trees' worth of logs in the same
        // wall-clock time, so the effective interval per unit of output is that
        // much shorter. Pricing one tree while cutting several understated
        // Woodcutting by exactly the multiple the character had bought.
        skill.getTreeInterval(tree) /
          Math.max(
            1,
            safeNumber('candidates.treeCutLimit', () => skill.treeCutLimit, 1),
          ),
        gpValue(tree.product),
        skill,
      ),
    );
}

export function miningCandidates(): Candidate[] {
  const skill = game.mining;
  const rocks = skill.actions.allObjects.filter(
    (rock) => skill.canMineOre(rock) && isRecipeRealmUnlocked(rock),
  );

  // One report for the whole pass, not one per rock.
  //
  // `gemGpPerAction` recorded a failure for every gem-bearing rock it priced,
  // and the live report read `candidates.share1 x1104` -- 1,104 being exactly
  // 138 enumeration passes times the 8 rocks that carry `giveGems`, i.e. one
  // per rock per pass, none of which said anything the first one had not. That
  // is the failure mode `safe.ts` exists to avoid: `adapterFailures` is read to
  // find the accessor that broke, and a single unanswerable read repeated a
  // thousand times buries every other entry under itself.
  //
  // The count still has to be non-zero -- a silent fallback is the thing this
  // module was written against -- so the pass records once and says how many
  // rocks it covers.
  const priced = rocks.map((rock) => ({ rock, gem: gemGpPerAction(rock) }));
  const unpriced = priced.filter(({ gem }) => gem.unpriced).length;
  if (unpriced > 0) {
    recordFallback(
      'candidates.rockGemChance',
      `${unpriced} gem-bearing rock(s) priced without their gem roll: Mining.getRockGemChance refuses while no rock is selected`,
    );
  }

  return priced.map(({ rock, gem }) =>
    candidate(
      MINING_ID,
      skill.name,
      rock,
      miningIntervalFor(rock),
      gpValue(rock.product),
      skill,
      gem.gpPerAction,
      passiveRegenNote(rock) + gem.note,
    ),
  );
}

/**
 * Expected GP from the gem roll a mining action carries, per action.
 *
 * Gems are a material share of what Mining pays and they appeared nowhere: the
 * board priced the ore and nothing else, so a rock whose whole point is its gem
 * chance read as worth only its ore. That is the same omission as Thieving's
 * `currencyDrops` -- a reward that does not arrive as the recipe's `product` is
 * invisible to product arithmetic.
 *
 * Every term is read, not modelled. `getRockGemChance` (rockTicking.d.ts:154)
 * and `getRockSuperiorGemChance` (:155) are the game's own per-rock chances, and
 * `DropTable.getAverageDropValue` (utils.d.ts:458) is documented as "the average
 * currency value of a drop in this table" for `game.randomGemTable` /
 * `game.randomSuperiorGemTable` (game.d.ts:198-199) -- so the gem's price comes
 * from the table rather than from picking a representative gem, which would have
 * been a guess dressed as data.
 *
 * Three deliberate understatements, all in the recoverable direction:
 *
 * - The rolls are gated on `giveGems` / `giveSuperiorGems`
 *   (rockTicking.d.ts:70-71) rather than trusting the chance getters to return 0
 *   for a rock that yields no gems, which is not stated.
 * - The chances are read as percentages, matching every other chance getter this
 *   file consumes. If they are fractions instead this is a hundredfold
 *   *under*statement, which measurement corrects; the other way round would put
 *   a fabricated number at the top of the board.
 * - `chanceToDoubleGems` (rockTicking.d.ts:153) is applied only to the ordinary
 *   gem. Whether it also covers superior gems is not stated in the typings.
 *
 * Abyssal gems are left out entirely: their rocks are realm-gated and absent
 * from the board anyway.
 *
 * And one thing that is not an understatement but a hole, named as such.
 *
 * `Mining.getRockGemChance(ore)` (rockTicking.d.ts:157) takes the rock as an
 * argument and yet throws "Tried to get active rock data, but none is selected"
 * -- the message of `get activeRock()` (rockTicking.d.ts:133) -- so it consults
 * the selection internally for something its signature does not disclose.
 * Enumeration runs precisely when nothing is selected, so this call has never
 * once succeeded: every gem-bearing rock on every board the agent has ever
 * ranked was priced at its ore alone.
 *
 * There is no second source to fall back on. `MiningRock` declares
 * `superiorGemChance` (rockTicking.d.ts:77) and `abyssalGemChance` (:79) as
 * data, but *no* field for the primary gem chance; `Mining` declares
 * `baseInterval`, `baseRockHP` and `passiveRegenInterval` as readonly constants
 * (:108-110) and no base gem chance among them; and while
 * `modifiers.miningGemChance` (modifierTable.d.ts:405) exists, it is by its name
 * the bonus applied to a base this codebase would have to invent. Inventing it
 * is the Crystal mistake -- a plausible model in the overstating direction cost
 * an afternoon -- so it is not invented.
 *
 * So the gem term is reported as *unknown*, not as zero, and the label says so.
 * A rock whose whole point is its gem chance must not read as identical to one
 * that yields none, which is exactly what a silent 0 did.
 *
 * `getRockSuperiorGemChance` (:158) is left calling the getter because we have
 * no evidence it refuses the same way: `share2` never appeared in the failure
 * report at all, which means it was never reached -- no rock on this character's
 * board reports `giveSuperiorGems` -- and not that it answered. If a superior
 * rock ever unlocks, the site below is what will say which of the two it is.
 */
interface GemValue {
  /** GP per action from gem rolls this code could actually price. */
  gpPerAction: number;
  /** True when a roll the rock definitely makes could not be priced at all. */
  unpriced: boolean;
  /** Appended to the label, so the reader can tell 0 from unknown. */
  note: string;
}

function gemGpPerAction(rock: MiningRock): GemValue {
  const nothing: GemValue = { gpPerAction: 0, unpriced: false, note: '' };

  try {
    const mining = game.mining;
    const doubling =
      1 +
      Math.max(
        0,
        safeNumber('candidates.chanceToDoubleGems', () => mining.chanceToDoubleGems, 0) / 100,
      );

    let gp = 0;
    let unpriced = false;

    if (rock.giveGems === true) {
      // Unrecorded here on purpose; `miningCandidates` records once per pass.
      // See the comment there for why 1,104 identical entries were the bug.
      const chance = unrecordedShare(() => mining.getRockGemChance(rock));
      if (chance === undefined) unpriced = true;
      else gp += chance * averageDropGp(game.randomGemTable) * doubling;
    }

    if (rock.giveSuperiorGems === true) {
      const chance = share('candidates.rockSuperiorGemChance', () =>
        mining.getRockSuperiorGemChance(rock),
      );
      gp += chance * averageDropGp(game.randomSuperiorGemTable);
    }

    return {
      gpPerAction: Number.isFinite(gp) && gp > 0 ? gp : 0,
      unpriced,
      note: unpriced
        ? ' — gem value unknown, not zero: the game will not report the gem chance of a rock while none is selected, so this figure prices the ore only'
        : '',
    };
  } catch {
    return nothing;
  }
}

/** A percentage getter read as a 0..1 share; 0 when it will not answer. */
function share(site: string, read: () => number): number {
  const percent = safeNumber(site, read, 0);
  if (!Number.isFinite(percent) || percent <= 0) return 0;
  return Math.min(1, percent / 100);
}

/**
 * The same reading, uncounted, for the one caller that counts for itself.
 *
 * `undefined` and 0 are different answers here and the caller acts on the
 * difference, which is why this does not go through `safeNumber`: that helper
 * folds "would not answer" into the fallback, and folding it is the whole bug.
 */
function unrecordedShare(read: () => number): number | undefined {
  try {
    const percent = read();
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return undefined;
    return Math.min(1, Math.max(0, percent / 100));
  } catch {
    return undefined;
  }
}

/** The GP a drop table pays on average, ignoring any non-GP currency it holds. */
function averageDropGp(table: DropTable): number {
  try {
    const value = table.getAverageDropValue().get(game.gp);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Names the uncertainty a passively regenerating rock carries.
 *
 * {@link miningIntervalFor} charges these rocks the bare interval, because they
 * refill while being mined and so never spend a respawn. That is an upper bound,
 * not a rate: `Mining.regenRockHP` (rockTicking.d.ts:176) restores an unstated
 * amount every `passiveRegenInterval` (:108), so whether regeneration actually
 * keeps pace with mining cannot be answered from the typings at all.
 *
 * The obvious model -- one HP per regen interval -- was tried and measured, and
 * it overestimated the realised rate by 3.3x. So the number is left as the bound
 * it is and the label says so, because the whole lesson of Crystal's 120,000
 * GP/h is that a plausible model in the overstating direction costs an
 * afternoon, while an acknowledged gap costs a sentence.
 */
function passiveRegenNote(rock: MiningRock): string {
  try {
    if (rock.hasPassiveRegen !== true) return '';
    return ' — rate unverified: this rock regenerates while mined and the HP restored per regen tick is not stated in the typings, so this is an upper bound';
  } catch {
    return '';
  }
}

/**
 * Thieving, with its GP actually visible.
 *
 * This existed in the generic path and was therefore scored at zero GP/hr,
 * because a thieving payout is a `currencyDrops` entry on the NPC rather than a
 * product item that gets sold. The effect was not cosmetic: Thieving is one of
 * the few things that turns time directly into money with no input, and a
 * planner comparing candidates on GP/hr could not see it at all. Every
 * money-making decision was made from a list where the money option read as
 * worthless.
 *
 * The rate is expected value, not best case: the payout is multiplied by the
 * game's own success rate, because a failed pickpocket earns nothing and
 * quoting the max would make Thieving look better than it is at low levels.
 *
 * **Gated on food.** A failed pickpocket deals damage, so Thieving without food
 * equipped is a slow death rather than an income — the same class of hazard as
 * combat, and it does not announce itself, because the first hour looks like it
 * is working. Offering it foodless would hand the planner an option that ends
 * with a dead character, so no candidates are emitted at all.
 *
 * The stricter check — whether healing outpaces damage for a *specific* NPC —
 * belongs with the combat gate's survivability math and is not duplicated here.
 * This is the floor: no food, no thieving.
 */
export function thievingCandidates(): Candidate[] {
  const skill = game.thieving;
  const player = game.combat.player;

  const foodQuantity = player.food.slots.reduce(
    (sum, slot) => sum + (slot.item === game.emptyFoodItem ? 0 : slot.quantity),
    0,
  );
  if (foodQuantity <= 0) return [];

  // Same "what is this for" annotation the fight candidates carry. Monsters got
  // it and Thieving did not, which is backwards: the reason this character is
  // grinding Thieving at all is Bob the Farmer, the only NPC in the game's data
  // that drops Potato Seeds, and his entry said nothing about that.
  const wantedByNeed = new Set<string>([
    ...readTaskWantedQuantities().keys(),
    ...readShortSeedIds(),
  ]);

  return (
    skill.actions.allObjects
      .filter((npc) => npc.level <= skill.level)
      // Dropped while the NPC hits too hard for the health on hand; see
      // THIEVING_MAX_HIT_FRACTION. Filtered on the NPC rather than on a marker
      // smuggled through the label — that trick put a literal NUL byte in this
      // file and shipped it, which is what a clever encoding buys you.
      .filter((npc) => !hitsTooHardForNow(npc.maxHit))
      .map((npc) => {
        const successRate = Math.max(
          0,
          Math.min(
            1,
            safeNumber('candidates.thievingSuccessRate', () => skill.getNPCSuccessRate(npc), 0) /
              100,
          ),
        );

        // `getNPCInterval(npc)` (thieving2.d.ts:193), not `skill.actionInterval`.
        //
        // The old reading had the active-selection dependency documented for
        // Mining: it returns 0 unless Thieving is the skill currently running,
        // so every Thieving candidate showed no rate at all while the agent was
        // doing anything else — worthless exactly when a planner is deciding
        // whether to start it. That was accepted here as "absent rather than
        // guessed", but the choice was never between a zero and a guess: this
        // accessor takes the NPC as an argument and so does not care what is
        // running. The honest number was available the whole time.
        //
        // A failed steal is charged too. `getStunInterval` (thieving2.d.ts:182)
        // is time in which nothing is earned, so the expected cost of an action
        // is its interval plus the stun that failure carries — the same shape
        // as a mining respawn, and ignoring it overstates exactly the low-level
        // NPCs whose success rate is worst.
        const baseIntervalMs = safeNumber(
          'candidates.thievingNPCInterval',
          () => skill.getNPCInterval(npc),
          safeNumber('candidates.thievingInterval', () => skill.actionInterval, 3000),
        );
        const stunMs = safeNumber(
          'candidates.thievingStunInterval',
          () => skill.getStunInterval(npc),
          0,
        );
        const intervalMs = baseIntervalMs + (1 - successRate) * stunMs;
        const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;

        const gpPerAction = npc.currencyDrops
          .filter((drop) => drop.currency === game.gp)
          // `quantity` is the maximum roll, so the mean is about half of it.
          .reduce((sum, drop) => sum + drop.quantity / 2, 0);

        return {
          kind: 'gather_resource' as const,
          params: {
            kind: 'gather_resource' as const,
            skillId: THIEVING_ID,
            recipeId: npc.id,
          },
          // Damage is named, because Thieving hurts and the number is not
          // proportional to level. Golbin Chief hits 10.1 at level 16 while
          // Marauder hits 6.8 at 21 and Assistant Cook 8.6 at 26 — so choosing by
          // XP alone picks the hardest-hitting NPC of its tier without ever
          // seeing the figure. It was chosen exactly that way, and the operator
          // had to point out that it hits hard for the character's health.
          //
          // Shown as a share of *current* health rather than maximum: a hit worth
          // a fifteenth of a full bar is a different proposition at half health,
          // and Thieving damage accrues over many failures rather than resolving
          // in one fight.
          label: `Thieving: ${npc.name} — hits up to ${npc.maxHit} (${hpShare(npc.maxHit)} of current HP)${describeNpcDrops(npc, wantedByNeed)}`,
          xpPerHour: actionsPerHour * npc.baseExperience * successRate,
          gpPerHour: actionsPerHour * gpPerAction * successRate,
          // Coins into the balance, not items that would fetch coins.
          gpIsEarned: true,
          requiresLevel: npc.level,
          available: true as const,
        };
      })
  );
}

/**
 * The share of current health a Thieving hit may take before the NPC is refused.
 *
 * Thieving is the only thing in the game that damages the character without
 * being combat, and it had no survivability gate at all — combat screens every
 * monster by combat level and then re-checks the real max hit once the fight
 * starts, while Thieving checked only that food was equipped.
 *
 * A quarter of *current* health, not maximum, so the gate tightens as the
 * character gets hurt rather than staying nominally satisfied while the bar
 * empties. At full health almost everything passes, which is correct: a 10.1
 * hit against 150 is survivable and the eat reflex covers it. At 40 health the
 * same NPC is refused, which is the case that actually matters and the one a
 * max-health check would have waved through.
 *
 * Deliberately not stricter. Refusing safe pickpockets costs the income that
 * funds Auto Eat, and Auto Eat is what would remove this whole problem.
 */
const THIEVING_MAX_HIT_FRACTION = 0.25;

/**
 * Whether an NPC hits too hard for the health currently available.
 *
 * Fails open on an unreadable state: refusing every NPC because the player
 * object could not be read would silently delete Thieving, and this is a gate
 * on one skill rather than a guard against irreversible harm.
 */
function hitsTooHardForNow(maxHit: number): boolean {
  try {
    const current = game.combat.player.hitpoints;
    if (current <= 0) return false;
    return maxHit > current * THIEVING_MAX_HIT_FRACTION;
  } catch (error) {
    noteSwallowed('candidates.hitsTooHardForNow', error);
    return false;
  }
}

/**
 * A hit expressed against the health actually available.
 *
 * The planner reads these labels as text; a bare number invites comparing max
 * hits to each other rather than to the character, which is the comparison that
 * decides whether a run is survivable.
 */
function hpShare(maxHit: number): string {
  try {
    const current = game.combat.player.hitpoints;
    if (current <= 0) return 'unknown share';
    return `${Math.round((maxHit / current) * 100)}%`;
  } catch (error) {
    noteSwallowed('candidates.hpShare', error);
    return 'unknown share';
  }
}

export function fishingCandidates(): Candidate[] {
  const skill = game.fishing;
  return skill.actions.allObjects
    .filter(
      (fish) =>
        fish.area !== undefined &&
        skill.isMasteryActionUnlocked(fish) &&
        isRecipeRealmUnlocked(fish),
    )
    .map((fish) =>
      candidate(
        FISHING_ID,
        skill.name,
        fish,
        // Fishing rolls an interval per action, so the midpoint is the honest
        // expected value rather than either bound.
        (skill.getMinFishInterval(fish) + skill.getMaxFishInterval(fish)) / 2,
        gpValue(fish.product),
        skill,
      ),
    );
}

/**
 * Names what a Thieving NPC drops that the agent is short of.
 *
 * The mirror of {@link readMonsterDropsOfInterest} for the other half of the
 * game that has loot tables. Without it, every NPC entry reads as a rate and a
 * damage figure, and the reason to prefer one over another — that it carries
 * the seed a blocked skill is waiting on — is invisible.
 *
 * `uniqueDrop` is included because it is guaranteed rather than rolled, and it
 * is not part of the loot table: an NPC whose unique drop is the wanted item
 * gives it every single time, which is the strongest possible reason to pick it
 * and was previously nowhere on screen.
 */
function describeNpcDrops(
  npc: {
    lootTable: { drops: { item: { id: string; name: string } }[] };
    uniqueDrop?: { item: { id: string; name: string } };
  },
  wanted: ReadonlySet<string>,
): string {
  if (wanted.size === 0) return '';

  try {
    const names = new Set<string>();
    for (const drop of npc.lootTable.drops) {
      if (wanted.has(drop.item.id)) names.add(drop.item.name);
    }
    const unique = npc.uniqueDrop?.item;
    if (unique !== undefined && wanted.has(unique.id)) names.add(`${unique.name} (guaranteed)`);

    return names.size === 0 ? '' : ` — drops ${[...names].join(', ')}, which you are short of`;
  } catch (error) {
    noteSwallowed('candidates.describeNpcDrops', error);
    return '';
  }
}

import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isArtisanSkill, startArtisan, stopArtisan } from './artisan.js';
import { noteSwallowed } from './safe.js';
import { isMiscSkill, startMiscSkill, stopMiscSkill } from './skills-misc.js';

/**
 * Namespaced ids of the gathering skills with a verified executor.
 *
 * Adding one means reading that skill's own selection API first. They are not
 * uniform and a shared abstraction would be a lie:
 *
 * - Woodcutting: `selectTree(tree)` toggles membership in a `Set`, multi-select
 *   up to `treeCutLimit`, then a plain `start()`.
 * - Mining: `onRockClick(rock)` sets a single `selectedRock`.
 * - Fishing: `onAreaFishSelection(area, fish)` per area, then
 *   `onAreaStartButtonClick(area)` — there is no plain `start()` per fish.
 */
export const WOODCUTTING_ID = 'melvorD:Woodcutting';
export const MINING_ID = 'melvorD:Mining';
export const THIEVING_ID = 'melvorD:Thieving';
export const FISHING_ID = 'melvorD:Fishing';

export const GATHERING_SKILL_IDS = [WOODCUTTING_ID, MINING_ID, FISHING_ID] as const;

/**
 * What "am I gathering the right thing" looks like, uniformly.
 *
 * Every skill projects into this shape so callers compare like with like even
 * though the underlying selection state differs wildly.
 */
export interface GatheringProjection {
  skillId: string;
  /** True when the skill reports itself as ticking. */
  active: boolean;
  /** Ids of the recipes currently selected. Sorted, so the projection is stable. */
  selected: string[];
  /** The game's single active action, if any. */
  activeActionId: string | null;
}

/** Whether a projection shows the intended recipe actually being gathered. */
function isGathering(projection: GatheringProjection, recipeId: string): boolean {
  return projection.active && projection.selected.includes(recipeId);
}

/**
 * Ensures a gathering skill is running on a specific recipe.
 *
 * Deliberately one call rather than a `select` then `start` pair. Several of
 * these skills expose selection as a *UI click callback* (`onRockClick`,
 * `onAreaStartButtonClick`) whose side effects are not documented — clicking may
 * or may not also start the action. Sequencing two separately-verified steps
 * across those would produce a real failure mode: selection succeeds, start
 * reports "already active", and the caller cannot tell success from a stuck
 * half-state.
 *
 * Making the composite the unit of verification sidesteps that entirely. The
 * post-condition is what the caller actually cares about — this skill is ticking
 * on this recipe — and it is observed, not inferred from any return value.
 *
 * @param skillId - One of {@link GATHERING_SKILL_IDS}.
 * @param recipeId - Tree, rock or fish id.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the skill is now gathering that recipe.
 */
/**
 * Refuses to start production the bank cannot hold.
 *
 * A full bank does not stop a skill: it keeps ticking, XP keeps accruing, and
 * every item it makes is discarded. Observed live — a minute of Runecrafting
 * consumed the essence, earned the XP, and banked no runes at all, because a
 * Township reward had filled the bank first.
 *
 * Only *new item types* are blocked. A skill topping up a stack the bank
 * already holds is fine at any capacity, which is why this asks whether the
 * product is already there rather than simply refusing on a full bank.
 *
 * @returns A reason to refuse, or null when the product has somewhere to go.
 */
function bankCannotHoldProduct(skillId: string, recipeId: string): string | null {
  try {
    // Inside the guard: a game object without a bank is a test double, and a
    // capacity check that throws must not stop the skill from starting.
    if (game.bank.occupiedSlots < game.bank.maximumSlots) return null;

    const skill = game.skills.getObjectByID(skillId) as
      | (AnySkill & { actions?: { getObjectByID(id: string): { product?: AnyItem } | undefined } })
      | undefined;

    const product = skill?.actions?.getObjectByID(recipeId)?.product;
    // A recipe whose product cannot be read is allowed through: refusing on
    // ignorance would block skills whose shape simply differs.
    if (product === undefined) return null;
    if (game.bank.getQty(product) > 0) return null;

    return `bank is full (${game.bank.occupiedSlots}/${game.bank.maximumSlots}) and holds no ${product.name}; the skill would run and every item it made would be discarded`;
  } catch (error) {
    noteSwallowed('gathering.bankCannotHoldProduct', error);
    return null;
  }
}

export function startGathering(
  skillId: string,
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const bankRefusal = bankCannotHoldProduct(skillId, recipeId);
  if (bankRefusal !== null) {
    return fail('gathering.start', 'precondition', bankRefusal);
  }

  switch (skillId) {
    case WOODCUTTING_ID:
      return startWoodcuttingOn(recipeId, isSuspended);
    case MINING_ID:
      return startMiningOn(recipeId, isSuspended);
    case FISHING_ID:
      return startFishingOn(recipeId, isSuspended);
    default:
      // Artisan skills share a real base class in the game's hierarchy;
      // everything else is routed individually.
      if (isArtisanSkill(skillId)) return startArtisan(skillId, recipeId, isSuspended);
      if (isMiscSkill(skillId)) return startMiscSkill(skillId, recipeId, isSuspended);
      return fail(
        'skill.start',
        'precondition',
        `no verified routine for skill ${skillId}; selection APIs are not uniform, so each needs one`,
      );
  }
}

/**
 * Every skill the agent can start.
 *
 * Deliberately excludes: the combat skills, which are started through the
 * combat manager and are gated on the Phase 2 survivability check; Farming,
 * which is plant-then-harvest rather than a continuous action and deserves its
 * own objective kind; and Township, Cartography and Archaeology, which are not
 * recipe-shaped at all — a hex is a position, a dig site consumes a map, a town
 * is built — and so have their own capabilities instead.
 */
export const STARTABLE_SKILL_IDS: readonly string[] = [
  ...GATHERING_SKILL_IDS,
  'melvorD:Smithing',
  'melvorD:Crafting',
  'melvorD:Fletching',
  'melvorD:Herblore',
  'melvorD:Runecrafting',
  'melvorD:Summoning',
  'melvorD:Firemaking',
  'melvorD:Cooking',
  'melvorD:Thieving',
  'melvorD:Astrology',
  'melvorD:Agility',
  'melvorD:Magic',
  'melvorItA:Harvesting',
];

/** Refuses when another skill already holds the game's single action slot. */
function actionSlotHeldBy(skillId: string): string | null {
  const active = game.activeAction;
  if (active === undefined || active.id === skillId) return null;
  return `another action is running: ${active.id}`;
}

// --- Woodcutting -----------------------------------------------------------

function projectWoodcutting(): GatheringProjection {
  return {
    skillId: WOODCUTTING_ID,
    active: game.woodcutting.isActive,
    selected: [...game.woodcutting.activeTrees].map((tree) => tree.id).sort(),
    activeActionId: game.activeAction?.id ?? null,
  };
}

function startWoodcuttingOn(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const tree = game.woodcutting.actions.getObjectByID(recipeId);
  if (tree === undefined) {
    return fail('woodcutting.gather', 'precondition', `no tree registered with id ${recipeId}`);
  }

  return act(
    {
      name: 'woodcutting.gather',
      observe: projectWoodcutting,
      precondition: () => {
        if (!game.woodcutting.isTreeUnlocked(tree)) {
          return `tree ${recipeId} is locked (needs level ${tree.level})`;
        }
        if (isGathering(projectWoodcutting(), recipeId)) {
          return `already cutting ${recipeId}`;
        }
        return actionSlotHeldBy(WOODCUTTING_ID);
      },
      perform: () => {
        // selectTree toggles, so selecting an already-selected tree would
        // deselect it. Only touch it when it is not already chosen.
        if (!game.woodcutting.activeTrees.has(tree)) {
          if (game.woodcutting.activeTrees.size >= game.woodcutting.treeCutLimit) {
            // At the limit, clear the selection so the intended tree can fit.
            for (const selected of [...game.woodcutting.activeTrees]) {
              game.woodcutting.selectTree(selected);
            }
          }
          game.woodcutting.selectTree(tree);
        }

        // Fill the remaining slots rather than leaving them empty.
        //
        // `treeCutLimit` is a real, purchasable capability -- Multi-Tree is a
        // shop upgrade -- and cutting one tree while holding two slots throws
        // away the half of it that was paid for. The executor previously only
        // ever cleared the selection to make room for its target, so the extra
        // slots stayed empty however many the character had earned.
        //
        // Best remaining tree first, so the filler is the next most valuable
        // thing and not whatever the registry happened to list.
        fillRemainingTreeSlots(tree);

        return game.woodcutting.isActive ? undefined : game.woodcutting.start();
      },
      changed: (_before, after) => isGathering(after, recipeId),
    },
    isSuspended,
  );
}

// --- Mining ----------------------------------------------------------------

function projectMining(): GatheringProjection {
  const selected = game.mining.selectedRock;
  return {
    skillId: MINING_ID,
    active: game.mining.isActive,
    selected: selected === undefined ? [] : [selected.id],
    activeActionId: game.activeAction?.id ?? null,
  };
}

function startMiningOn(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const rock = game.mining.actions.getObjectByID(recipeId);
  if (rock === undefined) {
    return fail('mining.gather', 'precondition', `no rock registered with id ${recipeId}`);
  }

  return act(
    {
      name: 'mining.gather',
      observe: projectMining,
      precondition: () => {
        if (!game.mining.canMineOre(rock)) {
          return `rock ${recipeId} cannot be mined (locked, or depleted and respawning)`;
        }
        if (isGathering(projectMining(), recipeId)) return `already mining ${recipeId}`;
        return actionSlotHeldBy(MINING_ID);
      },
      perform: () => {
        // onRockClick is the UI click handler. Whether it also starts the skill
        // is undocumented, so start() is called only if it did not.
        game.mining.onRockClick(rock);
        return game.mining.isActive ? undefined : game.mining.start();
      },
      changed: (_before, after) => isGathering(after, recipeId),
    },
    isSuspended,
  );
}

// --- Fishing ---------------------------------------------------------------

function projectFishing(): GatheringProjection {
  return {
    skillId: FISHING_ID,
    active: game.fishing.isActive,
    // Fishing selects one fish per area; the active one is what matters, but
    // reporting every selection makes a wrong-area start visible in the evidence.
    selected: [...game.fishing.selectedAreaFish.values()].map((fish) => fish.id).sort(),
    activeActionId: game.activeAction?.id ?? null,
  };
}

function startFishingOn(
  recipeId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const fish = game.fishing.actions.getObjectByID(recipeId);
  if (fish === undefined) {
    return fail('fishing.gather', 'precondition', `no fish registered with id ${recipeId}`);
  }

  const area = fish.area;
  if (area === undefined) {
    // `Fish.area` is optional in the typings; a fish with no area cannot be
    // started, because starting is an area-level operation.
    return fail('fishing.gather', 'precondition', `fish ${recipeId} has no fishing area`);
  }

  return act(
    {
      name: 'fishing.gather',
      observe: projectFishing,
      precondition: () => {
        if (!game.fishing.isMasteryActionUnlocked(fish)) {
          return `fish ${recipeId} is locked (needs level ${fish.level})`;
        }
        if (area.requiredItem !== undefined) {
          // Starting without the area's required item would silently no-op.
          const equipped = game.combat.player.equipment.checkForItem(area.requiredItem);
          if (!equipped) {
            return `area ${area.id} requires ${area.requiredItem.id} to be equipped`;
          }
        }
        if (game.fishing.isActive && game.fishing.activeFish === fish) {
          return `already fishing ${recipeId}`;
        }
        return actionSlotHeldBy(FISHING_ID);
      },
      perform: () => {
        game.fishing.onAreaFishSelection(area, fish);
        // Fishing has no plain start(): starting is per-area.
        game.fishing.onAreaStartButtonClick(area);
        return undefined;
      },
      // Fishing's own notion of "the thing I am doing" is `activeFish`, which is
      // stricter than set membership and the right post-condition here.
      changed: () => game.fishing.isActive && game.fishing.activeFish === fish,
    },
    isSuspended,
  );
}

/**
 * Stops a gathering skill.
 *
 * @param skillId - One of {@link GATHERING_SKILL_IDS}.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the skill left the active state.
 */
export function stopGathering(
  skillId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  if (isArtisanSkill(skillId)) return stopArtisan(skillId, isSuspended);
  if (isMiscSkill(skillId)) return stopMiscSkill(skillId, isSuspended);

  const skill = gatheringSkill(skillId);
  if (skill === null) {
    // Any skill that can hold the action slot can release it: `stop()` lives on
    // the active-skill base class. Without this fallback, Cartography took the
    // slot and nothing could take it back — the agent was stranded in it,
    // refusing every objective with "no verified routine", and the stopgap
    // looped on the same refusal.
    return stopAnyActiveSkill(skillId, isSuspended);
  }

  return act(
    {
      name: `${skill.name}.stop`,
      observe: skill.project,
      precondition: () => {
        if (!skill.instance.isActive) return `${skillId} is not active`;
        // Transient, not a refusal. Thieving cannot stop while the character is
        // stunned from a failed pickpocket, which lasts seconds — but it was
        // reported as a plain precondition, so the policy tier abandoned the
        // objective outright.
        //
        // That cost a whole Magic objective. The plan was food, then Magic,
        // then Thieving; Thieving happened to be running, refused to release
        // the action slot for the length of one stun, and the Magic step was
        // moved to the back of the plan and never came round again. The agent
        // looked like it had silently skipped a step, and the third combat
        // objective in a row appeared to fail for reasons of its own.
        if (!skill.instance.canStop) {
          return { wait: `${skillId} cannot stop yet — it is mid-action or stunned` };
        }
        return null;
      },
      perform: () => skill.instance.stop(),
      changed: (before, after) => before.active && !after.active,
    },
    isSuspended,
  );
}

interface GatheringSkillHandle {
  name: string;
  instance: { isActive: boolean; canStop: boolean; stop: () => boolean };
  project: () => GatheringProjection;
}

function gatheringSkill(skillId: string): GatheringSkillHandle | null {
  switch (skillId) {
    case WOODCUTTING_ID:
      return { name: 'woodcutting', instance: game.woodcutting, project: projectWoodcutting };
    case MINING_ID:
      return { name: 'mining', instance: game.mining, project: projectMining };
    case FISHING_ID:
      return { name: 'fishing', instance: game.fishing, project: projectFishing };
    default:
      return null;
  }
}

/**
 * Releases the action slot from a skill with no dedicated routine.
 *
 * The dedicated routines exist because most skills need a *selection* cleared
 * as well — a tree deselected, a recipe unset — and stopping without that
 * leaves a half-state. Skills like Cartography have no such selection, so the
 * game's own `stop()` is the whole operation.
 *
 * Verified by the skill reporting itself inactive, never by the return value.
 */
function stopAnyActiveSkill(
  skillId: string,
  isSuspended: () => boolean,
): ActionResult<GatheringProjection> {
  const skill = game.skills.getObjectByID(skillId) as
    | (AnySkill & { stop?: () => boolean; isActive?: boolean })
    | undefined;

  if (skill === undefined || typeof skill.stop !== 'function') {
    return fail('skill.stop', 'precondition', `no verified routine for skill ${skillId}`);
  }

  const project = (): GatheringProjection => ({
    skillId,
    active: skill.isActive === true,
    selected: [],
    activeActionId: game.activeAction?.id ?? null,
  });

  return act(
    {
      name: 'skill.stop',
      observe: project,
      precondition: () => (skill.isActive === true ? null : `${skillId} is not running`),
      perform: () => skill.stop?.(),
      // The slot being free is the point, so either signal counts: the skill
      // reporting itself stopped, or the game's action slot letting go.
      changed: (before, after) =>
        (before.active && !after.active) || after.activeActionId !== before.activeActionId,
    },
    isSuspended,
  );
}

/**
 * Selects further unlocked trees until the cut limit is reached.
 *
 * The primary tree is passed so it is never re-toggled: `selectTree` toggles,
 * so selecting an already-selected tree deselects it, which is the bug this
 * whole area of the file exists to avoid.
 *
 * Sorted by XP so a spare slot goes to the best available tree. Failures are
 * swallowed per tree: a filler that cannot be selected should not stop the tree
 * the objective actually asked for.
 */
function fillRemainingTreeSlots(primary: { id: string }): void {
  try {
    const skill = game.woodcutting;
    const others = skill.actions.allObjects
      .filter((candidate) => candidate.id !== primary.id)
      .filter((candidate) => skill.isTreeUnlocked(candidate))
      .filter((candidate) => !skill.activeTrees.has(candidate))
      .sort((a, b) => b.baseExperience - a.baseExperience);

    for (const other of others) {
      if (skill.activeTrees.size >= skill.treeCutLimit) return;
      try {
        skill.selectTree(other);
      } catch (error) {
        noteSwallowed('gathering.fillRemainingTreeSlots', error);
        // One unselectable tree must not stop the rest.
      }
    }
  } catch (error) {
    noteSwallowed('gathering.fillRemainingTreeSlots', error);
    // No filling is worse than the primary tree failing to start.
  }
}

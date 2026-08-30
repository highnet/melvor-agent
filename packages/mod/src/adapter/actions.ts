import type { ActionResult } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/** Ids of the trees currently being cut, sorted so the projection is stable. */
function activeTreeIds(): string[] {
  return [...game.woodcutting.activeTrees].map((tree) => tree.id).sort();
}

/** Whether the woodcutting skill itself reports as ticking. */
function woodcuttingActive(): boolean {
  return game.woodcutting.isActive;
}

/** Combined projection: what is selected *and* whether the skill is running. */
interface WoodcuttingProjection {
  trees: string[];
  active: boolean;
  activeActionId: string | null;
}

function projectWoodcutting(): WoodcuttingProjection {
  return {
    trees: activeTreeIds(),
    active: woodcuttingActive(),
    activeActionId: game.activeAction?.id ?? null,
  };
}

/**
 * Selects a tree for cutting.
 *
 * `Woodcutting.selectTree` returns `void` and behaves as a toggle — calling it
 * on an already-selected tree deselects it. So there is no return value to
 * check and a naive retry actively undoes the work. Both facts are why this
 * observes `activeTrees` rather than trusting the call.
 *
 * @param treeId - Namespaced `WoodcuttingTree` id, e.g. `melvorD:Normal_Tree`.
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the tree moved into `activeTrees`.
 */
export function selectTree(
  treeId: string,
  isSuspended: () => boolean,
): ActionResult<WoodcuttingProjection> {
  const tree = game.woodcutting.actions.getObjectByID(treeId);
  if (tree === undefined) {
    return fail('woodcutting.selectTree', 'precondition', `no tree registered with id ${treeId}`);
  }

  return act(
    {
      name: 'woodcutting.selectTree',
      observe: projectWoodcutting,
      precondition: () => {
        if (!game.woodcutting.isTreeUnlocked(tree)) {
          return `tree ${treeId} is locked (requires woodcutting level ${tree.level})`;
        }
        if (game.woodcutting.activeTrees.has(tree)) {
          return `tree ${treeId} is already selected; selectTree would toggle it off`;
        }
        if (game.woodcutting.activeTrees.size >= game.woodcutting.treeCutLimit) {
          return `already cutting ${game.woodcutting.activeTrees.size} trees (limit ${game.woodcutting.treeCutLimit})`;
        }
        return null;
      },
      perform: () => game.woodcutting.selectTree(tree),
      changed: (before, after) =>
        !before.trees.includes(treeId) && after.trees.includes(treeId),
    },
    isSuspended,
  );
}

/**
 * Starts the woodcutting skill with whatever trees are currently selected.
 *
 * `GatheringSkill.start()` returns a boolean, but a `true` return still does
 * not prove the game entered the action, so the transition of
 * `game.activeAction` is what is verified.
 *
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that woodcutting became the active action.
 */
export function startWoodcutting(
  isSuspended: () => boolean,
): ActionResult<WoodcuttingProjection> {
  return act(
    {
      name: 'woodcutting.start',
      observe: projectWoodcutting,
      precondition: () => {
        if (game.woodcutting.activeTrees.size === 0) {
          return 'no tree selected; start() would no-op';
        }
        if (game.woodcutting.isActive) return 'woodcutting is already active';
        if (game.activeAction !== undefined) {
          return `another action is running: ${game.activeAction.id}`;
        }
        return null;
      },
      perform: () => game.woodcutting.start(),
      changed: (before, after) => !before.active && after.active,
    },
    isSuspended,
  );
}

/**
 * Stops the woodcutting skill.
 *
 * @param isSuspended - Guard against acting during offline catch-up.
 * @returns Evidence that the skill left the active state.
 */
export function stopWoodcutting(
  isSuspended: () => boolean,
): ActionResult<WoodcuttingProjection> {
  return act(
    {
      name: 'woodcutting.stop',
      observe: projectWoodcutting,
      precondition: () => {
        if (!game.woodcutting.isActive) return 'woodcutting is not active';
        if (!game.woodcutting.canStop) return 'skill reports it cannot stop right now';
        return null;
      },
      perform: () => game.woodcutting.stop(),
      changed: (before, after) => before.active && !after.active,
    },
    isSuspended,
  );
}

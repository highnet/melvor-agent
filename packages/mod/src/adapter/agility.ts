import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/**
 * Building the Agility course.
 *
 * Agility is the only skill whose *content* the player constructs. An empty
 * course cannot be run at all, and a course built once at level 1 keeps paying
 * level-1 rates forever — so an agent that can run a course but not build one
 * is stuck at whatever it happened to inherit.
 *
 * Building costs GP and items and is not free to undo (destroying an obstacle
 * refunds nothing), which is exactly why it is a planner decision with real
 * numbers attached rather than something done automatically.
 */

/** What building claims to change: which obstacle occupies a slot. */
export interface ObstacleProjection {
  category: number;
  obstacleId: string | null;
}

function projectCategory(category: number): ObstacleProjection {
  // Courses are per realm; `activeCourse` is the one the character is standing
  // in, which is the only one building can affect.
  const built = game.agility.activeCourse.builtObstacles.get(category);
  return { category, obstacleId: built?.id ?? null };
}

/**
 * Builds an agility obstacle into its slot.
 *
 * `buildObstacle` returns `void` and refuses silently when the costs are not
 * met, so the slot's occupant is observed either side. The obstacle's own
 * category decides the slot — passing one would let a stale plan overwrite a
 * different part of the course than it meant to.
 *
 * @param obstacleId - Namespaced `AgilityObstacle` id.
 * @param isSuspended - Guard against acting during offline catch-up.
 */
export function buildAgilityObstacle(
  obstacleId: string,
  isSuspended: () => boolean,
): ActionResult<ObstacleProjection> {
  const agility = game.agility;
  const obstacle = agility.actions.getObjectByID(obstacleId);
  if (obstacle === undefined) {
    return fail('agility.build', 'precondition', `no agility obstacle ${obstacleId}`);
  }

  return act(
    {
      name: 'agility.build',
      observe: () => projectCategory(obstacle.category),
      precondition: () => {
        if (projectCategory(obstacle.category).obstacleId === obstacleId) {
          return `${obstacleId} is already built`;
        }
        if (!game.checkRequirements(obstacle.skillRequirements, false)) {
          return `skill requirements for ${obstacleId} are not met`;
        }
        // Building while the course is running would swap an obstacle out from
        // under the action that is currently paying for itself.
        if (agility.isActive) return 'the course is running; stop it before rebuilding';
        if (!agility.getObstacleBuildCosts(obstacle).checkIfOwned()) {
          return `cannot afford to build ${obstacleId}`;
        }
        return null;
      },
      perform: () => agility.buildObstacle(obstacle),
      changed: (_before, after) => after.obstacleId === obstacleId,
    },
    isSuspended,
  );
}

/**
 * Obstacles worth building right now.
 *
 * Only affordable, unlocked obstacles that would *replace something worse* —
 * an empty slot, or a lower-level obstacle in the same category. Offering every
 * buildable obstacle would invite the agent to rebuild the same slot back and
 * forth, paying the cost each time for no gain.
 */
export function readAgilityCandidates(): Candidate[] {
  const agility = game.agility;
  const candidates: Candidate[] = [];

  for (const obstacle of agility.actions.allObjects) {
    try {
      const current = agility.activeCourse.builtObstacles.get(obstacle.category);
      if (current?.id === obstacle.id) continue;

      // A lower-level obstacle in an occupied slot is a downgrade, and the game
      // charges for it just the same.
      if (current !== undefined && obstacle.level <= current.level) continue;

      if (!game.checkRequirements(obstacle.skillRequirements, false)) continue;
      if (!agility.getObstacleBuildCosts(obstacle).checkIfOwned()) continue;

      candidates.push({
        kind: 'build_obstacle',
        params: { kind: 'build_obstacle', obstacleId: obstacle.id },
        label:
          current === undefined
            ? `Build ${obstacle.name} in an empty course slot (level ${obstacle.level})`
            : `Build ${obstacle.name} (level ${obstacle.level}) over ${current.name} (level ${current.level})`,
        available: true,
      });
    } catch {
      // An obstacle whose costs cannot be read is not a candidate.
    }
  }

  return candidates;
}

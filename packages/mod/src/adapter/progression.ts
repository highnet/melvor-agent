import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/**
 * The two systems that turn accumulated materials into permanent bonuses.
 *
 * Astrology constellations and skill trees share a shape: something piles up
 * while the character plays — stardust, skill points — and does nothing at all
 * until somebody spends it. Both are pure upside and both are invisible to an
 * agent that only starts and stops skills, which is how a character ends up
 * with a bank full of stardust and no modifiers bought.
 */

// --- astrology -------------------------------------------------------------

/** Which modifier list an upgrade targets. */
type ModifierKind = 'standard' | 'unique';

/** What upgrading claims to change. */
export interface AstrologyProjection {
  constellationId: string;
  kind: ModifierKind;
  index: number;
  timesBought: number;
}

/**
 * Buys one level of a constellation modifier with stardust.
 *
 * The upgrade methods return `void` and refuse silently when the stardust is
 * short, so `timesBought` is observed either side.
 *
 * @param constellationId - Namespaced `AstrologyRecipe` id.
 * @param kind - `standard` (stardust) or `unique` (golden stardust).
 * @param index - Which modifier in that list.
 */
export function upgradeConstellation(
  constellationId: string,
  kind: ModifierKind,
  index: number,
  isSuspended: () => boolean,
): ActionResult<AstrologyProjection> {
  const astrology = game.astrology;
  const constellation = astrology.actions.getObjectByID(constellationId);
  if (constellation === undefined) {
    return fail('astrology.upgrade', 'precondition', `no constellation ${constellationId}`);
  }

  const modifiers =
    kind === 'standard' ? constellation.standardModifiers : constellation.uniqueModifiers;
  const modifier = modifiers[index];
  if (modifier === undefined) {
    return fail(
      'astrology.upgrade',
      'precondition',
      `${constellationId} has ${modifiers.length} ${kind} modifiers; ${index} is out of range`,
    );
  }

  const project = (): AstrologyProjection => ({
    constellationId,
    kind,
    index,
    timesBought: modifier.timesBought,
  });

  return act(
    {
      name: 'astrology.upgrade',
      observe: project,
      precondition: () => {
        if (modifier.isMaxed) return `${constellationId} ${kind} ${index} is already maxed`;
        const cost = modifier.upgradeCost;
        if (game.bank.getQty(cost.item) < cost.quantity) {
          return `needs ${cost.quantity}x ${cost.item.name}, bank has ${game.bank.getQty(cost.item)}`;
        }
        return null;
      },
      perform: () =>
        kind === 'standard'
          ? astrology.upgradeStandardModifier(constellation, index)
          : astrology.upgradeUniqueModifier(constellation, index),
      changed: (before, after) => after.timesBought > before.timesBought,
    },
    isSuspended,
  );
}

/**
 * Constellation upgrades that are affordable now.
 *
 * Stardust is only ever earned by studying constellations and has no other use,
 * so unspent stardust is progress the character has already paid for and not
 * collected. Standard modifiers come first because their cost curve is far
 * shallower than the unique ones.
 */
export function readAstrologyCandidates(): Candidate[] {
  const astrology = game.astrology;
  const candidates: Candidate[] = [];

  for (const constellation of astrology.actions.allObjects) {
    for (const kind of ['standard', 'unique'] as const) {
      const modifiers =
        kind === 'standard' ? constellation.standardModifiers : constellation.uniqueModifiers;

      modifiers.forEach((modifier, index) => {
        try {
          if (modifier.isMaxed) return;
          if (!astrology.isModifierUnlocked(constellation, kind === 'standard' ? 0 : 1, index)) {
            return;
          }

          const cost = modifier.upgradeCost;
          if (game.bank.getQty(cost.item) < cost.quantity) return;

          candidates.push({
            kind: 'upgrade_constellation',
            params: {
              kind: 'upgrade_constellation',
              constellationId: constellation.id,
              modifierKind: kind,
              index,
            },
            label: `Upgrade ${constellation.name} ${kind} modifier ${index + 1} (${modifier.timesBought}/${modifier.maxCount}) for ${cost.quantity}x ${cost.item.name}`,
            available: true,
          });
        } catch {
          // A modifier that cannot price itself is not a candidate.
        }
      });
    }
  }

  return candidates;
}

// --- skill trees -----------------------------------------------------------

/**
 * Unlocks a skill tree node.
 *
 * Skill points accumulate from levels and are spent here or nowhere. Unlocking
 * is permanent, and that is fine: every node is a gain, so the only mistake
 * available is spending points on a cheaper node than the one worth saving for
 * — a trade-off the planner can weigh from the labels.
 *
 * @param skillId - The skill owning the tree.
 * @param nodeId - Namespaced `SkillTreeNode` id.
 */
export function unlockSkillTreeNode(
  skillId: string,
  treeId: string,
  nodeId: string,
  isSuspended: () => boolean,
): ActionResult<{ nodeId: string; unlocked: boolean; pointsLeft: number }> {
  const skill = game.skills.getObjectByID(skillId);
  if (skill === undefined) {
    return fail('skillTree.unlock', 'precondition', `no skill ${skillId}`);
  }

  const tree = skill.skillTrees.getObjectByID(treeId);
  if (tree === undefined) {
    return fail('skillTree.unlock', 'precondition', `${skillId} has no skill tree ${treeId}`);
  }

  const node = tree.nodes.getObjectByID(nodeId);
  if (node === undefined) {
    return fail('skillTree.unlock', 'precondition', `no node ${nodeId} in ${treeId}`);
  }

  const project = (): { nodeId: string; unlocked: boolean; pointsLeft: number } => ({
    nodeId,
    unlocked: tree.unlockedNodes.includes(node),
    pointsLeft: tree.points,
  });

  return act(
    {
      name: 'skillTree.unlock',
      observe: project,
      precondition: () => {
        if (project().unlocked) return `${nodeId} is already unlocked`;
        if (!tree.canAffordNode(node)) return `cannot afford ${nodeId}`;
        return null;
      },
      perform: () => tree.unlockNode(node),
      changed: (_before, after) => after.unlocked,
    },
    isSuspended,
  );
}

/** Skill tree nodes that can be afforded and unlocked now. */
export function readSkillTreeCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const skill of game.skills.allObjects) {
    for (const tree of skill.skillTrees.allObjects) {
      try {
        if (tree.points <= 0) continue;

        for (const node of tree.nodes.allObjects) {
          if (tree.unlockedNodes.includes(node)) continue;
          if (!tree.canAffordNode(node)) continue;

          candidates.push({
            kind: 'unlock_skill_node',
            params: {
              kind: 'unlock_skill_node',
              skillId: skill.id,
              treeId: tree.id,
              nodeId: node.id,
            },
            label: `Unlock ${node.name} in the ${skill.name} skill tree (${tree.points} points available)`,
            available: true,
          });
        }
      } catch {
        // A tree that cannot answer for itself is not a candidate.
      }
    }
  }

  return candidates;
}

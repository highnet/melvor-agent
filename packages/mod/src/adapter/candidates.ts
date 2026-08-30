import type { Candidate } from '@melvor-agent/shared';

const MS_PER_HOUR = 3_600_000;

/**
 * Enumerates the gathering objectives the mod can execute right now.
 *
 * Every number comes from the game's own registries and modifier-aware getters
 * — `getTreeInterval` already accounts for gear, mastery and modifiers — so the
 * planner chooses among measured options rather than guessing. Locked trees are
 * not emitted at all, which is what makes `available` a literal `true`: an
 * unavailable candidate is simply absent.
 *
 * Phase 1 covers Woodcutting only. Extending to another gathering skill means
 * verifying that skill's own selection API first; the selection methods are not
 * uniform across skills, so there is deliberately no generic abstraction here.
 *
 * @returns Candidates with XP/hr and GP/hr attached.
 */
export function readGatherCandidates(): Candidate[] {
  const skill = game.woodcutting;

  return skill.actions.allObjects
    .filter((tree) => skill.isTreeUnlocked(tree))
    .map((tree) => {
      const intervalMs = skill.getTreeInterval(tree);
      const actionsPerHour = intervalMs > 0 ? MS_PER_HOUR / intervalMs : 0;
      // `sellsFor` is a CurrencyQuantity, and not every item sells for GP.
      // Reporting a non-GP value as gpPerHour would quietly mislead the planner.
      const sale = tree.product.sellsFor;
      const sellValue = sale.currency === game.gp ? sale.quantity : 0;

      return {
        kind: 'gather_resource' as const,
        params: {
          kind: 'gather_resource' as const,
          skillId: skill.id,
          recipeId: tree.id,
        },
        label: `${skill.name}: ${tree.name}`,
        xpPerHour: actionsPerHour * tree.baseExperience,
        gpPerHour: actionsPerHour * sellValue,
        requiresLevel: tree.level,
        available: true as const,
      };
    })
    .sort((a, b) => (b.xpPerHour ?? 0) - (a.xpPerHour ?? 0));
}

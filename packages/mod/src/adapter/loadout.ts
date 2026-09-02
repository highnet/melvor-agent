import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { noteSwallowed } from './safe.js';

/**
 * The rest of the combat loadout, and the bank's safety catch.
 *
 * Curses and auroras are the half of Magic that has nothing to do with which
 * spell you attack with: a curse weakens the enemy, an aurora strengthens you,
 * and both cost runes every fight. A human toggles them deliberately, which is
 * why they are decisions here rather than reflexes — leaving an aurora on
 * during a long fight quietly burns runes the agent may need later.
 *
 * Bank locking is here for a blunter reason: this agent can sell. A locked item
 * cannot be sold by accident, and the things worth locking — a first pickaxe, a
 * quest item, a rare drop — are exactly the ones whose loss is unrecoverable.
 */

// --- curses and auroras ----------------------------------------------------

/** What toggling a curse or aurora claims to change. */
interface SpellSlots {
  curse: string | null;
  aurora: string | null;
}

function projectSlots(): SpellSlots {
  const selection = game.combat.player.spellSelection;
  return {
    curse: selection.curse?.id ?? null,
    aurora: selection.aurora?.id ?? null,
  };
}

/**
 * Turns a curse on or off.
 *
 * `toggleCurse` returns `void` and refuses silently when the level or the runes
 * are missing, so the selection is observed either side. `canUseCombatSpell` is
 * the game's own requirement check, and reusing it is the only way to be right
 * about a rule set that spans levels, runes and equipped items.
 */
export function toggleCurse(curseId: string, isSuspended: () => boolean): ActionResult<SpellSlots> {
  const curse = game.curseSpells.getObjectByID(curseId);
  if (curse === undefined) {
    return fail('combat.toggleCurse', 'precondition', `no curse spell ${curseId}`);
  }

  const player = game.combat.player;

  return act(
    {
      name: 'combat.toggleCurse',
      observe: projectSlots,
      precondition: () => {
        if (game.combat.isActive) return 'in combat; refusing to change curse';
        if (projectSlots().curse !== curseId && !player.canUseCombatSpell(curse)) {
          return `${curseId} cannot be cast — level, runes or equipment requirements are unmet`;
        }
        return null;
      },
      perform: () => player.toggleCurse(curse, false),
      changed: (before, after) => before.curse !== after.curse,
    },
    isSuspended,
  );
}

/** Turns an aurora on or off. Same shape and same reasoning as {@link toggleCurse}. */
export function toggleAurora(
  auroraId: string,
  isSuspended: () => boolean,
): ActionResult<SpellSlots> {
  const aurora = game.auroraSpells.getObjectByID(auroraId);
  if (aurora === undefined) {
    return fail('combat.toggleAurora', 'precondition', `no aurora spell ${auroraId}`);
  }

  const player = game.combat.player;

  return act(
    {
      name: 'combat.toggleAurora',
      observe: projectSlots,
      precondition: () => {
        if (game.combat.isActive) return 'in combat; refusing to change aurora';
        if (projectSlots().aurora !== auroraId && !player.canUseCombatSpell(aurora)) {
          return `${auroraId} cannot be cast — level, runes or equipment requirements are unmet`;
        }
        return null;
      },
      perform: () => player.toggleAurora(aurora, false),
      changed: (before, after) => before.aurora !== after.aurora,
    },
    isSuspended,
  );
}

// --- bank locking ----------------------------------------------------------

/**
 * Locks or unlocks a bank item.
 *
 * The one guard rail the agent can give itself. Selling is the only capability
 * that destroys something, and the loss is silent — a sold rare drop looks
 * exactly like a successful transition in the journal. Locking is cheap,
 * reversible and, unlike a refusal baked into the sell path, it is a decision
 * the planner can make about specific items it has reason to keep.
 */
export function toggleBankLock(
  itemId: string,
  isSuspended: () => boolean,
): ActionResult<{ itemId: string; locked: boolean }> {
  const item = game.items.getObjectByID(itemId);
  if (item === undefined) {
    return fail('bank.toggleLock', 'precondition', `no item ${itemId}`);
  }

  const bankItem = game.bank.items.get(item);
  if (bankItem === undefined) {
    return fail('bank.toggleLock', 'precondition', `bank holds no ${itemId}`);
  }

  const project = (): { itemId: string; locked: boolean } => ({
    itemId,
    locked: game.bank.lockedItems.has(item),
  });

  return act(
    {
      name: 'bank.toggleLock',
      observe: project,
      perform: () => game.bank.toggleItemLock(bankItem),
      changed: (before, after) => before.locked !== after.locked,
    },
    isSuspended,
  );
}

// --- candidates ------------------------------------------------------------

/**
 * Loadout decisions that are currently possible.
 *
 * Curses and auroras are offered only when castable *now* — `canUseCombatSpell`
 * accounts for runes, so an offer here means the runes exist. Offering one the
 * character cannot cast would produce a selection that silently does nothing,
 * which is the worst failure mode in combat: invisible until the fight is lost.
 */
export function readLoadoutCandidates(): Candidate[] {
  const player = game.combat.player;
  const slots = projectSlots();
  const candidates: Candidate[] = [];

  for (const curse of game.curseSpells.allObjects) {
    if (curse.id === slots.curse) continue;
    try {
      if (!player.canUseCombatSpell(curse)) continue;
    } catch (error) {
      noteSwallowed('loadout.readLoadoutCandidates', error);
      continue;
    }
    candidates.push({
      kind: 'toggle_curse',
      params: { kind: 'toggle_curse', curseId: curse.id },
      label: `Curse ${curse.name} (Magic ${curse.level}, runes in bank)`,
      available: true,
    });
  }

  for (const aurora of game.auroraSpells.allObjects) {
    if (aurora.id === slots.aurora) continue;
    try {
      if (!player.canUseCombatSpell(aurora)) continue;
    } catch (error) {
      noteSwallowed('loadout.readLoadoutCandidates', error);
      continue;
    }
    candidates.push({
      kind: 'toggle_aurora',
      params: { kind: 'toggle_aurora', auroraId: aurora.id },
      label: `Aurora ${aurora.name} (Magic ${aurora.level}, runes in bank)`,
      available: true,
    });
  }

  return candidates;
}

/**
 * Chooses a pending level cap increase.
 *
 * This is a *permanent* choice: the raised cap cannot be moved to another skill
 * afterwards. It is still the agent's to make — an unchosen increase leaves the
 * character sitting at its cap indefinitely, and refusing on the grounds of
 * irreversibility would make the agent unable to play the part of the game that
 * exists after 99.
 *
 * The choice is expressed as a skill id rather than an index, so a stale plan
 * cannot silently raise the cap of whichever skill happens to be listed third.
 *
 * @param capIncreaseId - The pending `SkillLevelCapIncrease`.
 * @param skillId - Which offered skill to raise.
 */
export function selectLevelCapIncrease(
  capIncreaseId: string,
  skillId: string,
  isSuspended: () => boolean,
): ActionResult<{ skillId: string; levelCap: number; pending: number }> {
  const capIncrease = game.levelCapIncreasesBeingSelected.find(
    (pending) => pending.id === capIncreaseId,
  );
  if (capIncrease === undefined) {
    return fail(
      'game.selectLevelCap',
      'precondition',
      `no level cap increase ${capIncreaseId} is waiting to be selected`,
    );
  }

  const increase = [...capIncrease.randomSelection].find((option) => option.skill.id === skillId);
  if (increase === undefined) {
    const offered = [...capIncrease.randomSelection].map((option) => option.skill.id).join(', ');
    return fail(
      'game.selectLevelCap',
      'precondition',
      `${skillId} is not among the offered skills (${offered})`,
    );
  }

  const project = (): { skillId: string; levelCap: number; pending: number } => ({
    skillId,
    levelCap: increase.skill.currentLevelCap,
    pending: game.levelCapIncreasesBeingSelected.length,
  });

  return act(
    {
      name: 'game.selectLevelCap',
      observe: project,
      perform: () => game.selectRandomLevelCapIncrease(capIncrease, increase),
      // The cap must actually rise. A shrinking pending list alone would also
      // be true if the selection were dismissed without applying anything.
      changed: (before, after) => after.levelCap > before.levelCap,
    },
    isSuspended,
  );
}

/** Pending level cap increases, one candidate per skill on offer. */
export function readLevelCapCandidates(): Candidate[] {
  const candidates: Candidate[] = [];

  for (const capIncrease of game.levelCapIncreasesBeingSelected) {
    for (const option of capIncrease.randomSelection) {
      candidates.push({
        kind: 'select_level_cap',
        params: {
          kind: 'select_level_cap',
          capIncreaseId: capIncrease.id,
          skillId: option.skill.id,
        },
        label: `Raise the ${option.skill.name} level cap by ${option.increase} (to at most ${option.maximum}) — permanent, and the other options are lost`,
        available: true,
      });
    }
  }

  return candidates;
}

import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';

/**
 * Golbin Raid.
 *
 * The one part of the game that is not a skill, not combat as the rest of the
 * game means it, and not idle in any sense: a run is a sequence of *choices* —
 * which modifiers, which weapon, which food — with a fight between each. It is
 * the purest test of whether this agent plays like a human or merely leaves
 * things running, because there is no version of raiding that survives being
 * ignored for an hour.
 *
 * The whole flow is driven by callbacks the game exposes for its own modals:
 * `selectRandomModifier`, `setEquipmentSelection`, `equipItemCallback`,
 * `continueRaid`. Nothing here reaches into the DOM or invents a method — the
 * modals are one caller of those callbacks and this adapter is another.
 *
 * Raids use their own bank, equipment and food, so nothing done inside one can
 * touch the character. That is what makes it safe to let the agent commit to a
 * run without a survivability gate: the worst outcome is a wasted half hour.
 */

/** Mirrors the game's `RaidState` enum, which is not exported to mods. */
const RAID_STATE = {
  unstarted: 0,
  selectingModifiersStart: 1,
  fightingWave: 2,
  selectingCategory: 3,
  selectingItem: 4,
  selectingModifiersWave: 5,
} as const;

/** Mirrors `RaidDifficulty`. */
const DIFFICULTY: Record<string, number> = { easy: 0, medium: 1, hard: 2 };

/** What a raid action claims to change. */
export interface RaidProjection {
  running: boolean;
  state: number;
  wave: number;
  kills: number;
}

function project(): RaidProjection {
  const raid = game.golbinRaid;
  return {
    running: raid.raidRunning,
    state: raid.state as unknown as number,
    wave: raid.wave,
    kills: raid.killCount,
  };
}

/**
 * Starts a raid at a difficulty.
 *
 * `startRaid` returns `void` and refuses silently when the requirements are
 * unmet, so the evidence is the raid actually running afterwards.
 *
 * @param difficulty - `easy`, `medium` or `hard`.
 */
export function startGolbinRaid(
  difficulty: string,
  isSuspended: () => boolean,
): ActionResult<RaidProjection> {
  const level = DIFFICULTY[difficulty.toLowerCase()];
  if (level === undefined) {
    return fail('raid.start', 'precondition', `${difficulty} is not easy, medium or hard`);
  }

  const raid = game.golbinRaid;

  return act(
    {
      name: 'raid.start',
      observe: project,
      precondition: () => {
        if (raid.raidRunning) return 'a raid is already running';
        if (game.combat.isActive) return 'in combat; leave it before raiding';
        const active = game.activeAction;
        if (active !== undefined) return `another action is running: ${active.id}`;
        return null;
      },
      perform: () => {
        raid.changeDifficulty(level as never);
        raid.startRaid();
      },
      changed: (_before, after) => after.running,
    },
    isSuspended,
  );
}

/**
 * Takes the next decision a running raid is waiting on.
 *
 * A raid is a state machine that *stops* until someone chooses, so this is
 * called repeatedly rather than once: modifiers at the start, a category and an
 * item between waves, and nothing at all while a wave is being fought.
 *
 * The choices are deliberately simple — the first offered modifier, the first
 * offered item. A cleverer chooser would need to model raid scaling, and being
 * wrong there is indistinguishable from being unlucky. Choosing *something*
 * promptly is worth far more than choosing well slowly, because a raid waiting
 * on a modal earns nothing at all.
 *
 * @returns Evidence the state advanced, or a precondition when nothing is due.
 */
export function advanceGolbinRaid(isSuspended: () => boolean): ActionResult<RaidProjection> {
  const raid = game.golbinRaid;

  return act(
    {
      name: 'raid.advance',
      observe: project,
      precondition: () => {
        if (!raid.raidRunning) return 'no raid is running';
        const state = raid.state as unknown as number;
        if (state === RAID_STATE.fightingWave) return 'a wave is being fought; nothing to choose';
        return null;
      },
      perform: () => {
        const state = raid.state as unknown as number;

        if (
          state === RAID_STATE.selectingModifiersStart ||
          state === RAID_STATE.selectingModifiersWave
        ) {
          raid.selectRandomModifier(0);
          raid.continueModifierSelection();
          return;
        }

        if (state === RAID_STATE.selectingCategory) {
          // Weapons first: a raid is lost to not killing things fast enough far
          // more often than to any other cause.
          const categories = ['weapons', 'armour', 'food', 'runes', 'ammo', 'passives'] as const;
          const affordable = categories.find((category) => raid.getCategoryQuantity(category) > 0);
          raid.setEquipmentSelection(affordable ?? 'weapons');
          return;
        }

        if (state === RAID_STATE.selectingItem) {
          const category = raid.itemCategoryBeingSelected;
          const choices = raid.itemsBeingSelected[category];
          const first = choices[0];

          if (first === undefined) {
            // Declining is a legitimate move and keeps the raid moving; an
            // unanswered modal stalls it forever.
            raid.selectNothingCallback();
            return;
          }

          raid.equipItemCallback(first.item as never, first.quantity, first.isAlt);
          return;
        }

        raid.continueRaid();
      },
      // Any state change counts: the machine moving is the whole point, and
      // which state it moved to is the game's decision, not ours.
      changed: (before, after) => before.state !== after.state || after.wave > before.wave,
    },
    isSuspended,
  );
}

/**
 * Ends a raid.
 *
 * Fleeing keeps the coins earned so far, which makes it the right move once a
 * run stops progressing — a raid that cannot clear its current wave will not
 * clear the next one, and the coins are the only thing carried out.
 */
export function stopGolbinRaid(isSuspended: () => boolean): ActionResult<RaidProjection> {
  const raid = game.golbinRaid;

  return act(
    {
      name: 'raid.stop',
      observe: project,
      precondition: () => (raid.raidRunning ? null : 'no raid is running'),
      perform: () => raid.stop(true),
      changed: (before, after) => before.running && !after.running,
    },
    isSuspended,
  );
}

/**
 * Raiding as an option.
 *
 * Only offered when nothing else is running, because a raid takes the whole
 * character: it pauses the ordinary game loop, so starting one mid-objective
 * would silently stop whatever was earning.
 *
 * Easy only. Difficulty multiplies enemy stats without changing what the agent
 * can bring, and a failed raid pays nothing for the time spent.
 */
export function readRaidCandidates(): Candidate[] {
  const raid = game.golbinRaid;

  if (raid.raidRunning) {
    return [
      {
        kind: 'run_golbin_raid',
        params: { kind: 'run_golbin_raid', difficulty: 'easy' },
        label: `Continue the Golbin Raid (wave ${raid.wave}, ${raid.killCount} kills)`,
        available: true,
      },
    ];
  }

  if (game.combat.isActive || game.activeAction !== undefined) return [];

  return [
    {
      kind: 'run_golbin_raid',
      params: { kind: 'run_golbin_raid', difficulty: 'easy' },
      label: 'Start a Golbin Raid on Easy — its own bank and gear, so nothing here is risked',
      available: true,
    },
  ];
}

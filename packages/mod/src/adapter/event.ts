import type { ActionResult, Candidate } from '@melvor-agent/shared';
import { fail } from '@melvor-agent/shared';
import { act } from './act.js';
import { isRefusedRealm } from './guards.js';

/**
 * Combat events — the end-game gauntlet.
 *
 * An event is the hardest content in the base game: a run of slayer areas, a
 * boss at each stage, a passive to choose between stages, and a final boss.
 * Everything the agent has built up to — gear, food, auto-eat, prayers — exists
 * to make this survivable, so an agent that cannot enter one has a ceiling well
 * below "plays the complete game".
 *
 * The event is also the clearest case of a *decision that cannot be idled*:
 * each stage stops and waits for a passive to be chosen, and a run left waiting
 * makes no progress at all.
 */

/** What starting or advancing an event claims to change. */
export interface EventProjection {
  active: boolean;
  progress: number;
  passivesToChoose: number;
}

function project(): EventProjection {
  const manager = game.combat;
  return {
    active: manager.isEventActive,
    progress: manager.eventProgress,
    passivesToChoose: manager.eventPassivesBeingSelected.size,
  };
}

/**
 * Starts a combat event.
 *
 * No survivability gate runs here, and that is deliberate rather than an
 * oversight: the gate measures one monster or one dungeon, and an event is a
 * sequence of areas whose composition changes as it progresses. Measuring the
 * first stage would produce a confident number about the wrong fight.
 *
 * What protects the character instead is the same thing that protects a human:
 * the event can be stopped, and the policy tier's HP and food floors still end
 * it. Entering is the agent's call, with the difficulty stated in the label.
 *
 * @param eventId - Namespaced `CombatEvent` id.
 */
export function startCombatEvent(
  eventId: string,
  isSuspended: () => boolean,
): ActionResult<EventProjection> {
  const event = game.combatEvents.getObjectByID(eventId);
  if (event === undefined) {
    return fail('combat.startEvent', 'precondition', `no combat event ${eventId}`);
  }

  return act(
    {
      name: 'combat.startEvent',
      observe: project,
      precondition: () => {
        if (game.combat.isEventActive) return 'an event is already running';
        if (game.combat.isActive) return 'in combat; leave it before starting an event';
        const active = game.activeAction;
        if (active !== undefined) return `another action is running: ${active.id}`;
        // Food is not optional here. An event without it is a long walk to a
        // death, and the character keeps the losses.
        if (game.combat.player.food.currentSlot.quantity <= 0) {
          return 'no food equipped; an event without food is a death with extra steps';
        }
        return null;
      },
      perform: () => game.combat.startEvent(event),
      changed: (_before, after) => after.active,
    },
    isSuspended,
  );
}

/**
 * Chooses one of the passives an event is waiting on.
 *
 * Between stages the event stops and offers a choice. Until it is made the run
 * is frozen — no fighting, no progress, no XP — so answering promptly matters
 * more than answering cleverly.
 *
 * @param passiveId - One of the offered `CombatPassive` ids, or empty to take
 *                    whichever is offered first.
 */
export function chooseEventPassive(
  passiveId: string | undefined,
  isSuspended: () => boolean,
): ActionResult<EventProjection> {
  const manager = game.combat;
  const offered = [...manager.eventPassivesBeingSelected];

  const passive =
    passiveId === undefined || passiveId === ''
      ? offered[0]
      : offered.find((candidate) => candidate.id === passiveId);

  return act(
    {
      name: 'combat.chooseEventPassive',
      observe: project,
      precondition: () => {
        if (!manager.isEventActive) return 'no event is running';
        if (offered.length === 0) return 'the event is not waiting on a passive';
        if (passive === undefined) {
          return `${passiveId} is not among the offered passives (${offered.map((p) => p.id).join(', ')})`;
        }
        return null;
      },
      perform: () => {
        if (passive !== undefined) manager.onPassiveSelection(passive);
      },
      changed: (before, after) => after.passivesToChoose < before.passivesToChoose,
    },
    isSuspended,
  );
}

/**
 * Leaves a running event.
 *
 * Stopping forfeits the stage's progress, which is why it is a decision rather
 * than a reflex — but staying in an event the character cannot clear forfeits
 * the time instead, and time is the thing this project measures.
 */
export function stopCombatEvent(isSuspended: () => boolean): ActionResult<EventProjection> {
  return act(
    {
      name: 'combat.stopEvent',
      observe: project,
      precondition: () => (game.combat.isEventActive ? null : 'no event is running'),
      perform: () => game.combat.stopEvent(),
      changed: (before, after) => before.active && !after.active,
    },
    isSuspended,
  );
}

/**
 * Events the character could enter, or is being asked to answer.
 *
 * A waiting passive choice comes first and is described as blocking, because it
 * is: an event mid-stage earns nothing until the choice is made.
 */
export function readEventCandidates(): Candidate[] {
  const manager = game.combat;
  const candidates: Candidate[] = [];

  if (manager.isEventActive) {
    if (manager.eventPassivesBeingSelected.size > 0) {
      candidates.push({
        kind: 'choose_event_passive',
        params: { kind: 'choose_event_passive' },
        label: `Choose an event passive — the event is frozen at stage ${manager.eventProgress} until this is answered`,
        available: true,
      });
    }
    return candidates;
  }

  if (game.combat.isActive || game.activeAction !== undefined) return [];
  if (game.combat.player.food.currentSlot.quantity <= 0) return [];

  for (const event of game.combatEvents.allObjects) {
    try {
      // A CombatEvent has no realm of its own; its areas do, and clearing them
      // is what the event consists of.
      if (event.slayerAreas.some((area) => isRefusedRealm(area.realm.id))) continue;

      candidates.push({
        kind: 'start_combat_event',
        params: { kind: 'start_combat_event', eventId: event.id },
        // CombatEvent carries no display name, so it is described by what it
        // actually is: its stages and the boss at the end of them.
        label: `Start the combat event ending in ${event.finalBossMonster.name} — ${event.slayerAreas.length} stages, the hardest fight in the game`,
        available: true,
      });
    } catch {
      // An event that cannot describe itself is not a candidate.
    }
  }

  return candidates;
}

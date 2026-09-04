import { afterEach, describe, expect, it } from 'vitest';
import { readSynergyCandidates } from '../src/adapter/equipment.js';
import { installFakeGame } from './fixtures.js';

/**
 * A synergy the agent could propose and never assemble.
 *
 * `readSynergyCandidates` offers one half of a familiar pair at a time, which
 * is right — a pair is two equips and the planner should see the first as a
 * real step. What was wrong is that the slot was hardcoded to `Summon1`, so the
 * second half was offered into the slot the first half had just been put in.
 * Both calls returned ok, both equipped the correct tablet, and the two were
 * never worn at the same time — the only state in which a synergy applies
 * anything at all.
 *
 * The failure is invisible from either call. Nothing errors, nothing is
 * refused, and the journal shows two successful equips; only the *pair* is
 * missing, and nothing was ever looking for it. That is the same shape as the
 * Steel Scimitar / Staff of Air swap loop — two locally correct operations
 * composing into a cycle.
 *
 * All 53 familiars in the shipped data list both `melvorD:Summon1` and
 * `melvorD:Summon2` in `validSlots` (item.d.ts:245), so the second slot was
 * available the whole time.
 */

const uninstalls: (() => void)[] = [];

afterEach(() => {
  for (const uninstall of uninstalls.splice(0)) uninstall();
});

const WOLF = { id: 'melvorF:Summoning_Familiar_Wolf', name: 'Wolf' };
const MINOTAUR = { id: 'melvorF:Summoning_Familiar_Minotaur', name: 'Minotaur' };

/**
 * Installs one unlocked synergy, both tablets banked, and a given slot state.
 *
 * `equippedItems` is keyed by slot id the way the adapter's `projectSlot`
 * reads it, and an empty slot is modelled the way the game models it — the
 * slot's own `emptyItem` sitting in `item` — rather than as a missing key, so
 * "empty" and "absent" stay distinguishable exactly as they are in the game.
 */
function installGame(slots: { Summon1?: typeof WOLF; Summon2?: typeof WOLF }): void {
  const empty = { id: 'melvorD:Empty_Equipment' };
  const slotEntry = (item: typeof WOLF | undefined) => ({
    item: item ?? empty,
    emptyItem: empty,
    quantity: item === undefined ? 0 : 500,
  });

  uninstalls.push(
    installFakeGame({
      summoning: {
        synergies: [
          {
            name: 'Wolf + Minotaur',
            description: '+5% melee accuracy',
            summons: [{ product: WOLF }, { product: MINOTAUR }],
          },
        ],
        isSynergyUnlocked: () => true,
      },
      bank: { getQty: () => 500 },
      combat: {
        player: {
          equipment: {
            equippedItems: {
              'melvorD:Summon1': slotEntry(slots.Summon1),
              'melvorD:Summon2': slotEntry(slots.Summon2),
            },
          },
        },
      },
    }),
  );
}

describe('assembling a familiar synergy', () => {
  it('offers the first half into the first slot', () => {
    installGame({});

    const [candidate] = readSynergyCandidates();

    expect(candidate?.params).toMatchObject({
      itemId: WOLF.id,
      slotId: 'melvorD:Summon1',
    });
  });

  it('offers the second half into the *other* slot', () => {
    // The bug, stated as a test. With Wolf already in Summon1, the Minotaur
    // candidate used to name Summon1 too, so accepting it removed the Wolf and
    // the pair could never both be worn.
    installGame({ Summon1: WOLF });

    const [candidate] = readSynergyCandidates();

    expect(candidate?.params).toMatchObject({
      itemId: MINOTAUR.id,
      slotId: 'melvorD:Summon2',
    });
  });

  it('offers the second half into the first slot when the partner holds the second', () => {
    // Slot order is not part of a synergy — the game applies it to the pair —
    // so the reader must be able to fill either side rather than assuming the
    // first half always landed in Summon1.
    installGame({ Summon2: WOLF });

    const [candidate] = readSynergyCandidates();

    expect(candidate?.params).toMatchObject({
      itemId: MINOTAUR.id,
      slotId: 'melvorD:Summon1',
    });
  });

  it('says which slot in the label, so the pair being built is visible', () => {
    installGame({ Summon1: WOLF });

    expect(readSynergyCandidates()[0]?.label).toContain('the second summon slot');
  });

  it('offers nothing once both halves are worn', () => {
    // A candidate that changes nothing is an objective spent achieving nothing.
    installGame({ Summon1: WOLF, Summon2: MINOTAUR });

    expect(readSynergyCandidates()).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STARTABLE_SKILL_IDS, startGathering, stopGathering } from '../src/adapter/gathering.js';

/**
 * Exercises the observe → verify → act contract against stand-ins for the game.
 *
 * The fakes reproduce the specific behaviours that make `ActionResult`
 * necessary, and that a mock returning `true` would hide:
 *
 * - Woodcutting's `selectTree` returns `void` **and toggles**.
 * - Mining's `onRockClick` is a UI callback whose side effects are undocumented
 *   — it may or may not also start the skill. Both variants are tested.
 * - Fishing has no plain `start()`; starting is per-area.
 */

const WOODCUTTING = 'melvorD:Woodcutting';
const MINING = 'melvorD:Mining';
const FISHING = 'melvorD:Fishing';

const never = (): boolean => false;
const always = (): boolean => true;

interface Recipe {
  id: string;
  level: number;
}

const TREE: Recipe = { id: 'melvorD:Normal_Tree', level: 1 };
const OAK: Recipe = { id: 'melvorD:Oak_Tree', level: 10 };
const LOCKED_TREE: Recipe = { id: 'melvorD:Magic_Tree', level: 75 };
const ROCK: Recipe = { id: 'melvorD:Copper_Ore', level: 1 };
const AREA = { id: 'melvorD:Pond', requiredItem: undefined as { id: string } | undefined };
const FISH = { id: 'melvorD:Raw_Shrimp', level: 1, area: AREA };

class FakeWoodcutting {
  name = 'Woodcutting';
  activeTrees = new Set<Recipe>();
  isActive = false;
  canStop = true;
  treeCutLimit = 1;
  unlocked = new Set([TREE.id, OAK.id]);
  startLies = false;

  actions = {
    getObjectByID: (id: string) => [TREE, OAK, LOCKED_TREE].find((t) => t.id === id),
  };

  isTreeUnlocked(tree: Recipe): boolean {
    return this.unlocked.has(tree.id);
  }

  /** Returns void, and toggles — faithful to the real method. */
  selectTree(tree: Recipe): void {
    if (this.activeTrees.has(tree)) this.activeTrees.delete(tree);
    else this.activeTrees.add(tree);
  }

  start(): boolean {
    if (this.startLies) return true;
    if (this.activeTrees.size === 0) return false;
    this.isActive = true;
    return true;
  }

  stop(): boolean {
    this.isActive = false;
    return true;
  }
}

class FakeMining {
  name = 'Mining';
  selectedRock: Recipe | undefined;
  isActive = false;
  canStop = true;
  mineable = true;
  /** Whether onRockClick also starts the skill — the undocumented behaviour. */
  clickAlsoStarts = false;

  actions = { getObjectByID: (id: string) => (id === ROCK.id ? ROCK : undefined) };

  canMineOre(): boolean {
    return this.mineable;
  }

  onRockClick(rock: Recipe): void {
    this.selectedRock = rock;
    if (this.clickAlsoStarts) this.isActive = true;
  }

  start(): boolean {
    if (this.selectedRock === undefined) return false;
    this.isActive = true;
    return true;
  }

  stop(): boolean {
    this.isActive = false;
    return true;
  }
}

class FakeFishing {
  name = 'Fishing';
  selectedAreaFish = new Map<typeof AREA, typeof FISH>();
  activeFish: typeof FISH | undefined;
  isActive = false;
  canStop = true;
  unlocked = true;

  actions = { getObjectByID: (id: string) => (id === FISH.id ? FISH : undefined) };

  isMasteryActionUnlocked(): boolean {
    return this.unlocked;
  }

  onAreaFishSelection(area: typeof AREA, fish: typeof FISH): void {
    this.selectedAreaFish.set(area, fish);
  }

  /** Fishing starts per area, not via a plain start(). */
  onAreaStartButtonClick(area: typeof AREA): void {
    const fish = this.selectedAreaFish.get(area);
    if (fish === undefined) return;
    this.activeFish = fish;
    this.isActive = true;
  }

  stop(): boolean {
    this.isActive = false;
    return true;
  }
}

let woodcutting: FakeWoodcutting;
let mining: FakeMining;
let fishing: FakeFishing;

function installGame(activeActionId: string | null = null): void {
  (globalThis as Record<string, unknown>).game = {
    woodcutting,
    mining,
    fishing,
    activeAction: activeActionId === null ? undefined : { id: activeActionId },
    combat: { player: { equipment: { checkForItem: () => true } } },
  };
}

beforeEach(() => {
  woodcutting = new FakeWoodcutting();
  mining = new FakeMining();
  fishing = new FakeFishing();
  AREA.requiredItem = undefined;
  installGame();
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
});

describe('startGathering — woodcutting', () => {
  it('selects and starts, with before/after evidence', () => {
    const result = startGathering(WOODCUTTING, TREE.id, never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observed.before.active).toBe(false);
    expect(result.observed.after.selected).toEqual([TREE.id]);
    expect(woodcutting.isActive).toBe(true);
  });

  it('is idempotent — a second call refuses and leaves the skill running', () => {
    startGathering(WOODCUTTING, TREE.id, never);
    const second = startGathering(WOODCUTTING, TREE.id, never);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('precondition');
    // The critical assertion: selectTree toggles, so a careless retry would
    // have deselected the tree and left the agent idle forever.
    expect(woodcutting.activeTrees.has(TREE)).toBe(true);
    expect(woodcutting.isActive).toBe(true);
  });

  it('clears the selection when at the cut limit rather than silently no-opping', () => {
    startGathering(WOODCUTTING, TREE.id, never);
    woodcutting.isActive = false; // skill stopped, selection persists
    const result = startGathering(WOODCUTTING, OAK.id, never);

    expect(result.ok).toBe(true);
    expect([...woodcutting.activeTrees].map((t) => t.id)).toEqual([OAK.id]);
  });

  it('reports no_state_change when the game claims success but nothing moved', () => {
    // A caller trusting the boolean would believe woodcutting was running.
    woodcutting.startLies = true;
    const result = startGathering(WOODCUTTING, TREE.id, never);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_state_change');
  });

  it('refuses a locked tree without calling the game', () => {
    const result = startGathering(WOODCUTTING, LOCKED_TREE.id, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('precondition');
    expect(woodcutting.activeTrees.size).toBe(0);
  });
});

describe('startGathering — mining', () => {
  it('starts when onRockClick only selects', () => {
    mining.clickAlsoStarts = false;
    const result = startGathering(MINING, ROCK.id, never);
    expect(result.ok).toBe(true);
    expect(mining.isActive).toBe(true);
  });

  it('starts when onRockClick also starts the skill', () => {
    // The side effects of the UI callback are undocumented. Verifying the
    // post-condition rather than sequencing two steps makes both behaviours
    // succeed identically — which is the point of the composite action.
    mining.clickAlsoStarts = true;
    const result = startGathering(MINING, ROCK.id, never);
    expect(result.ok).toBe(true);
    expect(mining.isActive).toBe(true);
    expect(mining.selectedRock?.id).toBe(ROCK.id);
  });

  it('refuses a rock that cannot be mined', () => {
    mining.mineable = false;
    const result = startGathering(MINING, ROCK.id, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('precondition');
  });
});

describe('startGathering — fishing', () => {
  it('selects the fish and starts its area', () => {
    const result = startGathering(FISHING, FISH.id, never);
    expect(result.ok).toBe(true);
    expect(fishing.isActive).toBe(true);
    expect(fishing.activeFish?.id).toBe(FISH.id);
  });

  it('refuses when the area needs an item that is not equipped', () => {
    AREA.requiredItem = { id: 'melvorD:Message_In_A_Bottle' };
    (globalThis as Record<string, unknown>).game = {
      woodcutting,
      mining,
      fishing,
      activeAction: undefined,
      combat: { player: { equipment: { checkForItem: () => false } } },
    };

    const result = startGathering(FISHING, FISH.id, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('requires');
    expect(fishing.isActive).toBe(false);
  });
});

describe('startGathering — cross-cutting guards', () => {
  it('refuses outright while offline progress is resolving', () => {
    const result = startGathering(WOODCUTTING, TREE.id, always);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('suspended');
    expect(woodcutting.activeTrees.size).toBe(0);
  });

  it('does not preempt another skill holding the action slot', () => {
    installGame('melvorD:Firemaking');
    const result = startGathering(WOODCUTTING, TREE.id, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('another action is running');
  });

  it('refuses a skill with no verified executor rather than improvising', () => {
    const result = startGathering('melvorD:Township', 'melvorD:Whatever', never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('no verified routine');
  });

  it('refuses an unregistered recipe id', () => {
    const result = startGathering(WOODCUTTING, 'melvorD:Not_A_Tree', never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('no tree registered');
  });
});

describe('stopGathering', () => {
  it('stops each skill and observes the transition', () => {
    for (const [skillId, recipeId, fake] of [
      [WOODCUTTING, TREE.id, woodcutting],
      [MINING, ROCK.id, mining],
      [FISHING, FISH.id, fishing],
    ] as const) {
      startGathering(skillId, recipeId, never);
      const result = stopGathering(skillId, never);
      expect(result.ok).toBe(true);
      expect(fake.isActive).toBe(false);
    }
  });

  it('waits, rather than refusing, when the skill cannot stop yet', () => {
    // This test previously asserted 'precondition', which is what the adapter
    // returned and what the policy tier treats as "give up on this objective".
    // The premise was wrong: "cannot stop" is a moment, not a verdict —
    // mid-action, or stunned from a failed pickpocket, which lasts seconds.
    //
    // It cost a whole Magic objective. A plan of food, then Magic, then
    // Thieving hit one stun while Thieving held the action slot; the Magic step
    // was moved to the back of the plan and never came round again. From
    // outside it read as the third combat objective in a row failing on its own
    // merits, which sent me looking at spells, runes and gear instead.
    startGathering(WOODCUTTING, TREE.id, never);
    woodcutting.canStop = false;
    const result = stopGathering(WOODCUTTING, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('not_yet');
    expect(woodcutting.isActive).toBe(true);
  });
});

describe('skill coverage', () => {
  it('routes every startable skill to a verified routine', () => {
    // Guards against a skill being listed as supported while its routine was
    // never written — the list and the router must not drift apart.
    for (const skillId of STARTABLE_SKILL_IDS) {
      const result = startGathering(skillId, 'melvorD:Some_Recipe', never);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      // Any refusal is fine except "no routine": that would mean the skill is
      // advertised but unroutable.
      expect(result.detail).not.toContain('no verified routine');
    }
  });

  it('excludes combat, Farming, Township, Cartography and Archaeology', () => {
    // Combat needs the Phase 2 survivability gate; Farming is plant-then-harvest
    // rather than a continuous action; the rest are management interfaces.
    for (const excluded of [
      'melvorD:Attack',
      'melvorD:Slayer',
      'melvorD:Farming',
      'melvorD:Township',
      'melvorAoD:Cartography',
      'melvorAoD:Archaeology',
    ]) {
      expect(STARTABLE_SKILL_IDS).not.toContain(excluded);
      const result = startGathering(excluded, 'melvorD:Whatever', never);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.detail).toContain('no verified routine');
    }
  });
});

describe('skills where the game picks the action', () => {
  // Agility is a course: built obstacles run in sequence and the game advances
  // through them. Pinning one obstacle produced a thrash loop that burned
  // fifteen minutes — objective on Rope Jump, course on Cargo Net, mismatch
  // branch stops to switch, game restarts the same course, repeat every three
  // seconds with no XP. `Agility.stop ok` / `agility.run ok`, alternating.
  const isCourse = (skillId: string) => skillId === 'melvorD:Agility';
  const decide = (skillId: string, running: string[], wanted: string) =>
    isCourse(skillId) || running.includes(wanted) ? 'already_running' : 'stop_to_switch';

  it('treats an active course as already running whatever was asked', () => {
    expect(decide('melvorD:Agility', ['melvorD:Cargo_Net'], 'melvorD:Rope_Jump')).toBe(
      'already_running',
    );
  });

  it('still switches recipes for a skill that genuinely selects one', () => {
    // The behaviour this must not break: told to cut Willow while cutting Oak,
    // the agent once idled and kept cutting Oak for hours.
    expect(decide('melvorD:Woodcutting', ['melvorD:Oak'], 'melvorD:Willow')).toBe('stop_to_switch');
  });

  it('leaves a matching selection alone', () => {
    expect(decide('melvorD:Woodcutting', ['melvorD:Willow'], 'melvorD:Willow')).toBe(
      'already_running',
    );
  });
});

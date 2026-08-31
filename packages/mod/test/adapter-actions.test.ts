import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selectTree, startWoodcutting, stopWoodcutting } from '../src/adapter/actions.js';

/**
 * Exercises the observe → verify → act contract against a stand-in for the game.
 *
 * The fake reproduces the two behaviours that make `ActionResult` necessary and
 * that a mock returning `true` would hide:
 *
 * - `selectTree` returns `void` **and toggles** — so a caller that retries on a
 *   missing return value undoes its own work.
 * - `start()` returns a boolean that can be `true` while nothing changed.
 */

interface FakeTree {
  id: string;
  level: number;
  unlocked: boolean;
}

class FakeWoodcutting {
  activeTrees = new Set<FakeTree>();
  isActive = false;
  canStop = true;
  treeCutLimit = 1;
  /** Forces start() to report success without actually starting. */
  startLies = false;

  constructor(private readonly trees: FakeTree[]) {}

  actions = {
    getObjectByID: (id: string): FakeTree | undefined => this.trees.find((t) => t.id === id),
    allObjects: this.trees,
  };

  isTreeUnlocked(tree: FakeTree): boolean {
    return tree.unlocked;
  }

  /** Returns void, and toggles. Both are faithful to the real method. */
  selectTree(tree: FakeTree): void {
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

const NORMAL: FakeTree = { id: 'melvorD:Normal_Tree', level: 1, unlocked: true };
const OAK: FakeTree = { id: 'melvorD:Oak_Tree', level: 10, unlocked: true };
const LOCKED: FakeTree = { id: 'melvorD:Magic_Tree', level: 75, unlocked: false };

let woodcutting: FakeWoodcutting;
const never = (): boolean => false;
const always = (): boolean => true;

beforeEach(() => {
  woodcutting = new FakeWoodcutting([NORMAL, OAK, LOCKED]);
  // The adapter reads the ambient `game` global; stand one in for the test.
  (globalThis as Record<string, unknown>).game = {
    woodcutting,
    activeAction: undefined,
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).game = undefined;
});

describe('selectTree', () => {
  it('succeeds with before/after evidence, not a return code', () => {
    const result = selectTree(NORMAL.id, never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observed.before.trees).toEqual([]);
    expect(result.observed.after.trees).toEqual([NORMAL.id]);
  });

  it('refuses to re-select an already-selected tree, because that would toggle it off', () => {
    selectTree(NORMAL.id, never);
    const second = selectTree(NORMAL.id, never);

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('precondition');
    // The critical assertion: the tree is still selected. A naive retry would
    // have deselected it and the agent would sit idle forever.
    expect(woodcutting.activeTrees.has(NORMAL)).toBe(true);
  });

  it('refuses a locked tree without calling the game', () => {
    const result = selectTree(LOCKED.id, never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('precondition');
    expect(woodcutting.activeTrees.size).toBe(0);
  });

  it('refuses an unregistered tree id', () => {
    const result = selectTree('melvorD:Not_A_Tree', never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('no tree registered');
  });

  it('respects the tree cut limit', () => {
    woodcutting.treeCutLimit = 1;
    selectTree(NORMAL.id, never);
    const second = selectTree(OAK.id, never);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('precondition');
  });

  it('refuses outright while offline progress is resolving', () => {
    const result = selectTree(NORMAL.id, always);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('suspended');
    expect(woodcutting.activeTrees.size).toBe(0);
  });
});

describe('startWoodcutting', () => {
  it('starts and observes the transition', () => {
    selectTree(NORMAL.id, never);
    const result = startWoodcutting(never);
    expect(result.ok).toBe(true);
    expect(woodcutting.isActive).toBe(true);
  });

  it('reports no_state_change when the game claims success but nothing moved', () => {
    // This is the whole point of the contract. A caller trusting the boolean
    // would believe woodcutting was running and never retry.
    selectTree(NORMAL.id, never);
    woodcutting.startLies = true;

    const result = startWoodcutting(never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('no_state_change');
  });

  it('refuses to start with no tree selected', () => {
    const result = startWoodcutting(never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('precondition');
  });

  it('does not start over another running action', () => {
    selectTree(NORMAL.id, never);
    (globalThis as Record<string, unknown>).game = {
      woodcutting,
      activeAction: { id: 'melvorD:Fishing' },
    };
    const result = startWoodcutting(never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toContain('another action is running');
  });
});

describe('stopWoodcutting', () => {
  it('stops and observes the transition', () => {
    selectTree(NORMAL.id, never);
    startWoodcutting(never);
    const result = stopWoodcutting(never);
    expect(result.ok).toBe(true);
    expect(woodcutting.isActive).toBe(false);
  });

  it('refuses when the skill reports it cannot stop', () => {
    selectTree(NORMAL.id, never);
    startWoodcutting(never);
    woodcutting.canStop = false;
    const result = stopWoodcutting(never);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('precondition');
    expect(woodcutting.isActive).toBe(true);
  });
});

describe('the full Phase 1 behaviour', () => {
  it('recovers an idle skill: select then start, both verified', () => {
    // The end-to-end path the reflex tier drives after an interruption.
    const select = selectTree(NORMAL.id, never);
    const start = startWoodcutting(never);

    expect(select.ok && start.ok).toBe(true);
    expect(woodcutting.isActive).toBe(true);
    expect([...woodcutting.activeTrees].map((t) => t.id)).toEqual([NORMAL.id]);
  });

  it('is idempotent — a second pass changes nothing and reports why', () => {
    selectTree(NORMAL.id, never);
    startWoodcutting(never);

    const select = selectTree(NORMAL.id, never);
    const start = startWoodcutting(never);

    expect(select.ok).toBe(false);
    expect(start.ok).toBe(false);
    // Still running: the failed second pass did not disturb the first.
    expect(woodcutting.isActive).toBe(true);
    expect(woodcutting.activeTrees.has(NORMAL)).toBe(true);
  });
});

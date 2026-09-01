import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

function candidate(kind: string, id: string, label = `${kind} ${id}`) {
  return { kind, params: { kind, itemId: id }, label };
}

function storeShowing(shown: ReturnType<typeof candidate>[]): Store {
  const store = new Store('.');
  store.rememberShownCandidates(shown);
  return store;
}

describe('the drift guard', () => {
  it('follows a choice that only changed position', () => {
    // The live failure: the candidate list churns on every sale and every item
    // consumed in a fight, so a plan built from a fresh listing was still stale
    // by the time it was submitted. Refusing the correct answer trains the
    // caller to work around the guard, which is what it exists to prevent.
    const shown = [candidate('sell_items', 'Oak'), candidate('fight', 'Chicken')];
    const store = storeShowing(shown);

    const now = [candidate('buy', 'Shards'), ...shown];
    const resolved = store.resolveChoice(1, now);

    expect(resolved).toEqual({ index: 2, moved: true });
  });

  it('leaves an unmoved choice exactly where it is', () => {
    const shown = [candidate('sell_items', 'Oak'), candidate('fight', 'Chicken')];
    const store = storeShowing(shown);

    expect(store.resolveChoice(1, shown)).toEqual({ index: 1, moved: false });
  });

  it('still refuses a choice that is gone entirely', () => {
    // The case the guard was written for: the thing picked no longer exists,
    // so acting on that index would act on something else. A request to equip
    // a dagger once built a storehouse this way.
    const store = storeShowing([candidate('equip', 'Bronze_Dagger')]);

    const resolved = store.resolveChoice(0, [candidate('build', 'Storehouse')]);

    expect(resolved).toHaveProperty('error');
    expect((resolved as { error: string }).error).toMatch(/no longer available/);
  });

  it('ignores label churn, comparing identity only', () => {
    // Labels carry live numbers — a mastery pool ticks up every second — so
    // comparing text would reject choices that had not actually changed.
    const store = storeShowing([candidate('mastery', 'Golbin', 'pool 15396 XP')]);

    const resolved = store.resolveChoice(0, [candidate('mastery', 'Golbin', 'pool 22423 XP')]);

    expect(resolved).toEqual({ index: 0, moved: false });
  });
});

describe('an unverifiable index', () => {
  it('refuses when nothing was listed, instead of acting blindly', () => {
    // The hole this closes. Saving any planner file reloads the service and
    // empties the remembered listing; the guard then had nothing to compare
    // against and fell through to acting on the raw index. Twice in a row that
    // resolved a chosen fight to a different monster entirely — once a Seagull,
    // once the Lair of the Spider Queen — while the guard appeared to be on.
    const store = new Store('.');

    const resolved = store.resolveChoice(3, [
      candidate('fight', 'Golbin'),
      candidate('fight', 'Seagull'),
      candidate('fight', 'Cow'),
      candidate('fight', 'Spider'),
    ]);

    expect(resolved).toHaveProperty('error');
    expect((resolved as { error: string }).error).toMatch(/no candidate listing is remembered/);
  });

  it('works normally once a listing has been recorded', () => {
    const shown = [candidate('fight', 'Golbin')];
    const store = storeShowing(shown);

    expect(store.resolveChoice(0, shown)).toEqual({ index: 0, moved: false });
  });
});

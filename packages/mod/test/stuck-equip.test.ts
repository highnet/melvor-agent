import { describe, expect, it } from 'vitest';
import { StuckEquipWatch } from '../src/runtime/stuck-equip.js';

const SCIMITAR = 'melvorD:Steel_Scimitar';
const STAFF = 'melvorF:Staff_of_Air';

describe('StuckEquipWatch', () => {
  it('abandons an item only after a run of reversions, not on the first', () => {
    // One reversion is indistinguishable from the game unequipping during its
    // own tick for a reason that will not repeat. Refusing on that would
    // strand a slot the character could legitimately fill.
    const watch = new StuckEquipWatch();

    watch.record(SCIMITAR, STAFF);
    expect(watch.ids()).toEqual([]);

    watch.record(SCIMITAR, STAFF);
    expect(watch.ids()).toEqual([]);

    watch.record(SCIMITAR, STAFF);
    expect(watch.ids()).toEqual([SCIMITAR]);
  });

  it('forgets a run as soon as an equip sticks', () => {
    const watch = new StuckEquipWatch();

    watch.record(SCIMITAR, STAFF);
    watch.record(SCIMITAR, STAFF);
    watch.record(SCIMITAR, SCIMITAR);

    // The tally resets, so a later isolated reversion does not immediately
    // abandon an item that has been worn successfully.
    watch.record(SCIMITAR, STAFF);
    expect(watch.ids()).toEqual([]);
  });

  it('ignores a tick that equipped nothing', () => {
    const watch = new StuckEquipWatch();

    watch.record(null, STAFF);
    watch.record(null, null);

    expect(watch.ids()).toEqual([]);
  });

  it('tracks items independently', () => {
    const watch = new StuckEquipWatch();
    const boots = 'melvorD:Steel_Boots';

    for (let i = 0; i < 3; i += 1) watch.record(SCIMITAR, STAFF);
    watch.record(boots, null);

    expect(watch.isStuck(SCIMITAR)).toBe(true);
    expect(watch.isStuck(boots)).toBe(false);
  });
});

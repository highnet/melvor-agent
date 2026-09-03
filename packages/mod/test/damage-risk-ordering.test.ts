import type { Candidate, CombatSkillLevels, DamageRisk } from '@melvor-agent/shared';
import { damageRiskBand, orderDamagingCandidates } from '@melvor-agent/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { thievingCandidates } from '../src/adapter/gather-candidates.js';
import { resetAdapterFailures } from '../src/adapter/safe.js';
import { levelScreenPressure, screenByCombatSkillLevels } from '../src/policy/combat-gate.js';
import { installFakeGame } from './fixtures.js';

/**
 * The board sorted damaging work by rate alone, and it cost the character.
 *
 * On 2026-09-03 the combat candidates read as a leaderboard of the damage rates
 * in their labels: `Sweaty Monster` at ~17,085 damage/h on top, `Chicken` at
 * ~12,000. The top of that list was queued and produced deaths 56 and 57 eight
 * minutes apart, and `applyDeathPenalty` destroyed a Jeweled Necklace, which
 * cannot be bought back.
 *
 * The screen that let it through was not silent. It passed the fight with the
 * words *"Screened on levels only, not proven survivable"* and two
 * `uncertainties` entries beside them, and nothing downstream read either — so
 * a target the screen could not vouch for sorted identically to one the full
 * survivability gate had proved.
 *
 * These tests drive the real readers. `screenByCombatSkillLevels` and
 * `levelScreenPressure` produce the danger figures, `thievingCandidates`
 * produces the Thieving half against a stubbed `game`, and
 * `orderDamagingCandidates` does the ordering. Nothing here restates the
 * arithmetic: `mining-respawn.test.ts` mirrored an amortisation and kept
 * passing for weeks after the implementation moved away from it.
 */

/**
 * The live character on the day of the deaths: Defence 17, Hitpoints 16.
 *
 * Read from `GET /dashboard` on 2026-09-03. Its defensive mean is 16.5 and the
 * single-monster ceiling is therefore 24.75, which is the number that makes
 * this a real case rather than a constructed one.
 */
const PLAYER: CombatSkillLevels = {
  attack: 7,
  strength: 5,
  defence: 17,
  hitpoints: 16,
  ranged: 3,
  magic: 25,
};

/**
 * Two monsters, straight out of the shipped v1.3.1 game data.
 *
 * From the nw.js HTTP cache (`f_00000b`, decompressed; see
 * `learnings/mod-api.md`), quoted rather than paraphrased:
 *
 * ```json
 * { "id": "SweatyMonster", "name": "Sweaty Monster",
 *   "levels": { "Hitpoints": 28, "Attack": 22, "Strength": 24,
 *               "Defence": 24, "Ranged": 20, "Magic": 20 } }
 * { "id": "Chicken", "name": "Chicken",
 *   "levels": { "Hitpoints": 3, "Attack": 1, "Strength": 1,
 *               "Defence": 1, "Ranged": 1, "Magic": 1 } }
 * ```
 *
 * `data/dump.json` captures neither monster levels nor monster equipment stats,
 * so this is the only source for them that is not an invention.
 */
const SWEATY_MONSTER: CombatSkillLevels = {
  attack: 22,
  strength: 24,
  defence: 24,
  hitpoints: 28,
  ranged: 20,
  magic: 20,
};

const CHICKEN: CombatSkillLevels = {
  attack: 1,
  strength: 1,
  defence: 1,
  hitpoints: 3,
  ranged: 1,
  magic: 1,
};

/** Damage/h as the live board reported it for each, unedited. */
const SWEATY_MONSTER_DAMAGE_PER_HOUR = 17_085;
const CHICKEN_DAMAGE_PER_HOUR = 12_000;

/**
 * Prices one monster's danger the way the runtime does.
 *
 * Deliberately the real screen and the real pressure function rather than a
 * hand-written number: the claim under test is that the figure the screen
 * *already computed* is enough to separate these two fights, so computing it
 * here myself would prove nothing.
 */
function fightRisk(
  name: string,
  levels: CombatSkillLevels,
  damagePerHour: number,
): { risk: DamageRisk; screenPassed: boolean } {
  const verdict = screenByCombatSkillLevels({
    targetId: `melvorD:${name.replace(' ', '')}`,
    targetName: name,
    isDungeon: false,
    player: PLAYER,
    playerDefenceBonus: 0,
    monsters: [{ name, levels, strengthBonus: 0 }],
    unreadableMonsters: [],
  });

  return {
    screenPassed: verdict.ok,
    risk: {
      pressure: levelScreenPressure(verdict),
      basis: 'levels_only',
      guard: 'combat_level_screen',
      ratePerHour: damagePerHour,
      rateUnit: 'damage_per_hour',
      why: verdict.detail,
    },
  };
}

function fightCandidate(name: string, risk: DamageRisk): Candidate {
  return {
    kind: 'fight_monster',
    params: { kind: 'fight_monster', monsterId: `melvorD:${name.replace(' ', '')}`, areaId: '' },
    label: `Fight ${name}`,
    damageRisk: risk,
    available: true,
  };
}

describe('a level-1 monster outranks the level-27 one that killed the character', () => {
  it('passes both fights, which is why rate alone could decide between them', () => {
    // The premise. Neither monster is refused — the screen said yes to Sweaty
    // Monster on the day it killed the character twice — so a refusal-shaped
    // fix would have changed nothing here. Only an ordering can.
    expect(fightRisk('Chicken', CHICKEN, CHICKEN_DAMAGE_PER_HOUR).screenPassed).toBe(true);
    expect(
      fightRisk('Sweaty Monster', SWEATY_MONSTER, SWEATY_MONSTER_DAMAGE_PER_HOUR).screenPassed,
    ).toBe(true);
  });

  it('separates them into different danger bands from the screen it already ran', () => {
    // Sweaty Monster attacks at combat skill level 24 against a ceiling of
    // 24.75: it passed by three quarters of a level. Chicken attacks at 1.
    // Both facts were in `workings` and neither reached anything that sorts.
    const sweaty = fightRisk('Sweaty Monster', SWEATY_MONSTER, SWEATY_MONSTER_DAMAGE_PER_HOUR);
    const chicken = fightRisk('Chicken', CHICKEN, CHICKEN_DAMAGE_PER_HOUR);

    expect(damageRiskBand(chicken.risk.pressure)).toBe('low');
    expect(damageRiskBand(sweaty.risk.pressure)).toBe('high');
    expect(sweaty.risk.pressure).toBeGreaterThan(0.9);
  });

  it('offers the Chicken first despite 42% less damage per hour', () => {
    const sweaty = fightRisk('Sweaty Monster', SWEATY_MONSTER, SWEATY_MONSTER_DAMAGE_PER_HOUR);
    const chicken = fightRisk('Chicken', CHICKEN, CHICKEN_DAMAGE_PER_HOUR);

    // The rate really is higher, and that really was the whole argument for
    // queuing it. Asserted so the test cannot pass by the two rates drifting
    // together.
    expect(sweaty.risk.ratePerHour / chicken.risk.ratePerHour).toBeGreaterThan(1.4);

    const ordered = orderDamagingCandidates([
      fightCandidate('Sweaty Monster', sweaty.risk),
      fightCandidate('Chicken', chicken.risk),
    ]);

    expect(ordered.map((candidate) => candidate.label)).toEqual([
      'Fight Chicken',
      'Fight Sweaty Monster',
    ]);
  });
});

/** A risk record with every field stated, so each test varies exactly one. */
function risk(overrides: Partial<DamageRisk> = {}): DamageRisk {
  return {
    pressure: 0.1,
    basis: 'measured',
    guard: 'survivability_gate',
    ratePerHour: 1_000,
    rateUnit: 'damage_per_hour',
    why: 'stated by the test',
    ...overrides,
  };
}

function labelled(label: string, overrides: Partial<DamageRisk> = {}): Candidate {
  return {
    kind: 'fight_monster',
    params: { kind: 'fight_monster', monsterId: `melvorD:${label}`, areaId: '' },
    label,
    damageRisk: risk(overrides),
    available: true,
  };
}

describe("the screen's own uncertainty binds", () => {
  it('ranks a level-only screen below a verdict that measured the enemy', () => {
    // `uncertainties` said "Screened on levels only, not proven survivable" on
    // every cycle and cost nothing. This is the smallest thing that makes it
    // cost something: one position, among targets of the same danger.
    const ordered = orderDamagingCandidates([
      labelled('screened', { basis: 'levels_only' }),
      labelled('measured', { basis: 'measured' }),
    ]);

    expect(ordered.map((candidate) => candidate.label)).toEqual(['measured', 'screened']);
  });

  it('holds even when the level-only target advertises the better rate', () => {
    // The failure being prevented: an unproven fight buying its way back to the
    // top of the list with the same rate that put it there in the first place.
    const ordered = orderDamagingCandidates([
      labelled('screened, faster', { basis: 'levels_only', ratePerHour: 50_000 }),
      labelled('measured, slower', { basis: 'measured', ratePerHour: 1_000 }),
    ]);

    expect(ordered[0]?.label).toBe('measured, slower');
  });

  it('still puts danger first, so an unproven Chicken beats a proven Hill Giant', () => {
    // Basis ranks *within* a band and never above it, and that ordering is
    // load-bearing rather than incidental. The enemy probe returns NaN outside
    // combat for every monster in the game, so every fight on the board is
    // level-screened; if certainty outranked danger, the safest fights would
    // all sort beneath anything that happened to measure.
    const ordered = orderDamagingCandidates([
      labelled('proven but dangerous', { basis: 'measured', pressure: 0.9 }),
      labelled('unproven but safe', { basis: 'levels_only', pressure: 0.05 }),
    ]);

    expect(ordered[0]?.label).toBe('unproven but safe');
  });
});

describe('the ordering makes the agent fight better, not less', () => {
  it('still ranks by rate among equally safe, equally understood targets', () => {
    // The aim is better targets, not less combat: a level-1 monster ground for
    // ninety minutes is the intended play. Within a band the fastest still
    // wins, which is what keeps this an ordering rather than a brake.
    const ordered = orderDamagingCandidates([
      labelled('slow', { ratePerHour: 7_200 }),
      labelled('fast', { ratePerHour: 15_158 }),
      labelled('middling', { ratePerHour: 12_000 }),
    ]);

    expect(ordered.map((candidate) => candidate.label)).toEqual(['fast', 'middling', 'slow']);
  });

  it('refuses nothing — every candidate handed in comes back out', () => {
    const before = [
      labelled('dangerous', { pressure: 0.95 }),
      labelled('safe', { pressure: 0.05 }),
      labelled('moderate', { pressure: 0.5 }),
    ];
    const after = orderDamagingCandidates(before);

    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((candidate) => candidate.label))).toEqual(
      new Set(['dangerous', 'safe', 'moderate']),
    );
  });

  it('leaves candidates that cannot hurt anyone exactly where they were', () => {
    // Woodcutting is ranked on XP and must stay ranked on XP. Damaging
    // candidates are written back into the positions the group already
    // occupied, so this reorders them relative to each other and to nothing
    // else — which is also what keeps the comparison transitive on a mixed
    // list.
    const tree: Candidate = {
      kind: 'gather_resource',
      params: { kind: 'gather_resource', skillId: 'melvorD:Woodcutting', recipeId: 'melvorD:Yew' },
      label: 'Woodcutting: Yew',
      available: true,
    };

    const ordered = orderDamagingCandidates([
      labelled('dangerous', { pressure: 0.95 }),
      tree,
      labelled('safe', { pressure: 0.05 }),
    ]);

    expect(ordered.map((candidate) => candidate.label)).toEqual([
      'safe',
      'Woodcutting: Yew',
      'dangerous',
    ]);
  });

  it('will not compare a damage rate with an experience rate', () => {
    // Combat XP has no coefficient anywhere in the typings — the only statement
    // is `Player.rewardXPAndPetsForDamage(damage)` (player.d.ts:435) — so there
    // is no conversion between these two numbers and inventing one would be the
    // `numberMultiplier` mistake in a second place. Same band, same basis,
    // different units: arrival order stands.
    const ordered = orderDamagingCandidates([
      labelled('a fight', { rateUnit: 'damage_per_hour', ratePerHour: 12_000 }),
      labelled('an NPC', { rateUnit: 'xp_per_hour', ratePerHour: 6_766 }),
    ]);

    expect(ordered.map((candidate) => candidate.label)).toEqual(['a fight', 'an NPC']);
  });
});

/**
 * Thieving NPCs as the live board reported them on 2026-09-03.
 *
 * `maxHit` is `ThievingNPC.maxHit` (thieving2.d.ts:35) and these are the values
 * that appeared in the candidate labels: *"Thieving: Golbin Chief — hits up to
 * 10.1"*, *"Thieving: Woman — hits up to 3.2"*. The XP figures are arranged so
 * that the hardest hitter is also the best-paying one, which is the case that
 * matters: Golbin Chief hits 10.1 at level 16 while Marauder hits 6.8 at 21, so
 * damage is not proportional to level and an XP sort picks the hardest hitter of
 * each tier without ever seeing the number. It was chosen exactly that way.
 */
const NPCS = [
  { id: 'melvorD:Man', name: 'Man', maxHit: 2.2, level: 1, baseExperience: 10 },
  { id: 'melvorD:Woman', name: 'Woman', maxHit: 3.2, level: 2, baseExperience: 12 },
  { id: 'melvorD:GolbinChief', name: 'Golbin Chief', maxHit: 10.1, level: 16, baseExperience: 60 },
  { id: 'melvorD:Chef', name: 'Chef', maxHit: 10.8, level: 26, baseExperience: 80 },
];

/**
 * A `game` holding those NPCs and a character at 120 of 160 hitpoints.
 *
 * 120 is below the live 141 on purpose: the Thieving gate allows a quarter of
 * *current* health, so a character that has been hurt has a smaller allowance,
 * and the ordering has to be computed against the health actually on hand
 * rather than against a full bar.
 */
function installThievingGame(hitpoints: number): () => void {
  const emptyFoodItem = { id: 'melvorD:Empty_Food' };
  const gp = { id: 'melvorD:GP' };

  return installFakeGame({
    gp,
    emptyFoodItem,
    township: { townData: { townCreated: false } },
    farming: { level: 1, actions: { allObjects: [] } },
    bank: { getQty: () => 0 },
    combat: {
      player: {
        hitpoints,
        food: { slots: [{ item: { id: 'melvorD:Shrimp' }, quantity: 40 }] },
      },
    },
    thieving: {
      name: 'Thieving',
      level: 35,
      actionInterval: 3000,
      getNPCSuccessRate: () => 100,
      getNPCInterval: () => 3000,
      getStunInterval: () => 3000,
      actions: {
        allObjects: NPCS.map((npc) => ({
          ...npc,
          currencyDrops: [{ currency: gp, quantity: 100 }],
          lootTable: { drops: [] },
        })),
      },
    },
  });
}

describe('Thieving is ordered by danger too — the operator named it', () => {
  afterEach(() => {
    resetAdapterFailures();
  });

  it('offers the gentle NPCs before the hard-hitting, better-paying ones', () => {
    // *"we should never be greedy with combat, or thieving"*. Golbin Chief and
    // Chef pay the most XP per hour here and hit hardest; under the XP sort
    // that ran before this change they were the top of the list.
    //
    // Man and Woman are both in the low band, so between *those two* the rate
    // still decides and Woman leads on XP. That is the intended behaviour and
    // the assertion is written to allow it: the change is not "prefer the
    // weakest NPC", it is "prefer the safe band, then the best of it".
    const uninstall = installThievingGame(120);
    try {
      const labels = thievingCandidates().map((candidate) => candidate.label);

      const safest = labels.slice(0, 2).join(' | ');
      const hardest = labels.slice(2).join(' | ');

      expect(safest).toContain('Man');
      expect(safest).toContain('Woman');
      expect(hardest).toContain('Golbin Chief');
      expect(hardest).toContain('Chef');
    } finally {
      uninstall();
    }
  });

  it('prices each NPC against the allowance the gate would refuse it on', () => {
    // 120 HP, a quarter of which is 30. Woman's 3.2 is a tenth of that and
    // Chef's 10.8 is over a third, so the two land in different bands from one
    // stated field rather than from a threshold invented here.
    const uninstall = installThievingGame(120);
    try {
      const byName = new Map(
        thievingCandidates().map((candidate) => [candidate.label.split(' — ')[0], candidate]),
      );

      const woman = byName.get('Thieving: Woman')?.damageRisk;
      const chef = byName.get('Thieving: Chef')?.damageRisk;

      expect(woman?.basis).toBe('measured');
      expect(damageRiskBand(woman?.pressure ?? 1)).toBe('low');
      expect(damageRiskBand(chef?.pressure ?? 0)).toBe('moderate');
    } finally {
      uninstall();
    }
  });

  it('tightens as the character gets hurt, because the allowance is current HP', () => {
    // The same Woman at 18 HP is a different proposition: 3.2 against an
    // allowance of 4.5. A share of the maximum bar would have said "low" in
    // both states, which is the reading that lets a hurt character keep going.
    const healthy = installThievingGame(120);
    let atFullHealth = 0;
    try {
      atFullHealth =
        thievingCandidates().find((candidate) => candidate.label.includes('Woman'))?.damageRisk
          ?.pressure ?? 0;
    } finally {
      healthy();
    }

    const hurt = installThievingGame(18);
    try {
      const atLowHealth =
        thievingCandidates().find((candidate) => candidate.label.includes('Woman'))?.damageRisk
          ?.pressure ?? 0;

      expect(atFullHealth).toBeGreaterThan(0);
      expect(atLowHealth).toBeGreaterThan(atFullHealth);
      expect(damageRiskBand(atLowHealth)).toBe('high');
    } finally {
      hurt();
    }
  });
});

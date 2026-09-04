import { z } from 'zod';

/**
 * How candidates that can hurt the character are ordered against each other.
 *
 * Every damaging candidate on the board — a fight, a Thieving NPC — used to be
 * ranked by rate alone, and on 2026-09-03 that ranking put `Sweaty Monster`
 * (combat level 27, defence 24) on top at ~17,085 damage/h with `Chicken`
 * (combat level 1, defence 1) at ~12,000. The top of that list was queued and
 * killed the character twice in eight minutes — deaths 56 and 57 — and
 * `applyDeathPenalty` destroyed a Jeweled Necklace, which cannot be bought
 * back. 42% more damage per hour did not pay for that, and nothing in a single
 * rate scalar could ever have said so.
 *
 * The operator's instruction afterwards, verbatim: *"we should never be greedy
 * with combat, or thieving"*, *"for dangerous activities sometimes its best to
 * do even the simplest like killing chickens for a long time"*, *"we should be
 * more careful"* / *"fight less risky monsters"*.
 *
 * So this is deliberately **not** a refusal and must never become one. Refusing
 * damaging work outright would starve the very skills the open goals need —
 * `hp-40`, `defence-20`, `prayer-20` are all combat-shaped — which is the
 * guard-starves-its-own-precondition failure recorded in `learnings/README.md`
 * and paid for by a morning of zero income. It is an **ordering**: the safest
 * band first, and rate deciding only among targets of comparable danger. A
 * level-1 monster ground for ninety minutes is the intended play, not a
 * fallback.
 *
 * The second thing it encodes is that a screen's own doubt has to cost it
 * something. `screenByCombatSkillLevels` prints *"Screened on levels only, not
 * proven survivable"* and fills an `uncertainties` array that nothing
 * downstream read, so a target the screen could not vouch for sorted
 * identically to one the full survivability gate had proved. That is *a number
 * computed for a sentence is invisible to the code* in its most expensive form.
 * {@link DamageRisk.basis} is that sentence turned into a sort key.
 */

/**
 * Ordered safest to most dangerous; the array *is* the ranking.
 *
 * Three coarse bands rather than a raw score, and the coarseness is the point.
 * A band means "well inside / approaching / near the refusing guard's own
 * line", which is a claim any of the three guards can make honestly about its
 * own allowance. The raw {@link DamageRisk.pressure} figures behind them are
 * *not* comparable between guards — the level screen allows a monster to
 * attack at 1.5x the character's defensive mean, while the Thieving gate
 * allows a hit of a quarter of current health, and nothing calibrates those two
 * numbers against each other. Comparing bands is the strongest comparison the
 * available data supports; see `learnings/game-state.md`, *"Two numbers named
 * alike are not on one scale"*.
 */
export const DAMAGE_RISK_BANDS = ['low', 'moderate', 'high'] as const;
export type DamageRiskBand = (typeof DAMAGE_RISK_BANDS)[number];

/**
 * Where one band ends and the next begins, as a share of the guard's allowance.
 *
 * Thirds, because nothing in the typings or in `data/dump.json` calibrates
 * anything finer and an invented threshold is the defect this file exists to
 * remove. What the split has to achieve is one thing, and it does: on the live
 * board of 2026-09-03 it separates the Farmlands and Chicken Coop monsters
 * (offensive level 1 against a ceiling of 24.75) from `Sweaty Monster`, which
 * sits near it — and Thieving's `Man` (2.2 damage) and `Woman` (3.2) from
 * `Golbin Chief` (10.1) and `Chef` (10.8).
 */
const MODERATE_FROM = 1 / 3;
const HIGH_FROM = 2 / 3;

/**
 * The band a pressure reading falls in.
 *
 * @param pressure - Share of the refusing guard's own allowance the target
 *   consumes. 1 is the line at which that guard refuses outright, so anything
 *   at or above it should already have been withheld and is banded `high`
 *   rather than trusted.
 */
export function damageRiskBand(pressure: number): DamageRiskBand {
  if (!Number.isFinite(pressure) || pressure >= HIGH_FROM) return 'high';
  if (pressure >= MODERATE_FROM) return 'moderate';
  return 'low';
}

/** Position in {@link DAMAGE_RISK_BANDS}; lower sorts first. */
export function bandRank(band: DamageRiskBand): number {
  return DAMAGE_RISK_BANDS.indexOf(band);
}

/**
 * How the danger figure was arrived at, ordered most to least trustworthy.
 *
 * `measured` means the target's own damage was read — the survivability gate's
 * probed `Enemy` stats, or `ThievingNPC.maxHit` (thieving2.d.ts:35), which is a
 * stated field rather than an inference. `levels_only` means
 * `screenByCombatSkillLevels` compared combat *skill levels* and said so: it
 * models no equipment, special attack, passive or combat-triangle effect and
 * can be wrong in both directions.
 */
export const DAMAGE_RISK_BASES = ['measured', 'levels_only'] as const;
export const damageRiskBasisSchema = z.enum(DAMAGE_RISK_BASES);
export type DamageRiskBasis = z.infer<typeof damageRiskBasisSchema>;

/**
 * The unit {@link DamageRisk.ratePerHour} is expressed in.
 *
 * Carried rather than assumed, because the tie-break must not compare a fight's
 * damage/hour with a Thieving NPC's XP/hour. Combat XP has no coefficient
 * anywhere in the typings — the only statement is
 * `Player.rewardXPAndPetsForDamage(damage)` (player.d.ts:435) — so damage/hour
 * ranks fights against fights exactly as XP/hour would and cannot be converted
 * to compare against anything else. Two rates in different units sort as a tie
 * and keep the order they arrived in.
 */
export const damageRateUnitSchema = z.enum(['damage_per_hour', 'xp_per_hour']);
export type DamageRateUnit = z.infer<typeof damageRateUnitSchema>;

/**
 * What a damaging candidate carries so the ordering can be code and not prose.
 *
 * Every term here already existed somewhere in the mod as a sentence: the
 * screen's "not proven survivable", Thieving's "hits up to 3.2 (2% of current
 * HP)", the fight label's "~17,085 damage/h". None of them reached anything
 * that decides. This is those three sentences as numbers.
 */
export const damageRiskSchema = z.object({
  /**
   * Share of the refusing guard's own allowance this target consumes, where 1
   * is the point of refusal. Comparable only within one `guard`; across guards
   * use {@link damageRiskBand}.
   */
  pressure: z.number().nonnegative(),
  basis: damageRiskBasisSchema,
  /** Which guard's allowance `pressure` is a share of, named for the label. */
  guard: z.string().min(1),
  /** The rate that ranks this candidate among equally dangerous ones. */
  ratePerHour: z.number().nonnegative(),
  rateUnit: damageRateUnitSchema,
  /** One line fit for a label, so a planner can argue with the ordering. */
  why: z.string(),
});
export type DamageRisk = z.infer<typeof damageRiskSchema>;

/** Anything that can be ordered by danger. `Candidate` satisfies it. */
export interface RankableByDamage {
  damageRisk?: DamageRisk | undefined;
}

/**
 * Orders damaging candidates: safety band first, then certainty, then rate.
 *
 * Three keys, in the order the operator's doctrine puts them.
 *
 * 1. **Band.** A `low` target outranks a `high` one whatever the rate. This is
 *    the whole instruction — *"we should never be greedy with combat, or
 *    thieving"* — and it is what would have put Chicken above Sweaty Monster on
 *    2026-09-03 instead of 42% of a damage rate above a dead character.
 * 2. **Basis.** Within a band, a target whose damage was *measured* outranks
 *    one merely screened on levels. The screen already knew it could not
 *    vouch for the fight that killed the character and printed as much; making
 *    that doubt cost a position is the smallest change that lets it bind.
 *    Deliberately below the band and not above it: an unproven Chicken is still
 *    a Chicken, and demoting every level-screened target beneath every measured
 *    one would empty the board, since the enemy probe fails outside combat for
 *    every monster in the game (`combat.ts`, `probeMonsterStats`).
 * 3. **Rate.** Only then, and only between rates in the same unit. Among
 *    equally safe, equally well understood targets, faster is better — the aim
 *    is better targets, not less combat.
 *
 * Candidates carrying no {@link DamageRisk} are left exactly where they are,
 * and the damaging ones are written back into the positions the group already
 * occupied. So this reorders damaging candidates *relative to each other* and
 * changes nothing about how they interleave with gathering, buying or equipping
 * — which keeps it a total, transitive order rather than a comparator that
 * disagrees with itself on a mixed list.
 *
 * @param candidates - Any candidate list, damaging or not.
 * @returns A new list, same length, same members.
 */
export function orderDamagingCandidates<T extends RankableByDamage>(candidates: readonly T[]): T[] {
  const positions: number[] = [];
  const damaging: { item: T; risk: DamageRisk; at: number }[] = [];

  candidates.forEach((item, at) => {
    if (item.damageRisk === undefined) return;
    positions.push(at);
    damaging.push({ item, risk: item.damageRisk, at });
  });

  if (damaging.length < 2) return [...candidates];

  damaging.sort((a, b) => compareDamageRisk(a.risk, b.risk) || a.at - b.at);

  const ordered = [...candidates];
  positions.forEach((position, index) => {
    const entry = damaging[index];
    if (entry !== undefined) ordered[position] = entry.item;
  });
  return ordered;
}

/**
 * The three-key comparison itself, exposed so it can be tested on its own.
 *
 * @returns Negative when `a` should be offered first, as `Array.sort` expects.
 */
export function compareDamageRisk(a: DamageRisk, b: DamageRisk): number {
  const byBand = bandRank(damageRiskBand(a.pressure)) - bandRank(damageRiskBand(b.pressure));
  if (byBand !== 0) return byBand;

  const byBasis = DAMAGE_RISK_BASES.indexOf(a.basis) - DAMAGE_RISK_BASES.indexOf(b.basis);
  if (byBasis !== 0) return byBasis;

  // Different units are not a tie that can be broken, they are a comparison
  // that cannot be made. Returning 0 keeps the arrival order rather than
  // inventing a conversion between damage dealt and experience earned.
  if (a.rateUnit !== b.rateUnit) return 0;
  return b.ratePerHour - a.ratePerHour;
}

/**
 * The risk as a label fragment.
 *
 * Written once here rather than at each producer so a fight and a Thieving NPC
 * describe their danger in the same words — the planner reads both lists in one
 * response, and two phrasings of one idea read as two ideas.
 */
export function describeDamageRisk(risk: DamageRisk): string {
  const band = damageRiskBand(risk.pressure);
  const certainty = risk.basis === 'measured' ? '' : ', screened on levels only';
  return ` — ${band} risk${certainty}: ${risk.why}`;
}

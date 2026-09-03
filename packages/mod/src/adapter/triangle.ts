/**
 * The combat triangle, which nothing in this agent has ever consulted.
 *
 * The character fights with Magic and has died 57 times. Of the thirty-two
 * fights currently on its candidate list, six are against ranged monsters —
 * exactly the matchup the standard triangle punishes a caster for — and the
 * label on those six is indistinguishable from the label on the twenty-three
 * melee ones the triangle rewards. The planner has been choosing by combat
 * level and kill rate, both of which are computed *before* the triangle is
 * applied, so the number it reads is not the number the fight will produce.
 *
 * This module reads the multipliers and says which way they point. It changes
 * no behaviour: it does not rank, refuse, or retarget. That is deliberate —
 * target ranking and the survivability gate are being worked on elsewhere, and
 * an information-only change cannot collide with a decision.
 *
 * ## What the game actually states
 *
 * The typings declare the shape and none of the values. `CombatTriangle` is
 * `{ damageModifier, reductionModifier }`, each an
 * `AttackTypeObject<AttackTypeObject<number>>` (combatTriangle.d.ts:6-13), and
 * the numbers live in a static, `CombatTriangleSet.normalSetData`
 * (combatTriangle.d.ts:30), whose contents no `.d.ts` records.
 *
 * The *orientation* is not stated either, and it is the one thing that must be
 * right: `damageModifier[a][b]` could plausibly mean either direction, and
 * getting it backwards produces advice that is exactly wrong on every fight.
 * The shipped v1.3.1 source settles it. From the nw.js HTTP cache
 * (`learnings/mod-api.md` has the brotli recipe), `Character.applyTriangleToDamage`:
 *
 *     damage *= this.manager.combatTriangle.damageModifier[this.attackType][target.attackType];
 *
 * and, in the resistance path:
 *
 *     resistance *= this.manager.combatTriangle.reductionModifier[this.attackType][this.target.attackType];
 *
 * So the first index is the *attacker's own* type and the second is its
 * target's, for both tables. A player fighting a melee monster reads
 * `[playerType]['melee']`.
 *
 * The values are still not hardcoded here, for two reasons that are separate
 * and both sufficient. The gamemode picks which of three tables applies
 * (`Standard` / `Hardcore` / `InvertedHardcore`, combatTriangle.d.ts:1,25-27,
 * selected by `Gamemode.combatTriangleType`, gamemode.d.ts:100) and the
 * `InvertedHardcore` table reverses the whole triangle. And an *area* may
 * override the set entirely: the shipped data ships a `Reversed` set, and
 * `CombatArea.combatTriangleSet` (combatAreas.d.ts:343) is what
 * `CombatManager.combatTriangle` prefers over `game.normalCombatTriangleSet`
 * (game.d.ts:20). A constant in this file would be wrong in an inverted
 * gamemode and wrong again in a reversed area, and wrong silently in both.
 *
 * The multipliers are therefore read live and *printed* in the label. A number
 * on the report is a number an operator can check against the game's own
 * combat triangle screen; a number in a comment is a claim nobody can falsify.
 */

import { recordFallback, safeValue } from './safe.js';

/** The three types a *player* can attack with. `AttackType`, character.d.ts:621. */
export type PlayerAttackType = 'melee' | 'ranged' | 'magic';

/**
 * What a *monster* attacks with.
 *
 * `Monster.attackType` is `AttackType | 'random'` (monsters.d.ts:106), and
 * `'random'` is not a fourth column in the triangle — the tables are keyed by
 * the three real types (combatTriangle.d.ts:10-13). Five monsters in the
 * shipped data are `'random'`, three of which are currently on this
 * character's candidate list, so this is a live case rather than a defensive
 * one. It is reported as unknowable rather than guessed at.
 */
export type TargetAttackType = PlayerAttackType | 'random';

const PLAYER_ATTACK_TYPES: readonly PlayerAttackType[] = ['melee', 'ranged', 'magic'];

/** The minimum a triangle must supply. Structurally `CombatTriangle`, combatTriangle.d.ts:6-9. */
export interface TriangleLike {
  damageModifier: Record<string, Record<string, number>>;
  reductionModifier: Record<string, Record<string, number>>;
}

/** One side of one fight, priced by the triangle. */
export interface TriangleMatchup {
  playerType: PlayerAttackType;
  targetType: TargetAttackType;
  /** `damageModifier[player][target]`: multiplies the damage the player deals. */
  damageDealt: number;
  /** `reductionModifier[player][target]`: multiplies the player's damage reduction. */
  reduction: number;
  /**
   * The attack type this same table rewards most against this target.
   *
   * Read out of the live table rather than reasoned about, so it stays correct
   * in an inverted gamemode and in an area that overrides the set. It is
   * advice about a weapon, not a promise the character can hold one — see
   * {@link describeMatchup}, which never proposes a switch.
   */
  bestPlayerType: PlayerAttackType;
  /** False when the area supplies its own table. Worth saying: the usual rules are off. */
  standardTriangle: boolean;
}

/** A multiplier far enough from 1 to be worth a sentence. */
const NEUTRAL_TOLERANCE = 0.001;

function isNeutral(value: number): boolean {
  return Math.abs(value - 1) < NEUTRAL_TOLERANCE;
}

/**
 * Looks one cell up in each table, defending against a malformed row.
 *
 * The typings promise a total `AttackTypeObject` (combatTriangle.d.ts:10-13),
 * so a missing key is a data shape this code should not see. It returns
 * `undefined` rather than defaulting to 1 because a silent 1 is
 * indistinguishable from a genuinely neutral matchup, and the whole point of
 * this module is that a caster fighting an archer should not read as neutral.
 */
function cell(
  table: Record<string, Record<string, number>> | undefined,
  attacker: string,
  target: string,
): number | undefined {
  const row = table?.[attacker];
  const value = row?.[target];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Prices one matchup out of a triangle table.
 *
 * Pure, and separated from the reader below so the orientation established
 * from the shipped source can be pinned by a test that does not need a game.
 *
 * @returns The matchup, or null when the target's type is unknowable or the
 *   table cannot answer.
 */
export function matchupFrom(
  triangle: TriangleLike | undefined,
  playerType: PlayerAttackType,
  targetType: TargetAttackType,
  standardTriangle: boolean,
): TriangleMatchup | null {
  if (triangle === undefined) return null;
  if (targetType === 'random') return null;

  const damageDealt = cell(triangle.damageModifier, playerType, targetType);
  const reduction = cell(triangle.reductionModifier, playerType, targetType);
  if (damageDealt === undefined || reduction === undefined) return null;

  // Ranked on the product of the two, because the triangle is not symmetric:
  // the shipped data pairs a 0.85 damage penalty with a 0.85 reduction penalty
  // on one matchup and a 1.1 with a 1.25 on another, so a style can be favoured
  // on one table and neutral on the other. One number that combines "kills
  // faster" and "is hit softer" is the honest summary of "which weapon do I
  // want here", and it needs no assumption about the triangle's shape.
  let bestPlayerType = playerType;
  let bestScore = damageDealt * reduction;
  for (const candidate of PLAYER_ATTACK_TYPES) {
    const damage = cell(triangle.damageModifier, candidate, targetType);
    const resist = cell(triangle.reductionModifier, candidate, targetType);
    if (damage === undefined || resist === undefined) continue;
    if (damage * resist > bestScore + NEUTRAL_TOLERANCE) {
      bestScore = damage * resist;
      bestPlayerType = candidate;
    }
  }

  return { playerType, targetType, damageDealt, reduction, bestPlayerType, standardTriangle };
}

/**
 * The clause a fight candidate carries, or '' when the triangle has nothing to say.
 *
 * Empty on a neutral matchup deliberately. Every fight candidate would
 * otherwise gain a sentence, and a note on every line is the same as no note —
 * the exact failure the drops annotation was written to avoid. A mirror
 * matchup (magic against magic) is neutral by construction and is precisely
 * the case where the planner should read nothing and move on.
 *
 * The multipliers are printed rather than summarised into a verdict alone,
 * because this repo has twice found a computed number spent on a sentence and
 * then unavailable to anything that had to decide. A planner that can see 0.85
 * can weigh it against a kill rate; one told only "unfavourable" cannot.
 */
export function describeMatchup(matchup: TriangleMatchup | null): string {
  if (matchup === null) return '';

  const { playerType, targetType, damageDealt, reduction, bestPlayerType } = matchup;
  if (isNeutral(damageDealt) && isNeutral(reduction)) return '';

  const set = matchup.standardTriangle
    ? ''
    : ' (this area overrides the usual combat triangle, so the normal rules do not apply here)';

  const favourable = damageDealt * reduction > 1;
  const verdict = favourable ? 'favourable' : 'UNFAVOURABLE';

  // Named only when it is not what the character is already using. "Consider
  // melee" against a target melee is already best at is noise, and worse, it
  // reads as a criticism of a correct choice.
  const better =
    bestPlayerType === playerType
      ? ''
      : `; ${bestPlayerType} would be the favoured style against it`;

  return (
    ` — combat triangle ${verdict}: your ${playerType} against its ${targetType}` +
    ` deals x${damageDealt.toFixed(2)} damage and multiplies your damage reduction by` +
    ` x${reduction.toFixed(2)}${better}${set}`
  );
}

/**
 * The triangle that will apply in a given area, read live.
 *
 * Mirrors `CombatManager.combatTriangle` (combatManager.d.ts:100) rather than
 * calling it, and that difference is the reason this exists. The getter reads
 * `this.selectedArea` — the area the player is *currently in* — so outside
 * combat it always answers with the default set, which is exactly when
 * candidates are enumerated. Asking it about a prospective fight in a
 * triangle-overriding area would return the wrong table with no error.
 *
 * `CombatArea.combatTriangleSet` is declared non-optional (combatAreas.d.ts:343)
 * and the shipped getter still guards it with a `??` fallback to
 * `game.normalCombatTriangleSet`, so the guard here is the game's own, not a
 * defensive guess.
 */
export function readAreaTriangle(areaId: string | undefined): {
  triangle: TriangleLike | undefined;
  standard: boolean;
} {
  const type = safeValue(
    'triangle.combatTriangleType',
    () => game.currentGamemode.combatTriangleType,
  );
  if (type === undefined) return { triangle: undefined, standard: true };

  const area =
    areaId === undefined
      ? undefined
      : safeValue(
          'triangle.area',
          () =>
            game.combatAreas.getObjectByID(areaId) ??
            game.slayerAreas.getObjectByID(areaId) ??
            game.dungeons.getObjectByID(areaId),
        );

  const set = safeValue(
    'triangle.combatTriangleSet',
    () => area?.combatTriangleSet ?? game.normalCombatTriangleSet,
  );
  if (set === undefined) return { triangle: undefined, standard: true };

  const triangle = safeValue('triangle.table', () => set[type] as TriangleLike | undefined);
  if (triangle === undefined) {
    // A gamemode naming a table its set does not carry is the one failure this
    // module cannot work around, and it would otherwise show up as every fight
    // silently losing its clause.
    recordFallback('triangle.table', `combat triangle set has no ${type} table`);
    return { triangle: undefined, standard: true };
  }

  // `usesStandardCombatTriangle` (combatAreas.d.ts:337) is the game's own
  // answer, preferred over comparing the set against the default by identity.
  const standard =
    area === undefined
      ? true
      : (safeValue('triangle.usesStandardCombatTriangle', () => area.usesStandardCombatTriangle) ??
        true);

  return { triangle, standard };
}

/**
 * How the triangle prices a fight against one monster, in one area.
 *
 * @param monsterId - The monster being considered.
 * @param areaId - Where it will be fought; undefined for a dungeon, whose
 *   entry is by id alone and whose area is itself.
 * @returns The matchup, or null when the player's or the monster's attack type
 *   cannot be read, or the monster attacks with a random type.
 */
export function readTriangleMatchup(
  monsterId: string,
  areaId: string | undefined,
): TriangleMatchup | null {
  const playerType = safeValue('triangle.playerAttackType', () => game.combat.player.attackType);
  if (playerType !== 'melee' && playerType !== 'ranged' && playerType !== 'magic') return null;

  const targetType = safeValue(
    'triangle.monsterAttackType',
    () => game.monsters.getObjectByID(monsterId)?.attackType,
  );
  if (targetType === undefined) return null;
  if (targetType !== 'melee' && targetType !== 'ranged' && targetType !== 'magic') {
    // 'random' — the game's own value (monsters.d.ts:106), not a read failure,
    // so nothing is recorded. Saying nothing is correct: there is no cell to
    // look up, and inventing one would be worse than silence.
    return null;
  }

  const { triangle, standard } = readAreaTriangle(areaId);
  return matchupFrom(triangle, playerType, targetType, standard);
}

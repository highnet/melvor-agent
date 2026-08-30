# Game state learnings

## Game action return types are inconsistent — never infer success from the return value

Verified in the v1.3.1 typings:

| Call | Returns |
|---|---|
| `Player.equipItem(item, set, slot?, qty?)` | `boolean` |
| `Player.unequipItem(set, slot)` | `boolean` |
| `Player.equipFood(item, qty)` | `boolean \| undefined` |
| `Player.unequipFood()` | `void` |
| `Bank.addItem(item, qty, logLost, found, ignoreSpace?, notify?, src?)` | `boolean` |
| `Bank.removeItemQuantity(item, qty, removeCharges)` | **`void`** |
| `Skill.start()` | `boolean` |
| `Skill.stop()` | `boolean` |

`equipFood` returning `boolean | undefined` makes a truthiness check wrong; `removeItemQuantity`
returning `void` makes one impossible. Observing a before/after state diff is the only contract
that holds across all of them — hence `ActionResult<T>`.

Do still capture the raw return where one exists: an explicit `false` from `equipItem`
separates `"precondition"` from `"no_state_change"` at zero cost.

## A `Monster` has no `maxHit` — only an instantiated `Enemy` does

`maxHit` is on `Character`, and `Enemy extends Character`. A `Monster` in `game.monsters` is
data: no damage type resolution, no combat triangle, no modifiers applied. So the combat
gate's "worst monster in this dungeon" cannot be read out of the registry — it has to be
computed by instantiating the monster the way the combat engine would.

Relevant stat keys:
`CharacterStatKey = 'minHit' | 'maxHit' | 'accuracy' | 'maxHitpoints' | 'attackInterval' | 'maxBarrier'`.
`Character.modifyMaxHit(maxHit: number): number` applies reduction/modifiers.

## MICSR does not reimplement damage formulas — it subclasses the engine

`SimGame extends Game`, `SimPlayer extends Player`, `SimEnemy extends Enemy`,
`SimManager extends CombatManager`, and `Simulator.ts` drives ticks against them. Porting
formulas is the wrong instinct; subclassing keeps the math correct across game updates for
free.

`SimPlayer` derives auto-eat healing from the live getters, not constants — matching the rule
that these must never be hardcoded:

- `Player.autoEatThreshold` / `autoEatHPLimit` / `autoEatEfficiency` (`player.d.ts:76,78,80`)
- all three are getters over `modifierTable` (`modifierTable.d.ts:313-315`), so shop upgrades,
  gear and expansion effects are already folded in.

`SimGame` reads the Auto Eat shop tiers out of `shop.purchases` rather than hardcoding IDs.

## Abyssal content is separable by registry, not by name

`game.abyssDepths`, `game.strongholds`, `game.currentRealm`, `game.unlockedRealms`
(`realms.d.ts`) and `corruption.d.ts` are distinct. Refuse Into the Abyss content by realm or
registry membership — never by string-matching names.

## `gameVersion` is a global — use it as the dump version stamp

```ts
declare const gameVersion = "v1.3.1";   // gameTypes/account.d.ts:1
```

Stamp every knowledge dump with it and compare on boot. Note the typings project's own
`package.json` version (`1.13.0`) is unrelated and stale — do not use it for anything.

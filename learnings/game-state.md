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

## `isActive` is on `ActiveAction`, not on `Skill`

`skill.isActive` does not typecheck against `AnySkill` (= `Skill<any>`). The
property belongs to the `ActiveAction` interface, which only skills that can be
run directly implement. Combat is the notable case where the active action is the
`CombatManager`, not the Attack skill.

```ts
function readSkillActive(skill: AnySkill): boolean {
  const candidate = skill as AnySkill & Partial<Pick<ActiveAction, 'isActive'>>;
  return candidate.isActive ?? false;
}
```

The vendored typings caught this at compile time — worth remembering that they are
strict enough to be a real check on assumptions, not just autocomplete.

## There are two `GP` ids and only one is the currency

- `CurrencyIDs.GP = "melvorD:GP"` — the actual currency, in `game.currencies`.
- `TownshipResourceIDs.GP = "melvorF:GP"` — a Township resource, unrelated.

Grepping `idEnums.d.ts` for `GP` returns both. Always check which `const enum`
block a value came from before using it; the file is 480KB of similar-looking
names and several ids repeat across unrelated enums.

## `Woodcutting.selectTree` is a toggle that returns `void`

Two hazards in one call:

- It returns `void`, so there is nothing to check.
- It *toggles*. Calling it on an already-selected tree deselects it, so a naive
  retry loop undoes its own work.

The only correct pattern is to test membership first and then observe:

```ts
if (game.woodcutting.activeTrees.has(tree)) return;  // already selected
game.woodcutting.selectTree(tree);
// verify: tree.id is now in [...game.woodcutting.activeTrees].map(t => t.id)
```

Verified: `woodcutting.d.ts:57,77`. `isTreeUnlocked(tree)` and `treeCutLimit` are
the two preconditions worth checking before selecting.

## `Monster.combatLevel` exists; `Monster.maxHit` does not

`game.monsters` entries carry `combatLevel`, `name`, `levels` — but max hit is
computed on `Character`, and `Enemy extends Character`. Do not add a `maxHit`
field to any monster dump: a plausible-looking approximation there would poison
the combat gate silently.

`game.dungeons` entries do carry `monsters: Monster[]` (from `CombatArea`) and
`realm: Realm` (from `RealmedObject`), so "the monsters in this dungeon" and
"which realm is this" are both cheap and reliable.

## Use `game.generateSaveString()` for auto-export, not `exportSave()`

The global `exportSave(update?: boolean): Promise<void>` drives the export
*modal* — useless to an unattended agent. `game.generateSaveString(): string`
returns the save directly, which can be posted to a local service that writes it
to disk. The mod itself is sandboxed and cannot write files.

## Damage reduction is deprecated — v1.3 uses per-damage-type resistances

`EquipmentStats.damageReduction` is marked `@deprecated Use resistances instead`.
The live API is `Character.stats.getResistance(damageType)` /
`getResistanceByID(id)`, backed by `resistances: SparseNumericMap<DamageType>`.

This matters for the combat gate: the applicable reduction depends on what the
*specific enemy* hits with, so the enemy's `damageType` has to be read off the
probe and fed to the player's resistance lookup. A single flat number would be
wrong against anything unusual.

## Getting a monster's max hit requires instantiating an Enemy

```ts
const probe = new Enemy(game.combat, game);   // constructor(manager, game)
probe.setNewMonster(monster);
probe.setStatsFromMonster(monster);
probe.computeCombatStats();
probe.stats.maxHit;        // now populated
probe.damageType;          // which resistance applies
```

**Unconfirmed in-game:** whether constructing an `Enemy` bound to the live
manager has side effects the typings do not describe. The combat gate defaults to
advisory mode partly for this reason — watch it before trusting it.

## Shop `buyItemOnClick` takes a `confirmed` flag

`buyItemOnClick(purchase, confirmed?)`. Without `confirmed = true` it raises a
confirmation modal, which nothing answers in an unattended session. Returns
`void`, so verify via `getPurchaseCount(purchase)` rising.

Useful companions, all of which avoid reimplementing cost scaling:
`getPurchaseCosts(purchase, qty).checkIfOwned()`, `isPurchaseAtBuyLimit`,
`capPurchaseQuantity`, and `game.checkRequirements(reqs, false)` — pass `false`
to suppress failure toasts, or an agent probing requirements floods the screen.

## `ArtisanSkill` is a real shared base — six skills, one routine

Smithing, Crafting, Fletching, Herblore, Runecrafting and Summoning all extend
`ArtisanSkill`, which defines `selectRecipeOnClick`, `selectedRecipe`,
`createButtonOnClick` and `getRecipeCosts`. Cooking, Firemaking and Alt Magic
extend `CraftingSkill` directly and do *not* share those.

`getRecipeCosts(recipe).checkIfOwned()` is the precondition worth having: without
it the agent presses Create against an empty bank indefinitely.

## Several skill properties on `Game` are optional

`cartography?`, `archaeology?`, `harvesting?`, `corruption?` are all optional in
the typings — expansion content. Any accessor that casts without checking turns a
missing skill into a `TypeError` from deep inside a routine instead of a clean
refusal. Resolve first, null-check, then use.

## `getRecipeCosts` is ArtisanSkill-only — the optional call silently offers everything

Affordability has no single API, and the natural-looking check is wrong:

```ts
if (skill.getRecipeCosts?.(recipe).checkIfOwned() === false) continue;  // BROKEN
```

`getRecipeCosts(recipe)` exists on `ArtisanSkill` (Smithing, Crafting, Fletching,
Herblore, Runecrafting, Summoning, Cooking). `CraftingSkill` — Firemaking, Alt
Magic — has only `getCurrentRecipeCosts()`, for the *selected* recipe, which is
useless while enumerating. The optional call yields `undefined`, `undefined === false`
is `false`, and **nothing is filtered**.

Live symptom: the agent was offered "Firemaking: Oak Logs" with zero Oak Logs
banked, accepted it, and then refused its own action once per tick for ten
minutes. The filter failing open looks exactly like the filter not existing.

Three shapes cover it:

| Skill family | Input source |
|---|---|
| `ArtisanSkill` | `getRecipeCosts(recipe).checkIfOwned()` |
| Firemaking | `recipe.log` — one item, named on the recipe |
| any `ArtisanSkillRecipe` | `recipe.itemCosts: AnyItemQuantity[]` |

A recipe matching none of these consumes nothing (Woodcutting, Thieving) and is
allowed through — refusing the unknown would silently delete whole skills.

## Equipping is a quantity, not a boolean — ammunition needs the whole stack

`player.equipItem(item, set, slot, quantity)` takes a quantity, and passing `1`
is right for a platebody and catastrophic for arrows. The agent equipped one
Bronze Arrow out of 1,259, fired it, and fought on with an empty quiver.

`EquipmentSlot.allowQuantity` is the game's own answer to "does this slot hold a
stack" — ask it rather than inferring from the item:

```ts
const quantity = slot.allowQuantity ? Math.max(1, game.bank.getQty(item)) : 1;
```

The slot projection records *which* item is worn, not how many, so a quantity
bug is invisible in before/after evidence. The only symptom was the bank count
dropping by exactly one.

## Gear stats are per attack style — summing them all misjudges every piece

`item.equipmentStats` is a flat `{key, value}[]`, and summing it scores a Steel
Platebody as an upgrade for an archer: its large melee-defence numbers drown out
a `rangedAttackBonus` of −12. Equipped as "free survivability", it made the
character unable to land a shot — full health, no kills, twenty minutes.

Melee attack is three keys, not one:

| Style | Keys |
|---|---|
| ranged | `rangedAttackBonus` |
| magic | `magicAttackBonus` |
| melee | `stabAttackBonus` + `slashAttackBonus` + `blockAttackBonus` |

A negative bonus for the style in use is disqualifying, not a trade-off against
defence: no amount of armour compensates for never hitting anything.

## Being able to attack is state, and nothing reports it

`combat.engage` succeeding proves the game committed to the fight, not that a
punch can land — the enemy spawns a tick later, so requiring `isActive` reports
every successful engage as a no-op. A fight that can *never* start therefore
looks exactly like one about to start: "Doing: Combat", full health, nothing
moving, indefinitely.

Two ways in, both hit in one session:

- **Ranged**: the Quiver slot (`melvorD:Quiver`) empty.
- **Magic**: no spell selected — *or* a spell selected whose runes are not in
  the bank. Checking only `player.spellSelection.attack !== undefined` misses
  the second and is the more common failure. Wind Strike was selected the whole
  time; its Mind Runes had been sold as spare change.

Check both in the engage precondition. Equipping a staff is half of arming a
mage; the other half has no slot and no inventory entry.

## `canStop` is a moment, not a verdict

`skill.canStop` is false while a skill is mid-action, and while Thieving is
stunned from a failed pickpocket — seconds either way. Returning that as a
precondition makes the policy tier abandon whatever was queued behind it.

It cost a whole objective and three wrong diagnoses: a plan of food → Magic →
Thieving hit one stun while Thieving held the action slot, and the Magic step
was moved to the back of the plan and never came round again. From outside it
read as combat failing on its own merits.

Return `{ wait: ... }`, not a string.

## Summoning secondaries are priced by value — "held" is not "enough"

A tablet takes shards plus *one of several* secondaries, and the game prices
each by its value: a cheap log is needed in far greater quantity than an
expensive one. Picking the first option with `getQty(item) > 0` points the
recipe at something there is nowhere near enough of.

```ts
skill.getAltRecipeCosts(recipe, item).checkIfOwned()   // ask the game
```

Only visible with a mixed bank: one Normal Log and fifteen Mahogany produced
"missing materials" while holding 57 shards and plenty of usable wood.

## An empty candidate list is not self-explanatory

Three times in one session an empty list meant three different things, and none
of them said which:

- No spell candidates meant **everything was already correct** — at Magic 1 the
  only castable spell is Wind Strike, and the reader skips the selected one.
- No Slayer candidates meant **a bug in a different subsystem**: the food reflex
  was reading a stale bank, food kept coming unequipped, and `readSlayerCandidates`
  returns `[]` with no food — silently removing a whole skill from the board.
- 348 plant-reflex warnings meant **already fixed hours ago**, which timestamps
  showed and the count did not.

When a reader can return nothing for unrelated reasons, publish the reason.
Check timestamps before "fixing" anything a log complains about.

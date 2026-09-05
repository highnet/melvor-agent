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

## `skill.rareDrops` is the global rare table, not the skill's drops

Dumping `rareDrops` to answer "which skill drops Bird Nests" produced sixty
rows and not one nest. The field holds the *universal* rares that every skill
rolls — Gold Topaz Ring, Jewel/Circlet of Rhaelyx, Mysterious Stone, the
skill's Lesser Relic — plus the odd one-off. It is not "what this skill
produces".

Bird Nests are not in game data as a drop at all. The only trace in the
typings is a modifier:

```
enums.d.ts  increasedBirdNestDropRate
enums.d.ts  increasedMinimumBirdNestsWhenPotionActive
```

A modifier named for a thing implies a base rate, and the base rate lives in
game logic rather than in any registry. So the question is not answerable from
a dump, and adding a section to try was the wrong instrument — a modifier's
existence plus an observed drop while woodcutting is the whole of the available
evidence.

Worth knowing before repeating the attempt. Two sections were added today for
questions like this: `summoningRecipes` answered its question completely
(nonShardItemCosts is real data), `skillRareDrops` did not answer its one at
all.

Note also `Bird_Nest_Potion_I..IV` — Herblore boosts nest drops, which closes a
loop worth remembering: Farming needs seeds, seeds come from nests, nests are
boosted by a Herblore potion, and Herblore is gated on Farming.

## A dump section can exist, load, and answer the wrong question

Three failures in one evening, all in the knowledge dump, all invisible:

1. **`.default()` stopped regeneration.** A stored dump is refreshed when it
   fails validation. A field with a default never fails, so monster loot was
   added and never collected — 377 monsters, every table empty. The two
   sections added the same day *without* defaults appeared immediately.

2. **`skillRareDrops` answered a different question.** Added specifically to
   find which skill drops Bird Nests; it holds the universal rares every skill
   rolls. Sixty rows, not one nest. Nests are not in the data at all — the only
   trace is an `increasedBirdNestDropRate` modifier, so the rate lives in game
   logic and no dump could have answered it.

3. **`lootChance` is not a drop rate.** It is the chance the table rolls at
   all; which item emerges is `weight / totalWeight`. Reading them as one
   produced "Golbin drops Garum Seeds at 100% loot chance" — two true facts
   welded into a false one — and a night's plan was rewritten on it before the
   weights were even captured.

The shape is the same each time: the section was present, loaded cleanly, and
looked authoritative. Nothing errored. An empty list read as "nothing matches"
rather than "never collected", and a percentage read as a rate because it was
shaped like one.

What to do instead:

- After adding a section, **read the data back** and count non-empty entries.
  A commit is not a result.
- Prefer a schema that **refuses** over one that fills in. A dump that will not
  load regenerates; a dump that loads with holes lies.
- Before quoting a number, ask what it is the numerator and denominator *of*.
  `lootChance` passed that test and `100%` did not.

## `autoReuseActions` is a blocklist wearing an allowlist's name

`PotionManager.autoReuseActions: Set<Action>` is documented, in the game's own
typings, as *"Actions for which potions should **not** be automatically
re-used"* (potionManager.d.ts:11). The name says the opposite of the comment,
and the comment is the part that was written on purpose.

So the set is never read here. `autoReusePotionsForAction(action)`
(potionManager.d.ts:19) is the single reading, and `setPotionAutoReuse` asserts
that accessor's own value either side of `toggleAutoReusePotion` (:26).

The general move is worth more than the fact. When a field's name and its
documentation disagree, do not pick a winner — **express the action in terms of
the accessor you can observe**, so the polarity stops being load-bearing. Read
it wrong here and the cost is one reversible toggle that then reads as done;
read a set membership wrong and the cost is a silent inversion nobody notices.

## A skill can be unreachable with every piece of it present

Prayer had a bury capability, a bury candidate, a toggle capability, a prayer
candidate, and a reflex. Prayer 20 was still impossible.

Burying grants points and no XP; the XP comes only from *spending* points during
combat; spending needs a prayer switched on. The two candidates were the kind
nobody ever picks, and the one reflex — `dropUnpayablePrayers` — exclusively
turns prayers *off*, and was not even wired into the tick chain.

Nothing was broken. Every part worked and the chain between them was never
joined, which no per-part test can catch. Before believing a skill is covered,
trace the loop end to end and name the step that actually produces the XP —
here it was the fifth link, and four working links looked like coverage.
## Two numbers named alike are not on one scale

The pre-fight combat screen required `Monster.combatLevel <= floor(Game.playerCombatLevel / 2)`.
Neither getter's formula appears anywhere in `vendor/melvor-typings` — `monsters.d.ts:102` and
`game.d.ts:221` are bare `get ...(): number` — and the observed ranges do not overlap.
`data/dump.json` holds 377 monsters from combat level 1 to 3,501,091, median 465; a
character with 99 in every combat skill is around 126. The rule therefore excluded about
84% of all monsters from a maxed character, and every dungeon from every possible one:
"Into the Abyss" (hardest monster 626) needed player combat level 1,252.

It ran for weeks looking like a safety feature. Nothing errored; it simply refused, with a
plausible sentence attached, and the stated goal "clear a dungeon" was unreachable by
construction while combat training was banked toward it.

What the typings *do* state is the comparison worth making. `Monster.levels` is
`Omit<CombatLevels, 'Prayer'>` (`monsters.d.ts:103`) and `Character.levels` is `CombatLevels`
(`character.d.ts:101`) — one record type, so those six skill levels mean the same thing on
both sides. Same for equipment: `Monster.equipmentStats` (`monsters.d.ts:104`) is a list of
`{key, value}` pairs over the same `EquipStatKey` union the player's `EquipmentStats` object
is indexed by (`character.d.ts:445-457`).

The general test, before a threshold compares two quantities: **can you state the unit of
each?** If the answer is "they are both called a level", the comparison is a coincidence of
naming. And check the extremes of a threshold against real data — one line of arithmetic
over the dump would have shown this one admitting nothing.

## A getter that takes its subject as an argument can still read the selection

`Mining.getRockGemChance(ore: MiningRock): number` (`rockTicking.d.ts:157`) takes the rock
as an argument and yet throws *"Tried to get active rock data, but none is selected."* — the
message of `get activeRock()` (`:133`). The signature discloses a dependency on the argument
and hides one on the selection, so the call looks safe to make during enumeration and is not.
It had never once succeeded: every gem-bearing rock the agent has ever ranked was priced at
its ore alone. The tell in the report was arithmetic — `candidates.share1 x1104` is exactly
138 enumeration passes times the 8 rocks carrying `giveGems`, i.e. every call, every pass.

There is no second source. `MiningRock` declares `superiorGemChance` (`:77`) and
`abyssalGemChance` (`:79`) as data and **no** field for the primary gem chance; `Mining`
declares `baseInterval`, `baseRockHP` and `passiveRegenInterval` as readonly constants
(`:108-110`) and no base gem chance; `modifiers.miningGemChance` (`modifierTable.d.ts:405`)
is by its name a bonus applied to a base this codebase would have to invent.

So the term is reported as **unknown**, not as zero, and the candidate label says so. The
distinction is the whole point: a rock whose value is mostly its gem roll must not read as
identical to one that yields none.

Unsettled, and deliberately left so: whether `getRockSuperiorGemChance` (`:158`) refuses the
same way. `share2` never appeared in the failure report at all, which means it was never
reached — no rock on this character's board reports `giveSuperiorGems` — not that it
answered. `candidates.rockSuperiorGemChance` is what will say which, the first time a
superior rock unlocks.

The general move: **`actionInterval`-style refusal is not the only shape.** Before trusting
an accessor because its signature is action-scoped, check whether the *error text* names a
different object than the argument does. And when a term genuinely cannot be read, say
"unknown" in the label rather than letting a 0 stand in — a fallback indistinguishable from a
real value is the failure `safe.ts` exists to prevent.

## A fallback's absence is not a failure when nothing was going to use it

`adapterFailures` carried five standing entries, four of which described skills that were
pricing every recipe correctly. The candidate path resolved a *skill-wide* interval first and
recorded its exhaustion, then handed it to the per-recipe getter as a fallback. But Cooking
and Agility have no skill-wide interval to give — `actionInterval` (`cooking.d.ts:71`,
`agility.d.ts:194`) reads the selection and throws, and `baseInterval` lives on the recipe
(`cooking.d.ts:15`, `agility.d.ts:77`) — while `getRecipeCookingInterval` (`:100`) and
`getObstacleInterval` (`:223`) answer for every recipe. Two working skills filed a failure
apiece on every pass.

The same inversion hid a real bug. `readBlockedOpportunities` asked only for a skill-wide
interval, so Woodcutting and Fishing — which have none, and whose real intervals come from
`getTreeInterval` (`woodcutting.d.ts:76`) and `getMinFishInterval`/`getMaxFishInterval`
(`fishing.d.ts:128,:130`) — priced every blocked entry at a nominal 3s. The blocked list is
*sorted* by XP/hr, so a flat interval sorted it by base XP alone: the same inversion that had
Firemaking preferring its slowest logs.

**Resolve narrowest-source-first, and record only the last resort.** A chain that reports the
exhaustion of its *fallback* is reporting on a question nobody asked, and it does so once per
pass forever — which is how a real regression arrives as a sixth line under a thousand lines
of noise.

## One comparison cannot serve two economics

`chooseSelection` picked the item an Alt Magic spell destroys by the highest `getAlchemyGP`,
for every item-consuming spell. That is right for Item Alchemy, whose payout is a ratio of the
consumed item's own value, and backwards for everything else: `Just Learning` produces exactly
one Rune Essence whether it eats an Arrow Shaft that sells for 1 or a Gold Ore that sells for
30. The dump says so in one line — `produces {kind: Item, itemId: melvorD:Rune_Essence} ratio 1`
against Item Alchemy's `kind GP` — and the two cases want *opposite* ends of the same sorted
list. A single `>` served both and always took the dearest.

The tell that generalises: the ranking key and the payout model have to come from the same
place. Here the payout is `getAlchemyGP` for one family and a fixed product for the other, so
no one key could be right for both. When a chooser ranks candidates for an action whose
*yield model* varies by case, the key belongs beside the model, not above it.

The same reading turned up a second thing. **Item Alchemy I pays 0.4x while the shop pays
1.0x** — four runes spent to destroy 60% of an item's value — and the GP genuinely lands, so
the planner books the loss as income. Alchemy only beats selling from tier III (1.6x). The
executor now refuses any alchemy cast that does not clear the item's sale price: alchemy and
the shop consume the item identically, so the alternative to casting is selling, not keeping.

Two things that refusal had to get right:

- **Rank by the margin over selling, not by the gross payout.** Gross is the number the game
  shows, and it is the one that is almost always wrong — the same lesson as pricing a chain by
  its last step.
- **Carry the reason with the refusal.** `startAltMagic` turned every empty answer into
  "nothing eligible is banked", which is false when the bank is full of items the spell accepts
  and the cast is refused for losing money. A refusal the operator cannot interpret gets
  overridden. The *decision* stays where the ranking is — nothing else knows which item would
  be destroyed or what it is worth — but it now returns the reason rather than a `null` the
  caller has to invent a story for.

## A `declare enum` is a global reference, and this repo has now paid for it three times

`AltMagicProductionID` (`altMagic.d.ts:28-37`) is a plain `declare enum`, so
`spell.produces === AltMagicProductionID.Bar` compiles to a bare global lookup at the moment it
runs. `candidates.ts` spelled its two sentinels as `-1`/`-2` for that reason and `registries.ts`
spelled out all eight — while `skills-misc.ts` still used the enum, inside a `try` whose catch
returns "no selection". An unresolved global there refuses *every* item-consuming spell with a
message about the bank.

The test found it: the first run of the new fixture failed eight ways with `the item selection
could not be read`, which is the swallowed `ReferenceError` and nothing else. A convention
followed in two files out of three is not a convention, and the file that skipped it was the
one where the failure is silent. The sentinels are literals here now.
## A getter that answers is not a getter that answered *your* question

Alt Magic produced zero candidates at every level with every rune banked — not available,
not blocked, no `adapterFailures` line, nothing thrown. Meanwhile `set_objective` on
`melvorF:JustLearning` cast fine and took Magic 2 → 10 in six minutes. The capability was
complete; the enumerator simply never emitted it.

The filter was `genericSkillCandidates`' mastery gate:
`isMasteryActionUnlocked(recipe) === false` → `continue`, silently. `AltMagic` overrides that
method (`altMagic.d.ts:109`) together with `hasMastery` (`:102`),
`computeTotalMasteryActions` (`:107`) and `updateTotalUnlockedMasteryActions` (`:108`) —
the full set a skill overrides when it has *no mastery at all* — so its answer for a spell was
never "this spell is locked". It answered, confidently, a question nobody had asked.

Nothing threw, so `safe.ts` had nothing to count. The distinction already drawn here —
"locked" vs "the lock could not be consulted" — has a third case, and it is the one with no
exception attached: **the lock answered, and its answer means something else.**

What settled it was the live report, by elimination rather than by patching suspects:

- Magic was in `game.skills` (the snapshot lists it, with a mastery pool);
- `readLockedActions` walks the same `actions.allObjects` and reported
  "Magic: Bone Offering unlocks at level 18", so 26 spells really were enumerable;
- `adapterFailures` named no site in `candidates.ts`, so nothing threw;
- `canAfford` **cannot** refuse a spell — `AltMagic` declares no `getRecipeCosts` (only
  `ArtisanSkill`, Cooking, Fletching and Summoning do), and an `AltMagicSpell` has no
  `itemCosts`, so it fell through to `return true`.

That leaves exactly one silent `continue`. Ruling a suspect out with a *typings* fact and a
*live* fact is cheaper than fixing it and asking again whether anything changed — which is
what the previous Alt Magic hunt did three times.

Two things came out of it:

- **The gate now asks whether the answer applies.** `hasMastery === false`, or a skill that
  refuses every one of its own recipes (no skill ships with all actions locked), means the
  mastery answer is not a lock — and the level requirement takes over, because for every
  skill in that loop the mastery answer *was* the level check.
- **A skill that empties itself now says so.** `candidates.noCandidates:<skillId>` names the
  tally when the mastery or realm gate removed everything. Not for level or affordability:
  `readLockedActions` and `readUnstockedSkills` already tell the planner those, and a
  permanent line per idle skill is the noise that has twice evicted real diagnostics.

## Alt Magic prices itself in runes, and nothing was reading them

The same pass found the trap waiting on the other side. `canAfford` handles
`getRecipeCosts`, a `log`, or `itemCosts`; an `AltMagicSpell` has none of them. It carries
`runesRequired` (`spells.d.ts:27`), an optional combination-rune list `runesRequiredAlt`
(`:28`) selected by `Player.useCombinationRunes` (`player.d.ts:122`), and `fixedItemCosts`
(`altMagic.d.ts:72`). So every spell read as **free** — the exact condition under which the
last Alt Magic hunt could not tell "withheld for want of a rune" from "withheld by a bug".

Three costs deliberately not priced, each for a stated reason:

- **The staff discount.** Equipping the matching staff lowers a spell's rune cost, to a floor
  of one rune. `EquipmentItem.providedRunes` (`item.d.ts:267`), `Player.runesProvided`
  (`player.d.ts:81`) and `computeRuneProvision` (`:156`) are the machinery, but *how* they
  apply to an Alt Magic cast is **not stated anywhere in the typings**: `Player.getRuneCosts`
  (`:163`) carries no documentation at all, and `AltMagic.getCurrentRecipeRuneCosts`
  (`altMagic.d.ts:151`) prices only the *selected* spell, which is never set during
  enumeration. So the unreduced cost stands. That can withhold a spell a staff would have
  paid for — a missing candidate, the recoverable direction — rather than invent a discount,
  which is how Crystal came to advertise ten times what it paid. Settle it by measurement if
  it matters: equip the staff, read the candidate, cast, and watch the rune count.
- **Rune preservation.** `runePreservationChance` (`altMagic.d.ts:127`) is a chance not to
  consume, so it lowers the *average* cost over many casts. The question is whether one cast
  can be paid for, and a chance cannot pay for it.
- **The item a spell converts.** `specialCost` (`altMagic.d.ts:74`) is a selection, and the
  executor's precondition already refuses when nothing eligible is banked. That refusal is
  visible; the silence was not.

## Alt Magic was eating its own fuel, and the sell guard could not see it

Measured live over 100 seconds of `Just Learning`:

```
Air Rune  -49        Nature Rune  -98        Rune Essence  +49
```

49 casts. One Nature and one Air paid the spell's rune cost, which is correct. The *second*
Nature Rune per cast was the item the spell consumed. A Nature Rune is crafted from a Rune
Essence, so the trade was 2 Nature + 1 Air in for 1 essence out - a strict loss, paid in the
one rune that **every castable Alt Magic spell requires** (dump: 24 of 26 spells list
`melvorF:Nature_Rune`, including every Superheat below level 95).

The guard that should have caught it, `readSpellRuneIds`, walks `game.attackSpells`. No attack
spell wants a Nature Rune, so the rune passed every guard in `saleExclusionReason` and
`chooseSelection` took it as the cheapest item on offer. The hole is **independent of ranking
direction**: the previous dearest-first rule would have burned a Topaz or an Adamantite Bar
instead. Either ranking is wrong while the guard has the hole, so the fix is the guard.

Three things came out of it.

**"Reachable" is a band, not "castable now".** `readAltMagicFuelIds` reserves what any spell at
or below `Magic level + 25` consumes per cast, costed through the existing `spellCosts`
(`runesRequired`, `spells.d.ts:27`; `runesRequiredAlt`, `:28`, chosen by
`Player.useCombinationRunes`, `player.d.ts:122`; plus `fixedItemCosts`, `altMagic.d.ts:72`).
Castable-now is too narrow, because the point of casting Just Learning at all is to stockpile
toward Superheat II at Magic 25 - a Nature Rune sold at Magic 10 has to be re-crafted before the
milestone it was being saved for. Everything is too wide: Superheat III (64), Item Alchemy III
(76) and Superheat V (110) between them name every rune in the base game, and honouring those
from Magic 1 locks Air, Earth, Fire, Water, Spirit and Soul for the whole run in exchange for
nothing the character can do. 25 is the smallest band that reaches Superheat II from a fresh
Magic 1, and roughly a session's worth of levels - Just Learning took Magic 2 to 10 in six
minutes.

**Consuming and selling are the same act, with exactly one difference.** They share
`saleExclusionReason`, now taking a `'sell' | 'consume'` purpose, and only one clause differs:
`gpValue(item) <= 0`. A stack the shop will not pay for is pointless to *list* and perfect to
*burn* - and applying that clause to both paths is what made this bug expensive. **Arrow Shafts
sell for 0 GP, not 1** (dump: `melvorF:Arrow_Shafts`, `sellsFor: 0`; GOALS.md has 4,770 of them
as dead weight with no recipe that can use them), so they were filtered out of the offer list
entirely, and the cheapest thing Just Learning could still see was a 1 GP Nature Rune. The live
trace proves it independently: `chooseCheapestItem` breaks ties by taking the first item in id
order, `melvorF:Arrow_Shafts` sorts before `melvorF:Nature_Rune`, so had the shafts been offered
at a tied price they would have won. They were not offered.

**A spell must not be fed its own product.** Opening worthless stacks to consumption re-opens a
loop the value filter had been closing by accident: Just Learning produces a Rune Essence, a
Rune Essence sells for 0, and essence-in/essence-out is a net change of nothing for two runes a
cast that still reads as progress on the XP counter. `produces` is `AltMagicProductionID |
AnyItem` (`altMagic.d.ts:75`); the sentinels are numbers, so an object is the produced item and
its id is excluded from the offer list.

`specialCost` (`altMagic.d.ts:74`) is deliberately *not* reserved by any of this - it is the
selection itself, and reserving it would refuse every cast.

## `modifyPrimaryProductQuantity` is a die roll, not a getter

`Skill.modifyPrimaryProductQuantity(item, quantity, action)` (`skill.d.ts:476`) **rolls the item
doubling internally**. It is not idempotent. Two calls a millisecond apart on identical state
return different numbers, and the typings say nothing about it - the name and the signature both
read as a pure modifier.

Measured, not reasoned. 73 consecutive planner reports polled at 5s while the character mined
Gold and nothing else moved:

| candidate            | low     | high    | high/low | high share |
|----------------------|---------|---------|----------|------------|
| Smithing: Gold Bar   | 212,400 | 468,000 | 2.20     | 37%        |
| Smithing: Silver Bar |  53,550 | 145,350 | 2.71     | 23%        |
| Mining: Gold         |  53,283 | 100,294 | 1.88     | 10%        |
| Mining: Mithril      |  45,720 |  88,787 | 1.94     |  3%        |

Exactly two values each, never one in between, flipping **independently per recipe** from report
to report - while `xp/h` on every one of them (36,000 and 43,876) never moved by a single point.
XP is built from the same interval through a different multiplier that touches no yield, so the
swing is in the yield term and nowhere else.

The arithmetic identifies it as a doubling of the *product* specifically. Gold Bar runs at 1,800
actions/h; a bar sells for 142 and the ore it burns costs 30 less preservation:

```
1800 x (142 - 24) = 212,400     1800 x (2 x 142 - 24) = 468,000
```

Both to the GP. The ratios sit either side of 2 for reasons that confirm rather than muddy it:
an input cost is subtracted *after* the doubling and pushes Smithing above 2, a mining gem roll
is added after it and pushes Mining below. Mining Gold's two values differ by exactly
1,567.03 x 30 GP - one extra ore per action, at the same 1,567.03 actions/h that its 43,876 xp/h
divides into 28.0, the rock's `baseExperience` to three figures.

Three things follow.

**The open question is settled.** Whether `getDoublingChance` (`skill.d.ts:398`) is already
inside `modifyPrimaryProductQuantity` - it is. Multiplying by it again would have double-counted
every gathering rate, so the decision not to was right. Two recipes in the *same* skill doubling
at 37% and 23% is the per-action shape of `getDoublingChance(action)`, which takes the action as
its argument and scales with that action's mastery.

**A 2x swing across unrelated skills is not a global modifier.** The first instinct on seeing
Smithing and Mining move together was to hunt for a shared term that expired - a potion, an
Astrology bonus, a mastery-pool checkpoint. There is none. Two independent coin flips landing
heads together is a 4% event, and 4% events happen. **Poll a suspected drift before theorising
about it**: two readings cannot distinguish a trend from a sample, and 73 can.

**Sampling a random accessor once and calling it a rate is the general bug.** `productYieldFor`
now takes the expectation instead.

The cost of not fixing it was not the numbers. `list_candidates` ranks candidates *across*
skills, so a die roll inside one rate reprices every cross-skill comparison, and the agent
churns between actions for reasons that have nothing to do with the actions.

## A minimum is not an estimate either

The first repair took the **minimum of 8 samples** as the un-doubled quantity and multiplied it
by `getDoublingChance`. It was merged and reverted the same day, and the thing that caught it
was its own test: a fixture rolling `Math.random` at even odds, called 200 times, failed 54% of
runs with `expected [1.5, 3] to deeply equal [1.5]`.

A minimum only recovers the base quantity when at least one sample rolled *un*-doubled.
P(all 8 doubled) = 0.5^8 = 0.39%, so about one recipe in 260 per pass silently reports **twice**
the truth. That is not a bad test, it is the same defect one level down: a minimum does not
jitter, it is exact until the pass where it is wrong by exactly the factor the whole bug was
about - and a clean doubling is indistinguishable from a real discovery, which is precisely what
sent a day of planning after the original swing.

**What identifies the base quantity is not the minimum, it is having seen both faces of the
coin.** So sampling continues until two values appear in a 2:1 ratio, at which point the smaller
is the base with certainty. Three things can end it instead:

- **Every sample agreed.** Base and 2 x base are genuinely indistinguishable from that evidence,
  so the chance decides - below 50% they are the un-doubled face, at or above 50% the doubled
  one. The sample budget is solved from the chance so this is wrong at most one time in a
  million: the unlucky run has probability `min(p, 1-p)^n`, so a 3% chance needs 4 samples
  because four doublings running is already absurd, and a 50% chance needs 20 because nothing
  else separates the faces. A chance of 0 (or 100) is not a coin and costs **one** call.
- **The values are not a doubling.** Three distinct values, or two that are not 2:1, mean the
  model does not describe this accessor. The mean over the full budget is returned - unbiased
  whatever the shape - and `candidates.yieldShape:<skillId>` is recorded.
- **`getDoublingChance` refused.** No chance to divide out, so the mean of 8 stands in, counted
  under `candidates.doublingChance:<skillId>`.

The fallback is always the mean and never the minimum, and that is the whole lesson. A mean
jitters, narrowing as 1/sqrt(N), unbiased at every N. A minimum is exact until it is 100% wrong.
The planner ranks candidates *against each other*, so a few per cent of noise cannot reorder
anything that was not already a tie, while a clean doubling reorders the board.

Measured over 200,000 draws against real `Math.random` rolls at chances of 0, 3, 10, 23, 37, 50,
60, 80, 97 and 100%: **exactly one distinct reading at every chance, zero errors**, at a mean
cost of 1.0 to 4.8 accessor calls per recipe - cheaper than the flat 8 it replaced.

And the test lesson, which is general: **a probabilistic test cannot tell a defect from bad
luck.** Drive the roll from a script the test owns, so red means broken. The scripts are also
the only way to reach the interesting cases on purpose - a run of 32 consecutive doubles is what
the estimator has to survive, and waiting for `Math.random` to produce one is not a test.
## `isMasteryActionUnlocked` *is* the level check, and the tally was crediting it

`candidates.noCandidates` reported, live, at Firemaking 32 / Summoning 11 / Herblore 1 /
Harvesting 1:

```
melvorD:Firemaking   all 33 dropped: 29 mastery-locked, 0 level-locked, 1 realm-locked, 3 unaffordable
melvorD:Summoning    all 53 dropped: 49 mastery-locked, 0 level-locked, 0 realm-locked, 4 unaffordable
melvorD:Herblore     all 72 dropped: 71 mastery-locked, 0 level-locked, 0 realm-locked, 1 unaffordable
melvorItA:Harvesting all  7 dropped:  5 mastery-locked, 0 level-locked, 2 realm-locked, 0 unaffordable
```

`0 level-locked` was structural, not a coincidence. The loop asked the mastery gate first and
reached the level requirement only when `readMasteryGate` returned null -- which happens only for
a skill that has no mastery system at all. Every skill that *does* have one therefore banked all
four reasons under one heading.

**It was label-only.** Reconciled against the dump, recipe by recipe:

| Skill | mastery-refused | what they actually are |
|---|---|---|
| Firemaking 32 | 29 | 17 logs from Teak (35) to Carrion (120), plus 12 Abyssal-realm logs |
| Herblore 1 | 71 | the 70 potions above level 1, plus `melvorItA:Harvesters_Potion` |
| Summoning 11 | 49 | 25 familiars above level 11, plus 24 Abyssal-realm ones |
| Harvesting 1 | 5 | Twisted (abyssal 11) through Voidfire (55), all in a locked realm |

Nothing that should have been offered was dropped. Firemaking's three level-unlocked logs
(Normal, Oak, Willow) really were unaffordable: the bank held 125 Yew Logs -- a level-60 burn --
and no other log at all, so "3 unaffordable" is not suspiciously few, it is exactly the number of
burnable tiers the character has reached. The realm-locked 1 was `melvorItA:Riftwood_Logs`, whose
`level` and `abyssalLevel` are both 0 and whose realm is `melvorItA:Eternal`.

Two things came out of it.

**Attribute to the fact you can check; leave the gate deciding.** `isMasteryActionUnlocked`
(`skill.d.ts:806`) is declared abstract and the typings never say what it returns, so promoting
our own `recipe.level` comparison to a gate would risk dropping a recipe the game had unlocked by
a route we cannot see -- a missing candidate traded for a tidier tally, which is the wrong
direction. The gate still decides. When it refuses, the counters ask realm first, then the level
requirement on the track `recipeRequirement` selects, and **mastery is the residual**: what the
gate refused that neither of those explains. Post-fix Firemaking reads
`0 mastery-locked, 17 level-locked, 13 realm-locked, 3 unaffordable`.

**A wrong heading is not cosmetic when the heading is the print condition.**
`reportSilentSkill` prints only when `mastery` or `realm` is non-zero, on the stated grounds that
`readLockedActions` and `readUnstockedSkills` already carry level and stock. So a level block
filed as mastery both names the wrong cause *and* keeps alive a line the module had decided not
to print.

### The same `level: 0` trap, twice more, in the blocked list

Into the Abyss recipes carry their requirement on `abyssalLevel` and leave `level` at 0 (dump:
every Harvesting vein is `level: 0`; `melvorItA:Twisted_Vein` is `abyssalLevel: 11`). Two readers
in `blocked.ts` compared the standard pair only:

- `readUnstockedSkills` filtered `recipe.level <= skill.level`, so all seven veins passed and the
  planner was told "Harvesting has no candidates because nothing it can make is in stock --
  Abyssal Vein is unlocked at level 0 and needs materials bought or gathered". A shopping list,
  for veins that consume nothing, in a realm reporting `unlocked: false` with "Complete Into the
  Abyss x1" outstanding.
- `readLockedActions` could name a recipe in a locked realm as a level to grind toward.

Both now skip realm-locked recipes and read the requirement through `recipeRequirement` /
`currentLevelFor`. The general shape: **a requirement read off the wrong track defaults to 0, and
0 reads as an invitation** -- the third time this file has paid for that.

## Combat XP has no coefficient in the typings, and it did not need one

Fights were the only candidates carrying no rate at all, and the obvious reason is that combat
does not look priceable: `Player.rewardXPAndPetsForDamage(damage)` (`player.d.ts:435`) is the
*only* statement anywhere in `gameTypes/` about how combat pays, and it names the input without
naming the rate. There is no XP-per-damage constant on `CombatSkill`, on `AttackStyle`, or on
`Player`. `AttackStyle.experienceGain` (`attackStyle.d.ts:11-14`) gives the split between skills
and not the size.

The useful move was not to find the constant or to invent it, but to notice it does not matter.
It is the same for every fight, so **damage per hour orders fights exactly as XP per hour would**.
What the missing constant costs is the *cross-skill* comparison -- a fight against Thieving --
and saying so out loud is cheaper than a fabricated number that makes that comparison look sound.

Three things were readable and settled the rest:

- **`Player.getMonsterSpawnTime()`** (`player.d.ts:134`), the modifier-aware dead air between
  kills, with `baseSpawnInterval` (`player.d.ts:131`) behind it. This is the whole discriminator.
  Without it, damage per hour is just the character's DPS and *identical for every monster in the
  game* -- the fights would have sorted identically for a second reason after being fixed for the
  first. The mining respawn again: price the part that costs, not only the part that produces.
- **`DropTable.getAverageDropValue()`** (`utils.d.ts:545`), documented as an average, sitting
  beside `getDrop()` and `getRawDrop()` (`541`, `543`), documented as rolls. After
  `modifyPrimaryProductQuantity` the reflex is to distrust every quantity getter; the actual
  lesson is narrower and better -- **read the doc comment for the word "average" or "rolls"**,
  because Melvor does label them, and here it had already provided the un-rolled accessor.
- **`Monster.levels.Hitpoints`** times `numberMultiplier` (`main.d.ts:16`). Not stated anywhere,
  so measured: the live character reads Hitpoints 15 against a 150 bar. What made measurement
  *sufficient* rather than merely convenient is that the multiplier is one global, so being wrong
  about it scales every monster equally and reorders nothing -- and ordering is all a candidate
  list is for. A test pins that, so the argument is not left in a comment.

What stays unreadable is the hit chance against a specific monster: the `Enemy` probe that would
answer it returns NaN outside combat, which is a fact this repo already paid for. So every attack
is assumed to land, which overstates hardest against high-Defence monsters -- and the monster's
Defence level rides in the candidate label rather than the caveat sitting only in a doc comment.
**Put the axis an estimate is optimistic along next to the estimate**, where the reader deciding
on it will actually see it.

Real output, from `data/dump.json` against the live character (max hit 24, 3s interval, 3s spawn):

| monster      | HP  | kills/h | damage/h | note |
|--------------|-----|---------|----------|------|
| Chicken      |  30 |     400 |   12,000 | most bones/h, so most Prayer |
| Golbin       |  50 |     277 |   13,846 | |
| Steel Knight | 150 |     109 |   16,364 | |
| Hill Giant   | 350 |      49 |   17,260 | most damage/h, so most Attack and HP |

Note that the two useful orderings are *opposite*, and both are correct: a planner chasing
`prayer-20` wants the Chicken and one chasing `hp-40` wants the Giant. A single "which fight is
best" number could not have said both, which is the argument against collapsing this into one.

Finally: pricing runs **before** the survivability gate is consulted, so a refused fight can say
how big it was as well as why -- "could be one-shot" reads identically for a Chicken and for a
level-90 monster, and the scale is what tells a planner whether the answer is better gear or a
smaller target. That ordering is only safe because the two paths share nothing, and the pricing
result deliberately carries no field a caller could spread into an available candidate. A test
asserts its exact key set, so adding one fails the suite rather than the character.
### The reason a `continue` throws away

`ranged-20` read 3/20 for a whole run. The bank held three tiers of crossbow and 2,134 arrows,
and the entire equip candidate list was one line: `Equip Steel Scimitar`. Nothing anywhere said
why, and the only way left to learn which level refused a crossbow was to reach it.

The cause is one line in `readEquipCandidates`:

```ts
if (!game.checkRequirements(item.equipRequirements, false)) continue;
```

Correct as a gate -- offering gear the character cannot wear spends an objective discovering a
level the game already knew -- and the requirement it just evaluated is discarded on the same
line. The style filters below it are not the culprit and could not have been: a crossbow against
a Staff of Air sets `switchesStyle`, which skips both `penalisesAttackStyle` and the stat sum.

**A filter's predicate is a diagnostic, and dropping it is a choice.** Every `continue` in a
reader that answers "what can I do" silently produces the other half of the question -- "and why
not the rest" -- for free, and throws it away. `readBlockedOpportunities` is where that half
belongs; it already exists for exactly this and had no equipment entry at all.

### Ammunition compatibility is two questions, and stack counts answer neither

The second half of the same wall. A crossbow's `ammoTypeRequired` is `Bolts`; every arrow in that
bank is `Arrows` (`AmmoTypeID`, enums.d.ts:2983-2991). So "1,620 Adamant Arrows" reads as
*stocked* to everything that counts items and is worth nothing to a crossbow. And ammunition
carries `equipRequirements` like any other equipment (item.d.ts:251), so a stack of the right
*class* can still be unloadable.

`readRefillableAmmo` matched the class and not the requirement, which would have handed the
quiver reflex a stack `equipItem` refuses on the identical check -- retries spent on something
that can never load, in a fight, which is where that reflex runs.

### None of this could be asked offline, and that was the real gap

`data/dump.json` recorded items as `{id, name, category, type, sellsFor, healsFor}`. Not
`validSlots`, not `equipRequirements`, not `ammoType`. So "does a crossbow fire an arrow" -- the
most basic compatibility question in the game -- had no offline answer, and the honest options
were to guess or to stop. There is now an `equipment` section, scoped to `game.items.equipment`
rather than smeared across 3,748 item rows.

**A dump that prices everything and constrains nothing.** Every section added to date answers
*what a thing is worth*; the first question that was about *whether a thing is usable* found
nothing there at all.

### Reachable and unexplained is not the same as blocked

The tempting conclusion was that Ranged is unobtainable and the goal should say so. It is not.
From the dump alone: Normal Shortbow is Fletching 1 from an unstrung bow (Fletching 1, one Normal
Log) plus a Bowstring -- one is banked, the shop sells more at 24 GP with no requirement. Bronze
Arrows are Fletching 1 from Bronze Arrowtips (Smithing 1, one Bronze Bar) and Headless Arrows
(15 Arrow Shafts, 4,322 banked; 15 Feathers, 8 GP in the shop). Woodcutting 60, Smithing 55,
Mining 62, Fletching 22. Every input is held, mined, or costs under 100 GP.

`GoalStatus`'s `blocked` means one thing and should keep meaning it: a goal named in another
goal's `requires:` that is measurable and unmet (goals.ts:435). Marking this one blocked would
also drop it out of `goalsAdvancedBy`, so every fight would stop being tagged as advancing
Ranged -- a goal made *less* legible by the mechanism meant to explain it.

**The failure was never that the goal was unreachable. It was that the route was never said out
loud.** Those want different fixes, and the second one is a blocked-opportunity line, not a goal
state. Inferring reachability inside `goals.ts` would put a guessed route where the file does
snapshot arithmetic -- which is precisely what an invented `requires: magic-ranged-20` already
cost the Abyssal goal.
## `attackSpeed` is a cost sitting in the middle of the bonuses

`EquipmentItem.equipmentStats` (item.d.ts:253) is a flat `{key, value}[]`, and `attackSpeed` is
one of its keys (`EquipStatKey`, character.d.ts:445-446) alongside every attack, strength and
defence bonus. It is the only one where a larger number is *worse* -- milliseconds between
swings -- and it is two to three orders of magnitude bigger than any of them: 2,400 for a Steel
Scimitar, 3,000 for a Staff of Air, against single- and double-digit bonuses.

So a function that sums the array does not merely lean on attack speed, it *is* attack speed.
`statScore` over two weapons was the ratio of their attack intervals and essentially nothing
else, ranked backwards, which makes the slowest weapon in the bank the best one in the bank
forever. The same inversion had a second home one function along: `dominatesEquipmentStats`
compares key by key with a smaller value meaning worse, so it said a 3,000ms weapon dominates a
2,400ms one.

Excluded from the sum rather than negated. Negating lets it dominate in the other direction and
ranks gear by speed alone, which is the same defect mirrored. The key-by-key test is the place
where a stat can be compared in its own direction, and that is where the direction now lives.

The general shape, and it is the second time this file has paid for it: **a blind sum over a
heterogeneous stat array assumes every term points the same way and is measured on the same
scale.** The Steel Platebody whose melee defence drowned out its ranged penalty was the first,
and that one at least had all its terms pointing the right way.

## A verified `ok` that is undone can be two tiers of your own agent

A Steel Scimitar and a Staff of Air traded the weapon slot for forty minutes, forty equips a
minute, every one a verified `ok` with a truthful before/after diff -- and one tick later the
other weapon was back with the bank counts unmoved. It was written up as "the game reverts it for
a reason nothing reports, and the typings do not say what", and a watchdog was built on that
belief.

Nothing in the game reverted anything. What settled it was reading the log for **periods and
provenance** rather than for content:

- the `equipment.equip ok — "melvorF:Staff_of_Air" -> "melvorD:Steel_Scimitar"` lines recur at
  2,986-3,002ms. That is `POLICY_INTERVAL_MS` (3,000), not `REFLEX_THROTTLE_MS` (1,000), so the
  call cannot be the reflex's;
- only the objective executor writes a `source: "adapter"` line for an action; the reflex tier
  writes `reflex.X fired` and nothing else. `reflex.liquidateSurplus fired` with no `bank.sell`
  line beside it is the control;
- every one of those adapter lines reads `before: Staff_of_Air`, so the staff was back in the
  slot before each policy tick;
- the journal holds the objective doing the asking: `equip_item`, Steel Scimitar into the weapon
  slot, `successWhen: []`, aborted on its three-minute budget;
- and the swapping stops within half a second of that objective being replaced, rather than when
  anything about the gear, the spell selection or the running skill changed.

So the objective tier put the scimitar on every 3s and the gear reflex put the displaced staff
back on the next 1s tick. Both were doing exactly what they were told. The bank counts never
moved because each weapon was removed and returned inside the same second -- which is also why
the one measurement that had been trusted, a bank diff, was the one that misled.

Three things worth keeping.

**The attribution in the record was backwards.** `reflex.upgradeGear fired` names no item, so the
item was inferred from the adapter line half a second earlier, which belonged to the other tier.
A log line that reports *that* something fired and not *what* it did is an invitation to do
exactly that.

**Ask what else wants this resource before asking what the game does with it.** The typings were
searched for an auto-unequip, an equipment-set swap, a spell forcing a magic weapon back. All of
it was wasted: this agent has two tiers that both equip, on different clocks, and neither knows
about the other. That check is cheap and belongs first.

**A guard built on a wrong cause can still be the right guard.** `StuckEquipWatch` bounded the
loop correctly while explaining it wrongly. It is kept -- two tiers disagreeing about one slot is
a shape rather than an incident, and `Player.checkEquipmentRequirements` (player.d.ts:139) can
take a slot back on its own -- but its comments and its operator message now say what is known
and stop naming a culprit.

## A running Alt Magic cast keeps consuming whatever it was aimed at when it started

`AltMagic.selectedConversionItem` (altMagic.d.ts:126) and `selectedSmithingRecipe` (:124) are the
game's own record of what the current spell destroys, and they survive everything the mod does
short of a stop/start -- a rebuild, a reload, a guard shipped specifically to forbid the item
they name. `startAltMagic` short-circuited on "already casting", so `chooseSelection` decided
once at the start and never again, and a rune guard that shipped and loaded correctly changed
nothing: the agent went on burning Nature Runes until the cast was stopped by hand, after which
the measured draw fell from two Nature Runes a cast to one Nature Rune and one Arrow Shaft.

Three ways the selection goes stale, and they want the same answer:

- **the stack empties.** 4,322 Arrow Shafts at ~1,800 casts an hour is under three hours, and the
  cast would then be aimed at an item the bank no longer holds;
- **a guard starts covering it.** The item is still there; the rule about it changed;
- **it is absent.** What a reload leaves behind -- the spell survives, the selection does not.

All three are "the live selection is no longer in the offered list", which `chooseSelection`
already builds. The re-check is on **staleness, not preference**: re-selecting because something
cheaper appeared would churn the fuel on every tie broken differently, and every re-select
carries the unknown risk of disturbing a running cast, since `selectItemOnClick` (:143) is a UI
callback the typings say nothing about. Whether it can be applied to a running cast at all is now
checked rather than assumed -- the projection carries the selection, so `act` fails a refresh
that did not land instead of reporting `ok`.

Worth stating plainly because it is the reusable half: **"is this cheap enough to do every tick"
was the wrong question.** The precondition already walked the whole offered list on every call
and threw the answer away. The fix was not to add a check, it was to stop discarding one.

## A button callback takes its real argument from the screen, and the screen is empty

`Township.repairBuilding(building, render?)` (township.d.ts:723) takes a building and no biome.
It is a *button callback*, so the biome comes from `currentTownBiome` (:423) — the game's own
source opens the method with `if (biome === undefined) return;`. The agent never opens the town
page, so that early return was every repair it ever made. Once a minute, all day:

```
reflex.repairTownship: state unchanged after call:
{"buildingId":"melvorF:Miners_Pit","biomeId":"melvorF:Mountains","count":1,"efficiency":85}
 -> {identical}
```

Nothing spent, nothing changed, nothing thrown, and the game emitted no notification a mod could
see. `act`'s before/after diff was the only thing in the system that noticed at all.

Three things worth keeping.

**The affordability check was the alibi.** `canAffordRepair(building, biome)` (:691) *does* take
the biome, and answered truthfully — about a biome the repair would never look at. So the reader
kept offering the building, the reflex kept picking it, and every layer above the failure was
behaving correctly. Two functions on the same object, one taking the biome and one reading it
from the page, is the whole bug; the signatures give no hint that they disagree.

**We had already met this and forgotten.** `buildBuilding` has exactly the same shape, and
`buildTownshipBuilding` had been setting and restoring `currentTownBiome` around it, with a
comment, for months. Repair was written next to it and did not inherit the lesson. It is now one
`withTownBiome` helper both call, so the next such method is a one-line change rather than a
rediscovery.

**Check the sibling before writing a guard.** `repairAllBuildings` (:492) iterates `this.biomes`
itself and was never affected, and `repairAllBuildingsInCurrentBiome` (:488) has the same early
return as the single-building path. The three differ precisely in how they get a biome. A
"Repair All" that quietly worked while single repair quietly did not is the sort of thing that
makes a measurement look non-deterministic.

The generalisation, and it is the same one the equip loop produced: **when a call reports success
or silence and the world does not move, ask what the method reads that it does not take.** For a
UI-driven engine that is nearly always a selection — the open page, the selected biome, the
selected spell, the selected item — and it is nearly always absent for an agent that never
clicks. `learnings/mod-api.md` has how to read the shipped source to settle it in ten seconds.

## Half the loops of this shape never fail — they succeed, over and over, from the same place

Building the generic detector for the four loops started from a stated premise: that every one
of them produced a truthful `no_state_change` on its first call, and that a ledger in `act`
keyed on `(name, JSON(before))` would bound all four. `data/logs/*.jsonl` says that is true of
two of them and false of two.

The two that fail as expected:

```
altMagic.cast failed (no_state_change) [5/5]  ×5 in 15s, then abandoned and re-planned
reflex.repairTownship: state unchanged after call: {...,"efficiency":85} -> {identical}  ×389
```

The two that do not fail at all:

```
equipment.equip ok — itemId "melvorF:Staff_of_Air" -> "melvorD:Steel_Scimitar"   every ~3s, 40min
agility.run ok — {"active":false,...} -> {"active":true,...}                     every 6s, zero XP
```

Both `ok` readings are *correct*. The weapon really was swapped; Agility really did start. What
neither reading can say is that the same thing will be needed again in three seconds. The tell is
in the evidence already being recorded and nowhere else: **the `before` is byte-identical on every
pass**, so the change lands and something puts it back. Work being redone looks exactly like work
being done, one call at a time.

So the detector is two ledgers rather than one, both in `act`, both keyed on `(name,
JSON(before))`, both reporting once on the transition:

- a run of `no_state_change` against an unmoved projection — five, matching
  `ACTION_FAILURE_LIMIT`, because a higher threshold could never be reached by an objective tier
  that abandons at five;
- a run of `ok` from an identical starting state — five inside sixty seconds. The window is the
  whole discriminator: a building degrading and being repaired again from the same efficiency is
  correct and arrives minutes apart, while two tiers fighting over one equipment slot repeat in
  seconds.

Three things worth keeping.

**The premise was checkable and nobody had checked it.** The claim "all four produced a
no_state_change" had been made from memory of what the failures looked like, and four `grep`s of
the day's logs settled it. `grep -oh '"action":"[a-z.]*","reason":"no_state_change"' *.jsonl |
sort | uniq -c` also turned up a fifth instance nobody had ever investigated —
`reflex.refillFood`, 232 identical no-change warnings — which is the same bug in a reflex that
had been dismissed as noisy.

**A key that never repeats is a detector that never fires.** Most projections are stable ids and
counts, but `equipment.eatFood` carries live hitpoints, `combat.loot` the pending drop count, and
the mastery projection pool XP. A loop in one of those moves its key every tick and would have
disabled the detector silently — the same class of bug as the one being caught. It is covered by
a second, much looser counter: consecutive no-change for the action whatever the projection,
reported at forty, on the grounds that a moving projection is weaker evidence and deserves a
higher bar rather than none.

**Report, do not refuse.** A legitimately retried action — waiting on a respawn, a cooldown, a
tick boundary — produces the identical shape, and an adapter that starts declining real work is
worse than one that is noisy. `StuckEquipWatch` keeps the one refusal, because it knows something
`act` does not and must not: which item the *reflex* asked for. The adapter's evidence must not
depend on which tier issued the call.

## The audit that follows from it: what every button callback reads that it does not take

Every `perform` in the adapter was checked against the shipped v1.3.1 source where the nw.js
cache holds it (`learnings/mod-api.md` has the how), and against the typings elsewhere. The
question is always the same: what does this method read that it does not take?

**Verified clean against the shipped source** — every one takes everything it needs:
`Bank.processItemSale`, `buryItemOnClick`, `processItemOpen`, `claimItemOnClick`,
`upgradeItemOnClick`, `toggleItemLock`; `Player.equipFood`, `changeEquipmentSet`, `togglePrayer`,
`setAttackStyle`, `selectAttackSpell`, `toggleCurse`, `toggleAurora`; `CombatManager.selectMonster`,
`selectDungeon`, `startEvent`; `Cartography.startAutoSurvey`, `startMakingPaper`,
`createNewMapForDigSite`; `Township.increaseHealth`; `Game.selectRandomLevelCapIncrease`.

One nuance rather than a bug: `Player.equipFood` and `Player.eatFood` both work on
`this.food.currentSlot`, i.e. `EquippedFood.selectedSlot` (equippedFood.d.ts:5) — a UI selection.
They are consistent with each other and with the adapter's projection, so the agent equips and
eats from the same slot whichever one is selected. `EquippedFood.equip` itself is not in the
readable half of the cache, so "equip targets the selected slot" is inference from `eatFood`'s
source, not proof.

**One new finding, fixed.** `Township.buildBuilding(building)` (township.d.ts:722) reads *two*
selections, not one. The biome was already known. The second is the quantity:

```js
const upgradeQty = this.upgradeQty > 0 ? this.upgradeQty : this.getMaxAffordableBuildingQty(building, biome);
const qtyToBuild = Math.min(this.getBuildingCountRemainingForLevelUp(building, biome), upgradeQty);
```

`upgradeQty` (township.d.ts:439) is the town page's 1 / 5 / MAX dropdown, and MAX is stored as
`-1`. It defaults to 1, so nothing has gone wrong yet — but a human clicking MAX once would turn
every later agent build into "spend everything affordable", which is precisely the outcome
`BUILD_RESERVE_MULTIPLE` exists to prevent and cannot see coming: the reserve proves the town can
afford four and the call then buys as many as it likes. Now pinned to 1 and restored, the shape
`withTownBiome` established. `shop.buyItemOnClick` had already cost a real objective for the same
reason — an objective that bought one of twenty-five shards and reported success.

**Three remedies, and which to reach for.** Scope-and-restore (`withTownBiome`,
`withBuildQuantity`, `shop.buyQuantity`) when the selection is a mechanical detail the agent knows
the right value for. Set-then-act (`selectRecipeOnClick` before `createButtonOnClick`,
`onRockClick` before `start`) when the selection is the thing being chosen. Refuse
(`cooking.passive`, whose precondition declines when `selectedRecipes.get(category)` is absent)
when the selection is a real choice nothing should make on the player's behalf. All three are in
use; the failure mode is reaching for none of them.

**Unverified, listed rather than guessed.** The nw.js cache decompresses to 17 files (~2.9 MB) —
Bank, Player, CombatManager, Cartography, Township, Game and the skill base classes. Everything
else lives in `data_0`..`data_3`, which are held open by the running game. So these were checked
against the typings and the adapter's own call sequence only: `Agility.buildObstacle`, Archaeology
(`startDigging`, `setMapAsActive`, `setToolAsActive`), Farming (`unlockPlotOnClick`, `harvestPlot`,
`plantPlot`, `compostPlot`), Cooking (`startPassiveCooking`, `onCollectStockpileClick`),
`Astrology.studyConstellationOnClick`, `Thieving.startThieving`, `ArtisanSkill.createButtonOnClick`,
Alt Magic's selection callbacks, `PotionManager.usePotion`, `SlayerTask.selectTask`,
`SkillTree.unlockNode`, `Shop.buyItemOnClick`, `CombatLoot.lootAll`, the Township task and trader
conversions, and the raid callbacks. Each either passes everything explicitly or has the adapter
set the selection immediately before the call — structurally protected, not proven. The way to
settle any of them is to close the game once and decompress the cache again.

## A detector whose output has to be grepped for has not been read yet

The stuck ledgers above were built the day four separate loops were each found by hand, hours in.
Their finding went one place: the `ActionResult` detail. Both tiers log that, so it reached
`data/logs/*.jsonl` — and the policy tier puts the detail in the *structured payload* rather than
the message, so `STUCK` was greppable and appeared on no panel and in no state summary. The
detector that exists because nobody sees a loop had shipped its answer somewhere nobody looks.

Findings now ride out on `readAdapterFailures()`, the counted list that already reaches the TUI
and `get_agent_state` — it is how `rockGemChance` and `numberMultiplier` were both noticed —
marked `kind: 'stuck'`. Three things were decided there, and each is a rule worth keeping:

- **A different claim needs a different sentence.** A guarded read that fell back means a renamed
  accessor; a stuck action means the agent has spent hours achieving nothing. Rendering both under
  "guarded read failed at" would send the reader hunting a getter for a loop.
- **Ranking by count is ranking by how chatty a failure is.** The summary prints five. The live
  game carries six read sites at 655 apiece right now — `candidates.rockGemChance`, four
  `noCandidates:` sites and a `yieldShape` — so a stuck action ordered by count would have been
  the seventh entry and printed never. Stuck ranks first unconditionally. That truncation had
  already hidden real failures earlier the same day.
- **A counter must inherit the once-ness of what it counts.** The ledgers report on the
  transition, so the report's count is stuck *runs* — five identical failures, a success, five
  more is two — and not stuck passes. This project has twice had a real diagnostic buried by a
  line that fired every tick, and a per-pass counter would have been that line with extra steps.

The general shape: **surfacing is part of the detector, not a follow-up to it.** A finding that
travels only to a log will be read after the next day-long loop, not before it.

## The operator's selections are their state, including the ones the agent has to touch

`Shop.buyItemOnClick(purchase, confirmed)` (shop.d.ts:261) takes no quantity: it buys
`shop.buyQuantity` (shop.d.ts:232), the shop page's own selector, whose update callback is
`updateBuyQuantity` (:263). The adapter had to set it — before that, "buy 25 shards" bought one and
the objective reported success — and then left it set, so the operator's next click bought
twenty-five of something they wanted one of.

The reading that matters is not "a bug", because nothing the agent does is wrong: it sets the field
on every purchase. It is that a UI-driven API makes the agent a second pair of hands on one set of
controls, and the surprise lands on the person who did not press anything. Every set-then-act in
this adapter therefore restores: `withTownBiome`, `withBuildQuantity`, `withBuyQuantity`.

Three copies, and deliberately not one helper. `buyQuantity` and `upgradeQty` are plain numbers;
`currentTownBiome` is optional and must be restored to *absent* rather than to `undefined`, because
the game reads an absent biome as "viewing all biomes". A single abstraction would have to carry
that distinction into all three call sites to save five lines at each of them.

## An executor precondition the candidate list cannot ask is a lie with a price on it

Every combat goal stalled for an evening. Both Fight Leech objectives died on
`Wind Strike is selected but the bank cannot pay for it (needs 1x Mind Rune)` while the
candidate list carried `221. Fight Leech (Wet Forest, combat level 20) — 200 HP (defence 10),
~84 kills/h, ~16,744 damage/h` as fully available, and a grep of the whole candidate text for
"Wind Strike" or "Mind Rune" returned nothing. The refusal was correct, legible and useless: it
arrives *after* the planner has spent its choice.

The shape is not "a missing check". `combat.engage` had a precondition — the private
`cannotAttackRefusal` — that no enumerator could ask, so a fact good enough to abandon an
objective on was not good enough to be visible when the objective was picked. **A precondition
worth refusing on is worth exporting**, because the two answers must come from one function or
they diverge, and they diverge in the expensive direction every time: the game refuses, and
nothing said it would.

What made the repair cheap was prior art one list over. `Magic: Superheat II — Earth Rune from
Runecrafting: Earth Rune` blocks *and names the producer*, and the same join turns "needs 1x
Mind Rune" into a move. So the fights are withheld and one high-severity line explains them —
one line, not two hundred, because the blocked window is twelve and two hundred copies would
truncate every other diagnostic away. That is the same budget the food-reserve countdown was
once lost to.

Three details worth keeping, all read out of the shipped v1.3.1 build (`Player.attack` in the
nw.js HTTP cache; `learnings/mod-api.md` has the brotli recipe) rather than guessed:

- **`getRuneCosts` is the bill; `runesRequired` is the sticker price.** `Player.getRuneCosts`
  (player.d.ts:163) swaps in `runesRequiredAlt` when combination runes are on and subtracts
  `runesProvided`, the runes the equipped staff supplies free, flooring each rune at 1. Wind
  Strike lists an Air Rune *and* a Mind Rune; with a Staff of Air the character owes only the
  Mind Rune — which is exactly why the refusal named one rune while the bank held 253 of the
  other. Pricing off the raw list would withhold every fight for a rune nobody owes.
- **Ranged ammunition is a type check, not a count.** The game reads
  `if (weapon.ammoTypeRequired === 4) break;` and then
  `if (weapon.ammoTypeRequired !== quiver.ammoType) onRangedAttackFailure(quiver)`, and that
  handler distinguishes `TOASTS_NO_AMMO` from `TOASTS_WRONG_AMMO`. Counting quantity alone let
  981 Bronze Arrows arm a crossbow that fires bolts — a full quiver and zero damage — and
  refused a Slingshot, one of the four ranged weapons in the dump (`AmmoTypeID.None`) that need
  no ammunition at all. A guard that withholds every fight must not invent the last one.
- **Golbin Raid is the exception, and not an oversight.** The raid arms the character with
  `golbinRaidStartingWeapon`, so its candidates stay offered when nothing else can fight.

The same reading found a refusal that was simply absent: `startCombatEvent` checked food and
never checked whether a punch could land, so the one entry into the hardest content in the game
would happily begin a run the character cannot damage anything in — standing in a boss area
taking hits with no way to return them, which is the idle stall plus the health it costs.

The guard was checked against the question this project keeps paying to relearn — what
replenishes the thing the guard protects, and can the guard block it? What restores the ability
to attack is runes, ammunition or a different weapon: a Runecrafting candidate, the quiver
reflex, an equip candidate. None of them is a fight, so unlike the bank-slot cap this guard
cannot starve its own precondition. That was verified rather than assumed, and it is the reason
withholding is safe here and would not have been for food.

## Empty slots are in the death roll, so a slot can be worth emptying

Every gear reader in this mod answered "what is worth *wearing*". The question
nobody asked is whether a slot is worth **emptying**, and `applyDeathPenalty`
had been charging for the omission 55 times.

The typings say only *"Removes an item from the player's equipment on death"*
(player.d.ts:410). The shipped v1.3.1 `Player` says how (nw.js cache,
f_00019a.js:2628-2643):

```js
const priorityOrderSlots = [...this.equipment.equippedArray]
    .sort((a, b) => a.item.deathPenaltyPriority - b.item.deathPenaltyPriority);
const lowestPriority = priorityOrderSlots[0].item.deathPenaltyPriority;
let minPriorityLength = priorityOrderSlots.findIndex(
    (equipped) => equipped.item.deathPenaltyPriority > lowestPriority);
if (minPriorityLength === -1) minPriorityLength = priorityOrderSlots.length;
const priorityIndex = rollInteger(0, minPriorityLength - 1);
const equipped = priorityOrderSlots[priorityIndex];
if (!equipped.isEmpty && this.game.tutorial.complete) { /* it is destroyed */ }
```

Three facts, and the third is the one worth having:

- `deathPenaltyPriority` defaults to 0 (item.d.ts:197-198) and **exactly one
  item in the base game sets it** — the Decoy Idol, at -1, whose own
  description is "This is always chosen as the item lost on death". So for
  everyone else the tier is uniform and the roll is over the whole array.
- The empty-slot placeholder is an ordinary `EquipmentItem` constructed with no
  `deathPenaltyPriority` at all (f_00019d.js:346-362). It defaults to 0 too, so
  **empty slots are drawn like any other**, and a roll landing on one destroys
  nothing.
- Therefore taking an item off does not merely remove it from the draw — it
  converts its ticket into a blank. This character's array is 19 entries with 9
  occupied, so each worn item was 1/19 per death, and each strip is worth a
  full ticket in both directions.

None of that is derivable from the typings, and the middle fact is the one a
reasonable person would have guessed wrong.

### "Cannot be scored" is not "contributes nothing"

The tempting rule is "strip anything with no combat stats". Three items in this
character's own loadout show why that is not the same claim, and the shipped
data settles each:

| Item | `equipmentStats` | Verdict |
|---|---|---|
| Thiever's Cape | `[]` | inert in a fight — its modifiers are Thieving |
| Basic Barrier Gem | `[]` | **not** inert — `flatBarrierDamage` acts in a fight |
| Ent (Summon) | `[]` | skilling familiar; a *combat* one carries `summoningMaxhit` |

`Modifier.isCombat` looks like the game's own answer and is not. It is
documented as "if this modifier causes a change in combat stats when changed"
(modifiers.d.ts:295-296) — a claim about the recomputed stats block, not about
whether the modifier matters when swords come out. `flatBarrierDamage` and
`lifesteal` are both unscoped, neither sets `isCombat`, and both plainly act in
a fight. There is no machine-readable "affects combat" flag on a modifier.

What is real is `ModifierValue.skill` (modifiers.d.ts:56, :19) — the game's own
record of the scope — but it is present on fewer modifiers than the data
suggests: the Thiever's Cape's `currencyGain` and `skillXP` carry
`skillID: melvorD:Thieving`, while its `thievingStealth` carries no scope at
all. So "every modifier is skill-scoped to a non-combat skill" rejects the very
item the work existed for.

The rule that survived is deny-by-default and three-layered: no non-zero
equipment stat, no conditional modifiers, and every modifier either scoped by
the game to a non-combat skill *or* named in a short explicit table — plus a
slot deny-list, so the Gem and the Summons take two mistakes rather than one to
strip. Being wrong toward "keep it on" costs nothing that is not already being
paid; being wrong toward "inert" fights without something that mattered.

### The `withTownBiome` shape does not survive contact with a fight

`withTownBiome` / `withBuildQuantity` / `withBuyQuantity` work because the call
they wrap is synchronous. A fight is not: it starts on one tick and ends minutes
later on a tick nobody is standing on, and it can end in death, an abort, a
reload or the offline loop. A `finally` around `combat.engage` returns before
the first punch.

The general form: **when the thing being scoped outlives the call, the restore
is a state machine and not a scope** — a record of what was changed, and a
condition that puts it back. Here the strip is `inCombat && strippable > 0` and
the restore is `!inCombat && stashed`, which is one observation covering death,
abort, victory and disengage alike, plus an explicit restore before `reloadGame`
saves, since a reload takes the page and the record with it.

The failure the design cannot handle is worth stating because it is why this is
safe: a crash mid-fight loses the record, and loses nothing else. Stashed gear
is in the *bank*, where the death penalty cannot reach it, and the fill reflex
puts it back unprompted next session.

### One opinion per question

The first version stripped at the engage chokepoint. The better version is one
more clause beside `removePenalisingGear`, which already unequips gear that
*actively hurts* the style in use — the missing case was gear that merely
contributes nothing. Two separate opinions about what should come off is the bug
class this repo keeps paying for, and the existing reflex had already solved an
ordering problem the new one would have hit: unequipping puts the item back in
the bank, so it has to run after the bank reflexes, on a bank that sits at 53 of
64 slots most of the day.

The cost of folding it in is one throttled tick of exposure at the start of each
fight instead of none. That is the right trade, and the condition it buys is the
one that matters: `inCombat`, so the Thiever's Cape keeps its 25 Stealth and
+10% Thieving GP every second the character is not fighting. A rule that
stripped whenever an item failed a *combat* test would quietly have cost the
Thieving income the run lives on.

## A floor that governs leaving governs nothing

The fifth retry-forever loop, and the first one whose ontology was right.
Combat alternated `combat.engage ok` / `combat.disengage ok` on the 3s policy
clock for seventeen minutes across two game reloads, no kills, no XP, no GP.

Both of `fightMonster`'s safety floors — HP and food — lived *inside* the
`inCombat` branch. So a crossing could end the fight that was running and
nothing more: the next tick found combat stopped, never evaluated the floors at
all, and engaged; the tick after crossed the same floor and stopped again. A
condition consulted only at the moment it can be acted on one way cannot
terminate anything. It can only alternate, forever, at two ticks per cycle.

The measurement that named it was in the log all along, and it is worth the
habit: **tabulate the durations, not the events.** The first engage of an
episode holds 42.0s and 24.0s; every subsequent one holds exactly 3.0s. One long
hold and then a flat line at one tick is the signature of a state that became
true during the first pass and stayed true — and it points at the *entry*
condition, because that is the only asymmetry between the first pass and the
rest.

Three diagnoses missed it, and one instrument gap explains all three.

- **The reason was never logged.** `perform(actions, reason)` accepted the
  policy's reason and used it nowhere, so `combat.disengage ok — inCombat true
  -> false` was the entire record of the decision. "No floor reason appears
  beside it, therefore it was not the floor" was the reasonable inference and it
  was false: no reason appeared for *any* action. A log that records what was
  done and never why cannot tell five branches of one function apart.
- **A reflex and a policy action do look different, and that is the one
  provenance fact the log does carry.** A reflex logs `reflex.<name> fired` and
  no adapter line; only `perform` writes `<action> ok`. That alone rules out
  every reflex and the abort handler — which calls `disengageCombat` directly
  and logs nothing on success — and leaves three call sites. Worth checking
  before guessing.
- **Fixing a real bug is not evidence of having found the bug**, again. The flat
  50% floor above a 30% auto-eat trigger was genuine, was the whole story for
  the 22:14 and 22:38 episodes, and the loop resumed on the next build.

The general rule: **an exit condition and an entry condition are the same
question asked at two moments, and they belong in one function.** Where they are
two — or where one is simply missing — they will disagree, and disagreement
between a start rule and a stop rule does not surface as a wrong answer. It
surfaces as an infinite loop in which every individual decision is correct.

### Why it was one cause and not two

The loop survived a fix to the floor's *value* and that looked like evidence of
a second cause. It is not. Lowering the floor from a flat 50% to the auto
eater's trigger less 5% was correct and changed nothing structural, and the
character had by then already been driven to the new floor by the loop the old
one started.

The mechanism that pins it is that **the thrash prevents its own recovery.**
Auto Eat fires inside `Character.damage`, so it only ever fires when the
character is hit. Three seconds of combat is about one spawn timer, so the
thrash cycles without the enemy landing much — HP neither falls nor is healed,
and out of combat it regenerates far too slowly to matter. HP was 38 of 150 when
the character was pulled out: 25.3%, sitting on the 25% floor to a decimal
place. A hit landing inside one three-second window pushes it under and the
policy leaves; a rare auto-eat pushes it over and the fight holds for a minute
or two before grinding back down. That is exactly the mixture of 3.0s cycles and
occasional long holds in the log, and it is the same loop under both floor
values.

So the character was pinned at the floor *by* the guard meant to protect it, and
neither of the two conditions the guard names could change while the guard was
firing. A stop rule with no matching start rule does not merely fail to
terminate; it can hold the state that triggers it perfectly still.

The bill for that: death 56, and the Jeweled Necklace destroyed. Each cycle
re-entered a fight the character had not recovered from, and re-armed the death
penalty on gear the strip had been written to protect — see the next section for
how the restore put it back on.

The corollary for the fix: refusing to *start* is a wait, not a refusal. Out of
combat both floors mend themselves — hitpoints regenerate, `refillFood` and
`cookWhenFoodLow` restock the slot — so standing still gives them the chance the
thrash denied them, and the budget and no-movement detectors escalate if they do
not take it. That is the third question from *a guard that can starve its own
precondition*, answered before it was asked.

## The reflex tier reads a snapshot the policy tier owns

Same investigation, second defect, and it is measurable in the log to the
second: `reflex.restoreValuables` fired one second after every `combat.engage`,
and `reflex.stripValuables` one second after every `combat.disengage`. The pair
was inverted.

Reflexes run on a 1s throttle (`REFLEX_THROTTLE_MS`) against `lastSnapshot`,
which only refreshes on the 3s policy clock. So any reflex whose condition is
`inCombat` can act on a reading up to three seconds stale, and the restore
reading a pre-engage `inCombat: false` puts the valuables back on *during* the
fight the strip exists to protect them from — at the one moment
`applyDeathPenalty` can charge for it.

The strip side of that lag was anticipated and written down, one section above.
The restore side has the same lag and the opposite consequence, because it
undoes the protection rather than delaying it. `readPlayerHitpoints` already
exists for exactly this reason on exactly this tier, and its own doc comment
says so. The lesson that comment did not generalise: **every input a reflex
takes from the snapshot inherits the policy tier's clock, and the reflex tier
exists precisely because that clock is too slow.**

Worth being explicit that this was *not* the cause of the engage/disengage loop,
and that the log proves it rather than argues it: `disengageCombat` refuses when
`game.combat.isActive` is false, and it succeeded two seconds after each
restore. Equipping during a fight does not end the fight. The loop also predates
these two reflexes by twelve minutes.

## Equipped food is one set, not one per equipment set

Checked while chasing the food floor, because "the strip switched equipment sets
and the new set had no food" would have explained everything. It does not:
`EquipmentSet` holds `equipment`, `spellSelection` and `prayerSelection`
(equipment.d.ts:136-144) and no food, while `Player.food` is a single
`EquippedFood` on the player (player.d.ts:76). `changeEquipmentSet`
(player.d.ts:224) cannot change what the character eats.

Worth recording because the opposite is intuitive — the food UI sits with the
equipment UI — and because *a count in the bank is a claim, not an observation*
already established that the number that matters is the equipped one. It is the
equipped one, and there is exactly one of it.

## The combat triangle: the game states the shape, the source states the direction

`CombatManager.combatTriangle` (combatManager.d.ts:100) has existed all run and
nothing read it. The typings give the shape and none of the numbers:
`CombatTriangle` is `{ damageModifier, reductionModifier }`, each an
`AttackTypeObject<AttackTypeObject<number>>` (combatTriangle.d.ts:6-13), and the
values live in a static, `CombatTriangleSet.normalSetData`
(combatTriangle.d.ts:30), whose contents no `.d.ts` records.

The dangerous gap was not the values, which can be read live. It was the
**orientation**: `damageModifier[a][b]` reads equally well in either direction,
and a triangle applied backwards is not slightly wrong, it is advice that is
exactly inverted on every fight and looks confident. The shipped v1.3.1 source
settles it in one line — from the nw.js cache, `Character.applyTriangleToDamage`:

    damage *= this.manager.combatTriangle.damageModifier[this.attackType][target.attackType];

and the resistance path reads `reductionModifier[this.attackType][this.target.attackType]`.
First index is the attacker's own type, for both tables.

Three things that make hardcoding the numbers wrong, any one of them sufficient:

- The gamemode picks one of three tables — `Standard`, `Hardcore`,
  `InvertedHardcore` (combatTriangle.d.ts:1,25-27) via `Gamemode.combatTriangleType`
  (gamemode.d.ts:100) — and the inverted one reverses the whole triangle.
- An **area** can override the set outright. `CombatArea.combatTriangleSet`
  (combatAreas.d.ts:343) is what the getter prefers over
  `game.normalCombatTriangleSet` (game.d.ts:20), and the shipped data really does
  carry a `Reversed` set. `usesStandardCombatTriangle` (combatAreas.d.ts:337) is
  the game's own answer to "are the usual rules on here".
- The typings declare `combatTriangleSet` non-optional while the shipped getter
  still guards it with `?? this.game.normalCombatTriangleSet`. The game does not
  trust its own type; neither should we.

One trap in reusing the getter rather than mirroring it: `CombatManager.combatTriangle`
reads `this.selectedArea`, the area the player is *currently in*. Candidates are
enumerated when no area is selected, so asking it about a prospective fight in a
triangle-overriding area returns the default table with no error at all. The
area has to be passed in, not inferred from where the character is standing.

Finally, `Monster.attackType` is `AttackType | 'random'` (monsters.d.ts:106) and
the tables have three columns, not four. Five monsters in the shipped data are
random and three of them are currently on this character's candidate list, so
"there is no cell to look up" is a live case rather than a defensive one.

## A synergy that could be proposed and never assembled

`readSynergyCandidates` offers one half of a familiar pair at a time, which is
right. The slot it named was hardcoded to `melvorD:Summon1`, which meant the
second half was offered into the slot the first half had just been put in. Both
`equip_item` calls returned ok, both equipped the correct tablet, and the two
were never worn simultaneously — the only state in which a synergy applies
anything.

All 53 familiars list both `Summon1` and `Summon2` in `validSlots`
(item.d.ts:245), so the second slot was available the whole time. Nothing about
`Summon2` was ever read anywhere in the mod.

The shape is the one this repo keeps finding: two locally correct operations
composing into a cycle, with every individual call verifiable and the composite
invisible. It is the Steel Scimitar / Staff of Air swap loop again, and the tell
is the same — **when a feature's payoff requires two actions, the test is
whether the second one can survive the first.**

## Happiness is a multiplier on everything the town pays, and nothing had asked

`happiness` had been in the snapshot, in the summary, and in the build labels
for as long as the town has existed. Nothing had ever read it as anything but a
number to print, and it sat at 0 for a whole run without a single line of code
noticing. The typings cannot answer why: `currentHappiness` (township.d.ts:479)
is an undocumented number, and so are `population`, `education` and `health`
beside it.

The shipped v1.3.1 source answers it in four lines (township.js from the nw.js
cache, `learnings/mod-api.md` for the how):

```js
computeTownPopulation() { ... this.townData.population = applyModifier(population, this.townData.happiness); }
get currentPopulation() { return applyModifier(this.townData.population, this.townData.health, 3); }
get baseXPRate() { return this.currentPopulation; }
getGPGainRate() { const gain = this.currentPopulation * this.GP_PER_CITIZEN * (this.taxRate / 100); ... }
```

with `applyModifier(base, mod, 0)` = `floor(base × (1 + mod/100))` and type 3 =
`floor(base × (mod/100))` (f_000195.js:42). So the whole town is one chain:

**happiness → population → `currentPopulation` → Township XP per tick, and the
same figure × 15 × the tax rate → GP.** The GP is *real* GP: `addResources`
calls `this.game.gp.add(gpToAdd)`, not merely the town's own GP resource. Ticks
are `TICK_LENGTH` 300 seconds, so twelve an hour. Live, that is 184 population
at 90% health = 165 working citizens = 1,980 Township xp/h and about 7,400 GP/h,
none of it costing an action slot.

Three things worth keeping.

**Zero happiness is a foregone multiplier, not a fault.** The honest answer to
"why is happiness 0 and what is it costing" is that the town is not decaying and
nothing is being lost against a baseline — it is running at exactly 1.0x, and
every point is +1% of both rates, permanently and with no action slot spent.
"It is harmless" would have been wrong and "the town is broken" would have been
wrong; the useful sentence is the multiplier.

**`health` is the other multiplier and it is a different number from
`healthPercent`.** `townData.health` is 20..100, decays by one on 25% of ticks
once Township is level 15 (`applyPreTickTownUpdates`), floors at
`MINIMUM_HEALTH` 20, and is restored only by `increaseHealth`. It is the one
`currentPopulation` reads. `townData.healthPercent` is a *display* figure
computed as `(education + happiness) / 235 × 100` and nothing load-bearing reads
it — which is why the summary reading it once reported 0 on a healthy town. Two
fields, similar names, one of them the real thing.

**A per-building figure answers zero for the best move on the board.** Gardens
provide +0.5 happiness each. Against 184 population, `floor(184 × 1.005)` is
184 — one Garden is worth *nothing*, two are worth as much as a Wooden Hut, and
the twelve the town can afford are worth +6% of everything. Pricing a build one
at a time would have ranked the only source of happiness in reach below
buildings that provide nothing at all, with impeccable arithmetic the whole way.
The unit has to be the batch, because the flooring is not rounding noise: it is
where sub-integer provision disappears entirely.

## `getBuildingCountRemainingForLevelUp` is not about Township level

Every build candidate the agent has ever emitted carried the sentence *"N more
here reaches the next Township level"*. It was false on every one of them. From
the shipped source, the method is one line:

```js
getBuildingCountRemainingForLevelUp(building, biome) {
    return building.maxUpgrades - biome.getBuildingCount(building);
}
```

It counts down to the building being *maxed in that biome*, which is what
`isBuildingAvailable` gates the next building in the upgrade chain on. A real
and useful number, and not remotely the one the name promises. `maxUpgrades` is
20 for most buildings, so seventeen candidates all advertised "20 more here
reaches the next Township level" and nothing about the town levelled up when one
maxed. Township level comes from XP, and Township XP is population — an entirely
different lever, which is what `valueOfBuilding` now measures.

The operator paid for it directly: three Schools went up on the strength of the
sentence, and the fourth was refused with `melvorF:School is maxed in
melvorF:Grasslands`. The count was right about maxing the whole time. The
*sentence* was an inference from the method name, written once and then read as
a fact by everything downstream.

The rule this repo already has for accessors — verify against the typings — is
not enough here, because the typings carry the same misleading name and no
documentation to contradict it. **A name is not a specification, and a method
whose name makes a claim its signature cannot check is exactly where the shipped
source pays for itself.** Ten seconds of grep against the cache, against a label
that had been lying to every planning session for the life of the feature.

The related trap, which did *not* bite: the number does correctly reach 0 for a
maxed building, and the candidate reader already skips maxed buildings, so it
never counted anything unbuildable. The figure was accurate and its description
was wrong, which is the harder failure to see — a wrong number gets caught by
the next measurement, a wrong noun never does.

## A reservation must expire, or it starves what it protects

The bury reflex destroyed every Bone while a Township task asked for 10,000, and
the obvious fix was the one the sell guard already uses: withhold whatever
`readTaskWantedQuantities` names. That fix is wrong, in the shape *a guard that
can starve its own precondition* describes.

`readTaskWantedQuantities` walks **every task in the game**, not the ones
currently offered, because tasks rotate — correct for the sell guard, where
holding stock costs a bank slot and nothing else. Applied to burying it would
reserve 10,000 Bones permanently, and burying is the only source of prayer
points, which are the only source of Prayer XP, against a `prayer-20` goal
sitting at level 3. The guard would have protected a task that may never be
offered by making a goal unreachable.

What is reserved instead is the stock the **running objective** asked for
(`stockTargetsOf`). A task's wanted quantity is a hypothesis until a planner
adopts it; once `item_qty_at_least melvorD:Bones 10000` *is* the objective's own
success condition, burying them is the reflex tier undoing the objective tier —
the same failure as the sell reflex eating the raw fish out from under the cook.
With no such objective, bones are surplus again and Prayer gets them. The
reserve expires when the objective does, with no bookkeeping and no way to
forget to release it.

The generalisation, and it is the answer to "which of the three sell-versus-
consume gaps is this": **the right scope for a reservation is the narrowest one
that still covers the failure.** "Everything a task might ever want" covers the
failure and a great deal else; "what the agent is currently trying to bank"
covers it exactly. Only the surplus above the target is buried, so even an
adopted objective does not stall Prayer once the target is met.

## Township tasks are claimed, and that was worth checking rather than fixing

Asked whether finished Township tasks are ever actually handed in — producing
the goods being only half of it — the answer is yes, and the evidence is in the
logs rather than in the code reading right: `claimFinishedTasks` is wired into
the reflex tier (agent.ts), routes casual and permanent tasks to their separate
completion calls, and `data/logs/*.jsonl` holds seven `township.claimTask ok`
and six `township.claimCasualTask ok` with real before/after evidence
(`{"claimed":false} -> {"claimed":true}`, `remaining 4 -> 3`).

Recorded because "we checked and it works" is a result, and because the shape of
the check is the reusable part: the reflex existing proves nothing (this repo
has shipped four reflexes that fired forever and changed nothing), and the
`ok` lines with a moved projection are what actually settles it.

## The town's tax rate has no setter, and that was the answer rather than the obstacle

The town line reported `0 GP/h` against 165 working citizens. The formula is
`currentPopulation * GP_PER_CITIZEN * (taxRate / 100)`, and with the population
non-zero the only term that can zero it is the tax rate — so the reading was
that a slider had been left at zero for the life of the character. `taxRate` is
declared `get taxRate(): number` (township.d.ts:544) with **no setter anywhere
in `gameTypes/`**, which made it look like exactly the class of thing
`withTownBiome` and `withBuildQuantity` exist for: a value the game takes off
the screen through a UI callback the typings cannot express.

It is not that at all. From the shipped v1.3.1 source:

```js
get taxRate() {
    const baseRate = this.BASE_TAX_RATE;
    const modifier = this.game.modifiers.townshipTaxPerCitizen;
    return Math.min(baseRate + modifier, 80);
}
```

`BASE_TAX_RATE` is 0 — and unusually, the typings state the literal
(township.d.ts:405, `readonly BASE_TAX_RATE = 0`), so this half was checkable
without the cache and nobody had checked it. The rate *is* the modifier. The
game data (f_00000c.js) gives **Town Hall** `"modifiers": {
"townshipTaxPerCitizen": 10 }` with `"maxUpgrades": 8`, which is where the 80 in
the getter comes from: eight Town Halls is exactly the cap.

Three things follow, and each one closes a question rather than opening one.

**A missing setter is not evidence of a hidden UI callback.** That inference had
just been right twice in a row — `repairBuilding` and `buildBuilding` both read
selections their signatures do not mention — and a pattern that has paid off
twice is exactly when it gets applied without checking. The absence of a setter
is equally consistent with "this is not settable", and that was the case here.
The cache answers which in ten seconds; the guess would have sent someone
hunting for a callback that does not exist, which is most of the way to writing
a `withTaxRate` helper that scopes nothing.

**There is no trade-off, and the expectation that there would be was reasonable
and wrong.** Tax-versus-happiness is how such systems usually work, and
happiness is precisely the scarce term in this town — so the interaction, if it
existed, would have been the whole answer. Town Hall's `provides` entry is
`population: 0, happiness: 0, education: 0, storage: 0, resources: []`. It costs
resources and supplies tax and nothing else. No optimum to find, and the greedy
mistake ("set it to max") is not even available.

**A correct number with no cause is not a finished number.** Zero GP/h is
structural: Town Hall is tier 5, which `populationForTier` (township.d.ts:418)
gates on Township level 80 and 40,000 population, against a town at 33 and 184.
Nothing is misconfigured and nothing can be done about it for a very long time.
Reporting the bare zero cost an operator an investigation within a day of the
line shipping, and it would have cost the next reader the same one. The rule
this repo already has — *a number computed for a sentence is invisible to the
code* — has a mirror image: **a number with no explanation is visible to
everybody and useful to nobody, and it bills every reader the same hour.**
Explaining a zero is not noise-in-the-normal-case; the unexplained zero was the
noise, because it read as an alarm.

The corollary that made this cheap to get right: the explanation stops the
moment the tax rate is above zero, and the building is found from the registry's
own `stats.modifiers` (statProvider.d.ts:21) rather than hardcoded, so nothing
here is a fact about the day it was written.

### The half of it that was our own overstatement

The happiness line shipped the day before said every point of happiness is
`+1% of both figures above` — the XP rate and the GP rate. One percent of a zero
GP rate is zero, so while the town is untaxed happiness buys Township XP and
nothing else. The sentence was derived correctly from the formula and was wrong
about today, which is the same failure as an advertised rate that has never been
measured. A claim scoped to "in general" and read as "right now" is worth less
than no claim; the line is now scoped to whatever the town is actually paid in.

## The town's population is always one decay round stale, and the guard was right

`valueOfBuilding` refused to price anything on the live town: the transcribed
model read 176 against the game's 178, happiness was 0 so there was no
percentage to round, and the flat ±1 tolerance called it a drift. The
transcription was correct the whole time. `computeTownPopulation` in the shipped
v1.3.1 source is character-for-character what the adapter does.

The answer is in the tick, three lines down (township.js, nw.js cache — see
`learnings/mod-api.md`):

```js
tick() {
    ...
    this.computeWorshipAndStats();     // writes townData.population
    this.reduceAllBuildingEfficiency(1);
    this.updateAllBuildingProvidedStatsMultiplier();
```

**The game recomputes the town's stats and then degrades efficiency, in that
order, and there is exactly one decay call site in the whole file.** So
`townData.population` permanently describes the efficiencies of one tick ago,
and anything that recomputes from *current* efficiency is always the lower of
the two. The model was not drifting; it was ahead.

Two off, rather than a fraction, because of the second half:

```js
reduceBuildingEfficiency(building, amount, game) {
    let newEfficiency = this.getBuildingEfficiency(building) - amount;
    newEfficiency = Math.max(20 + game.modifiers.minimumTownshipBuildingEfficiency, newEfficiency);
```

`buildingEfficiency` is a `Map<TownshipBuilding, number>` on the *biome*
(township.d.ts:33) — **one entry per building type, not per copy.** Every hut in
a biome shares a single efficiency number, so one point of decay is 1% of the
whole stack at once. 184 huts at +1 population each is 1.84 citizens gone in one
roll; twenty at +10 each would be two. A per-instance mental model predicts a
drift of hundredths and would have sent the next reader hunting for a missing
population source that does not exist — a season, a worship bonus, a modifier
from outside Township. None of them contribute. There is exactly one writer of
`townData.population` in the entire shipped file, and its inputs are the loop
the adapter already had.

Three things worth keeping.

**A tolerance is a claim about a mechanism, and a constant cannot make one.**
The ±1 was chosen for a rounding argument and then asked to absorb a
degradation round, which is a different quantity and one that scales with the
town. The band is now computed in the same walk that sums the population — how
much a single decay round could remove, respecting the same three gates the game
applies (`canDegrade` township.d.ts:130, `hasBuildingBeenUpgraded` :558, and the
`20 + minimumTownshipBuildingEfficiency` floor) — so it tightens as stacks reach
the floor instead of staying loose forever. A guard whose tolerance does not
know why it is tolerating will either fire on the normal case or miss the
abnormal one, and this one did the first for a day.

**The half that survives the guard is the arithmetic downstream of it.** Even
with the band widened, `valueOfBuilding` was still differencing a *modelled*
projection against the game's *stale* live rate. At this town that is a two
citizen head start the build has to pay off before it prices at anything, and
one Wooden Hut is worth one citizen — so a real gain clamped to zero, silently,
with the guard green. Both ends of a delta have to come from the same model;
mixing a projection with a live reading is the same class of error as comparing
an advertised rate against a measured one and calling the difference profit.

**`TICK_LENGTH` is 3600, not 300, and the entry above says otherwise.** Found
while checking the rate arithmetic: the class initialises `TICK_LENGTH = 300`,
then `preLoad` does `this.TICK_LENGTH = this.PASSIVE_TICK_LENGTH` — stated as
the literal 3600 in the typings (township.d.ts:403) — and nothing anywhere sets
it back. A loaded save ticks **once an hour**. The adapter read it live and was
right; the happiness entry above did the arithmetic by hand and is out by
twelve, so its "1,980 Township xp/h and about 7,400 GP/h" should read 165 and
about 620. The reusable part: a constant that is *reassigned at load* looks like
a constant in both the initialiser and the `.d.ts`, and only the running game or
the one line in `preLoad` contradicts it — which is why the dashboard's
`ticksPerHour: 1` was worth reading before trusting either.

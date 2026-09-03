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

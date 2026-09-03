# Adapter API

<!--
  GENERATED FILE — do not edit by hand.
  Source: packages/mod/src/adapter/index.ts
  Regenerate: pnpm docs:api   Verify: pnpm docs:api:check (CI runs this)
-->

Every Melvor API touchpoint in this repo lives behind these exports. Nothing
outside `packages/mod/src/adapter/` may call a game function, so a game update
breaks exactly one directory.

Two invariants hold across the whole surface:

- **No action returns `void`.** Each returns an `ActionResult` carrying before/after
  evidence, because the game's own return conventions are inconsistent and a
  non-throwing call proves nothing.
- **Nothing acts during offline progress.** Actions take an `isSuspended` guard and
  fail with reason `suspended` rather than acting mid catch-up.

219 exports.

## `act`

`function`

Runs a game action and returns evidence that it worked.

A game call returning without throwing does not mean it worked: requirements
can be unmet, the wrong screen can be open, an offline tick can swallow it.
Worse, the game's own return conventions are inconsistent —
`Player.equipItem` returns boolean, `Player.equipFood` returns
`boolean | undefined`, and `Bank.removeItemQuantity` and
`Woodcutting.selectTree` return `void`. So the return value is recorded as
*supporting* detail, never as the verdict; the verdict is the before/after diff.

```ts
act: <T>(spec: ActSpec<T>, isSuspended: () => boolean) => ActionResult<T>
```

## `ActionResult`

`type`

The contract every adapter action returns. Never `void`.

On success it carries the before/after projection that *proves* the state
changed, so callers verify evidence rather than trusting a return code.

```ts
ActionResult: any
```

## `ActivatablePrayer`

`interface`

A prayer that can be switched on now, and what it costs to run.

```ts
ActivatablePrayer: any
```

## `ActiveActionState`

`type`

```ts
ActiveActionState: any
```

## `ActSpec`

`interface`

Options for a single verified action.

```ts
ActSpec: any
```

## `AdapterFailure`

`interface`

One site's failure tally, with the most recent reason.

```ts
AdapterFailure: any
```

## `addSidebarPanel`

`function`

Registers the agent's sidebar entry.

`sidebar` is a global, not part of the mod context. Categories and items are
get-or-create, so this is safe to call more than once — a reload that
re-registers will configure the existing entry rather than duplicating it.

```ts
addSidebarPanel: (options: SidebarPanelOptions) => PanelHandle
```

## `advanceGolbinRaid`

`function`

Takes the next decision a running raid is waiting on.

A raid is a state machine that *stops* until someone chooses, so this is
called repeatedly rather than once: modifiers at the start, a category and an
item between waves, and nothing at all while a wave is being fought.

The choices are deliberately simple — the first offered modifier, the first
offered item. A cleverer chooser would need to model raid scaling, and being
wrong there is indistinguishable from being unlucky. Choosing *something*
promptly is worth far more than choosing well slowly, because a raid waiting
on a modal earns nothing at all.

```ts
advanceGolbinRaid: (isSuspended: () => boolean) => ActionResult<RaidProjection>
```

## `ARTISAN_SKILL_IDS`

`const`

The six skills that inherit `ArtisanSkill`.

Unlike the gathering skills, these genuinely do share one API — `ArtisanSkill`
defines `selectRecipeOnClick`, `selectedRecipe`, `createButtonOnClick` and
`getRecipeCosts` for all of them — so one verified routine covers all six.
This is a real shared base class in the game's own hierarchy, not an
abstraction invented here.

```ts
ARTISAN_SKILL_IDS: readonly ["melvorD:Smithing", "melvorD:Crafting", "melvorD:Fletching", "melvorD:Herblore", "melvorD:Runecrafting", "melvorD:Summoning"]
```

## `AstrologyProjection`

`interface`

What upgrading claims to change.

```ts
AstrologyProjection: any
```

## `BankState`

`type`

```ts
BankState: any
```

## `buildAgilityObstacle`

`function`

Builds an agility obstacle into its slot.

`buildObstacle` returns `void` and refuses silently when the costs are not
met, so the slot's occupant is observed either side. The obstacle's own
category decides the slot — passing one would let a stale plan overwrite a
different part of the course than it meant to.

```ts
buildAgilityObstacle: (obstacleId: string, isSuspended: () => boolean) => ActionResult<ObstacleProjection>
```

## `buildTownshipBuilding`

`function`

```ts
buildTownshipBuilding: (buildingId: string, biomeId: string, isSuspended: () => boolean) => ActionResult<TownshipProjection>
```

## `BuriableBones`

`interface`

A bone stack in the bank, with what burying it is worth.

```ts
BuriableBones: any
```

## `buryBones`

`function`

Buries bones for Prayer XP and Prayer points.

The only source of both. Prayer cannot be trained any other way, and prayers
cannot be used without points, so bones left in the bank are the whole skill
left unplayed — and combat produces them steadily whether or not anything
uses them.

**Burying grants prayer points, not Prayer XP.** Verified live: 52 bones went
from the bank and Prayer XP stayed at 0. The XP comes later, from *spending*
those points during combat. Requiring XP to rise made every successful bury
report as a no-op and retry.

`buryItemOnClick` returns void and silently does nothing for a non-bone, so
the evidence taken is the stack falling while points do not fall. Points are
not required to rise, because they cap: burying into a full bar is wasteful
but not a failure to observe.

```ts
buryBones: (itemId: string, quantity: number, isSuspended: () => boolean) => ActionResult<{ held: number; prayerPoints: number; }>
```

## `buyShopPurchase`

`function`

Buys from the shop.

Shop purchases are the transition the wiki corpus exists to advise on — which
upgrades matter first is the classic thing game data alone does not encode.
The agent may spend, so this is permitted, but three guards apply:

- Requirements are checked through the game's own `checkRequirements`, with
  notifications suppressed so an unattended agent does not spam the UI.
- Affordability is checked through `getPurchaseCosts(...).checkIfOwned()`
  rather than by reimplementing cost scaling, which changes per purchase.
- {@link categoricalRefusal} blocks gambles and unique items outright.

`buyItemOnClick` returns `void` and normally raises a confirmation modal; it
is called with `confirmed = true` because an unattended agent has nobody to
answer it. Success is established by observing the owned count rise.

```ts
buyShopPurchase: (purchaseId: string, quantity: number, isSuspended: () => boolean) => ActionResult<PurchaseProjection>
```

## `Candidate`

`type`

```ts
Candidate: any
```

## `CATEGORICALLY_REFUSED`

`const`

Actions the agent will never take, at any autonomy level.

These are refused categorically rather than escalated to the operator: an
agent running unattended for days has nobody to ask, and "ask" degrades into
"block forever" or, worse, "assume yes".

There is deliberately no adapter function for any of these, so this list is
documentation of an absence rather than a runtime check that could be
bypassed. It exists so the omission is legible, and so a future contributor
adding one of these trips over the reason first.

```ts
CATEGORICALLY_REFUSED: readonly ["destroying unique or one-of-a-kind items", "spending one-time tokens or consumable unlock items", "permanent character choices (gamemode, ironman, skill resets)", "deleting or overwriting save slots"]
```

## `changeEquipmentSet`

`function`

Switches to another equipment set.

Sets are how a human keeps a skilling loadout and a combat loadout without
re-equipping eight items each time. Without this the agent has one set and
pays the full swap cost for every context change — which in practice means
it never changes context at all.

```ts
changeEquipmentSet: (setIndex: number, isSuspended: () => boolean) => ActionResult<{ setIndex: number; }>
```

## `CharacterSettings`

`class`

```ts
CharacterSettings: typeof CharacterSettings
```

## `ChargedEquipment`

`interface`

A worn item that spends charges, and how many it has left.

```ts
ChargedEquipment: any
```

## `checkCharacterAllowed`

`function`

Whether this character may be automated.

The agent is meant to run on a throwaway character. An empty allowlist means
"refuse everything" rather than "allow everything": a misconfigured agent must
fail closed, since the failure mode is days of unattended play on the wrong save.

```ts
checkCharacterAllowed: (characterName: string, allowlist: readonly string[]) => string | null
```

## `checkRealmAllowed`

`function`

Whether the currently selected realm is refused.

```ts
checkRealmAllowed: () => string | null
```

## `chooseEventPassive`

`function`

Chooses one of the passives an event is waiting on.

Between stages the event stops and offers a choice. Until it is made the run
is frozen — no fighting, no progress, no XP — so answering promptly matters
more than answering cleverly.

```ts
chooseEventPassive: (passiveId: string | undefined, isSuspended: () => boolean) => ActionResult<EventProjection>
```

## `claimCasualTask`

`function`

Claims a completed casual (daily) task.

Separate registry, separate completion call, and a five-task limit that
*blocks new ones* — an unclaimed casual task does not just withhold its own
reward, it stops the next task from arriving. That makes claiming these more
urgent than the permanent ones.

```ts
claimCasualTask: (taskId: string, isSuspended: () => boolean) => ActionResult<{ taskId: string; remaining: number; }>
```

## `claimMasteryToken`

`function`

Claims a Mastery Token, pouring its percentage into the skill's mastery pool.

Tokens were invisible to this agent in the worst possible way: not merely
unclaimable, but offered *for sale*. `readOpenableCandidates` filters on
`instanceof OpenableItem` and a `MasteryTokenItem` is a sibling class, not a
subclass — so the container reflex could never see one, while the sell reader,
which filters on nothing of the sort, happily listed six Woodcutting tokens
as a stack to liquidate.

One caveat carried deliberately into the code. Unlike opening — where
`openItemOnClick` raises a confirmation nothing here will answer and
`processItemOpen` does the real work — the typings expose *only*
`claimMasteryTokenOnClick`. There is no process-level counterpart to call, so
this uses the click callback knowing it may raise a modal, which would show
up as a no-state-change failure rather than a silent success.

That is why the evidence is the pool, not the bank. A token leaving the bank
proves a click landed; mastery pool XP rising proves the claim actually paid
out, and it distinguishes the case where the pool is already full.

```ts
claimMasteryToken: (itemId: string, quantity: number, isSuspended: () => boolean) => ActionResult<{ held: number; poolXp: number; }>
```

## `claimTownshipTask`

`function`

Claims a completed Township task.

Tasks are the town's reward loop: they complete themselves as the character
plays, and then sit there paying nothing until someone presses claim. A human
collects them in passing; an agent that never does accumulates finished tasks
indefinitely, which is a pure loss — the work is already done.

`completeTask` takes `giveRewards` and `forceComplete` flags. Rewards are
requested and forcing is not: forcing would claim a task whose goals are
unmet, which is cheating the game rather than playing it.

```ts
claimTownshipTask: (taskId: string, isSuspended: () => boolean) => ActionResult<{ taskId: string; claimed: boolean; }>
```

## `collectCookedStockpile`

`function`

Collects one category's passive-cooking output into the bank.

`onCollectStockpileClick` is the UI callback, and this codebase's standing
rule is that OnClick is the UI path rather than the operation. It is used
here because the typings expose no process-level counterpart -- `cooking.d.ts`
has `addItemToStockpile`, `getStockpileSnapshot` and this, and nothing else
that empties it. The same was true of `claimMasteryTokenOnClick`. The rule
exists to stop the UI path being reached for out of convenience, not to
forbid it where it is the only door.

Evidence is the stockpile emptying, so a click that silently does nothing is
reported as `no_state_change` rather than as success.

```ts
collectCookedStockpile: (categoryId: string, isSuspended: () => boolean) => ActionResult<{ quantity: number; }>
```

## `collectLoot`

`function`

Collects everything in the combat loot container.

Kills drop into a container that holds a fixed number of stacks and then
starts *discarding* — the game tracks what was lost in `lostLoot`. Nothing
announces this: the fight looks healthy, the XP keeps coming, and every drop
silently evaporates. An agent fighting unattended for hours would collect
nothing at all, which makes combat pure XP and no materials.

That matters beyond the items: bones feed Prayer, hides feed Crafting, and
the Township tasks ask for monster drops by name.

```ts
collectLoot: (isSuspended: () => boolean) => ActionResult<LootProjection>
```

## `CombatProjection`

`interface`

What engaging claims to change.

```ts
CombatProjection: any
```

## `CombatState`

`type`

```ts
CombatState: any
```

## `compostFarmPlot`

`function`

Applies compost to a plot.

Compost raises the harvest yield and, more importantly, stops crops dying —
a dead plot is the whole growth cycle wasted, and an unattended agent is
exactly who cannot notice one. Buying compost and never applying it, which
is what the shop capability alone allowed, is strictly worse than not buying
it.

`compostPlot` returns a boolean, so the plot's compost level is observed
either side instead.

```ts
compostFarmPlot: (plotId: string, compostId: string, amount: number, isSuspended: () => boolean) => ActionResult<{ plotId: string; compostLevel: number; }>
```

## `ConversionProjection`

`interface`

What a conversion claims to change: bank down, town resource up.

```ts
ConversionProjection: any
```

## `convertItemToTownship`

`function`

Trades bank items to the town for a resource.

`processConversionToTownship` returns void, and the quantity is *staged*
separately by `updateConvertToQty` rather than passed in — so both sides are
observed instead: the item leaving the bank and the resource arriving.

```ts
convertItemToTownship: (itemId: string, resourceId: string, quantity: number, isSuspended: () => boolean) => ActionResult<ConversionProjection>
```

## `convertTownshipToItem`

`function`

Trades the town's resources back for items.

Long treated as rarely worth doing — the town needs its resources more than
the bank needs another log — and so left unoffered. That reasoning holds for
logs and fails badly for anything the town alone can make: `Herbs → Herb Box`
yields finished herbs, which is Herblore's input and the only route to it
that does not run through Farming. A capability nothing offers is a
capability that does not exist, which is how Herblore stayed unreachable.

```ts
convertTownshipToItem: (resourceId: string, itemId: string, quantity: number, isSuspended: () => boolean) => ActionResult<ConversionProjection>
```

## `createDigSiteMap`

`function`

Creates a new map for a dig site.

The missing half of Archaeology, and the reason the skill quietly disappears.
Maps are consumable: each carries charges, `canExcavate` goes false when the
selected map runs out, and every Archaeology candidate vanishes with it. The
agent could select a map and dig with one, but nothing in the whole candidate
list could make one — so it made paper indefinitely and never turned any of
it into a dig, with no signal that the chain had a missing link rather than
simply being unprofitable.

Creation lives on Cartography rather than Archaeology, which is why it was
easy to miss: `getMapCreationCosts` (cartography.d.ts:384) prices it and
`createNewMapForDigSite` (cartography.d.ts:389) performs it, and the typings
state the cap of three maps per dig site there while `getMaxMaps`
(archaeology.d.ts:95) is the number to ask.

```ts
createDigSiteMap: (digSiteId: string, isSuspended: () => boolean) => ActionResult<{ maps: number; charges: number; }>
```

## `disengageCombat`

`function`

Stops combat.

Combat cannot be exited cleanly mid-fight, so this is called at a kill
boundary by the runtime backup monitor rather than the instant a floor is
crossed — taking the gap early is the whole point of that monitor.

```ts
disengageCombat: (isSuspended: () => boolean) => ActionResult<CombatProjection>
```

## `Disposer`

`type`

Undoes a subscription. Every listener the mod creates returns one of these.

```ts
Disposer: any
```

## `dumpRegistries`

`function`

```ts
dumpRegistries: () => KnowledgeDump
```

## `eatFood`

`function`

Eats one item from the equipped food slot.

`Player.eatFood` returns void and silently does nothing with an empty slot,
so healing is proved by hitpoints rising and the slot falling — either alone
is ambiguous. A heal at full HP raises nothing, which is why the caller is
responsible for only asking when it is low.

`interrupt: false` — eating must not stop the fight it is keeping alive.

```ts
eatFood: (isSuspended: () => boolean) => ActionResult<{ hp: number; quantity: number; }>
```

## `engageMonster`

`function`

Engages a monster in an area.

Callers must have already cleared the survivability gate; this function does
not run it. That split is deliberate — the gate is pure and testable, and
mixing it into the action would make it untestable and easy to bypass. The
runtime is the only caller and it refuses to reach here without a verdict.

```ts
engageMonster: (monsterId: string, areaId: string, isSuspended: () => boolean) => ActionResult<CombatProjection>
```

## `equipFood`

`function`

Equips food.

Separate from {@link equipItem} because food has its own slots and its own
game method. `Player.equipFood` returns `boolean | undefined`, which is the
clearest example in the codebase of why a return value is not evidence: a
truthiness check is simply wrong for it.

```ts
equipFood: (itemId: string, quantity: number, isSuspended: () => boolean) => ActionResult<{ itemId: string | null; quantity: number; }>
```

## `equipItem`

`function`

Equips an item from the bank.

`Player.equipItem` returns a boolean, but a `true` return does not prove the
slot changed — so the slot's occupant is observed either side, which is the
only evidence that holds.

The slot is taken from the item's own `validSlots` rather than guessed. An
item can be valid in several (a shield in Shield, a torch in Passive), and
picking the wrong one silently no-ops.

```ts
equipItem: (itemId: string, slotId: string | undefined, isSuspended: () => boolean) => ActionResult<EquipProjection>
```

## `EquipProjection`

`interface`

What equipping claims to change: which item occupies the slot.

```ts
EquipProjection: any
```

## `EventProjection`

`interface`

What starting or advancing an event claims to change.

```ts
EventProjection: any
```

## `excavateDigSite`

`function`

Starts excavating a dig site.

`canExcavate` is the game's own answer to "is this actually doable" — it
accounts for the map, its charges and the selected tools, all of which fail
silently otherwise. Reimplementing that check here would be the classic way
to get it subtly wrong.

```ts
excavateDigSite: (digSiteId: string, isSuspended: () => boolean) => ActionResult<{ digSiteId: string | null; active: boolean; }>
```

## `ExpendableStack`

`interface`

A stack the guards permit, and how much of it may actually go.

`quantity` is the sellable portion — what is held minus anything an open
Township task is asking for — and not the bank count. The distinction is the
whole reason this shape exists. `saleExclusionReason` withholds a stack only
while it *fails* to cover a task's ask, so once 582 Gold Bars are held against
a task wanting 100 the stack becomes sellable, and every caller that then
asked the bank how many there were sold all 582. The candidate path never had
that bug: it carries `keepQuantity` and the `sell_items` executor subtracts
it, which is why an operator selling by hand kept 100 of every 582 each time
while the reflex beside it would not have.

So the reserve is computed once, here, alongside the guard that established
it — the same argument that keeps `saleExclusionReason` private to this
module. A caller cannot honour it by accident and cannot skip it by accident.

```ts
ExpendableStack: any
```

## `exportSave`

`function`

Produces the save-export string.

Uses `game.generateSaveString()` rather than the global `exportSave()`, which
drives the export modal — useless to an unattended agent. The string is
handed to the planner service, which is the only component that can write to
disk.

```ts
exportSave: () => { ok: true; save: string; } | { ok: false; detail: string; }
```

## `FailureReason`

`type`

```ts
FailureReason: any
```

## `FARMING_ID`

`const`

```ts
FARMING_ID: "melvorD:Farming"
```

## `FarmPlotState`

`interface`

```ts
FarmPlotState: any
```

## `FightPricing`

`interface`

A fight priced: the numbers that separate one monster from another.

```ts
FightPricing: any
```

## `FISHING_ID`

`const`

```ts
FISHING_ID: "melvorD:Fishing"
```

## `GATHERING_SKILL_IDS`

`const`

```ts
GATHERING_SKILL_IDS: readonly ["melvorD:Woodcutting", "melvorD:Mining", "melvorD:Fishing"]
```

## `GatheringProjection`

`interface`

What "am I gathering the right thing" looks like, uniformly.

Every skill projects into this shape so callers compare like with like even
though the underlying selection state differs wildly.

```ts
GatheringProjection: any
```

## `harvestFarmPlot`

`function`

Harvests one plot.

`harvestPlot` returns a boolean, but a `true` return does not prove the plot
actually emptied, so the state transition is what is verified. Dead crops are
harvested too — that is how the plot is cleared for replanting.

```ts
harvestFarmPlot: (plotId: string, isSuspended: () => boolean) => ActionResult<{ state: string; recipeId: string | null; }>
```

## `hasAutoEat`

`function`

Whether Auto Eat is owned, which feeds from the bank and needs no reflex.

```ts
hasAutoEat: () => boolean
```

## `increaseTownHealth`

`function`

```ts
increaseTownHealth: (resourceId: string, amount: number, isSuspended: () => boolean) => ActionResult<{ healthPercent: number; }>
```

## `isArtisanSkill`

`function`

Whether an id names one of the artisan skills.

```ts
isArtisanSkill: (skillId: string) => skillId is ArtisanSkillId
```

## `isMiscSkill`

`function`

Whether an id names one of the individually-routed skills.

```ts
isMiscSkill: (skillId: string) => skillId is MiscSkillId
```

## `isRefusedRealm`

`function`

Whether a realm is on the hard refusal list.

```ts
isRefusedRealm: (realmId: string) => boolean
```

## `LapsingPotion`

`interface`

A potion that will lapse when its charges run out, with a replacement banked.

```ts
LapsingPotion: any
```

## `loadCharacterByName`

`function`

Enters the game as the named character, from the character-select screen.

A reload lands here and stops: the agent is not running, the service reports
nothing, and the run idles until a human clicks. Overnight that is the whole
night. Since the mod's own `onCharacterSelectionLoaded` hook proves it is
alive on this screen, the click is automatable and there is no good reason
for a person to be the one making it.

Refuses on anything ambiguous. Zero matches means the expected character is
not here and guessing would enter the wrong save; more than one match means
the name does not identify a character, and picking the first would be a coin
toss with someone's run. In both cases doing nothing leaves the screen up for
a human, which is exactly where this started and is a safe place to stop.

```ts
loadCharacterByName: (name: string) => ActionResult<{ slotId: number; }>
```

## `MasteryProjection`

`interface`

What spending the pool claims to change.

```ts
MasteryProjection: any
```

## `MINING_ID`

`const`

```ts
MINING_ID: "melvorD:Mining"
```

## `MISC_SKILL_IDS`

`const`

Skills that share no base class with anything else and need their own routine.

Each entry below was read out of the typings individually. The variety is the
point: Firemaking selects a log then burns it, Cooking selects per *category*
and starts per category, Thieving takes an area and an NPC together, Astrology
has a single study call, Agility runs a whole prebuilt course with no per-item
selection at all, and Harvesting clicks a vein. Any shared abstraction across
these would be invented rather than observed.

```ts
MISC_SKILL_IDS: readonly ["melvorD:Firemaking", "melvorD:Cooking", "melvorD:Thieving", "melvorD:Astrology", "melvorD:Agility", "melvorD:Magic", "melvorItA:Harvesting"]
```

## `ModifierGear`

`interface`

Owned gear whose value is in modifiers rather than in equipment stats.

```ts
ModifierGear: any
```

## `newSlayerTask`

`function`

Takes a new Slayer task.

Slayer is a progression system a human drives by hand: take a task, kill it,
take another. Without this the agent can fight monsters but can never earn
Slayer XP or the coins that unlock its shop.

```ts
newSlayerTask: (categoryId: string, payWithCoins: boolean, isSuspended: () => boolean) => ActionResult<{ monsterId: string | null; remaining: number; }>
```

## `Objective`

`type`

```ts
Objective: any
```

## `ObstacleProjection`

`interface`

What building claims to change: which obstacle occupies a slot.

```ts
ObstacleProjection: any
```

## `onGameEvent`

`function`

Subscribes to a `Game` event and returns a disposer.

`GameEventEmitter` wraps mitt and exposes only `on` / `off` — there is no
`once` and no built-in unsubscribe handle. An unattended agent that leaks
listeners across reloads will double-fire its reflexes, so every subscription
is wrapped here and the kill switch disposes all of them.

The emitter is typed against the `GameEvents` map, so an event-name typo is a
compile error rather than a silently dead listener.

```ts
onGameEvent: <K extends keyof GameEvents>(event: K, handler: (payload: GameEvents[K]) => void) => Disposer
```

## `onGameLoop`

`function`

Runs a handler after every game loop tick.

This is what makes the reflex tier genuinely per-tick rather than a timer
approximating one. Patching is the only way to hook the loop, so it lives
here with every other game touchpoint.

The hook is a `function`, not an arrow: patch hooks are invoked with `this`
bound to the patched instance, and an arrow would silently capture module
scope instead. Nothing here needs `this`, but the habit is the one that
matters — the failure is quiet when it does.

```ts
onGameLoop: (ctx: Modding.ModContext, handler: () => void) => Disposer
```

## `openItem`

`function`

Opens a container item — bird nests, chests, loot bags.

These sit in the bank looking like ordinary items and are the game's way of
handing out things that have no other source. Bird nests hold Farming seeds,
which is the only reachable seed supply for a character whose Thieving tier
is too low to drop them — so an agent that cannot open a nest cannot start
Farming, and therefore cannot start Herblore either.

The open call returns void and the contents are random, so the evidence is
the container leaving the bank rather than any particular reward arriving.

```ts
openItem: (itemId: string, quantity: number, isSuspended: () => boolean) => ActionResult<{ held: number; bankSlots: number; }>
```

## `PanelHandle`

`interface`

Lets callers remove the sidebar entry again; the kill switch uses it.

```ts
PanelHandle: any
```

## `PassiveCookProjection`

`interface`

What starting passive cooking claims to change.

```ts
PassiveCookProjection: any
```

## `PersistenceHealth`

`interface`

```ts
PersistenceHealth: any
```

## `plantFarmPlot`

`function`

Plants a seed in one plot.

`plantPlot` returns a number rather than a boolean, and what that number
means is not documented in the typings — another reason the observed state
change is the verdict rather than the return value.

```ts
plantFarmPlot: (plotId: string, recipeId: string, isSuspended: () => boolean) => ActionResult<{ state: string; recipeId: string | null; }>
```

## `PurchaseProjection`

`interface`

What buying claims to change: one more owned, some currency gone.

```ts
PurchaseProjection: any
```

## `RaidProjection`

`interface`

What a raid action claims to change.

```ts
RaidProjection: any
```

## `readActivatablePrayers`

`function`

Prayers the character can switch on right now, cheapest to run first.

Prayer is the one skill in the game with no action of its own. Burying bones
grants points and no XP — verified live, 52 bones for zero XP — and the XP
comes only from *spending* those points during a fight. So a prayer being
active is not a buff decision, it is the entire training method, and Prayer 20
was unreachable by construction while nothing ever turned one on.

Cheapest first is deliberate and is not about efficiency. The point is to
spend points steadily for as long as the bones last; an expensive prayer
empties the bar in a handful of swings and then the reflex that drops
unpayable prayers switches it off again.

Two exclusions, both from the game's own data rather than from a name:

- `useSoulPoints` prayers (prayer.d.ts:36) spend Soul Points, a different
  currency with a different source, so a check on prayer points says nothing
  about whether they can be paid for.
- `canUseWithDamageType` (prayer.d.ts:39) against the player's own damage type
  (character.d.ts:100), because a prayer the character cannot use is one the
  game silently refuses — the same shape as selecting a spell without runes.

```ts
readActivatablePrayers: () => ActivatablePrayer[]
```

## `readActivePrayerIds`

`function`

Prayers currently switched on.

Read live rather than from the snapshot, which carries prayer points but not
the prayers spending them. Both prayer reflexes need it: one to know there is
something to drop, the other to know there is nothing to add to.

```ts
readActivePrayerIds: () => string[]
```

## `readActiveRecipeIds`

`function`

The recipes the active skill is running.

Empty when nothing is active, and also when the skill's selection could not
be read — the caller treats "cannot tell" the same as "not the one I want",
which restarts the action. Restarting the right recipe is cheap; running the
wrong one for an hour is not.

```ts
readActiveRecipeIds: () => string[]
```

## `readAdapterFailures`

`function`

Every site that has failed, worst first.

Cumulative for the run rather than drained per report, because the question
an operator asks at 8am is "what has been failing all night", and a counter
that resets every three seconds cannot answer it.

```ts
readAdapterFailures: () => AdapterFailure[]
```

## `readAgilityCandidates`

`function`

Obstacles worth building right now.

Only affordable, unlocked obstacles that would *replace something worse* —
an empty slot, or a lower-level obstacle in the same category. Offering every
buildable obstacle would invite the agent to rebuild the same slot back and
forth, paying the cost each time for no gain.

```ts
readAgilityCandidates: () => Candidate[]
```

## `readAllSeedIds`

`function`

Every seed the farm can ever plant, at any level.

Deliberately unfiltered by level, which is the whole point. Seeds for crops
the character cannot plant yet are not surplus — they are exactly the stock
that becomes useful as Farming rises, and the sell list was offering 32
Ancient Corn Seeds and 30 Ancient Carrot Seeds while Farming sat at level 1
blocking the only untrained skill left in scope.

A seed is worth a few GP and a harvest is worth Farming XP, which is the
scarce thing here; there is no bank balance at which that trade is correct.
Selling seeds is not a judgement the planner should be offered.

```ts
readAllSeedIds: () => Set<string>
```

## `readAstrologyCandidates`

`function`

Constellation upgrades that are affordable now.

Stardust is only ever earned by studying constellations and has no other use,
so unspent stardust is progress the character has already paid for and not
collected. Standard modifiers come first because their cost curve is far
shallower than the unique ones.

```ts
readAstrologyCandidates: () => Candidate[]
```

## `readBankedFood`

`function`

```ts
readBankedFood: () => { itemId: string; quantity: number; heals: number; }[]
```

## `readBankExpansion`

`function`

The shop's bank-slot purchase, or null when it is unavailable or unaffordable.

```ts
readBankExpansion: () => { purchaseId: string; gpCost: number; held: number; } | null
```

## `readBankPressure`

`function`

Warns when the bank is about to stop the character working, and reports what
it has already destroyed.

A full bank does not announce itself. Gathering an item type the bank has no
room for simply produces nothing, while the skill keeps running and the XP
keeps ticking — so an agent watching only "is the skill active" sees a
perfectly healthy run that is quietly throwing away every drop.

The loss line is separate from the pressure line and deliberately not gated on
free slots. A discard that has already happened is a fact whatever the bank
looks like now — a slot bought since, or a stack sold, does not bring the
items back — and the two lines answer different questions: one is a countdown,
the other is a receipt. See {@link readLostItems} for what the receipt covers.

Reported rather than fixed. The remedies are selling something or buying a
slot, both of which are decisions with costs, and both of which the agent
already has capabilities for — and both of which now have a measured number to
argue with instead of a warning about the future.

```ts
readBankPressure: () => { label: string; xpPerHour: number; severity: BlockedSeverity; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readBankQuantity`

`function`

Quantity of an item held in the bank.

```ts
readBankQuantity: (itemId: string) => number
```

## `readBlockedOpportunities`

`function`

High-value recipes the agent is level-unlocked for but cannot currently do,
with the input it is missing.

This is the prerequisite half of planning. A candidate list alone answers
"what can I do now", which is not enough to play well: the best move is often
to produce the input for something better. Firemaking Oak Logs is worth six
times Woodcutting Oak Trees, but only once you have oak logs — and the agent
discovered that chain by accident, because cutting oak happened to be the
highest-XP thing it *could* do.

These are deliberately NOT candidates. A candidate is something the agent has
proven it can execute, and keeping that guarantee absolute is what makes
choosing by index safe. These are context for the planner: read them, then
pick a real candidate that produces the missing input.

```ts
readBlockedOpportunities: () => { label: string; xpPerHour: number; severity?: BlockedSeverity; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readBoneCandidates`

`function`

Bones worth burying.

Offered whenever any are held: there is no reason to hoard them, no recipe
consumes them, and Prayer is otherwise untrainable.

```ts
readBoneCandidates: () => Candidate[]
```

## `readBuriableBones`

`function`

Bones held, richest first.

Shared by the candidate list and the burying reflex so the two cannot disagree
about what is in the bank. Richest first because the reflex takes one stack
per pass and points are what everything downstream is short of.

```ts
readBuriableBones: () => BuriableBones[]
```

## `readCharacterName`

`function`

Name of the currently loaded character, for the save allowlist guard.

```ts
readCharacterName: () => string
```

## `readCheapestExpendableStack`

`function`

The least valuable stack that is safe to sell, for breaking a full-bank
deadlock and nothing else.

This codebase has said "buying, never selling" since the bank reflex was
written, on the grounds that which stack is worth destroying is a judgement
with no undo. That held right up until the case it did not cover: a bank at
59/59 with a slot priced above what the character could pay. Every gathering
action was refused because its output had nowhere to go, income was zero, the
price never moved, and the agent re-planned into the same wall for two hours.

Buying stays the first answer and runs first. This exists only for the case
where buying is impossible, where the choice is not "sell or keep" but "sell
or stop playing".

Every guard the sell list already applies is inherited by construction, since
this picks from `readSellCandidates`: task items, seeds, runes a castable
attack spell or a reachable Alt Magic spell needs, mastery tokens, the last of
a recipe ingredient and locked items are all excluded. The *cheapest* surviving stack is chosen, because the point
is to free one slot at the smallest cost rather than to raise money.

Only stacks that can be emptied are considered, which is narrower than it was
and is the one change that makes this defensible. A stack an open task has a
claim on can only be sold down to the reserve, and a bank slot with anything
left in it is still a used slot — so a partial sale here does not escape the
deadlock it exists to escape. The previous code freed the slot by selling the
reserve along with the surplus, which trades a task cycle for a slot and calls
it a last resort. If nothing can be emptied, the honest answer is that this
hatch has nothing to offer.

```ts
readCheapestExpendableStack: () => ExpendableStack | null
```

## `readCheapPermanentUpgrades`

`function`

Permanent upgrades cheap enough that not owning them is simply an oversight.

These were sitting unbought for a whole session: an Iron Axe at 50 GP, an
Iron Fishing Rod at 100, an Iron Pickaxe at 250, against 43,860 GP held.
Each is a permanent -5% interval on a skill the agent actually trains, and
every one of them was on the candidate list the entire time — at index 120 of
227, where a planner reading top-down never reached it. Surfacing a thing is
not the same as doing it.

Restricted to purchases that grant *no items*: a pure modifier upgrade. That
is not a stylistic filter but the safety property that makes this reflex-safe
on two counts. It cannot consume a bank slot, so it can never make the
full-bank problem worse; and it cannot buy consumables — compost, dragonhide,
summoning shards — where "how many" is a judgement the planner should keep.
A one-off upgrade has no such judgement: the only wrong quantity is zero.

```ts
readCheapPermanentUpgrades: () => { purchaseId: string; name: string; gpCost: number; }[]
```

## `readClaimableTasks`

`function`

Finished tasks the town is sitting on, ready to claim.

Separate from the candidate reader because this is for the reflex tier: a
task whose work is already done pays out rewards and Township XP, costs
nothing, and cannot be claimed wrongly. Leaving it unclaimed also blocks the
slot it occupies, so the next task never starts.

That matters more than it sounds. Township XP is what gates the biome the
Herb producer lives in, and Herblore is behind that — so an unclaimed task is
not tidy-up, it is the critical path standing still.

```ts
readClaimableTasks: () => { kind: "casual" | "township"; taskId: string; }[]
```

## `readCombatGateInputs`

`function`

Assembles the inputs for the survivability gate.

Reads only; makes no decision. The decision is `assessSurvivability`, which is
pure and lives in the policy tier so it can be tested exhaustively.

Outside combat this always fails, because {@link probeMonsterStats} always
fails: the game's own `computeCombatStats` yields NaN for a detached enemy.
{@link readCombatLevelScreenInputs} is what actually runs before a fight.

```ts
readCombatGateInputs: (targetId: string, intendedSessionMinutes: number) => { ok: true; inputs: CombatGateInputs; } | { ok: false; detail: string; }
```

## `readCombatLevelScreenInputs`

`function`

Assembles the inputs for the level screen.

Reads only. The judgement is `screenByCombatSkillLevels`, which is pure and
lives in the policy tier so it can be tested without a game.

Every monster of a dungeon is carried through rather than summarised here:
the screen judges a target by its worst inhabitant and has to be able to name
which one that was, or its refusals are unarguable.

A monster whose levels throw is recorded by name in `unreadableMonsters`
rather than skipped. Skipping would judge a dungeon by the monsters that
happened to read, which is the same failure as judging it by its first.

```ts
readCombatLevelScreenInputs: (targetId: string) => CombatLevelScreenInputs | null
```

## `readCombatSetupCandidates`

`function`

Prayers worth turning on, and potions worth drinking.

Both existed as capabilities that nothing offered. The character finished the
day with 506 prayer points and no way for the planner to spend them, which is
the same shape as bones sitting in the bank before burying existed.

Prayers are only offered when there are points to pay for them and a fight to
spend them on: an active prayer drains points whether or not anything is
being fought, and points cost bones.

```ts
readCombatSetupCandidates: () => Candidate[]
```

## `readCombatTargets`

`function`

Enumerates the fights that are currently *enterable*.

Deliberately not the same question as "survivable": entry requirements are a
game rule, survivability is our own judgement, and the gate owns the second
one. Mixing them here would put the safety decision in two places.

Areas hold up to dozens of monsters and the game has hundreds in total, so
each area contributes only its easiest few. The planner picks among real
options; it does not need every option.

```ts
readCombatTargets: () => CombatTarget[]
```

## `readCompletionPercent`

`function`

Overall completion percentage across every category.

```ts
readCompletionPercent: () => number
```

## `readCompostCandidates`

`function`

Plots worth composting.

Only planted, uncomposted plots: composting an empty plot is not wrong, but
it is worth nothing until something is growing in it, and the compost is
consumed either way.

```ts
readCompostCandidates: () => Candidate[]
```

## `readCookedStockpile`

`function`

Cooking categories holding uncollected passive output.

Passive cooking does not bank what it makes. It accumulates in
`stockpileItems` (cooking.d.ts:78) and has to be collected, and nothing in
this codebase ever collected it -- so the food reflex started passive cooking,
the food appeared in a stockpile, `readMealCount` (which counts the bank and
the equipped slot) never saw it, and the reflex started cooking again. The
meal count could not move no matter how long it ran.

That is the starvation death in mechanical form: a character surrounded by
food it had already cooked and could not reach.

```ts
readCookedStockpile: () => { categoryId: string; itemName: string; quantity: number; }[]
```

## `readCurrency`

`function`

Amount of a currency by namespaced id, or 0 when it is not registered.

```ts
readCurrency: (currencyId: string) => number
```

## `readDeathCount`

`function`

How many times this character has died, ever.

The agent had no death detection at all. `deathsSinceStart` was only ever
assigned zero -- never incremented -- so `abortWhen.deathsExceed` could not
fire, the `death` replan trigger was never sent, and the run that died
overnight carried on as though nothing had happened. Nothing in the codebase
knew the difference between a character that was working and one that was
dead.

Read as a statistic rather than an event because there is no death event in
`GameEvents` to subscribe to, and patching `Player.processDeath` would be a
guess about what the mod loader permits. A counter that only ever rises needs
no such assumption: compare it against the last reading and any increase is a
death, including one that happened during offline progression while the mod
was not loaded -- which is precisely how this character died last time.

The literal 4 is `CombatStats.Deaths` (statistics.d.ts:420). It is spelled out
because that is a plain `declare enum`, so the runtime bundle may carry no
value for it; citing the line is honest where importing would be fragile.

```ts
readDeathCount: () => number
```

## `readDigSiteSetupCandidates`

`function`

Dig site setup that is currently missing.

Offered as candidates rather than done automatically because *which* map and
*which* tools is a real trade-off — tools cost charges and target different
artefact sizes, so the right choice depends on what the run is for.

```ts
readDigSiteSetupCandidates: () => Candidate[]
```

## `readDungeonPricing`

`function`

How long one run of a dungeon takes, and what it is worth.

A dungeon is every one of its monsters in sequence, so it is priced as the
sum rather than by its hardest inhabitant -- the hardest one decides whether
the run is *survivable*, which is a different question and already answered
by the gate. Reporting only the boss would have priced a twenty-monster
dungeon as one fight.

One unpriceable monster abandons the whole figure, for the same reason
`worstCaseStats` refuses a dungeon with one unmeasurable monster: a total
over the monsters that happened to read is not a total.

```ts
readDungeonPricing: (dungeonId: string) => FightPricing | null
```

## `readEquipCandidates`

`function`

Gear in the bank that is worth wearing.

Only *upgrades* are offered: an item whose slot is empty, or whose combined
offensive and defensive stats beat what is currently there. Offering every
equippable item would bury the planner in noise and invite pointless swaps.

Food is offered separately and unconditionally when none is equipped, because
"no food at all" is not a marginal upgrade — it is the thing blocking Thieving
and combat outright.

"Beats what is worn" was a stat sum, and a skilling outfit has no stats, so
an outfit could never be offered against anything already in its slot. That
is Township's whole payoff, earned and never worn. The one extra case now
offered is the one that needs no pricing —
{@link unambiguousModifierUpgrade} — and everything past it still belongs to
the planner.

```ts
readEquipCandidates: () => Candidate[]
```

## `readEquipmentCharges`

`function`

Worn gear that runs on charges, with the charges it has left.

`game.itemCharges` (game.d.ts:75) appeared nowhere in this mod, which made a
whole class of equipment silently temporary. A charged item keeps its stats
listed and its slot filled after the last charge is gone — the gloves are
still worn, the equipment screen still reads the same — so the gear reflexes
see a full slot, the planner sees a full loadout, and the bonus everything was
bought for has simply stopped. It is the same shape as the empty quiver: full
health, every call succeeding, and nothing happening.

Which items are chargeable is not guessed. `consumesChargesOn`
(item.d.ts:215) is the game's own marker for an item that spends charges, so
an item without it is not reported as having zero — it is not reported at all.
The count itself is `ItemCharges.getCharges` (itemCharges.d.ts:20).

A reader, not a reflex. Replacing a spent Thieving glove means buying another
from the shop for real GP, and whether that is worth it depends on what the
run is saving for — a planner decision, unlike topping up a food slot.

```ts
readEquipmentCharges: () => ChargedEquipment[]
```

## `readEquipmentSetCandidates`

`function`

Equipment sets worth switching to.

Only offered when another set actually holds something: an empty set is a
worse version of the current one, and switching to it would strip the
character mid-run. Most characters have one populated set, so this is
usually silent — which is correct, not a gap.

```ts
readEquipmentSetCandidates: () => Candidate[]
```

## `readEquippedFood`

`function`

The equipped food slot and what the bank holds of that food, read live.

The food reflexes were fed a mix: banked food read live, but the equipped
slot and bank quantities taken from the snapshot, which refreshes only when
the agent reports. So the reflex acted on a picture of the bank that could be
a minute old, and produced a steady drip of failures — "bank holds no
melvorD:Chicken" for a stack that had since been eaten, and "state unchanged"
for a slot it thought was empty and was not.

Individually harmless, since every one was caught by the adapter's own
preconditions. Collectively not: 570 of them buried the single warning that
actually mattered, which was Thieving refusing to release the action slot.
Noise is not free when the log is the diagnostic.

The same fix as `readPlayerHitpoints`, applied to the reflex next door — the
hitpoints half was corrected this session and the food half was missed.

```ts
readEquippedFood: () => { itemId: string | null; quantity: number; bankQuantityOf: (itemId: string) => number; }
```

## `readEquippedFoodHealing`

`function`

What the equipped food heals for, so a better one can be recognised.

```ts
readEquippedFoodHealing: () => number
```

## `readEventCandidates`

`function`

Events the character could enter, or is being asked to answer.

A waiting passive choice comes first and is described as blocking, because it
is: an event mid-stage earns nothing until the choice is made.

```ts
readEventCandidates: () => Candidate[]
```

## `readExplorationCandidates`

`function`

Exploration work that is currently possible.

At most one survey candidate is offered, because the choice of *which* hex is
made from live geometry — survey range moves with the player — and a stale
list of hexes would be worse than no list.

```ts
readExplorationCandidates: () => Candidate[]
```

## `readFarmCandidates`

`function`

Farming work that is ready now.

Farming is the clearest "transitions, not uptime" skill in the game: a plot
is planted, ignored for twenty minutes, and then must be harvested and
replanted or it simply sits there. The capability existed and nothing offered
it, so the agent grew nothing all day.

Grown and dead plots come first — a dead plot is a wasted cycle either way,
and clearing it is what allows the next planting.

```ts
readFarmCandidates: () => Candidate[]
```

## `readFarmPlots`

`function`

Reads every farming plot.

Farming is the clearest case of the transitions this agent exists for: a plot
is planted, ignored for a long time, then harvested and replanted. The game's
offline progress grows the crops but never replants them, so an unattended
player loses every cycle after the first.

```ts
readFarmPlots: () => FarmPlotState[]
```

## `readFightPricing`

`function`

Prices one monster fight.

The join between {@link readFightRate}, which says how fast kills come, and
`killValueFor`, which says what a kill is worth. Neither belongs here: rate
maths lives in `rates.ts` and value maths in `pricing.ts`, and this only
turns them into a line a planner can read.

Runs *after* the survivability gate and the level screen, never instead of
them. Pricing a fight is not a route to taking it: an unsurvivable monster is
refused before this is ever called, and a priced number must never be
mistakable for a permit. That ordering is enforced by the caller, which
builds a blocked entry and moves on before reaching this.

```ts
readFightPricing: (monsterId: string) => FightPricing | null
```

## `readFoodReserve`

`function`

Whether the food reserve is running out, and by how much.

The thing that actually limits unattended play, and nothing was watching it.
Without Auto Eat the eat reflex is the only thing between the character and
death, and it consumes an item every time it fires — Thieving damages on
every failed pickpocket, so a long run burns food steadily. When the last
meal goes, the reflex has nothing to work with, the Thieving gate starts
refusing NPCs as health falls, and the run quietly stops progressing.

Reported rather than acted on. Restocking is a genuine plan — fish, then
cook, then come back — and inventing that as a reflex would have the agent
abandoning objectives to go fishing. Naming the shortfall lets a planning
session decide, which is the split this codebase already draws between
oversights and trade-offs.

```ts
readFoodReserve: (minimumMeals?: number) => { label: string; xpPerHour: number; severity: BlockedSeverity; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readGameVersion`

`function`

The global `gameVersion`, e.g. `"v1.3.1"`. Drives the stale-dump refusal.

```ts
readGameVersion: () => string
```

## `readGatherCandidates`

`function`

Enumerates the gathering objectives the mod can execute right now.

Every number comes from the game's own registries and modifier-aware getters,
so the planner chooses among measured options rather than guessing. Locked
recipes are not emitted at all, which is what makes `available` a literal
`true`: an unavailable candidate is simply absent.

```ts
readGatherCandidates: () => Candidate[]
```

## `readGearUpgrades`

`function`

Gear worth putting on, with the comparison already made.

The candidate reader evaluates every item in the bank against what is worn
and offers only improvements — that part has always worked. What was missing
is anything acting on the answer: a Jeweled Necklace sat in the bank with an
empty neck slot and the list saying "Neck is empty" for as long as nobody
read that line.

Empty slots and replacements are returned separately because they are
different kinds of decision. Filling nothing has no downside and belongs to a
reflex; displacing worn gear is a comparison that has already been wrong once
— a Steel Platebody scored *higher* than what it replaced and left an archer
unable to land a shot — so it carries the margin by which it claims to win
and lets the caller decide how much to trust a stat sum.

```ts
readGearUpgrades: () => { emptySlot: { itemId: string; slotId: string; name: string; scopedModifiers: number; }[]; replacement: { itemId: string; slotId: string; name: string; gain: number; }[]; }
```

## `readHeldCompost`

`function`

The cheapest compost actually held, or null when there is none.

```ts
readHeldCompost: () => { itemId: string; held: number; } | null
```

## `readIsInOnlineLoop`

`function`

Raw read of the game's online-loop flag.

Underscore-prefixed and therefore fragile, which is why it is read in exactly
one place. It is corroborating evidence only — authoritative offline state is
tracked from the `offlineLoopEntered` / `offlineLoopExited` events, because
those are a documented part of `GameEvents` and this field is not.

```ts
readIsInOnlineLoop: () => boolean
```

## `readLapsingPotions`

`function`

Active potions that will lapse silently, and could be re-used instead.

Deliberately restricted to potions that are *already active*. Turning
automatic re-use on spends another potion from the bank when the charges run
out, so this is not free — but it is not a fresh decision either: the planner
has already chosen this potion for this action, and letting the choice expire
halfway through the objective it was drunk for is not a decision anyone made.

Restricted again to potions there are more of. Enabling re-use with an empty
bank changes nothing, and a candidate or reflex that fires on nothing is how
the reflex tier fills a journal with refusals.

```ts
readLapsingPotions: () => LapsingPotion[]
```

## `readLevelCapCandidates`

`function`

Pending level cap increases, one candidate per skill on offer.

```ts
readLevelCapCandidates: () => Candidate[]
```

## `readLoadoutCandidates`

`function`

Loadout decisions that are currently possible.

Curses and auroras are offered only when castable *now* — `canUseCombatSpell`
accounts for runes, so an offer here means the runes exist. Offering one the
character cannot cast would produce a selection that silently does nothing,
which is the worst failure mode in combat: invisible until the fight is lost.

```ts
readLoadoutCandidates: () => Candidate[]
```

## `readLockedActions`

`function`

Skill actions the character has not yet unlocked, nearest first.

A locked action is invisible in every other list: candidates hold only what
can be done now, and the blocked list holds only what is missing *materials*.
So "Farmer unlocks at Thieving 15" — the thing that decides whether Herblore
is reachable this hour or next — could not be seen at all, and the only way
to find out was to grind and watch.

Reported as opportunities because a level requirement is not an action; it is
a reason to keep going with one.

```ts
readLockedActions: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readLostItems`

`function`

What the bank actually threw away, by the game's own count.

`Bank.lostItems` (bank2.d.ts:78) is the game recording every item it tried to
add and could not fit. Nothing in this mod had ever read it, so the only thing
said about a full bank was the speculative warning below — "new item types
*will* start being discarded" — which is a prediction where a measurement was
sitting one accessor away.

Two honest limits, both stated because they change how the number should be
read and neither of them makes it a false positive:

- The typings describe the map as being for offline progress, and do not say
  when the game clears it. So this is a floor on what has been lost since it
  was last cleared, never a ceiling and never a total for the run.
- A non-empty map is nonetheless proof. The game only writes to it when an
  add has already failed, so anything in here is a drop that is gone.

```ts
readLostItems: () => { name: string; quantity: number; }[]
```

## `readMasteryCandidates`

`function`

Skills whose mastery pool has XP worth spending.

The label carries how full the pool is and where the next checkpoint sits,
because "3,400 pool XP" on its own reads as pure surplus and is not: the pool
is also the thing granting the skill's checkpoint bonuses and scaling its pet
chance, and both are given back the moment it drains past a threshold. A
planner choosing between two spends needs to see which one is close to a
checkpoint. {@link spendMasteryPool} still refuses a spend that would drop
one — this is the number that lets the choice be made before the refusal.

```ts
readMasteryCandidates: () => Candidate[]
```

## `readMasteryTokenCandidates`

`function`

Mastery Tokens sitting in the bank.

Their own reader, because they are not `OpenableItem`s and the container
reader's `instanceof` check excludes them by construction.

```ts
readMasteryTokenCandidates: () => Candidate[]
```

## `readMasteryTokenIds`

`function`

Ids of every Mastery Token held, so the sell reader can refuse them.

```ts
readMasteryTokenIds: () => Set<string>
```

## `readMealCount`

`function`

Meals across the bank and the equipped slot; see readFoodReserve.

```ts
readMealCount: () => number
```

## `readModifierGear`

`function`

Gear held in the bank whose worth {@link statScore} cannot see.

`statScore` sums `equipmentStats` — attack bonuses, defence bonuses, the
numbers a weapon has. A skilling outfit has none of those. Its entire value
lives in `modifiers` (item.d.ts:197): the Mining Skillcape's interval
reduction, a Township outfit's flat XP multiplier. Summed as equipment stats
they score exactly zero, so every gear reader in this file ranks them level
with an empty slot and the equip reflex, which only fills empty slots and
clears a margin, has no reason to ever wear one.

**This is still a reader and not a score, for almost every item.** Turning a
modifier list into one comparable number is not arithmetic, it is a judgement
about relevance: +5% Mining mastery XP is worth a great deal to a character
mining and nothing at all to one fishing, and the same item's worth changes
with the objective it is worn for. Every weighting this file could invent
would be a guess dressed as a measurement — and a wrong stat sum has already
cost this project twenty minutes of unwinnable fighting, with a Steel
Platebody that scored *higher* than what it replaced. So the modifiers are
surfaced verbatim, in the game's own words via `ModifierValue.getDescription`
(modifiers.d.ts:117), and the choice stays with the planner.

The single exception is marked with `decidable`, and it is not a weighting:
{@link unambiguousModifierUpgrade} asks only whether the *game* scoped the
modifiers to the skill being trained and whether anything is given up by
wearing it. When the answer is yes and no, there is no trade to price.

Restricted to gear not currently worn, because the point is what is being
missed.

```ts
readModifierGear: () => ModifierGear[]
```

## `readModifierGearNotice`

`function`

Reports owned gear that every scorer in this mod values at zero.

Named as a blocked opportunity because that is exactly what it is: the item is
already owned, the slot is filled with something whose own modifiers cannot be
priced either, and the only thing between the two is that nothing here can
weigh one against the other. Saying so plainly is more honest than a scoring
function that would have to invent the price.

Items marked `decidable` are excluded. They are offered as equip candidates
and, when the slot is empty, taken by the fill reflex — so reporting them as
something nobody will act on would be a stale claim, and a notice that is
wrong about its own system is worse than no notice.

```ts
readModifierGearNotice: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readMonsterDropsOfInterest`

`function`

What a monster drops that the agent is currently short of.

Dumping monster loot made it knowable; this makes it *reachable*. Knowing
that Bob the Farmer drops Potato Seeds is only useful if something connects
"Farming is blocked on this item" to "here is a fight that produces it" —
otherwise every fight candidate reads identically and the planner picks by
combat level, which is a proxy for danger, not for value.

The comparison is against items the agent already knows it wants: what an
open Township task is asking for, and seeds it holds too few of to plant.
Deliberately not "everything in the bank is low" — a note attached to every
monster is the same as no note at all.

```ts
readMonsterDropsOfInterest: (monsterId: string, wanted: ReadonlySet<string>) => string[]
```

## `readMostValuableExpendableStack`

`function`

The most valuable stack the agent may safely sell.

The counterpart to {@link readCheapestExpendableStack}, and the difference in
direction is the difference in purpose. That one exists to escape a full
bank, where the goal is to free a slot while destroying as little value as
possible. This one exists to *earn*, so it takes the stack worth the most.

Both draw from the same `readSellCandidates` filter, which is what makes an
automatic sale defensible at all: task items, scarce ingredients, every
farming seed, attack-spell runes, the runes and fixed inputs a reachable Alt
Magic spell needs, mastery tokens, bank-locked items, food while the larder
is thin, and ammunition are all already excluded by construction. The
reflex inherits every one of those guards rather than restating them, so a
guard added for the planner's benefit protects the reflex too.

Ranked on the *sellable* portion rather than on the bank count, which is the
only ranking that answers the question the caller is asking. A stack whose
surplus above a task reserve is worth 200 GP is not the most valuable thing
the agent may sell just because the reserve underneath it is worth 80,000.

```ts
readMostValuableExpendableStack: () => ExpendableStack | null
```

## `readNextContainer`

`function`

The first container in the bank worth opening, if any.

```ts
readNextContainer: () => { itemId: string; quantity: number; } | null
```

## `readOpenableCandidates`

`function`

Containers worth opening.

```ts
readOpenableCandidates: () => Candidate[]
```

## `readPaperCandidates`

`function`

Paper the character has the materials to make.

```ts
readPaperCandidates: () => Candidate[]
```

## `readPassiveCookingCandidates`

`function`

Cooking categories that have a recipe selected but are not cooking.

```ts
readPassiveCookingCandidates: () => Candidate[]
```

## `readPenalisingGear`

`function`

Worn gear that is working against the current attack style.

Reads only; the decision to remove it is {@link removePenalisingGear } in the
reflex tier. The weapon slot is excluded deliberately — a weapon *defines*
the style rather than fighting it, and stripping it would leave the character
unarmed, which is a worse position than a bad bonus.

```ts
readPenalisingGear: () => { slotId: string; itemName: string; }[]
```

## `readPlantableSeeds`

`function`

Seeds that could be planted right now, best XP first.

Only seeds actually held in the bank are offered — an unplantable seed is a
planner trap, not a choice.

```ts
readPlantableSeeds: () => { recipeId: string; name: string; categoryId: string; level: number; xp: number; seedsHeld: number; seedCost: number; }[]
```

## `readPlayerHitpoints`

`function`

The player's hitpoints, read live.

The eat reflex was taking these from the snapshot, which refreshes only when
the mod reports. Two consequences, and the second is the serious one: it
retried an eat it had already done — "already at full hitpoints; eating would
waste the item" — and, in the other direction, it could read a healthy figure
for a character that had since been hurt, and decline to eat at all.

The whole point of the reflex tier is reacting faster than a planning cycle,
which it cannot do from a number a planning cycle produced.

```ts
readPlayerHitpoints: () => { hitpoints: number; maxHitpoints: number; }
```

## `readRaidCandidates`

`function`

Raiding as an option.

Only offered when nothing else is running, because a raid takes the whole
character: it pauses the ordinary game loop, so starting one mid-objective
would silently stop whatever was earning.

Easy only. Difficulty multiplies enemy stats without changing what the agent
can bring, and a failed raid pays nothing for the time spent.

```ts
readRaidCandidates: () => Candidate[]
```

## `readRefillableAmmo`

`function`

Ammunition in the bank that the equipped weapon can actually fire.

The quiver is checked once, as a precondition of engaging, and never again --
but arrows are consumed per shot. When it empties mid-fight the game reports
combat as active, health stays full, and nothing lands: the same silent
zero-damage stall the engage-time check was written to prevent, arriving
twenty minutes later instead.

Matched on `ammoTypeRequired` against `ammoType` (item.d.ts:239, :211) rather
than on names, so bolts and javelins are handled by the same rule as arrows.
Returns null when the weapon needs no ammunition, which is most of them.

```ts
readRefillableAmmo: () => { itemId: string; quantity: number; } | null
```

## `readRepairableBuildings`

`function`

Degraded buildings the town can afford to repair.

Reads only, and deliberately unordered: which one to repair first is a
decision, and decisions live in the reflex tier where they can be tested
without a live game.

```ts
readRepairableBuildings: () => { buildingId: string; biomeId: string; efficiency: number; }[]
```

## `readSeedShortfalls`

`function`

Seeds the character holds but not enough of to plant.

Farming sat at level 1 for a whole session on a two-seed shortfall, and
nothing said so. The candidate list offered "Plant Potatoes — 2 seeds held",
which reads like an opportunity; the reflex correctly declined it; and the
only trace was a reflex warning that stopped appearing once the reflex was
fixed. The shortfall itself was never stated anywhere.

It is a blocked opportunity in the exact sense the blocked list exists for: a
thing the character is level-unlocked for and lacks the inputs to do, with
the missing item named. Farming 30 gates Herblore, so this two-seed gap was
the last skill in scope waiting on something nobody had said out loud.

```ts
readSeedShortfalls: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readSellCandidates`

`function`

```ts
readSellCandidates: () => Candidate[]
```

## `readShopCandidates`

`function`

Shop purchases the agent could make right now.

Mirrors every refusal in {@link buyShopPurchase}, so an offered purchase is
one that would actually go through. Cost is reported so the planner can weigh
a purchase against a GP floor rather than discovering the floor by hitting it.

```ts
readShopCandidates: () => { purchaseId: string; name: string; gpCost: number; owned: number; }[]
```

## `readShopGoalNotice`

`function`

The nearest shop purchases the character is saving toward.

Surfaced beside the blocked list because "you are 107,054 GP from the upgrade
that stops you starving" is a planning fact of exactly the same kind as "this
recipe needs five bars you do not have" -- a known, priced thing standing
between the run and something it wants.

Only the nearest few, so this stays a horizon rather than a catalogue.

```ts
readShopGoalNotice: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readShopObjectiveCandidates`

`function`

Shop purchases the planner may choose, as objective candidates.

Wraps {@link readShopCandidates} into the `Candidate` shape. The GP cost rides
along in the label because the planner has to weigh a purchase against a floor
and there is no rate to express it as.

```ts
readShopObjectiveCandidates: () => Candidate[]
```

## `readShortSeedIds`

`function`

Seed ids the character holds too few of to plant; see readSeedShortfalls.

```ts
readShortSeedIds: () => Set<string>
```

## `readSkillTreeCandidates`

`function`

Skill tree nodes that can be afforded and unlocked now.

```ts
readSkillTreeCandidates: () => Candidate[]
```

## `readSlayerBlockedReason`

`function`

Why Slayer is offering nothing, or null when it is.

{@link readSlayerCandidates} returns an empty array in three unrelated
situations — a task is already running, no food is equipped, or every
category is above the character's Slayer level — and an empty list looks
identical in all three. Slayer sat at level 1 for a whole session without the
agent or the operator ever being told which of those was true, and the answer
turned out to matter: no food equipped is a thing a reflex fixes in seconds,
while an active task means the work is to go and kill the assigned monster.

The lesson is one this session kept relearning. An empty candidate list is
not self-explanatory, and the difference between "cannot" and "already done"
is invisible until something says which.

```ts
readSlayerBlockedReason: () => string | null
```

## `readSlayerCandidates`

`function`

Slayer tasks the character could take.

The capability to take one existed all along and nothing ever offered it, so
the planner could not choose Slayer at all — a whole progression system
present in the contract and unreachable in play.

Only offered when no task is running: taking one mid-task discards the kills
already made, which is a real loss rather than a fresh start. Categories the
character cannot enter are left out, and the level requirement is stated so a
blocked one reads as a target rather than an absence.

```ts
readSlayerCandidates: () => Candidate[]
```

## `readSlayerTaskTarget`

`function`

The monster an accepted Slayer task is asking for.

The missing half of Slayer. `newSlayerTask` takes a task and
`readSlayerCandidates` then correctly returns nothing while one is active --
taking another discards the kills already made -- so an accepted task removed
every Slayer candidate and put none back. The task's own monster
(slayer.d.ts:106) was the one thing that could have advanced it, and nothing
read it.

The area is resolved rather than assumed: `SlayerTask` names a monster and not
a place, while `engageMonster` needs both. Slayer areas are searched first,
then ordinary combat areas that set `allowSlayerKills` — the game's own flag
for "kills here count toward a Slayer task" (combatAreas.d.ts:353). Tasks are
assigned by combat level rather than by area, so a low-level task monster
genuinely can live outside a Slayer area, and searching only one registry
would have reproduced the same dead end one level down.

Enterability is checked here, not left to the engage call, because a candidate
is by definition something the mod has proven it can execute now. A task whose
area is gated is a real situation and it belongs in the blocked list rather
than in a candidate that refuses every time it is chosen.

```ts
readSlayerTaskTarget: () => CombatTarget | null
```

## `readSnapshot`

`function`

Builds a complete observation of the game.

Must not be called while offline progress is resolving — the character is mid
catch-up and about to change underneath the snapshot. The runtime enforces
this; this function does not guard, so that it stays pure and cheap.

```ts
readSnapshot: () => StateSnapshot
```

## `readSpellCandidates`

`function`

Attack spells the character can currently cast.

Gated on the runes actually being in the bank, not just on the Magic level:
a spell without runes is selected happily and then does nothing, which is the
worst failure mode available — silent, and only visible as zero XP an hour
later.

```ts
readSpellCandidates: () => Candidate[]
```

## `readSpellRuneIds`

`function`

Runes that an attack spell the character could cast actually requires.

Selling these is how Magic became unreachable. A bank-clearing pass sold all
81 Mind Runes with the note "not the runes Township wants" — true, and beside
the point: the basic strike spells take a Mind Rune as catalyst alongside the
elemental one, so the stack that looked like spare change was half of every
castable spell. The failure surfaced much later and in a completely different
place: a staff equipped, 821 Air Runes banked, and a fight that could not
land a cast.

Deliberately restricted to spells within the character's Magic level. Runes
for spells decades away are genuinely surplus, and a guard that protects
everything protects nothing — the bank filling up has stalled this agent
repeatedly, and selling is the planner's lever for that.

```ts
readSpellRuneIds: () => Set<string>
```

## `readSpentChargesNotice`

`function`

Reports worn gear whose charges are spent or nearly spent.

Surfacing this matters because nothing else can. A spent item produces no
error, no notification and no observable change: XP and GP simply come in
slightly slower forever, which is indistinguishable from the advertised rates
having been optimistic. This is the line that makes the difference visible
while it can still be acted on.

```ts
readSpentChargesNotice: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readSynergyCandidates`

`function`

Familiar pairs that would combine into a synergy.

Summoning's real payoff is not the familiars individually — it is the
synergy between a specific *pair*, which applies a bonus neither gives
alone. A human checks the synergy table before equipping; an agent that
equips familiars one at a time by stat score will essentially never land on
a pair by accident, so this is the difference between Summoning being a
source of buffs and being a source of two mediocre trinkets.

Only pairs whose tablets are both in the bank and whose synergy is unlocked
are offered, and only the half that is missing from the slots.

```ts
readSynergyCandidates: () => Candidate[]
```

## `readTaskCandidates`

`function`

```ts
readTaskCandidates: () => Candidate[]
```

## `readTaskOpportunities`

`function`

What the unfinished Township tasks are asking for.

Claiming finished tasks is only half of playing them. The tasks are also the
game's own advice about what to do next: they pay GP, items and Township XP
for spreading across skills — "earn 5,000 Fishing XP", "defeat 25 Chickens",
"give 25 Beef to your town" — which is exactly the breadth a single-skill
grinder never develops.

Without this the agent could only ever notice a task after it had accidentally
completed one. Reported as opportunities rather than candidates because a
task is not an action: it is a reason to choose among the actions there are.

```ts
readTaskOpportunities: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readTaskWantedItemIds`

`function`

Items an unfinished Township task is asking for.

Selling one of these throws away a task cycle. It happened: 500 Potatoes
were sold as "free from a Point of Interest, not food the character needs
and not something the town accepts" — true when written, and wrong an hour
later when a task appeared wanting 100 Potatoes. Tasks rotate, so today's
junk is tomorrow's requirement, and task cycles are currently the fastest
Township XP there is.

Casual tasks count too: they hold the same kind of item goal.

```ts
readTaskWantedItemIds: () => Set<string>
```

## `readTotalLevel`

`function`

Total skill level, summed from the skills themselves rather than inferred.

```ts
readTotalLevel: () => number
```

## `readTownHealthCandidates`

`function`

Town health worth restoring, when the town can pay for it.

```ts
readTownHealthCandidates: () => Candidate[]
```

## `readTownshipCandidates`

`function`

What the town could usefully do right now.

Repairs are offered alongside new construction, and the distinction is a real
judgement for the planner: a degraded building already costs its upkeep and
produces less, so restoring it usually beats adding another one that will
degrade alongside it.

Only affordable work is offered. Township resources cannot be bought, so an
unaffordable building is not a "save up for it" decision the way a shop
purchase is — it is simply not a move yet.

```ts
readTownshipCandidates: () => Candidate[]
```

## `readTownshipGoodsCandidates`

`function`

Goods only the town can make.

Offered from a surplus, never from a town that needs the resource itself, and
only for items the bank does not already hold a pile of. The point is the
things with no other source — Herb Boxes above all, which carry the herbs
Herblore needs and which no skill the character has can otherwise produce.

```ts
readTownshipGoodsCandidates: () => Candidate[]
```

## `readTownshipSummary`

`function`

Reads the town.

Storage is the number that matters most and the one a human checks first: a
full town discards everything it produces, so a town at 100% storage earns
nothing per hour no matter how many buildings it has.

```ts
readTownshipSummary: () => TownshipSummary | null
```

## `readTraderCandidates`

`function`

Trades the town actually needs.

Only offered for resources the town is short of, and only for items the bank
has a real surplus of. Both halves matter: trading away a stack the character
is about to use is a loss, and topping up a resource the town already has
plenty of does nothing.

```ts
readTraderCandidates: () => Candidate[]
```

## `readTravelCandidates`

`function`

Points of interest that have been surveyed but never visited.

Offered cheapest-first. Each one is a one-off with a fixed reward, and the
chain matters more than any single entry — travelling to one reveals the
next, and somewhere along it are the dig sites.

```ts
readTravelCandidates: () => Candidate[]
```

## `readUnsellableNotice`

`function`

Valuable stacks the agent is holding but refuses to sell, and why.

The counterpart to the sell list rather than a duplicate of it. A stack worth
six figures that never appears as a candidate is indistinguishable, from
outside, from a stack the agent simply has not got to yet -- and that
ambiguity is what let 216,000 GP of bars sit through several planning passes
while the run was short of GP for Auto Eat.

Only above a floor, and only the worst offenders, so this stays a diagnostic
rather than a second inventory listing.

```ts
readUnsellableNotice: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readUpgradeCandidates`

`function`

Upgrades the bank can currently afford.

Downgrades are excluded outright — they exist for players who want a
cosmetic or a refund, and doing one unattended destroys the better item for
nothing.

The full cost goes in the label because the trade-off is the whole decision:
an upgrade is usually worth it, but not while the materials are earmarked
for something else.

```ts
readUpgradeCandidates: () => Candidate[]
```

## `readWorshipCandidates`

`function`

Worship choices available to the town.

Only offered while the town has none. Once a worship is set, switching is a
50M GP decision that also destroys buildings, and putting that in the same
list as "build a hut" invites it to be chosen by a planner skimming labels.
An operator who wants the switch can still ask for it directly.

```ts
readWorshipCandidates: () => Candidate[]
```

## `reloadGame`

`function`

Saves, then reloads the page so the mod is re-read from disk.

The mod only changes when the game reloads, which until now meant a human at
the keyboard clicking the Creator Toolkit. That made every fix wait on
someone being present: today a deadlock fix, a course-thrash fix and four
diagnostics all sat committed and unloaded while the agent worked around
them, and two attempts to do it by driving the UI opened the Equipment panel
and the Summoning Synergies panel instead.

`saveData` first, and it is not optional. A reload without it discards
whatever the game has not yet written on its own timer, which would turn a
convenience into a way to lose an hour.

Deliberately the whole page rather than anything cleverer. Melvor loads mods
at startup; there is no documented way to swap one in place, and inventing
one would be exactly the kind of guess this codebase keeps paying for.

```ts
reloadGame: () => ActionResult<{ reloading: boolean; }>
```

## `repairAllTownshipBuildings`

`function`

Repairs every degraded building the town can pay for, in one call.

Repairing one building at a time is how this was reachable before, and it
scales badly in exactly the wrong direction: the town grows, so the number of
decisions grows, while each one costs a policy tick and the buildings not yet
reached keep producing at reduced efficiency the whole time. The game ships
the batch operation its own UI uses.

`getTotalRepairCosts` prices the whole batch and `canAffordRepairAllCosts`
answers whether the town can pay for it — asked in that order, so nothing is
attempted that the town cannot complete.

One thing the typings do not state: `repairAllBuildings` is documented as
"Callback function for the Repair All button", and there is a separate
`onRepairAllBuildings` beside it, so which of the two raises a confirmation
is unknown from the typings alone. That is precisely why the verdict here is
the efficiency total either side rather than the call returning — a
confirmation nobody answers shows up as `no_state_change` and is reported,
not believed.

```ts
repairAllTownshipBuildings: (isSuspended: () => boolean) => ActionResult<RepairProjection>
```

## `repairTownshipBuilding`

`function`

Repairs a degraded building.

Buildings lose efficiency over time, and a town of half-broken buildings
produces half the resources while costing the same upkeep. Repair is the
cheapest progress in the skill and the easiest thing for an idle player to
neglect, which makes it exactly the kind of transition worth automating.

```ts
repairTownshipBuilding: (buildingId: string, biomeId: string, isSuspended: () => boolean) => ActionResult<TownshipProjection>
```

## `SaleProjection`

`interface`

What selling claims to change: less of the item, more of the currency.

```ts
SaleProjection: any
```

## `selectAttackSpell`

`function`

Selects the attack spell for Magic combat.

Without this the agent cannot fight with Magic at all — the spell is a
separate selection from the attack style, and an unset one means the
character falls back to melee regardless of gear.

`selectAttackSpell` returns `void` and silently refuses when the Magic level
or the runes are missing, so the selection is observed either side.

```ts
selectAttackSpell: (spellId: string, isSuspended: () => boolean) => ActionResult<{ spellId: string | null; }>
```

## `selectDigSiteMap`

`function`

Selects a dig site's map.

Excavating is impossible without one, so this is the step that turns a dig
site from "listed" into "doable". Maps are held per dig site and identified
by index, which is the game's own model — they are not namespaced objects.

```ts
selectDigSiteMap: (digSiteId: string, mapIndex: number, isSuspended: () => boolean) => ActionResult<{ selectedIndex: number; charges: number; }>
```

## `selectDigSiteTool`

`function`

Turns one of a dig site's tools on.

Tools decide *which artefact sizes* a dig can find, so digging with none
selected finds nothing while still consuming map charges — a silent waste
that looks exactly like bad luck.

```ts
selectDigSiteTool: (digSiteId: string, toolId: string, isSuspended: () => boolean) => ActionResult<{ tools: string[]; }>
```

## `selectLevelCapIncrease`

`function`

Chooses a pending level cap increase.

This is a *permanent* choice: the raised cap cannot be moved to another skill
afterwards. It is still the agent's to make — an unchosen increase leaves the
character sitting at its cap indefinitely, and refusing on the grounds of
irreversibility would make the agent unable to play the part of the game that
exists after 99.

The choice is expressed as a skill id rather than an index, so a stale plan
cannot silently raise the cap of whichever skill happens to be listed third.

```ts
selectLevelCapIncrease: (capIncreaseId: string, skillId: string, isSuspended: () => boolean) => ActionResult<{ skillId: string; levelCap: number; pending: number; }>
```

## `selectTownshipWorship`

`function`

Chooses the town's worship.

Worship is a set of permanent modifiers for the whole town, and the first
choice is free. Changing it afterwards costs 50,000,000 GP *and destroys
every worship building*, which is why the cost is stated plainly in the
candidate label rather than hidden behind a confirmation the agent would
click through.

Nothing here refuses on the operator's behalf. A town left on no worship
forever is a real loss, and an agent that cannot choose one cannot play
Township properly.

`selectWorship` only stages the choice; `confirmWorship` applies it. Both are
called, and the town's actual worship is observed either side.

```ts
selectTownshipWorship: (worshipId: string, isSuspended: () => boolean) => ActionResult<{ worshipId: string; }>
```

## `sellItem`

`function`

Sells items from the bank.

Selling is permitted — the agent may spend and consume — but it is the first
capability that destroys something, so the guards are structural rather than
advisory:

- **Locked items are never sold.** `bank.lockedItems` is the operator's own
  marking, made in the game's UI, and it is the one signal that reliably means
  "not this". Honouring it costs nothing and is the cheapest protection
  against losing something irreplaceable.
- **Zero-value items are never sold.** An item that yields nothing is being
  destroyed for no gain, and a zero sell value is a common marker for quest
  and unique items.
- **The item must be named explicitly.** There is deliberately no "sell
  everything" or "sell by filter" action, so a bad plan can lose one stack,
  never a bank.

`Bank.processItemSale` returns `void`, so success is established by observing
both sides of the trade: the stack shrank *and* the currency grew.

```ts
sellItem: (itemId: string, quantity: number, isSuspended: () => boolean) => ActionResult<SaleProjection>
```

## `setAttackStyle`

`function`

Sets the attack style for a combat type.

Which style is active decides which combat skill receives XP, so leaving it
on the default silently funnels everything into one skill. A human changes it
deliberately; without this the agent cannot train Defence at all.

```ts
setAttackStyle: (attackTypeId: string, styleId: string, isSuspended: () => boolean) => ActionResult<{ styleId: string | undefined; }>
```

## `setPotionAutoReuse`

`function`

Turns automatic potion re-use on or off for one action.

A potion is a fixed number of charges and then nothing. `usePotion` drinks
one, the charges tick away against whatever is running, and the buff ends
without a word — the skill carries on at the un-potioned rate, which looks
exactly like the potion never having been worth much. Over a long objective
the drink is a few minutes of benefit and hours of nothing.

**On the polarity, which is the whole trap here.** `PotionManager` holds
`autoReuseActions: Set<Action>` and documents it as *"Actions for which
potions should **not** be automatically re-used"* (potionManager.d.ts:11) —
the set is a blocklist and its name reads like an allowlist. So the set is
never touched here. The single reading is `autoReusePotionsForAction`
(potionManager.d.ts:19), whose name asks the question in the same direction
this function's `enabled` answers it, and the action asserts that accessor's
own value either side of `toggleAutoReusePotion` (potionManager.d.ts:26).

That framing is what makes a wrong guess cheap rather than silent. If the
accessor turned out to mean the opposite, this would toggle once, observe the
value it asked for, and stop — because the caller's precondition is that same
accessor. One reversible call, not a loop and not a loss.

```ts
setPotionAutoReuse: (actionId: string, enabled: boolean, isSuspended: () => boolean) => ActionResult<{ actionId: string; autoReuse: boolean; }>
```

## `shouldCollectLoot`

`function`

Whether loot is worth collecting now.

```ts
shouldCollectLoot: () => boolean
```

## `SkillState`

`type`

```ts
SkillState: any
```

## `spendMasteryPool`

`function`

Spends mastery pool XP to raise an action's mastery level.

Free progression: the pool fills on its own as the skill is trained, and
converting it costs nothing but the pool itself. A human does this whenever
they glance at the screen; an agent that cannot leaves it accumulating
forever.

**It is not unconditionally free, and that is what this guard is for.**
Mastery pool checkpoints are granted automatically as the pool fills past
their percent and revoked automatically as it empties back below — and
spending is the only thing that empties it. So a spend can hand back a level
and silently take away a standing bonus on every action in the skill, which
is a straight loss whenever the checkpoint was worth more than the level.
The game itself treats this as a decision worth stopping for: settings.d.ts:80
ships `showMasteryCheckpointconfirmations`, *"If confirmation messages should
be shown when losing a mastery pool checkpoint when spending mastery xp"*.
This adapter calls the underlying method with no dialog, so the check has to
live here or nowhere.

A second, independent reason to leave the pool full: a pet whose
`scaleChanceWithMasteryPool` is set (pets.d.ts:12-13) is rolled through
`rollForSkillPet` (pets.d.ts:63) with a chance that scales with pool
progress, so draining the pool also lowers the skill-pet drop rate for as
long as it stays drained. Nothing here prices that; it is one more reason the
refusal errs towards keeping the pool full.

The refusal is deliberately the minimum: it blocks a spend that would drop a
checkpoint and permits everything else. Banking up to the next checkpoint and
spending only the surplus would be the better policy, and it is not
implemented because the pool XP a level-up charges is not stated in the
typings — see {@link poolXpForLevels}. Since that cost is an estimate, the
realised cost is compared against it after the fact and a mismatch is
recorded, so a wrong model shows up as a counter rather than as a bonus that
quietly went missing.

```ts
spendMasteryPool: (skillId: string, actionId: string, levels: number, isSuspended: () => boolean) => ActionResult<MasteryProjection>
```

## `STARTABLE_SKILL_IDS`

`const`

Every skill the agent can start.

Deliberately excludes: the combat skills, which are started through the
combat manager and are gated on the Phase 2 survivability check; Farming,
which is plant-then-harvest rather than a continuous action and deserves its
own objective kind; and Township, Cartography and Archaeology, which are not
recipe-shaped at all — a hex is a position, a dig site consumes a map, a town
is built — and so have their own capabilities instead.

```ts
STARTABLE_SKILL_IDS: readonly string[]
```

## `startCombatEvent`

`function`

Starts a combat event.

No survivability gate runs here, and that is deliberate rather than an
oversight: the gate measures one monster or one dungeon, and an event is a
sequence of areas whose composition changes as it progresses. Measuring the
first stage would produce a confident number about the wrong fight.

What protects the character instead is the same thing that protects a human:
the event can be stopped, and the policy tier's HP and food floors still end
it. Entering is the agent's call, with the difficulty stated in the label.

```ts
startCombatEvent: (eventId: string, isSuspended: () => boolean) => ActionResult<EventProjection>
```

## `startDungeon`

`function`

Starts a dungeon.

Dungeons are a large slice of the game's content and rewards, and they were
unreachable: the survivability gate already knew how to measure one — walking
every monster and keeping the worst — but nothing could actually enter it.

Judged by its *worst* monster, not its first, which is why the gate does that
walk. Dying on floor nine costs exactly as much as dying on floor one, and a
dungeon cannot be left partway without losing the run.

Callers must have cleared the gate. As with {@link engageMonster}, this does
not run it: the gate is pure and testable, and mixing it in here would make
it both untestable and easy to bypass.

```ts
startDungeon: (dungeonId: string, isSuspended: () => boolean) => ActionResult<CombatProjection>
```

## `startGathering`

`function`

```ts
startGathering: (skillId: string, recipeId: string, isSuspended: () => boolean) => ActionResult<GatheringProjection>
```

## `startGolbinRaid`

`function`

Starts a raid at a difficulty.

`startRaid` returns `void` and refuses silently when the requirements are
unmet, so the evidence is the raid actually running afterwards.

```ts
startGolbinRaid: (difficulty: string, isSuspended: () => boolean) => ActionResult<RaidProjection>
```

## `startPaperMaking`

`function`

Makes paper.

The bottom of the Cartography chain: paper makes maps, maps make dig sites
excavatable. Surveying without ever making paper produces discoveries that
cannot be acted on, which is a slower and less obvious way of getting stuck
than simply not surveying.

`startMakingPaper` returns a boolean, so the skill actually running its paper
action is the evidence taken instead.

```ts
startPaperMaking: (recipeId: string, isSuspended: () => boolean) => ActionResult<{ recipeId: string | null; active: boolean; }>
```

## `startPassiveCooking`

`function`

Starts passive cooking in a category.

The only genuinely *parallel* production in the game: it fills a stockpile
while the character mines, fights or chops. Leaving it off costs nothing
visible, which is exactly why it stays off forever without someone to notice.

Food is also the input to the survivability gate, so a stockpile filling in
the background is what eventually makes combat possible.

```ts
startPassiveCooking: (categoryId: string, isSuspended: () => boolean) => ActionResult<PassiveCookProjection>
```

## `StateSnapshot`

`type`

```ts
StateSnapshot: any
```

## `stopCombatEvent`

`function`

Leaves a running event.

Stopping forfeits the stage's progress, which is why it is a decision rather
than a reflex — but staying in an event the character cannot clear forfeits
the time instead, and time is the thing this project measures.

```ts
stopCombatEvent: (isSuspended: () => boolean) => ActionResult<EventProjection>
```

## `stopGathering`

`function`

Stops a gathering skill.

```ts
stopGathering: (skillId: string, isSuspended: () => boolean) => ActionResult<GatheringProjection>
```

## `stopGolbinRaid`

`function`

Ends a raid.

Fleeing keeps the coins earned so far, which makes it the right move once a
run stops progressing — a raid that cannot clear its current wave will not
clear the next one, and the coins are the only thing carried out.

```ts
stopGolbinRaid: (isSuspended: () => boolean) => ActionResult<RaidProjection>
```

## `Subscriptions`

`class`

Collects disposers so a single call tears everything down.

Disposal is best-effort and never throws: the kill switch must always
complete, even if one listener was already removed.

```ts
Subscriptions: typeof Subscriptions
```

## `surveyBestHex`

`function`

Starts surveying the best available hex.

Auto-survey rather than a single survey action: the game will keep working
through the hex on its own, which is what an idle player leaves running, and
what makes this survive the offline window.

`startAutoSurvey` returns a boolean, but the evidence is the skill actually
being active on the hex we chose.

```ts
surveyBestHex: (isSuspended: () => boolean) => ActionResult<{ surveying: boolean; hex: string | null; }>
```

## `THIEVING_ID`

`const`

```ts
THIEVING_ID: "melvorD:Thieving"
```

## `toggleAurora`

`function`

Turns an aurora on or off. Same shape and same reasoning as {@link toggleCurse}.

```ts
toggleAurora: (auroraId: string, isSuspended: () => boolean) => ActionResult<SpellSlots>
```

## `toggleBankLock`

`function`

Locks or unlocks a bank item.

The one guard rail the agent can give itself. Selling is the only capability
that destroys something, and the loss is silent — a sold rare drop looks
exactly like a successful transition in the journal. Locking is cheap,
reversible and, unlike a refusal baked into the sell path, it is a decision
the planner can make about specific items it has reason to keep.

```ts
toggleBankLock: (itemId: string, isSuspended: () => boolean) => ActionResult<{ itemId: string; locked: boolean; }>
```

## `toggleCurse`

`function`

Turns a curse on or off.

`toggleCurse` returns `void` and refuses silently when the level or the runes
are missing, so the selection is observed either side. `canUseCombatSpell` is
the game's own requirement check, and reusing it is the only way to be right
about a rule set that spans levels, runes and equipped items.

```ts
toggleCurse: (curseId: string, isSuspended: () => boolean) => ActionResult<SpellSlots>
```

## `togglePrayer`

`function`

Turns a prayer on or off.

`togglePrayer` returns `void`, and prayers silently refuse when the level
requirement is unmet, so the active set is observed either side.

Deliberately not automatic: prayers drain prayer points, and points cost
bones. Leaving one on during idle training is a slow, invisible resource
leak, which is why this is an explicit decision rather than a reflex.

```ts
togglePrayer: (prayerId: string, isSuspended: () => boolean) => ActionResult<{ active: string[]; }>
```

## `TownshipProjection`

`interface`

What building or repairing claims to change.

```ts
TownshipProjection: any
```

## `TownshipSummary`

`interface`

The town's state, for the planner to reason about.

```ts
TownshipSummary: any
```

## `travelToPointOfInterest`

`function`

Travels to a surveyed but undiscovered Point of Interest.

The gap this closes was found the hard way. Surveying a hex queues a POI and
the game raises a "Travel there now?" modal — which an unattended agent can
neither see nor answer, so it sat there swallowing input while every reload
click went into it. Discovering POIs is not optional decoration either: the
Old Village dig site, and therefore Archaeology at all, is reached only by
travelling to one.

`travelOnClick` is the modal's button. `movePlayer` is the operation, and it
takes a path rather than a destination, so the path is computed first and the
cost is checked before spending anything — `ignoreCosts` stays false so the
game deducts and refuses exactly as it would for a player.

```ts
travelToPointOfInterest: (poiId: string, isSuspended: () => boolean) => ActionResult<{ discovered: number; undiscovered: number; position: string; }>
```

## `unequipItem`

`function`

Takes something off.

The counterpart that did not exist. The agent could put gear on and never
remove it, which is not a small omission: a human unequips constantly — to
swap damage types, to clear a slot, to undo a mistake — and without it every
equip was one-way and permanent.

It became urgent rather than theoretical when a Steel Platebody was equipped
for its defence and turned out to carry a negative ranged attack bonus. The
candidate reader now refuses to offer such gear, but refusing to offer it
does nothing about the piece already worn, and there was no way to take it
off short of a human doing it by hand.

The bank check is a real precondition, not defensiveness: unequipping moves
the item back to the bank, and a full bank is the one state where that can
fail.

```ts
unequipItem: (slotId: string, isSuspended: () => boolean) => ActionResult<EquipProjection>
```

## `unlockFarmPlot`

`function`

Buys a locked plot.

Every farming plot starts locked, including the first, and a locked plot can
never be planted. The agent held sixteen allotment seeds and Farming level 1
for a full day while the farm reported "no empty plots" — the capability to
open a plot simply did not exist, so Farming was unreachable no matter what
else was fixed.

`unlockPlotOnClick` returns void, so the state leaving `locked` is the
evidence rather than any return value.

```ts
unlockFarmPlot: (plotId: string, isSuspended: () => boolean) => ActionResult<{ state: string; recipeId: string | null; }>
```

## `unlockSkillTreeNode`

`function`

Unlocks a skill tree node.

Skill points accumulate from levels and are spent here or nowhere. Unlocking
is permanent, and that is fine: every node is a gain, so the only mistake
available is spending points on a cheaper node than the one worth saving for
— a trade-off the planner can weigh from the labels.

```ts
unlockSkillTreeNode: (skillId: string, treeId: string, nodeId: string, isSuspended: () => boolean) => ActionResult<{ nodeId: string; unlocked: boolean; pointsLeft: number; }>
```

## `upgradeBankItem`

`function`

Upgrades an item in the bank.

Identified by the *result*, not by a recipe id, because `ItemUpgrade` has no
id of its own — the upgraded item is the only stable name the pair has.

```ts
upgradeBankItem: (upgradedItemId: string, quantity: number, allowDowngrade: boolean, isSuspended: () => boolean) => ActionResult<UpgradeProjection>
```

## `upgradeConstellation`

`function`

Buys one level of a constellation modifier with stardust.

The upgrade methods return `void` and refuse silently when the stardust is
short, so `timesBought` is observed either side.

```ts
upgradeConstellation: (constellationId: string, kind: ModifierKind, index: number, isSuspended: () => boolean) => ActionResult<AstrologyProjection>
```

## `UpgradeProjection`

`interface`

What upgrading claims to change: how many of the upgraded item exist.

```ts
UpgradeProjection: any
```

## `usePotion`

`function`

Drinks a potion for the current activity.

Potions are consumable and time-limited, so this is a decision with a cost
rather than a free buff — worth it before a long run of the thing it boosts,
wasteful otherwise.

```ts
usePotion: (itemId: string, isSuspended: () => boolean) => ActionResult<{ potionId: string | null; charges: number; }>
```

## `WOODCUTTING_ID`

`const`

Namespaced ids of the gathering skills with a verified executor.

Adding one means reading that skill's own selection API first. They are not
uniform and a shared abstraction would be a lie:

- Woodcutting: `selectTree(tree)` toggles membership in a `Set`, multi-select
  up to `treeCutLimit`, then a plain `start()`.
- Mining: `onRockClick(rock)` sets a single `selectedRock`.
- Fishing: `onAreaFishSelection(area, fish)` per area, then
  `onAreaStartButtonClick(area)` — there is no plain `start()` per fish.

```ts
WOODCUTTING_ID: "melvorD:Woodcutting"
```

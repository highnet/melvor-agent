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

143 exports.

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

Builds one building in a biome.

`buildBuilding` takes no biome argument: it builds into whichever biome the
town page is currently showing. That is a UI-driven API, so the biome is set
first and restored afterwards — leaving it changed would silently redirect a
human's next click to a biome they did not choose.

It returns `void` and refuses silently when resources are short, so the only
evidence that holds is the building count either side.

```ts
buildTownshipBuilding: (buildingId: string, biomeId: string, isSuspended: () => boolean) => ActionResult<TownshipProjection>
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

The reverse direction is rarely the right move — the town needs its resources
far more than the bank needs another log — so it exists for completeness and
is not offered as a candidate. A planner that wants it can ask.

```ts
convertTownshipToItem: (resourceId: string, itemId: string, quantity: number, isSuspended: () => boolean) => ActionResult<ConversionProjection>
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

Exports the game's own data registries.

These registries are ground truth: they are correct for the exact installed
version, which the wiki is not. Everything numeric the planner ever sees
originates here. The dump is stamped with `gameVersion` so a game update
makes the staleness detectable rather than silent.

Only the slices Phase 1 and the Phase 2 combat gate need are exported. This
is deliberate: `game.items` alone is thousands of entries, and a dump nobody
reads is just a large file that goes stale.

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

## `increaseTownHealth`

`function`

Spends a resource to restore town health.

Health decays continuously and drags every rate in the town down with it, so
a town left alone for a week produces a fraction of what its buildings say it
should. Restoring it is cheap and the effect is immediate — the definition of
upkeep a human does without thinking about it.

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
MISC_SKILL_IDS: readonly ["melvorD:Firemaking", "melvorD:Cooking", "melvorD:Thieving", "melvorD:Astrology", "melvorD:Agility", "melvorD:AltMagic", "melvorItA:Harvesting"]
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

## `readBankPressure`

`function`

Warns when the bank is about to stop the character working.

A full bank does not announce itself. Gathering an item type the bank has no
room for simply produces nothing, while the skill keeps running and the XP
keeps ticking — so an agent watching only "is the skill active" sees a
perfectly healthy run that is quietly throwing away every drop.

Reported rather than fixed. The remedies are selling something or buying a
slot, both of which are decisions with costs, and both of which the agent
already has capabilities for.

```ts
readBankPressure: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
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
readBlockedOpportunities: () => { label: string; xpPerHour: number; missing: { itemId: string; name: string; need: number; have: number; }[]; }[]
```

## `readCharacterName`

`function`

Name of the currently loaded character, for the save allowlist guard.

```ts
readCharacterName: () => string
```

## `readCombatGateInputs`

`function`

```ts
readCombatGateInputs: (targetId: string, intendedSessionMinutes: number) => { ok: true; inputs: CombatGateInputs; } | { ok: false; detail: string; }
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

## `readCurrency`

`function`

Amount of a currency by namespaced id, or 0 when it is not registered.

```ts
readCurrency: (currencyId: string) => number
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

## `readEquipCandidates`

`function`

Gear in the bank that is worth wearing.

Only *upgrades* are offered: an item whose slot is empty, or whose combined
offensive and defensive stats beat what is currently there. Offering every
equippable item would bury the planner in noise and invite pointless swaps.

Food is offered separately and unconditionally when none is equipped, because
"no food at all" is not a marginal upgrade — it is the thing blocking Thieving
and combat outright.

```ts
readEquipCandidates: () => Candidate[]
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

## `readMasteryCandidates`

`function`

Skills whose mastery pool has XP worth spending.

```ts
readMasteryCandidates: () => Candidate[]
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

## `readPlantableSeeds`

`function`

Seeds that could be planted right now, best XP first.

Only seeds actually held in the bank are offered — an unplantable seed is a
planner trap, not a choice.

```ts
readPlantableSeeds: () => { recipeId: string; name: string; categoryId: string; level: number; xp: number; seedsHeld: number; }[]
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

## `readSellCandidates`

`function`

Enumerates sellable surplus in the bank.

Mirrors the refusals in {@link sellItem } exactly — locked items and
zero-value items are absent rather than offered and then rejected. A
candidate the adapter would refuse is a planner trap, not a choice.

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

## `readShopObjectiveCandidates`

`function`

Shop purchases the planner may choose, as objective candidates.

Wraps {@link readShopCandidates} into the `Candidate` shape. The GP cost rides
along in the label because the planner has to weigh a purchase against a floor
and there is no rate to express it as.

```ts
readShopObjectiveCandidates: () => Candidate[]
```

## `readSkillTreeCandidates`

`function`

Skill tree nodes that can be afforded and unlocked now.

```ts
readSkillTreeCandidates: () => Candidate[]
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

Tasks whose goals are met and whose rewards are waiting.

Casual tasks are listed first: the five-slot limit means an unclaimed one
blocks the next task from arriving, so it costs more than its own reward.

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

## `screenByCombatLevel`

`function`

A conservative screen using only data the game states plainly.

Used when the probe cannot measure, which outside combat is always. It makes
no attempt to predict damage — predicting it would mean reimplementing the
game's formulas, which is how a safety check quietly becomes fiction. It only
asks the question a human answers by glancing at a monster: is this thing
obviously out of my league?

Deliberately strict. Screening out a fight the character could have won costs
some XP; screening in one it cannot costs the run. The real judgement happens
a second later against the live enemy, whose stats the game computes for
real — see `verifyLiveEngagement`.

```ts
screenByCombatLevel: (monsterCombatLevel: number) => { ok: boolean; detail: string; }
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

Ensures a gathering skill is running on a specific recipe.

Deliberately one call rather than a `select` then `start` pair. Several of
these skills expose selection as a *UI click callback* (`onRockClick`,
`onAreaStartButtonClick`) whose side effects are not documented — clicking may
or may not also start the action. Sequencing two separately-verified steps
across those would produce a real failure mode: selection succeeds, start
reports "already active", and the caller cannot tell success from a stuck
half-state.

Making the composite the unit of verification sidesteps that entirely. The
post-condition is what the caller actually cares about — this skill is ticking
on this recipe — and it is observed, not inferred from any return value.

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

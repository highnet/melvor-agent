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

64 exports.

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

## `BankState`

`type`

```ts
BankState: any
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

## `Objective`

`type`

```ts
Objective: any
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

Assembles the inputs for the survivability gate.

Reads only; makes no decision. The decision is `assessSurvivability`, which is
pure and lives in the policy tier so it can be tested exhaustively.

```ts
readCombatGateInputs: (targetId: string, intendedSessionMinutes: number) => { ok: true; inputs: CombatGateInputs; } | { ok: false; detail: string; }
```

## `readCompletionPercent`

`function`

Overall completion percentage across every category.

```ts
readCompletionPercent: () => number
```

## `readCurrency`

`function`

Amount of a currency by namespaced id, or 0 when it is not registered.

```ts
readCurrency: (currencyId: string) => number
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

## `readPlantableSeeds`

`function`

Seeds that could be planted right now, best XP first.

Only seeds actually held in the bank are offered — an unplantable seed is a
planner trap, not a choice.

```ts
readPlantableSeeds: () => { recipeId: string; name: string; categoryId: string; level: number; xp: number; seedsHeld: number; }[]
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

## `readSnapshot`

`function`

Builds a complete observation of the game.

Must not be called while offline progress is resolving — the character is mid
catch-up and about to change underneath the snapshot. The runtime enforces
this; this function does not guard, so that it stays pure and cheap.

```ts
readSnapshot: () => StateSnapshot
```

## `readTotalLevel`

`function`

Total skill level, summed from the skills themselves rather than inferred.

```ts
readTotalLevel: () => number
```

## `SaleProjection`

`interface`

What selling claims to change: less of the item, more of the currency.

```ts
SaleProjection: any
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

## `SkillState`

`type`

```ts
SkillState: any
```

## `STARTABLE_SKILL_IDS`

`const`

Every skill the agent can start.

Deliberately excludes: the combat skills, which are started through the
combat manager and are gated on the Phase 2 survivability check; Farming,
which is plant-then-harvest rather than a continuous action and deserves its
own objective kind; and Township, Cartography and Archaeology, whose flows
are management interfaces rather than a single startable action.

```ts
STARTABLE_SKILL_IDS: readonly string[]
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

## `StateSnapshot`

`type`

```ts
StateSnapshot: any
```

## `stopGathering`

`function`

Stops a gathering skill.

```ts
stopGathering: (skillId: string, isSuspended: () => boolean) => ActionResult<GatheringProjection>
```

## `Subscriptions`

`class`

Collects disposers so a single call tears everything down.

Disposal is best-effort and never throws: the kill switch must always
complete, even if one listener was already removed.

```ts
Subscriptions: typeof Subscriptions
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

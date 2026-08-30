# Melvor Idle Mod API — grounding notes

Retrieved 2026-08-30. Every claim below is cited to either the official typings
(`Melvor-Typing-Project`, commit of 2025-06-09, "Update typedefs for game version
v1.3.1 (?12094)") or a named wiki page. Anything I could not verify is in
[§13 Unverified](#13-unverified--must-confirm-in-game).

Sources:
- wiki `Mod_Creation/Getting_Started`, `/Essentials`, `/Mod_Context_API_Reference`,
  `/Creator_Toolkit` — fetched via `api.php?action=parse&prop=wikitext` (see §9)
- typings: https://github.com/GamesByMalcsPtyLtd/Melvor-Typing-Project
- structural refs: `broderickhyman/Melvor-Idle-Combat-Simulator-Reloaded` (MICSR),
  `AnarchyEcho/autoLesserRelics`

---

## 1. Typings — where they are, what version

Not on npm. Single `main` branch, no tags, no releases. Vendor by copying
`src/gameTypes/` and `src/libraryTypes/` from the repo.

- `src/gameTypes/` — 150 `.d.ts`, ~2.2 MB, generated from game source.
  `idEnums.d.ts` alone is 480 KB; `enums.d.ts` 98 KB.
- `src/libraryTypes/` — globals for the libraries the game bundles.

`package.json` `version` says `1.13.0` — that is the *typings project's* own version and
is stale/meaningless. The real marker is the git log plus `gameTypes/account.d.ts:1`:

```ts
declare const gameVersion = "v1.3.1";
```

Current typings = game **v1.3.1**, i.e. Into the Abyss is covered.

These are ambient declarations (`declare class Game`, `declare const game`), not a module.
Reference from `tsconfig.json` via `include`, never `import`. Their own tsconfig uses
`strict: true`, `skipLibCheck: true`, `allowUmdGlobalAccess: true`. We will need
`skipLibCheck` too — 2.2 MB of generated types.

**Pinning:** record the upstream commit SHA when vendoring. There are no tags, so a SHA is
the only reproducible reference.

## 2. Manifest — and the esbuild `format` question

`manifest.json` at mod root (wiki `/Essentials`):

```json
{
  "namespace": "helloWorld",
  "icon": "assets/icon.png",
  "setup": "src/setup.mjs",
  "load": ["assets/style.css"]
}
```

- `namespace?` — alphanumeric + underscore, cannot start with `melvor`. Required by several
  APIs (`ctx.api` exposure keys off it). Include it.
- `setup?` — path to a JS **module** whose exported `setup` function is the entry point.
  Required unless `load` is present.
- `load?` — string | string[], loaded **after** `setup` runs. Valid: `.js`, `.mjs`, `.css`,
  `.json` (game data packages), `.html` (templates).
- `icon?` — `.png`/`.svg`, rendered at max 38px, or an absolute URL.

**Answer to the esbuild question: `format: "esm"`.** The `setup` entry is loaded as a
JavaScript module and the loader looks for a named export `setup`. Evidence:

1. Wiki `/Getting_Started`: "This value should be a file path pointing to a JavaScript
   module to act as the entry-point"; its example is `export function setup() {}`.
2. `mod.d.ts`: `register: (setup: (ctx: Modding.ModContext) => Promise<unknown>) => Promise<unknown>`.
3. Real mods ship a single bundled file as an ES module — MICSR's manifest is
   `"setup": "built/contentScript.js"`, and `autoLesserRelics/main.js` is
   `export function setup({ ctx, onCharacterLoaded, onInterfaceReady }) {...}`.

Note the extension asymmetry, which is a real trap:
- For **`setup`**, both `.js` and `.mjs` are treated as modules.
- For **`load`**, a file must end in `.mjs` to be treated as a module; a `.js` file listed
  in `load` is injected as a **classic script**.

So: bundle to a single file, `format: "esm"`, `platform: "browser"`, `target: "es2022"`,
point `setup` at it, keep `load` for CSS only.

**Static `import` does not work inside mod code.** Mod resources are not served from a
normal URL space; the wiki is explicit that you must use `ctx.loadModule(path)` instead.
This is moot for us — esbuild bundles everything into one file, so there is exactly one
module and nothing to resolve at runtime. It matters only if we ever ship unbundled.

## 3. Lifecycle hooks — there are exactly five

Verified against `modtypes.d.ts` `interface ModContext` and `mod.d.ts` `mod.trigger`.
In fire order:

| Hook | Fires |
|---|---|
| `onModsLoaded` | all mods loaded, character-select screen |
| `onCharacterSelectionLoaded` | character-select screen fully rendered |
| `onInterfaceAvailable` | game UI injected but **not initialized**, before character load |
| `onCharacterLoaded` | character loaded, all game objects created, **before offline progress** |
| `onInterfaceReady` | **after offline progress has been calculated**, all UI created |

All have the signature `(callback: (ctx: ModContext) => void | Promise<void>) => void`.

### The post-offline-progress hook is `onInterfaceReady`

This is the one the brief asks to verify. Wiki `/Mod_Context_API_Reference`, verbatim:
"Execute code after offline progress has been calculated and all in-game user interface
elements have been created." And `onCharacterLoaded` is explicitly "*before* offline
progress calculations."

**So: gate all automation on `onInterfaceReady`. Never `onCharacterLoaded`.**

`mod.trigger` also lists `creatorToolkitOpen`, exposed as `CreatorToolkitContext.onOpen`,
not on a normal `ModContext`. Not useful to us.

### ...but `onInterfaceReady` only covers game *start*

**This is the most important thing I found, and it is not in the brief.** Offline progress
is not a startup-only event. From `game.d.ts`:

```ts
declare type GameEvents = {
    offlineLoopEntered: GameEvent;
    offlineLoopExited: GameEvent;
    requirementChange: RequirementChangedEvent;
    skillAction: SkillActionEvent;
};
```

and, on `Game`:

```ts
/** Determines the minimum time delta in [ms] that triggers offline mode on a game loop */
readonly MIN_OFFLINE_TIME = 60000;
/** Determines the maximum time delta in [ms] that offline mode can run for */
readonly MAX_OFFLINE_TIME = 86400000;
readonly OFFLINE_EXIT_TIME = 500;
_isInOnlineLoop: boolean;
_offlineInfo: OfflineModeInfo;
/** Triggers the game to enter the offline loop on its next loop */
triggerOfflineLoop(): void;
```

`MIN_OFFLINE_TIME` is **60 seconds**. Any tab throttle, laptop sleep, or stalled loop
longer than a minute drops a *running* game into the offline loop mid-session.
`MAX_OFFLINE_TIME` confirms the 24 h cap this whole project exists to beat.

For an agent running unattended for days, this will happen constantly. Consequences:

- The three-tier clocks must **suspend on `offlineLoopEntered` and resume on
  `offlineLoopExited`**, not merely wait once at boot. Ticking policy or reflex logic
  against a snapshot taken mid-catch-up is exactly the "nonsense" the brief warns about.
- `offlineLoopExited` is a **replan trigger**, and arguably the most valuable one: it is
  the moment hours of progress have just landed.
- `_isInOnlineLoop` is a cheap per-tick guard. Leading underscore = internal/save-state
  field; it is in the public typings but should be wrapped in the adapter, not trusted.

I would add `offlineLoopExited` to the replan-trigger list in the plan.

### 3a. Subscribing to game events

`GameEventEmitter` wraps **mitt**, and is fully typed against the `GameEvents` map, so event
names are checked at compile time and the handler payload is inferred:

```ts
declare class GameEventEmitter<Events extends Record<EventType, GameEvent>> {
  on: {
    <K extends keyof Events>(type: K, handler: Handler<Events[K]>): void;
    (type: "*", handler: WildcardHandler<Events>): void;
  };
  off: { /* same shape */ };
}
```

So `game.on('offlineLoopExited', handler)` / `game.off('offlineLoopExited', handler)` is
correct, and a typo is a compile error rather than a silently dead listener. `'*'` is
supported and is useful for a debug tap during development.

Note there is **no `once`** — handlers must unsubscribe themselves via `off`, so the adapter
should hand back a disposer.

Separately, `GameEventMatcher.assignHandler(handler, golbinRaid?)` **returns a
`VoidFunction` that unassigns the handler** — that is the finer-grained mechanism used for
skill-action and requirement events, and it does give you a disposer.

## 4. `ModContext` — full verified surface

From `modtypes.d.ts`. This is the complete interface:

```ts
interface ModContext {
  name: string;
  namespace?: string;
  namespaceData?: DataNamespace;
  version: string;
  gameData: {
    addPackage: (data: string | GameDataPackage) => Promise<void>;
    buildPackage: (b: (pb: GameDataPackageBuilder) => void) => { package: GameDataPackage; add: () => Promise<void> };
  };
  characterStorage: { setItem(k, v): void; getItem(k): any; removeItem(k): void; clear(): void };
  accountStorage:   { setItem(k, v): void; getItem(k): any; removeItem(k): void; clear(): void };
  settings: {
    section: (name: string) => { get(name): unknown; set(name, value): void; add(config | config[]): void };
    type: (name: string, config: SettingConfig) => void;
  };
  getResourceBlob(path): Blob;
  getResourceUrl(path): string;
  loadTemplates(path): void;          // NOTE: void, not Promise — see §13
  loadStylesheet(path): void;
  loadScript(path): Promise<void>;
  loadModule(path): Promise<any>;
  loadData(path): Promise<any>;
  onModsLoaded / onCharacterSelectionLoaded / onInterfaceAvailable
    / onCharacterLoaded / onInterfaceReady: (cb: LifecycleCallback) => void;
  share(path): void;
  api(endpoints: Record<string, unknown>): any;
  patch<T, K extends keyof T>(cls: Constructor<T>, member: K): MethodOrPropertyPatch<T, K>;
  isPatched<T>(cls: Constructor<T>, member: keyof T): boolean;
}
```

Getting the context outside `setup`, from a module: `const ctx = mod.getContext(import.meta);`
(you must pass `import.meta`). From an injected script: `mod.register(ctx => {...})`.
`mod.getDevContext()` exists for console experimentation and is documented as **not for use
from within a mod**.

Since we bundle to one file, `setup(ctx)` receives the context and we thread it explicitly.
`import.meta` is unreliable in bundled output anyway — do not depend on `getContext`.

## 5. Settings persistence — a hard blocker for Phase 1

The brief says use character storage so settings travel with the save. That is the right
API, but two limits change the design.

**Limit 1 — 8 KB.** Wiki `/Mod_Context_API_Reference`: "Each character can store up to
8,192 bytes (8kb) of data per mod, including keys." JSON-serializable values only. The same
8 KB cap applies to `accountStorage`, which additionally warns that "data integrity is not
100% guaranteed."

8 KB is fine for settings and the current objective. It is **not** enough for the objective
journal. The journal has to live on disk (planner service), with at most a small rolling
digest in `characterStorage` — which happens to match the brief's own "recent verbatim,
older rolled up" requirement, now for a hard reason rather than a context-budget one.

**Limit 2 — local mods do not persist unless linked to mod.io.** Wiki `/Creator_Toolkit`,
verbatim: "In order for a local mod to persist data (`characterStorage`, `accountStorage`,
and `settings` values), the mod must be linked to mod.io and you must have subscribed to and
installed the mod via mod.io."

Phase 1 is explicitly "Local mod via Creator Toolkit, NOT uploaded to mod.io." Those two are
in direct conflict: **as specified, no setting will survive a reload.**

**Decision (2026-08-30): a private, non-public mod.io entry.** Uncheck Visibility so the mod
never appears in the in-game Browse tab, subscribe to it from the mod.io website, and link the
local mod to it. The wiki's Getting Started documents this private-mod path explicitly. This
satisfies "not uploaded/published" while unlocking persistence, and it is a one-time setup
cost. Rejected alternatives: persisting through the planner service (settings would stop
travelling with the save, which was the reason for choosing character storage), and accepting
non-persistence (the master toggle and kill switch would reset on every reload).

Setup prerequisite for Phase 1, in order:
1. Create the mod.io entry, Visibility unchecked. Set Platforms and Supported Game Version tags.
2. Subscribe to it from the mod.io website (My library → My Mods).
3. Reload the game so it installs, then link the local Directory Link mod to that entry.
4. Only then does `characterStorage` retain anything.

Sign-in caveat from the wiki: the mod.io login method/email must match the one saved in the
in-game mod section, or the linkage will not resolve.

Also note: `characterStorage` is only usable **after `onCharacterLoaded`**.

## 6. Patching

`ctx.patch(Class, 'member')` returns a `MethodPatch` or `PropertyPatch`.

- `MethodPatch.before(hook)` — return an array to **replace the arguments**, or nothing to
  leave them alone.
- `MethodPatch.after(hook)` — receives `(returnValue, ...args)`; return a value to replace it.
- `MethodPatch.replace(fn)` — `fn(replacedMethod, ...args)`; call `replacedMethod` to chain.
- `PropertyPatch.get(o => ...)` / `.set((o, v) => ...)` / `.replace(getter?, setter?)`.
- `ctx.isPatched(Class, 'member'): boolean`.

The wiki flags "A Quick Note on Function Syntax": hooks are invoked with `this` bound to the
patched instance, so use `function`, **not** arrow functions, wherever you need `this`. Arrow
functions silently capture module scope — a quiet, hard-to-trace bug class.

Patch targets are the game's global classes (`Skill`, `Player`, `Game`, ...), available as
ambient globals from the typings.

## 7. Combat gate — do not reimplement the formulas, subclass the engine

The brief says to extract the math from MICSR. Having read it: **MICSR does not implement
damage formulas at all.** It subclasses the game's own combat engine and runs it headless:

```
SimGame    extends Game
SimPlayer  extends Player
SimEnemy   extends Enemy
SimManager extends CombatManager
```

`Simulator.ts` then drives ticks against those subclasses. `SimPlayer` overrides `autoEat()`
and derives the auto-eat heal amount from the live `autoEatThreshold` / `autoEatEfficiency`
getters rather than from constants. `SimGame` enumerates the Auto Eat shop tiers
(`autoEatTiers`) and reads them out of `shop.purchases`.

This is the right approach for us, and strictly better than porting formulas: the gate stays
correct across game updates for free, and it can answer "will I die" by *simulating actual
fights* rather than comparing two scalars.

The inputs the gate needs are all verified present:

- `Player.autoEatThreshold: number` (getter), `autoEatHPLimit`, `autoEatEfficiency`
  — `player.d.ts:76,78,80`. All are getters over the modifier table
  (`modifierTable.d.ts:313-315`), so they already fold in shop upgrades, gear and expansions.
  Confirms the brief's "read it, never hardcode."
- `Character.stats.maxHit`, `stats.maxHitpoints` — `character.d.ts`. The full key set is
  `CharacterStatKey = 'minHit' | 'maxHit' | 'accuracy' | 'maxHitpoints' | 'attackInterval' | 'maxBarrier'`.
- `Character.modifyMaxHit(maxHit: number): number` — applies damage reduction and modifiers.
- `game.dungeons`, `game.monsters`, `game.abyssDepths`, `game.strongholds`, `game.slayerAreas`.

**Caveat that shapes the design:** `maxHit` lives on `Character`, and `Enemy extends Character`.
A `Monster` in the registry is *data* — it has no computed `maxHit` until instantiated as an
`Enemy` with a damage type, combat triangle and modifiers applied. So "the worst monster in
the dungeon" cannot be read off the registry; it must be computed through a `SimEnemy`-style
instantiation. That is a real chunk of work, and I would keep it firmly out of Phase 1, as
the brief already does.

`game.abyssDepths` and `corruption.d.ts` are separate registries, and `game.currentRealm` /
`game.unlockedRealms` exist (`realms.d.ts`). So Abyssal content can be hard-refused by realm
or registry membership rather than by name matching — much more robust.

## 8. Return-value contract — the evidence for `ActionResult`

The brief's "a call that returns without throwing does not mean it worked" is understated.
The game's own return conventions are **inconsistent**, verified in the typings:

| Call | Returns |
|---|---|
| `Player.equipItem(item, set, slot?, qty?)` | `boolean` |
| `Player.unequipItem(set, slot)` | `boolean` |
| `Player.equipFood(item, qty)` | `boolean \| undefined` |
| `Player.unequipFood()` | `void` |
| `Bank.addItem(item, qty, logLost, found, ignoreSpace?, notify?, src?)` | `boolean` |
| `Bank.removeItemQuantity(item, qty, removeCharges)` | **`void`** |
| `Bank.willItemsFit(items)` | `boolean` |
| `Skill.start()` | `boolean` |
| `Skill.stop()` | `boolean` |

`equipFood` returning `boolean | undefined` and `removeItemQuantity` returning `void` are the
canonical cases: a truthiness check is wrong for the first and impossible for the second.
Observing before/after state is the only uniform contract.

The `ActionResult<T>` design is correct. One refinement: adapters should *also* record the
raw return value in `detail` where one exists, since an explicit `false` from `equipItem`
distinguishes `"precondition"` from `"no_state_change"` for free.

Community mods confirm the hazard from the other direction — `autoLesserRelics` wraps
`equipItem`/`unequipItem` and checks the boolean, a pattern it credits to the SEMI mods.
The ecosystem learned this the hard way.

## 9. Wiki access — `WebFetch` is blocked, `api.php` is not

`wiki.melvoridle.com` returns **HTTP 403** to the fetch tool on normal page URLs. The
MediaWiki API works fine with a User-Agent header:

```
https://wiki.melvoridle.com/api.php?action=parse&page=Mod_Creation/Essentials&prop=wikitext&format=json&formatversion=2
```

This de-risks `pnpm knowledge:wiki`: the brief's "use api.php, not scraped HTML" is not just
good manners, it is the only thing that works. Set a descriptive UA and rate-limit.

Full `Mod_Creation` page set (via `list=allpages&apprefix=Mod_Creation`). Two pages the brief
did not list are worth reading before UI work:

```
Mod Creation
Mod Creation/Creator Toolkit
Mod Creation/Enabling DevTools for the Steam Client
Mod Creation/Enabling DevTools for the Steam and Epic Clients
Mod Creation/Essentials
Mod Creation/Getting Started
Mod Creation/Migrating from Scripts and Extensions
Mod Creation/Mod Context API Reference
Mod Creation/Reusable Components with PetiteVue
Mod Creation/Sidebar API Reference
```

`mod.io/g/melvoridle/r/getting-started` is client-side rendered and returned no content to
the fetch tool. Its substance appears to duplicate the wiki Getting Started page.

## 10. Creator Toolkit / dev loop

- Subscribe to "Creator Toolkit" via the Mod Manager or mod.io. It opens from the Mod Manager
  tab, the asterisk on character select, or the sidebar.
- Local mods load **after** the Creator Toolkit but **before** all other mods. Order is
  adjustable among local mods.
- A local mod linked to a mod.io mod suppresses the mod.io copy.
- **Directory Link mode is Steam client only.** It re-zips the linked directory on every game
  reload. This is not hot reload in the web sense — the game must be reloaded to pick up a build.
- `.modignore` at the linked directory root: plain text, one rule per line, case-sensitive,
  `*` wildcard, matches both files and folders. The file ignores itself.
  We want at least: `node_modules`, `src`, `*.ts`, `*.map`, `tsconfig*.json`, `.git`, `.*ignore`.
  Only `manifest.json`, the bundled output, and CSS should ship.
- Modfile mode is the non-Steam fallback (manual zip).
- DevTools on the Steam client requires the documented flag — see
  `Mod Creation/Enabling DevTools for the Steam and Epic Clients`.

Implication for esbuild watch: write the bundle into the linked directory, but reloading the
game stays a manual step. Combined with the brief's note about needing a speedup mod, the
iteration loop is the main ergonomic risk in this project.

## 11. Sidebar

Global `sidebar` object (not on `ctx`). Four levels: sidebar → categories → items → subitems.

```js
sidebar.category('Combat');                        // get-or-create
sidebar.category('Combat').item('Attack');         // get-or-create
sidebar.category('Combat').item('Slayer', { before: 'Attack', ignoreToggle: true });
sidebar.categories();  sidebar.category('Combat').items();
sidebar.category('Non-Combat').remove();
sidebar.removeCategory('Combat');                  // avoids creating it
```

Full config object shapes are in `Mod Creation/Sidebar API Reference` (not yet read) and
`sidebar.d.ts` (8 KB). The wiki has a typo — `sidebar.catetory` — in its own example; the
correct method is `category`.

The game ships **PetiteVue** for components, plus jQuery, Bootstrap 4, SweetAlert2, Tippy,
SimpleBar and Toastify (from the typings `package.json` dev deps). Since the brief rules out
React and wants the game's own CSS classes, plain DOM plus the existing Bootstrap classes is
the path of least resistance; PetiteVue is there if a panel gets stateful.

## 12. Registries — `knowledge:dump` targets

All on the global `game`, verified in `game.d.ts`. `NamespaceRegistry<T>` unless noted:

```
realms, damageTypes, combatTriangleSets, attackStyles,
combatEffectGroups, combatEffectTemplates, combatEffects, combatEffectTables,
specialAttacks, currencies, equipmentSlots, pages,
actions, activeActions, passiveActions,
skills, masterySkills, monsters, combatPassives,
combatAreaCategories, slayerAreas, dungeons, abyssDepths, strongholds, combatEvents,
prayers, attackSpellbooks, attackSpells, curseSpells, auroraSpells,
pets, skillLevelCapIncreases, gamemodes, ancientRelics, modifierScopeSources
```

Not `NamespaceRegistry` — different shapes:
- `items: ItemRegistry`
- `combatAreas: CombatAreaRegistry`
- `monsterAreas: Map<Monster, CombatArea | SlayerArea>`
- `itemSynergies: Map<EquipmentItem, ItemSynergy[]>`
- `modifierRegistry: ModifierRegistry`
- `shop` (see `shop.d.ts`; MICSR reads Auto Eat tiers from `shop.purchases`)

Useful adjacent state: `game.activeAction: ActiveAction | undefined`, `game.pausedAction`,
`game.openPage`, `game.currentGamemode`, `game.currentRealm`, `game.tickTimestamp`,
`game.saveTimestamp`, `game.playerCombatLevel`, `game.combat` (`CombatManager`), `game.bank`,
`game.combat.player` (`Player`).

**Version stamp for the dump:** `gameVersion` is a global
(`declare const gameVersion = "v1.3.1"`). That is the stale-dump check the brief wants — dump
it, compare on boot, refuse automation on mismatch.

## 13. Unverified — must confirm in game

Flagging rather than assuming, per the project rule.

1. ~~Whether `game.on('offlineLoopExited', cb)` is the correct subscription form.~~
   **Resolved** — see §3a.
2. **`_isInOnlineLoop` / `_offlineInfo` stability.** Public in the typings but
   underscore-prefixed. Fine behind an adapter; not to be depended on directly.
3. **`loadTemplates` return type.** The wiki documents it as `Promise<void>`; the typings
   declare `void`. One of them is wrong. Matters only if we await it.
4. **Whether a `false` from `Skill.start()` is distinguishable from a silent no-op** without a
   state diff. Assume not; observe anyway.
5. **Sidebar config object fields** — need `Mod Creation/Sidebar API Reference` + `sidebar.d.ts`.
6. **The Creator Toolkit directory-link folder path on this machine.** Machine-specific; read
   it out of the Toolkit UI during setup.
7. **Whether an unlinked local mod silently drops `characterStorage` writes or throws.**
   Determines whether §5 is a loud failure or a silent one. Worth testing first — silent data
   loss in a days-long unattended agent is the worst case.

---

## What changed vs. the brief

- The post-offline hook is confirmed as `onInterfaceReady`, as suspected. **But** offline
  progress recurs at runtime after only 60 s of stall, with `offlineLoopEntered` /
  `offlineLoopExited` events. This belongs in the tier design and the replan triggers, not
  just in startup handling.
- `characterStorage` is 8 KB **and does not persist for an unlinked local mod**, which
  collides head-on with "Phase 1, not uploaded to mod.io."
- The combat gate should subclass the game's engine (MICSR's actual approach) rather than
  extract formulas. Enemy max hit is not readable from the registry at all.
- Game action return types are inconsistent enough (`void`, `boolean`, `boolean | undefined`)
  that `ActionResult` is carrying more weight than the brief credits it with.

# PLAN — Melvor Idle autonomous play agent

Status: **Phase 1 implemented.** See README for how to run it.

Scope change after approval: a **TUI** was added (`packages/tui`). It made the
service topology explicit rather than changing it — the mod is sandboxed and
cannot write to disk, so mod → service HTTP was already implied by "log to
disk". The TUI is simply a third client of that service. Hand-rolled ANSI, no
runtime deps: Ink is the obvious choice but is React-based, which is excluded.

Grounding: [docs/api-notes.md](docs/api-notes.md). Every API named here is verified against
the v1.3.1 typings or a cited wiki page; unverified items are called out inline.

---

## 0. What changed from the brief

Four things I learned in Step 1 that alter the design. Details in `api-notes.md`.

1. **Offline progress recurs at runtime**, after only 60 s of a stalled loop
   (`Game.MIN_OFFLINE_TIME = 60000`), signalled by `offlineLoopEntered` / `offlineLoopExited`.
   So "wait for the post-offline hook" is not a boot-time gate, it is a **permanent gating
   condition on every tier**, and `offlineLoopExited` becomes a replan trigger.
2. **`characterStorage` is 8 KB and requires a mod.io link.** Decided: private, non-public
   mod.io entry. The 8 KB cap means the journal cannot live there — it lives on disk in the
   planner service, with only a digest in-game.
3. **The combat gate should subclass the engine**, not port formulas (MICSR's actual approach).
   Deferred to Phase 2, but it shapes where the seam goes now.
4. **Return types are inconsistent** (`void` / `boolean` / `boolean | undefined`), which is
   what `ActionResult` exists to absorb.

---

## 1. Repo layout

```
melvor-agent/
  pnpm-workspace.yaml
  package.json                 # scripts only, no deps
  biome.json
  tsconfig.base.json
  .modignore                   # consumed by Creator Toolkit Directory Link
  PLAN.md  README.md
  docs/
    api-notes.md               # hand-written, Step 1
    API.md                     # GENERATED from adapter surface — pnpm docs:api
  learnings/                   # hand-curated, read at session start
  vendor/
    melvor-typings/            # copied .d.ts + PINNED_SHA
  config/
    goals.yaml                 # terminal goals DAG — you edit this
  packages/
    shared/       # zod schemas, the contract
    mod/          # the in-game mod
    knowledge/    # dump + wiki generators
    planner/      # Hono service
    tui/          # terminal dashboard (added after approval)
  knowledge/                   # build artifact: dump.json, *.md, conflicts.md
```

`vendor/melvor-typings/` holds the copied `src/gameTypes/` + `src/libraryTypes/` plus a
`PINNED_SHA` file. There are no tags upstream, so a SHA is the only reproducible pin.
Wired as ambient declarations from `tsconfig.base.json` — never `import`ed:

```jsonc
{
  "compilerOptions": {
    "strict": true, "target": "es2022", "module": "es2022",
    "moduleResolution": "bundler",
    "skipLibCheck": true,          // 2.2 MB of generated types
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  },
  "include": ["src", "../../vendor/melvor-typings/**/*.d.ts"]
}
```

## 2. Build

**`packages/mod`** — esbuild, single file, **`format: "esm"`** (§2 of api-notes: the `setup`
entry is imported as a module; MICSR ships a bundled `.js` the same way).

```
target: "es2022", platform: "browser", format: "esm",
bundle: true, sourcemap: "inline", legalComments: "none",
outfile: <CT_DIR>/dist/setup.js
```

`manifest.json` ships as:

```json
{ "namespace": "melvorAgent", "setup": "dist/setup.js", "load": ["dist/style.css"] }
```

`load` is CSS-only, deliberately: under `load` a `.js` file is injected as a *classic script*,
and keeping only CSS there makes that trap unreachable.

The Creator Toolkit directory is configured via `MELVOR_CT_DIR` in `.env` (machine-specific;
read out of the Toolkit UI at setup). `pnpm dev` runs esbuild `--watch` writing straight into
it. **Directory Link re-zips on game reload, so a rebuild still needs a manual game reload** —
this is the main ergonomic cost and the reason the speedup mod matters.

`.modignore` ships only what is needed: ignore `node_modules`, `src`, `*.ts`, `*.map`,
`tsconfig*.json`, `.git`, `.*ignore`, `.env*`.

Tooling: Biome (`biome.json` at root, `check` in CI), Vitest, TypeScript strict everywhere.
No webpack/rollup, no React, no Turborepo, no CSS pipeline, no vector DB.

## 3. `packages/shared` — the contract

Zod schemas, TS types derived via `z.infer`. Everything crossing a boundary is parsed.

- `StateSnapshot` — skills (level, XP, mastery), bank (id → qty, capacity), equipment sets,
  food, `activeAction`, combat state, currencies, `gameVersion`, `capturedAt`, plus the fields
  the combat gate will need later (`autoEatThreshold`, `autoEatHPLimit`, `autoEatEfficiency`,
  `stats.maxHitpoints`, `stats.maxHit`, current realm) so the schema does not churn in Phase 2.
- `Objective` — `{ objective, params, successWhen, abortWhen: { gpBelow, deathsExceed,
  minutesExceed }, expectedDurationMin, rationale }`.
- `Candidate` — an objective the mod has *proven it can execute*, with real numbers attached.
- `ActionResult<T>` — the discriminated union from the brief.
- `JournalEntry`, `PlannerRequest`, `PlannerResponse`.

The safety boundary: `PlannerResponse` is `.parse`d, and every returned objective is checked
against the **capability registry** (§6) before it can reach a game function. An objective the
policy layer cannot execute is rejected at the door and logged as a planner bug.

## 4. `packages/mod/src/adapter` — the only place that touches the game

No game API call anywhere else in the repo, enforced by a Biome `noRestrictedGlobals` rule on
`game`, `sidebar`, `mod` outside `src/adapter/**` (plus a CI grep as a backstop).

Two halves:

**Readers** — pure, no mutation, build the `StateSnapshot`. Each reader is a small function over
one registry or object, so a game update breaks one function, not the snapshot.

**Actions** — every one returns `ActionResult<T>`, never `void`. Shape:

```ts
async function act<T>(
  name: string,
  observe: () => T,                 // cheap, pure projection of the relevant state
  precondition: () => string | null,
  perform: () => unknown,           // raw game call; return value captured
  changed: (before: T, after: T) => boolean,
): Promise<ActionResult<T>>
```

`perform`'s raw return value goes into `detail` when there is one — an explicit `false` from
`equipItem` separates `"precondition"` from `"no_state_change"` for free. Verification is
deferred by one game tick where the effect is not synchronous.

The inconsistency this absorbs, verified in the typings:

| Call | Returns |
|---|---|
| `Player.equipItem` / `unequipItem` | `boolean` |
| `Player.equipFood` | `boolean \| undefined` |
| `Bank.addItem` | `boolean` |
| `Bank.removeItemQuantity` | **`void`** |
| `Woodcutting.selectTree` | **`void`** |
| `Skill.start()` / `stop()` | `boolean` |

**Event seam.** `GameEventEmitter` wraps mitt and is typed against the `GameEvents` map, so
`game.on('offlineLoopExited', h)` is compile-checked. There is **no `once`**, so the adapter
wraps subscriptions and hands back disposers; every listener is torn down by the kill switch.

**`docs/API.md`** is generated from this directory by `pnpm docs:api` — a small script walking
the adapter's exported signatures and JSDoc via the TypeScript compiler API. CI runs
`pnpm docs:api --check` and fails on drift. This is the anti-hallucination mechanism: the
reference cannot go stale because it is derived.

## 5. Three tiers, three clocks — all gated on offline state

A single `RunState` machine wraps all three: `Idle → Armed → Running → Suspended → Killed`.

```
offlineLoopEntered  ->  Suspended   (no tier ticks, no snapshots)
offlineLoopExited   ->  re-snapshot, mandatory replan, then Running
kill switch         ->  Killed      (disposers run; only a reload leaves this state)
```

1. **Reflexes** — every game tick, in-mod, pure and deterministic, no LLM ever. Eat, restock
   ammo, re-equip, resume an idle action. Suspended while offline.
2. **Policy** — every few seconds. Pure functions `(StateSnapshot, Objective) => Action[]`.
   No game access, no I/O, no clock reads — which is exactly what makes it the testable layer.
   **This is where Vitest coverage goes**, against recorded snapshot fixtures.
3. **Planner** — event-driven, never on a timer. Selects and orders objectives.

Automation arms only after `onInterfaceReady` (the verified post-offline hook) **and** a
successful dump-freshness check. `onCharacterLoaded` is used only for reading settings and
registering patches — never for acting.

Replan triggers: objective completed · aborted · unlock acquired · death · resource exhausted ·
budget exceeded · stuck detector · game start · **`offlineLoopExited`** (added).

Stuck detector: track total XP / GP / completion %; flat for N minutes with automation on →
escalate to planner with failure context.

## 6. Constrained selection

The mod computes `Candidate[]` with real numbers. The planner **chooses and orders**; it never
authors instructions. Enforcement is a **capability registry**: policy-layer executors register
under objective kind, and a `PlannerResponse` naming a kind with no registered executor is
rejected before parsing params. "If a plan requires new mod capability, that's a bug" becomes a
runtime assertion rather than a convention.

Goals are a DAG in `config/goals.yaml` (you edit it); the planner resolves prerequisites and
picks what is reachable now.

Journal: full history on disk in the planner service; a rolling digest — recent entries
verbatim, older rolled into aggregate lines — is what the planner actually sees. The 8 KB
`characterStorage` cap forces this split, which is what the brief wanted anyway.

## 7. Knowledge

**`pnpm knowledge:dump`** — the mod serializes the registries listed in api-notes §12
(`game.items`, `monsters`, `skills`, `shop`, `dungeons`, `slayerAreas`, `abyssDepths`,
`realms`, …) to `knowledge/dump.json`, stamped with the global `gameVersion`
(`declare const gameVersion = "v1.3.1"`) and a capture timestamp. Triggered from a panel
button, written out via a download blob (the mod is sandboxed and cannot write to disk).

**Stale-dump refusal:** on `onInterfaceReady`, compare live `gameVersion` against the dump
stamp. Mismatch → automation refuses to arm, panel says regenerate. Read-only snapshot and
panel still work, so the refusal is diagnosable.

**`pnpm knowledge:wiki`** — deferred, but the transport is settled and de-risked: the wiki
returns **403 to ordinary page fetches**; `api.php?action=parse&prop=wikitext` works with a
descriptive UA. On-disk HTTP cache, polite rate limit, distilled to `knowledge/<topic>.md`
with source page + retrieval date. Never fetched at runtime.

**Cross-validation:** dumped data wins over the wiki, always; every contradiction is appended
to `knowledge/conflicts.md`. Never silently prefer the wiki.

## 8. `packages/planner`

Node + Hono + Anthropic TS SDK, stateless. Phase 1: schemas wired, `POST /plan` stubbed to
return a fixed valid `PlannerResponse`, **no model calls**. Journal persistence and the digest
roller live here.

Watchdog (Phase 2): planner errors, returns garbage twice, or is unreachable → fall back to the
last valid objective and continue. Degrade, never halt.

## 9. Safety

- **Irreversible actions are refused categorically, in the adapter**, not asked about:
  destroying unique items, spending one-time tokens, permanent character choices. There is no
  adapter function for them, so there is nothing for the planner to call.
- **Abyssal / Into the Abyss refused entirely** until explicitly whitelisted — enforced by
  realm/registry membership (`game.abyssDepths`, `game.strongholds`, `game.currentRealm`),
  never by name matching.
- Auto-export the save on a schedule and before any large commitment.
- Caps: daily token budget, GP floor.
- **Kill switch**: synchronous, disposes every listener and timer, sets `Killed`. For you.
- Throwaway character only. The panel shows the loaded character name and refuses to arm on a
  name not in an allowlist — cheap insurance against pointing it at your main.

## 10. Quality metric

Total level (or completion %) per real-time hour, logged continuously to disk alongside every
action and planner decision with reasoning, and mirrored to the in-panel log. Control condition:
"one good skill left running, collected every 24 h." If the agent is not clearly beating that,
the transitions are bad.

---

## Phase 1 deliverables

1. Mod loads cleanly, registers a sidebar panel, arms nothing before `onInterfaceReady`.
2. Full `StateSnapshot`, zod-validated, rendered in the panel — including the combat-gate fields.
3. Adapter layer with `ActionResult`, generated `docs/API.md`, CI drift check.
4. `knowledge:dump` end to end, version stamp, stale-dump refusal.
5. Master toggle + hard kill switch, persisted to `characterStorage`.
6. One trivial automation behaviour (below).
7. `packages/planner` scaffolded, schemas wired, route stubbed, no model calls.

Deferred: `knowledge:wiki`, combat gate, real planner calls.

### The trivial behaviour: **resume idle Woodcutting on a configured tree**

Reflex-tier. If `game.activeAction` is undefined and the configured tree is not in
`Woodcutting.activeTrees`, select it and start.

Why this one:

- It is a **two-contract flow in three calls**, which is the whole point. `selectTree(tree)`
  returns **`void`** — the only way to know it worked is observing `activeTrees`.
  `start()` returns `boolean` — a second, different contract. Both verified in the typings
  (`woodcutting.d.ts:57,77`; `GatheringSkill.start(): boolean` "Starts up the skill with
  whatever selections have been made"). A behaviour where the game hands back a clean success
  boolean would prove nothing about the `ActionResult` design.
- It is **on the critical path**: "resume an idle action" is a named Tier-1 reflex, and it is
  precisely what needs to fire after every `offlineLoopExited`. So it exercises the offline
  gating too, not just the action loop.
- **Failure is inert.** Worst case nothing starts. No items consumed, no GP spent, no combat,
  nothing irreversible.
- It is **idempotent** and its success criterion is unambiguous: `activeAction` transitions
  from `undefined` to Woodcutting, `isActive` true.

Success criterion for the phase: kill the action from the game UI, watch the reflex restore it
within one policy tick, and see a well-formed `ActionResult` with before/after evidence in both
the panel log and the disk log. Then sleep the machine for two minutes, confirm the tier
suspends on `offlineLoopEntered` and re-snapshots on `offlineLoopExited`.

---

## Open items before implementation

1. **The mod.io setup is a prerequisite, and it is on you** (api-notes §5): create the private
   entry, subscribe from the website, link the local mod. Until that is done nothing persists.
   I can build against it and have the panel warn loudly when persistence is not working.
2. **Speedup mod** — the brief wants this early and I agree. I have not identified a specific
   one yet; I will find and verify a current one before writing the automation loop, since
   iterating on the reflex tier at 1x is unworkable.
3. **`MELVOR_CT_DIR`** — I need the Creator Toolkit directory-link path from your machine, or
   I will scaffold with a placeholder and you fill it in.
4. Unresolved API details in api-notes §13 — none block Phase 1; each is confirmed in-game at
   the point it is first needed, and appended to `learnings/`.

# melvor-agent

A local Melvor Idle mod that plays the game autonomously, with an LLM planner
making high-level strategy decisions.

The game already simulates up to 24 hours of offline progress for one running
action, so keeping a single skill going is worth nothing. The value is entirely
in **transitions** — banking, selling, buying, re-equipping, switching skill —
in decisions that require acting on state, and in running continuously past the
24 hour cap. Optimise for good transitions per day, not for uptime.

**Single user, single machine.** This is not distributed and is not built to be.
The mod.io entry exists only because the Creator Toolkit refuses to persist
settings for an unlinked local mod; it stays hidden, and `pnpm release` refuses
to upload to a public entry.

**Phase 1 status: complete.** Observe → verify → act works end to end for one
trivial behaviour. No planner model calls yet, no combat gate, no wiki corpus.

## Layout

```
packages/shared      zod schemas — the contract, and the safety boundary
packages/mod         the in-game mod (esbuild → one ESM file)
packages/knowledge   dump schema, freshness check, verify CLI
packages/planner     local Node + Hono service (stateless planning, durable state)
packages/tui         terminal dashboard for driving the agent
vendor/melvor-typings  official .d.ts, pinned by commit SHA
docs/api-notes.md    hand-written grounding notes (read this first)
docs/API.md          GENERATED from the adapter surface — do not edit
learnings/           hand-curated gotchas — read at the start of every session
```

## First-time setup

### 1. A private mod.io entry (required — nothing persists without it)

The Creator Toolkit only persists `characterStorage`, `accountStorage` and
`settings` for a local mod **linked to mod.io and installed from there**. An
unlinked local mod silently loses every setting on reload.

1. Create a mod.io entry for Melvor Idle with **Visibility unchecked** — it will
   not appear in the in-game Browse tab.
2. Subscribe to it from the mod.io website (profile → My library → My Mods).
3. Reload the game so it installs.
4. Link your local Directory Link mod to that entry.

Your mod.io login must match the account saved in the in-game mod section, or the
link will not resolve.

### 2. Point the build at your Creator Toolkit folder

```bash
cp .env.example .env
```

Set `MELVOR_CT_DIR` to the folder you linked in the Toolkit's Directory Link
mode. Directory Link is **Steam client only**, and it re-zips that folder on every
game reload — so a rebuild still needs a manual game reload.

### 3. Install and build

```bash
pnpm install
```

```bash
pnpm build
```

## Running it

Three processes. The mod is sandboxed and cannot write to disk, so the service
holds everything durable — logs, journal, saves, the knowledge dump.

Start the service:

```bash
pnpm planner
```

Watch-build the mod (reload the game after each build):

```bash
pnpm dev
```

Open the dashboard:

```bash
pnpm --filter @melvor-agent/tui start
```

Keys: `a` arm, `d` disarm, `k` kill, `r` replan, `e` export save, `q` quit.
Commands are queued on the service and applied on the mod's next report, so the
TUI works with the game closed.

### In game

Sidebar → Modding → **Play Agent**. The panel shows the validated snapshot, the
run state, and the log tail.

**It will refuse to arm until:**

- a character allowlist is set, and the loaded character is on it (an empty list
  fails closed — the point is not to run this on a save that matters);
- a knowledge dump exists and its `gameVersion` matches the running game;
- the current realm is not Abyssal or Eternal.

Press **Dump knowledge** once to produce the dump. Then:

```bash
pnpm knowledge:dump
```

**Dry run is ON by default.** The agent decides and logs but performs no game
action. Turn it off in the panel once you have watched it make the right calls.

## Releasing to mod.io

`pnpm release` builds, zips, verifies `manifest.json` is at the archive root, and
uploads a new modfile to the hidden entry. It refuses outright if the entry is
public — there is no override.

```bash
pnpm release:dry
```

Builds and verifies without uploading. The real upload needs `MODIO_TOKEN` and
`MODIO_MOD_ID` in `.env`; see `.env.example`.

## Verifying

```bash
pnpm verify
```

Runs lint, typecheck, the adapter-boundary check, the API docs drift check, and
the tests.

## The rules this codebase enforces mechanically

Documented conventions rot. These are checked:

- **Every Melvor API call lives in `packages/mod/src/adapter/`.** A game update
  then breaks exactly one directory. `scripts/check-adapter-boundary.mjs` fails
  the build otherwise — including on bare class references like
  `ctx.patch(Game, …)`, which do not look like API calls.
- **`docs/API.md` is generated** from the adapter's public surface, and CI fails
  on drift. The reference cannot go stale, which is how this project avoids
  hallucinating API surface.
- **No adapter action returns `void`.** Each returns an `ActionResult` carrying
  before/after evidence. The game's own conventions are inconsistent —
  `equipItem` returns boolean, `equipFood` returns `boolean | undefined`,
  `Bank.removeItemQuantity` and `Woodcutting.selectTree` return `void` — so a
  non-throwing call proves nothing.
- **The planner cannot emit an action the policy layer could not perform.**
  `EXECUTORS` is typed `Record<ObjectiveKind, PolicyExecutor>`, so a kind added
  to the schema without an executor fails the build, and an unregistered kind is
  rejected at runtime before its params are parsed.
- **The build asserts its own output exports `setup`.** A wrong esbuild format
  produces a mod that loads and silently never runs.

## Skill coverage

16 skills can be started, stopped and verified:

| Family | Skills | Routing |
|---|---|---|
| Gathering | Woodcutting, Mining, Fishing | one routine each — the selection APIs differ completely |
| Artisan | Smithing, Crafting, Fletching, Herblore, Runecrafting, Summoning | **one shared routine** — they inherit `ArtisanSkill` |
| Individual | Firemaking, Cooking, Thieving, Astrology, Agility, Alt Magic, Harvesting | one routine each |

Deliberately excluded, with reasons:

- **Combat skills** (Attack, Strength, Defence, Hitpoints, Ranged, Magic, Prayer,
  Slayer) — started through the combat manager and gated on the Phase 2
  survivability check. Enabling them before that gate exists would be the one
  way this agent can lose something irreversible.
- **Farming** — plant-then-wait-then-harvest, not a continuous action. It needs
  its own objective kind rather than being forced into `gather_resource`.
- **Township, Cartography, Archaeology** — management interfaces rather than a
  single startable action.
- **Alt Magic spells that consume a chosen bank item** — they need a second
  selection whose correct argument depends on the spell's consumption type.
  Refused explicitly rather than guessed at.

## Timescale

**We run at real time — no speedup mod.** The quality metric is progress per
*real* hour measured against the control condition ("one good skill left running,
collected every 24h"), and a speedup mod would make that number meaningless.

The consequence: you cannot evaluate a behavioural change by watching it. That is
why the policy tier is pure and unit-tested against snapshots — the tests are the
fast feedback loop, the game is the slow one.

## Things that will bite you

Read `learnings/` before changing anything. The short version:

- `onCharacterLoaded` fires **before** offline progress. Only `onInterfaceReady`
  is safe for automation.
- Offline progress **recurs at runtime** after 60s of a stalled loop, not just at
  startup. Every tier suspends on `offlineLoopEntered`.
- Patch hooks need `function`, not arrows — and lint autofix will rewrite them if
  you let it.
- `ctx.patch` has no unpatch. The kill switch cannot truly un-hook the game loop.

## Safety

- Refuses categorically, with no adapter function to call: destroying unique
  items, spending one-time tokens, permanent character choices, deleting saves.
- Refuses Abyssal and Eternal realms by realm id, never by name matching.
- Kill switch is synchronous and latches until reload. It is for the operator.
- Test on a throwaway character.

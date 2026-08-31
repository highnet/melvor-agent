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

### 1. Point the build at your Creator Toolkit folder

```bash
cp .env.example .env
```

Set `MELVOR_CT_DIR` to the folder you linked in the Toolkit's Directory Link
mode. Directory Link is **Steam client only**, and it re-zips that folder on every
game reload — so a rebuild still needs a manual game reload.

### 2. Install and build

```bash
pnpm install
```

```bash
pnpm build
```

### 3. Add it as a local mod

Mod Manager → **Creator Toolkit** → add a local mod → **Directory Link** → point
it at the folder from step 1 (`packages/mod/dist-local` by default). Reload the
game.

Directory Link is Steam-client only, and it re-zips the linked folder on every
game reload — so a rebuild always needs a game reload to take effect.

There is deliberately no mod.io step. `characterStorage` only persists for a
mod.io-installed mod, and Melvor gates mod.io entries behind game-admin
approval; depending on a moderation queue for an unattended agent's settings is
a bad trade. Settings live in the planner service instead, with
`characterStorage` as a best-effort cache. If you *do* link a mod.io entry, the
cache starts working too and settings also travel with the save.

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

Open the dashboard, in your own terminal:

```bash
pnpm tui
```

It takes over the terminal (alternate screen, raw-mode keys), so it needs a real
TTY — it cannot be driven from a non-interactive shell or an agent tool call.
Everything it does is also available over plain HTTP on the service, which is
the better route for scripting:

```bash
curl -s localhost:8787/dashboard
```

```bash
curl -s -X POST localhost:8787/command -H 'content-type: application/json' -d '{"type":"arm"}'
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

**It acts for real.** There is no dry-run mode: arming means the agent plays, and
combat engages whenever the survivability gate passes. The gate itself still
runs on every fight and refuses anything it cannot prove survivable — that is
what keeps deaths rare, not a mode switch. Deaths are an accepted cost.

## Releasing to mod.io

`pnpm release` builds, zips, verifies `manifest.json` is at the archive root, and
uploads a new modfile to the hidden entry. It refuses outright if the entry is
public — there is no override.

```bash
pnpm release:check
```

Verifies credentials only - no build, no upload. Confirms the token is valid,
that it has write access, that the game id really is Melvor Idle, and that the
mod entry is hidden.

```bash
pnpm release:dry
```

Builds and zips without uploading.

### Versioning

Versions are managed by [release-please](https://github.com/googleapis/release-please)
from Conventional Commits. On push to `main` it opens a release PR that bumps
`package.json` and writes `CHANGELOG.md`; merging that PR tags the release.

`pnpm release` then reads the version from `package.json`, so a release is:

1. land commits using `feat:` / `fix:` / `refactor:` prefixes;
2. merge the release PR release-please opens;
3. `git pull && pnpm release`.

Publishing stays local on purpose — the mod.io token is a personal access token
and does not belong in repository secrets for a single-user tool.

Commits before this point are not Conventional Commits, so release-please will
not see them; the first conventional commit starts the changelog.

A husky `commit-msg` hook runs commitlint, so a non-conforming message is
rejected at commit time. That is not style enforcement: release-please parses
these prefixes, so a message it cannot read makes the change **invisible to the
release** — it silently never appears in the changelog or triggers a version
bump. Cheaper to catch at the commit than to notice a release is missing things.

Hooks install themselves via the `prepare` script on `pnpm install`.

### Getting a token

Go to **https://mod.io/me/access** (avatar -> Access). That page offers two
things and only one works:

- an **API key** - read-only, cannot upload;
- an **OAuth 2 Access Token** - create this one, with **Read and Write**.

Paste it into `.env` as `MODIO_TOKEN`, then run `pnpm release:check`. `.env` is
gitignored. Scripts load it via `node --env-file`, so there is no dotenv
dependency.

## Verifying

```bash
pnpm verify
```

Runs lint, typecheck, the adapter-boundary check, the API docs drift check, and
the tests.

## How planning works

Three ways to plan, sharing one contract. In every one the mod supplies a list
of candidates it has **proven it can execute**, and the planner picks an index —
it never authors skill or recipe ids. A hallucinated objective is structurally
impossible, not merely discouraged.

**1. A Claude Code session (primary).** `.mcp.json` registers an MCP server
exposing `get_agent_state`, `list_candidates`, `set_objective`, `get_journal`,
`get_recent_activity` and `control_agent`. Open a session in this repo and it
can read the game and decide what to play next.

**2. The Claude API (unattended).** With `ANTHROPIC_API_KEY` set, `/plan` calls
`claude-opus-5` with a structured output constrained to a candidate index plus a
target and a budget. This is what keeps the agent going at 4am when no session
is attached. Bounded by `PLANNER_DAILY_TOKEN_BUDGET` (default 200k output
tokens/day); past that it falls back to the heuristic.

**3. A deterministic heuristic (always).** Scores candidates on XP/hr. Used when
there is no API key, when the budget is spent, and after two consecutive model
failures. Degrade, never halt — `GET /health` reports which is live.

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

Combat is supported too, behind the survivability gate (below).

Still excluded, with reasons:

- **Farming** — plant-then-wait-then-harvest, not a continuous action. It needs
  its own objective kind rather than being forced into `gather_resource`.
- **Township, Cartography, Archaeology** — management interfaces rather than a
  single startable action.
- **Alt Magic spells that consume a chosen bank item** — they need a second
  selection whose correct argument depends on the spell's consumption type.
  Refused explicitly rather than guessed at.

## The combat gate

Combat is the only capability that can lose something irreversible, so
deterministic code proves survivability before any fight. The planner gets no
vote — it cannot even express an override.

The gate sits in the runtime *between* the policy intent and the game call, so
neither a policy bug nor a planner output can reach `engageMonster` without a
passing verdict. Two conditions, both required:

1. **Cannot be one-shot.** The enemy's max hit, after the resistance that
   applies to *its* damage type, must be below 60% of the auto-eat trigger. Auto
   eat fires *at* the threshold, so a hit landing above it kills before auto eat
   gets a turn.
2. **Can sustain.** Healing per auto-eat must outpace damage per enemy attack by
   1.5x, and equipped food must cover the intended session with 25% slack.

A monster in the registry has no max hit — only an instantiated `Enemy` does —
so the gate spins up a throwaway `Enemy`, hands it the monster and lets the
game's own code compute the stats. That's MICSR's approach, and it's why neither
project reimplements damage formulas. For a dungeon, every monster is measured
and the worst is used; one unmeasurable monster makes the whole dungeon
unmeasurable, because skipping it would silently judge the dungeon by the
monsters that happened to work.

Combat engages as soon as the gate passes. The gate logs its full verdict either
way, so a refusal is always diagnosable after the fact.

Independent of the gate, a runtime backup disengages at the next kill boundary if
HP drops below 50% or food below 5 items. Combat can't be exited cleanly
mid-fight, so it takes the gap early.

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

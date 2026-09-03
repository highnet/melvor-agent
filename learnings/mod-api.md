# Mod API learnings

## `onCharacterLoaded` fires BEFORE offline progress — it is the wrong gate

The obvious-sounding hook is the wrong one. `onCharacterLoaded` is documented as running
"after the player's chosen character has loaded and all game objects are created, but
**before offline progress calculations**." Snapshots taken there describe a character that
is about to have up to 24 h of progress applied to it.

`onInterfaceReady` is the post-offline hook: "after offline progress has been calculated and
all in-game user interface elements have been created."

```ts
export function setup(ctx: Modding.ModContext) {
  ctx.onCharacterLoaded(() => {
    // safe: read settings, wire UI scaffolding, register patches
  });
  ctx.onInterfaceReady(() => {
    // ONLY here: snapshot state, start any automation
  });
}
```

Source: wiki `Mod_Creation/Mod_Context_API_Reference`, verified against `mod.d.ts`
`mod.trigger` (exactly five lifecycle triggers exist).

## Offline progress is not a startup-only event — it recurs after 60 seconds

`Game.MIN_OFFLINE_TIME = 60000`. A stalled game loop (tab throttled, laptop asleep) longer
than one minute re-enters the offline loop *during* a running session, and
`Game.MAX_OFFLINE_TIME = 86400000` caps it at the familiar 24 h.

So `onInterfaceReady` alone is not enough for a long-running agent: it fires once. The
recurring signal is a pair of `Game` events:

```ts
declare type GameEvents = {
    offlineLoopEntered: GameEvent;
    offlineLoopExited: GameEvent;
    requirementChange: RequirementChangedEvent;
    skillAction: SkillActionEvent;
};
```

Suspend all tiers on `offlineLoopEntered`, resume and re-snapshot on `offlineLoopExited`.
`Game._isInOnlineLoop` is a per-tick guard for the same condition — underscore-prefixed, so
wrap it in the adapter rather than reading it directly.

`GameEventEmitter` wraps **mitt** and is typed against the `GameEvents` map, so the event name
is compile-checked and the payload inferred:

```ts
const onExit = () => { /* re-snapshot, replan */ };
game.on('offlineLoopExited', onExit);
game.off('offlineLoopExited', onExit);   // no `once` exists — hand back a disposer
```

`'*'` is supported as a wildcard and is a useful debug tap. Note `GameEventMatcher.assignHandler()`
— the mechanism for skill-action/requirement events — *does* return an unassign function.

Source: `gameTypes/game.d.ts`, `gameTypes/gameEvents.d.ts`.

## `setup` loads as an ES module — esbuild `format: "esm"`

The manifest's `setup` entry is imported as a module and the loader looks for a named export
`setup`. Bundle to one file with `format: "esm"`, `platform: "browser"`, `target: "es2022"`.

The asymmetry that bites: for `setup`, both `.js` and `.mjs` are treated as modules. For
`load`, a file must end in `.mjs` or it is injected as a **classic script**. Keep `load` for
CSS only and there is nothing to get wrong.

MICSR ships `"setup": "built/contentScript.js"` — a single bundled file — which confirms the
pattern in the wild.

## Patch hooks need `function`, not arrow functions

Patch hooks are called with `this` bound to the patched instance. An arrow function silently
captures module scope instead, and the failure is quiet.

```ts
ctx.patch(Skill, 'addXP').before(function (amount, masteryAction) {
  // `this` is the Skill instance
  return [amount * 2, masteryAction];
});
```

`before` returning an array replaces the arguments; returning nothing leaves them alone.

## `characterStorage` will not persist for a local mod unless it is linked to mod.io

Wiki `Mod_Creation/Creator_Toolkit`: "In order for a local mod to persist data
(`characterStorage`, `accountStorage`, and `settings` values), the mod must be linked to
mod.io and you must have subscribed to and installed the mod via mod.io."

A private (non-public) mod.io entry satisfies this without publishing anything. Also: the cap
is 8,192 bytes per character per mod, keys included, JSON-serializable values only — settings
fit, a journal does not. And `characterStorage` is unusable before `onCharacterLoaded`.

**Unconfirmed:** whether writes on an unlinked mod throw or fail silently. Test this before
trusting any persistence.

## The wiki blocks normal fetches; use `api.php`

`wiki.melvoridle.com` returns HTTP 403 to page URLs but serves the MediaWiki API fine with a
descriptive User-Agent:

```
https://wiki.melvoridle.com/api.php?action=parse&page=Mod_Creation/Essentials&prop=wikitext&format=json&formatversion=2
```

`action=query&list=allpages&apprefix=<prefix>` enumerates a page tree.

## Lint autofix will rewrite patch hooks into arrows — disable that rule

Biome's `lint/complexity/useArrowFunction` rewrote

```ts
ctx.patch(Game, 'loop').after(function () { ... });
```

into an arrow function on the first `--write` run. That is precisely the
documented `this`-binding trap: patch hooks are invoked with `this` bound to the
patched instance, and an arrow captures module scope instead. It happened to be
harmless in that hook because it does not use `this` — the next one that does
would fail silently.

`useArrowFunction` is now `off` for `packages/mod/src/adapter/**` in `biome.json`.
Any linter or codemod touching patch hooks needs the same treatment.

## The `Game` class reference is an API touchpoint that does not look like one

An adapter-boundary rule that only greps for `game.` misses this:

```ts
ctx.patch(Game, 'loop')   // <- `Game`, the class, passed as a value
```

There is no dot, so it reads as ordinary code. `scripts/check-adapter-boundary.mjs`
matches bare class identifiers followed by `,`, `)` or `]` for exactly this reason,
and it caught a real leak on its first run.

## `ctx.patch` has no unpatch

`ModContext` exposes `patch` and `isPatched`, but nothing to remove a patch. A
disposer for a patched hook can only flip a flag so the handler stops doing work;
the patch itself stays installed for the life of the page. Budget for that when
designing teardown — the kill switch cannot truly un-hook the game loop.

## A namespace may not start with "melvor" — and the error names no file

The manifest rule is: alphanumeric and underscores only, and it **cannot start
with the word "melvor"**. That prefix is reserved for the game's own data
namespaces (`melvorD`, `melvorF`, `melvorTotH`, `melvorAoD`, `melvorItA`).

`melvorAgent` looks like a natural name for a Melvor mod and is invalid. The
Creator Toolkit rejects it at *link* time with:

> Namespace is invalid. Namespaces must only contain alphanumeric characters and
> underscores and cannot start with the word "melvor".

Two things make this expensive to diagnose. The error appears in the Add Mod
dialog next to the **Name** field, which is the mod's display name and has
nothing to do with the namespace — so the obvious fix (rename the mod) does
nothing. And the message never says the value came from `manifest.json`.

`build.mjs` now validates the namespace, so it fails at build time with a message
that names the file.

## The Steam client is an iframe on a public HTTPS origin — `fetch` to localhost is blocked

`package.nw/index.html` is a local page whose entire body is:

```html
<iframe id="game" src="https://steam.melvoridle.com" ...></iframe>
```

Mods run inside that iframe, so the page origin is **`https://steam.melvoridle.com`** —
public and secure. A request to `http://localhost:8787` is therefore a public
secure page reaching into the private, insecure address space, which Chrome
gates behind Private Network Access.

The symptom is a bare **`Failed to fetch`** with no CORS error, because CORS is
not the problem — which sends you debugging the wrong layer for a long time.
Answering the PNA preflight (`Access-Control-Allow-Private-Network: true`, which
must be set *before* Hono's `cors()` since that answers `OPTIONS` itself) helps
on some Chromium builds and not others, and the feature's roadmap is toward
blocking the combination outright.

**The fix is to leave Chromium's network stack entirely.** The same manifest says:

```json
"nodejs": true,
"node-remote": ["https://*.melvoridle.com/*"]
```

`steam.melvoridle.com` matches, so the game frame has full Node integration and
`require('http')` works. Node's HTTP client has no CORS, no mixed content and no
PNA. Verified end to end: GET, POST with a body, and both `localhost` and
`127.0.0.1`.

```ts
const require_ = (globalThis as any).require ?? (globalThis as any).nw?.require;
const http = require_('http');   // no browser policy applies
```

Feature-detect it and keep `fetch` as the fallback, so the mod still works in a
plain browser where Node is absent.

Related: `localhost` and `127.0.0.1` are not interchangeable in a packaged
Chromium — name resolution, IPv6 vs IPv4, and PNA classification can each
differ, and every failure looks identical. Try both.

## The shipped game source is on disk, and it settles what the typings cannot

Four loops of the same shape were found in one day, and every one of them ended
in the same place: the typings say what a method *takes*, never what it *reads*.
`repairBuilding(building, render?)` (township.d.ts:723) looks total. It is not —
it reads `currentTownBiome` and returns when nothing is selected. No signature
can express that, and no amount of staring at a `.d.ts` will.

The game's own JavaScript answers it in ten seconds, and it is already on this
machine. The Steam build is an nw.js shell that loads the real game over HTTPS,
so there is no game JS under `package.nw` — but there is in the nw.js HTTP cache:

```
%LOCALAPPDATA%\Melvor Idle\User Data\Default\Cache\Cache_Data
```

Entries are **brotli**, so a plain `grep` over that directory finds nothing and
looks like proof the source is not there. It is; decompress first. `data_0`..
`data_3` are locked while the game runs — skip them, the payloads are `f_*`:

```python
import os, brotli
d = os.path.expandvars(r"%LOCALAPPDATA%\Melvor Idle\User Data\Default\Cache\Cache_Data")
for name in os.listdir(d):
    try: raw = open(os.path.join(d, name), 'rb').read()
    except OSError: continue          # data_* are held open by the running game
    try: body = brotli.decompress(raw)
    except Exception: continue
    if b'repairBuilding' in body: print(name, len(body))
```

That found `township.js` — readable, unminified v1.3.1 source, ~200KB — and the
bug was the first line of the method. Confirming from the same file that
`repairAllBuildings` iterates `this.biomes` itself, so the batch path was never
affected, took another ten seconds; guessing at that would have cost an hour and
a wrong guard.

Read-only, and it is the *shipped* build rather than a published repo, so it
matches the version the agent is actually running (`gameVersion` stamps which).
Reach for it whenever the question is "what does this method read that it does
not take" — which is most of the questions that produce a silent no-op.

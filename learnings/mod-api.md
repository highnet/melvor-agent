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

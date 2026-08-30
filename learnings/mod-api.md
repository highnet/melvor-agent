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

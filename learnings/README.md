# learnings/

Hand-curated, non-obvious facts discovered the hard way. Not generated — `docs/API.md` is
the generated reference, this is the opposite.

**Read this directory at the start of every session.**

One entry per fact. Format: what bit us, why, and a working snippet. Newest at the bottom of
each file. Keep entries short.

Files:
- `mod-api.md` — mod loader, context, lifecycle, build
- `game-state.md` — game objects, registries, return-value traps

## Protocol: encode efficiencies in code, not in planning sessions

When an efficiency is found — a cheap upgrade worth buying, a token worth
claiming, a conversion worth doing, a faster variant of the same action — the
work is not "do it". The work is **make the agent do it without being told**.

A planning session that notices something is a session that will not notice it
next time, and the operator should not be the mechanism. Every efficiency found
by looking at the screen is a reflex, a candidate, or a guard that was missing.

Worked examples, all from one session:

| Found | Wrong fix | Right fix |
|---|---|---|
| 50 GP axe unbought at 43,860 GP | buy it | reflex buys cheap permanent upgrades |
| 10,000 GP axe unbought at 58,733 GP | buy it | raise the reflex's band to 25% |
| Mastery Tokens sitting in the bank | claim them | reflex claims them, sell guard refuses them |
| Farming seeds on the sell list | do not sell them | sell reader excludes every seed |
| Mind Runes sold, Magic unusable | craft more | sell reader excludes runes a castable spell needs |

The tell is a sentence beginning "we should" — if it is true now it will be true
tomorrow, and tomorrow nobody is watching.

Corollary: prefer the guard that makes the mistake unavailable over the fix that
makes it undone. A sell list that cannot offer seeds is stronger than a planner
that remembers not to pick them.

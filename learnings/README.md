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

## If the fix is free, it is never a plan

The protocol above says encode efficiencies in code. This is its sharp edge, and
it was learned by killing the character.

The food reserve ran out during Thieving. An hour earlier I had looked at
exactly that shortfall, added a warning, and argued in the commit message for
*reporting* it rather than acting: restocking is a real plan — fish, then cook,
then come back — and a reflex would send the agent off fishing mid-objective.

Both halves were wrong.

**The asymmetry was backwards.** A detour costs minutes. Running out costs the
character. When one branch is recoverable and the other is not, "let the planner
decide" is not caution; it is a bet that someone is watching.

**The premise was false, and checkable.** Passive cooking does not take the
action slot. Its own candidate label says so: *"runs in the background of
whatever else is happening."* I had read that line a dozen times that day. There
was never a trade-off to delegate — cooking while Thieving is free.

Every ingredient was present when it died: sixteen Raw Beef, nineteen Raw
Shrimp, Cooking 22, two idle cookers, and a warning I had written myself. It
starved surrounded by food it could have cooked.

The test before deciding something belongs to the planner:

1. Does acting cost anything the agent cannot get back? If no, reflex.
2. Does *not* acting cost something it cannot get back? If yes, reflex.
3. Is the "cost" I am protecting actually real — or did I infer it? Check.

Step 3 is the one that failed. The others were reasoning; this was a fact
sitting in a string literal.

## Verify the outcome, not just the data

The dump said Golbin drops Garum Seeds. That was true, and it was not the
question. The question was whether *this character* could kill a Golbin, and
the answer was no: Magic 2 does too little damage to finish one.

The failure was silent in every way that matters. `combat.engage` returned ok.
The panel said "Doing: Combat". Air Runes drained, so spells were being cast.
Food was eaten every minute, so damage was being taken. Everything looked like
a fight. Nothing died.

What actually exposed it was a number that did not move: GP frozen at exactly
30,816 across three state reads fifteen minutes apart, with no Bones
accumulating from a monster that drops them. Switching to Thieving moved GP
within one report.

The general rule, which cost a plan to learn twice in one day:

- **A capability check is not an outcome check.** "The game accepted the
  action" and "the action achieved something" are different claims, and the
  adapter can only ever prove the first.
- **Pick the counter before starting.** Decide in advance which number must
  move — GP, a drop, a level — and check it early. A fight that produces
  nothing looks identical to a fight that is about to produce something, and
  the only difference is a counter.
- **Excitement about a finding is when to be most careful.** The Golbin drop
  was a genuine discovery from real data, and it went straight into a
  twelve-hour plan without a single kill being confirmed first.

## A guard that can starve its own precondition

The bank filled. Every gathering action is refused when its output has nowhere
to go, so income fell to exactly zero. The fix — a bank slot — cost 33,068
against a reflex cap of half the balance, 29,684. Short by 3,384, with no way
to ever earn the difference.

Two hours of an agent working perfectly and achieving nothing: 150 refusals to
start, 150 abandoned objectives, 75 stopgaps adopted and refused in turn. Every
individual decision was correct.

The shape is worth naming because it is not "a bug in the guard". The guard was
reasonable in isolation: *do not spend more than half your money on storage*. It
became a trap because the resource it protected — GP — could only be replenished
by the thing it was blocking. A cap on spending assumes earning continues.

The test to apply to any threshold:

1. What does this guard protect?
2. What replenishes that thing?
3. **Can the guard block what replenishes it?**

If yes, the guard needs an escape at the limit, not a smaller number. Two
escapes were added here: at zero free slots the purchase spends whatever it
takes, and if even that fails, one cheap stack is sold. Both are worse than the
normal path and both are better than stopping.

The same question applies to the food reserve, the Thieving damage gate and the
survivability gate. None of them currently gate their own replenishment — but
none of them were checked for it either, until this cost a morning.

## Check what kind of thing the game thinks it is

Agility thrashed for fifteen minutes — stop, run, stop, run, every three
seconds, zero XP — because an objective pinned one obstacle and Agility runs a
*course*. The built obstacles cycle and the game advances through them itself.
There is no "select this obstacle" the way there is "select this tree".

Every layer behaved correctly. The candidate reader emits one entry per
obstacle, which is right: they have different rates and different level gates.
The policy stops a skill running the wrong recipe, which is right, and exists
because this agent once idled while cutting Oak after being told to cut Willow.
Composed, they produced a loop that could never terminate.

The tell was that it had "worked" before. Cargo Net ran fine for five levels —
because Cargo Net happened to be the obstacle the course was on. A coincidence
that looks like a passing test.

Before modelling a game action as a `{skill, recipe}` pair, ask what the game
lets you choose:

- **Tree, ore, fish, recipe** — you select it; pinning is correct.
- **Agility course** — you build it, the game runs it; only "active" is askable.
- **Thieving NPC** — you select it, but its success rate is only readable while
  the skill runs, which is a different trap in the same family.

The general form: a wrong ontology produces code that is locally correct
everywhere and globally broken, and it will often pass by luck first.

## A reload is not a pause

The character died at Thieving *during* a reload, holding 99 cooked Seahorse.

Melvor computes offline progression from the save. A save taken mid-Thieving
tells the next session to replay every second of elapsed time — landing all the
hits — while the mod is not yet loaded, so none of the reflexes that answer
damage are running. The death happens during the load, before anything that
could have prevented it exists. And the gap is unbounded on the other side: the
reload lands on the character-select screen and nothing resumes until a human
picks a character.

So "stop the dangerous thing before saving" is not politeness, it is the only
moment the stop can still be made. `reloadGame` now stops combat or Thieving
first and saves the stopped state.

The general shape: **an operation that suspends the agent does not suspend the
game.** Anything the agent was doing keeps costing whatever it costs, with the
agent's judgement removed. Ask of every such operation what runs while nothing
is watching.

## A count in the bank is a claim, not an observation

The same death had a second cause. `stopWhenStarving` — the last line of defence
— returned early on `meals > 0`, so while any food existed anywhere it could not
fire however low health went.

But eating happens from the *equipped* food slot. A bank count is only a claim
about what `eatWhenLow` should have been able to do; an empty slot, a refused
refill or the wrong item makes the claim false. Health at 20% is the observation
that it *is* false — and at that point the reading to trust is the health, not
the inventory.

Prefer the measurement over the ledger. When a guard's precondition is a stock
level and its purpose is to catch a failure, the failure it is catching is
usually the reason that stock level is not reachable.

The test that asserted the old behaviour was not a regression to work around. It
was the belief that killed the character, written down as an expectation.

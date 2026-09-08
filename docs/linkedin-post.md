# LinkedIn post — melvor-agent

## Main version

I spent a few months building an LLM agent that plays an idle game, and the
most useful thing I learned had nothing to do with the game.

Melvor Idle already simulates 24 hours of offline progress for whatever action
you left running. So an agent that keeps one skill going is worth exactly
nothing — the game does that for free. All of the value sits in the
**transitions**: banking, selling, buying the upgrade you can now afford,
re-equipping for a fight, switching skill when the current one goes dry.

That reframing changed the whole architecture. The metric is good transitions
per day, not uptime.

Three things that turned out to generalise well beyond a game mod:

**1. Never trust a return value — observe the state.**
The game's own API is inconsistent: `equipItem` returns a boolean, `equipFood`
returns `boolean | undefined`, `removeItemQuantity` returns `void`. A truthiness
check is wrong in one case and impossible in another. So every action goes
through an `ActionResult` that diffs observed state before and after, and the
raw return value is only extra evidence. Any agent acting on a real system needs
this: "the call didn't throw" is not "the thing happened".

**2. The right fix for a missed opportunity is a reflex, not an instruction.**
When a session noticed a 50 GP axe unbought while sitting on 43,000 GP, the
wrong fix was buying the axe. The right fix was a reflex that buys cheap
permanent upgrades without being told. The tell is any sentence starting with
"we should" — if it's true now, it's true tomorrow, and tomorrow nobody is
watching. Prefer the guard that makes the mistake *unavailable* over the fix
that makes it undone.

**3. Fail closed, at a named boundary.**
The agent refuses to arm unless the character is on an explicit allowlist (empty
list fails closed on purpose), the knowledge dump matches the running game
version, and the realm isn't one it can't reason about. Every combat encounter
goes through a survivability gate that refuses anything it can't prove
survivable. There's no dry-run mode — arming means it really plays, and the gate
is what keeps that safe, not a toggle.

The stack: a TypeScript monorepo — a sandboxed in-game mod, a local Hono
service holding everything durable, a terminal dashboard, and zod schemas as the
contract between them. Planning objectives arrive from a Claude Code session
over MCP; when no session is attached the agent keeps executing its current
objective rather than stopping. It never stops playing, it just stops changing
its mind.

There's also a `learnings/` directory of things that bit me, read at the start
of every session, and an `IMPROVEMENTS.md` that's now 75k of "here's what went
wrong and why". Honestly the most valuable files in the repo.

Building an agent for a game that doesn't matter is a very cheap way to learn
what agents get wrong when it does.

#AI #LLM #Agents #TypeScript #SoftwareEngineering

---

## Short version

Melvor Idle simulates 24h of offline progress for whatever you left running. So
an agent that keeps one skill going is worth nothing — the game does that free.
The value is entirely in the transitions: bank, sell, buy the upgrade, re-equip,
switch skill.

Three lessons from building it that generalise past the game:

→ Never infer success from a return value. The API returns `boolean`,
`boolean | undefined`, and `void` for equivalent operations. Diff observed state
instead. "It didn't throw" is not "it worked".

→ When a session spots a missed opportunity, don't fix the instance — build the
reflex. Any sentence starting "we should" is a missing guard, because tomorrow
nobody's watching.

→ Fail closed at a named boundary. Empty allowlist means refuse. No dry-run
mode; a survivability gate that runs on every fight is what makes acting for
real safe.

TypeScript monorepo: sandboxed game mod, local Hono service, terminal dashboard,
zod schemas as the contract. Objectives come from a Claude Code session over
MCP — and when none is attached it keeps playing the objective it has. It never
stops playing, it just stops changing its mind.

#AI #Agents #TypeScript

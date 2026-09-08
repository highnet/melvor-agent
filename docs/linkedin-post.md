# LinkedIn post — melvor-agent

## What the game looks like (for readers who've never seen it)

Two official Steam store screenshots, saved here so the post can show a reader
what "an idle RPG" actually means before making a point about it.

`melvor-idle-skill-screen.jpg` — the skill screen. Best single image for a
non-gamer: 20+ skills down the left, and a grid of trees to cut, each with its
XP and its seconds-per-action. This is the whole game in one frame — pick a
thing, it repeats, you come back later.

`melvor-idle-combat-screen.jpg` — the combat screen. Worth pairing with the post
because it shows the numbers the agent's gate actually reads: your HP, the
enemy's HP, max hit, and the food slot. "Refused the fight because the enemy hit
harder than it could heal" is legible here in a way it isn't in prose.

**Suggested carousel order:** game screenshot first (here's the world), agent
dashboard second (here's what it did in it).

⚠️ These are Melvor Idle's own store screenshots — Games by Malcs' copyright, not
mine. Fine for editorial/commentary use with credit ("Screenshot: Melvor Idle,
Games by Malcs"), but they are not my artwork and the post shouldn't imply they
are. A capture from your own save avoids the question entirely.

Source: https://store.steampowered.com/app/1267910/Melvor_Idle/

---

## Screenshot of the agent

![The melvor-agent terminal dashboard: run state RUNNING, mod connected, the current objective, a levels/h and gp/h rate, the validated character snapshot, and an activity log showing a skill switch, a bank, a reflex shop purchase, a combat gate refusal, and an objective accepted from a planning session.](linkedin-tui.png)

Attach `docs/linkedin-tui.png` to the post. It is the real `packages/tui`
renderer (`render()` called directly, same code path as `pnpm tui`) with a
representative dashboard payload — not a capture of a live run, so no real save
data is in it.

**Suggested caption for the image:**

> The whole agent in one pane: what it's doing, whether that's beating a single
> skill left running, and every transition it made in the last 15 minutes —
> including the fight it refused.

Why this frame earns its place: the log tells the story the post makes. A skill
switch when the rate fell below band. A reflex buying an upgrade nobody asked it
to buy. The gate refusing a dungeon because max hit exceeded the auto-eat
threshold. An objective arriving from a planning session. That's transitions,
reflexes, and failing closed — visible in eight lines.

---

## Main version (short / hook-first)

I gave Fable 5.1 one instruction: **"play this game while I sleep."**

Not "here's a script." Not fifty rules. One sentence.

The game is an idle RPG — you pick a skill, it grinds by itself, you come back
later. It already plays 24 hours of that for you automatically. So an agent that
just keeps something running is worth exactly zero.

Everything that matters happens in the **switches**: sell the loot, buy the
upgrade you can suddenly afford, change gear, change skill when the current one
stops paying, walk away from a fight you'd lose.

Eight hours later I opened the dashboard.

It had switched skills when the returns dropped. Bought an upgrade nobody told
it to buy. Sold 1,204 items — and quietly excluded the ones it would need later.
Then refused a fight, on its own, because the enemy's max hit was above what it
could heal through.

That last line is the whole thing. Not that it played well.

That it knew when not to.

The three rules that made it work:

→ Never believe a return value. Check what actually changed in the world.
→ When it misses an opportunity, don't tell it — give it a reflex. Anything
starting with "we should" is a missing guard, because tomorrow nobody's watching.
→ Fail closed. Empty permission list = refuse. No "practice mode."

Built as a TypeScript monorepo. Full writeup + code in the comments.

Would you let one run unsupervised?

#AI #Agents #LLM #SoftwareEngineering

---

## Even shorter (if the above still feels long)

I gave Fable 5.1 one instruction: **"play this game while I sleep."**

It's an idle RPG. The game already grinds for you 24 hours at a time, so keeping
something running is worth nothing. All the value is in the switches — sell,
upgrade, re-gear, change skill, walk away from a fight you'd lose.

Eight hours later: it had switched skills when returns dropped, bought an
upgrade nobody told it to buy, sold 1,204 items while excluding the ones it'd
need later — and refused a fight because the enemy hit harder than it could heal.

Not that it played well. That it knew when not to.

Three rules got it there:
→ Never believe a return value — check what actually changed.
→ Don't tell it what it missed. Give it a reflex.
→ Fail closed. Empty permission list = refuse.

Would you let one run unsupervised?

#AI #Agents #LLM

---


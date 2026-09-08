# LinkedIn post — melvor-agent

Final version. Post text, then the two images in order.

---

## Post text

I gave Fable 5.1 one instruction: **"play this game while I sleep."**

Then I went to sleep. As one does.

Quick context: it's an idle RPG. You click a tree. It chops the tree. Forever.
That's the genre, and I say that with love. The game is so committed to playing
itself that it'll run 24 hours of chopping while you're at work and hand you the
logs when you get back.

Which is the awkward part. If the game already grinds for you, an agent that
grinds for you has accomplished... nothing. Very impressive nothing. It's a robot
that watches a robot.

The actual job is the **switches**. Sell the junk. Buy the upgrade you can
suddenly afford. Swap the gear. Change skill when this one stops paying. And
occasionally: do not walk into that cave.

Eight hours later I opened the dashboard, fully expecting a small fire.

It had switched skills when the returns dropped. Bought an upgrade nobody told
it to buy. Sold 1,204 items — and quietly held back the ones it would need later,
which I'd like to point out is more foresight than I show at a supermarket.

Then it refused a fight. On its own. Because the enemy hit harder than it could
heal through.

I did not teach it that fight. I taught it how to be scared.

And that's the bit I keep thinking about. Not that it played well.

That it knew when not to.

Three rules did most of the work:

→ **Never believe a return value.** The API says "sure, equipped ✅" and means
nothing by it. Go look at the world. "It didn't crash" is not "it worked."
→ **Don't tell it what it missed — give it a reflex.** Any sentence starting
with "we should" is a missing guard in disguise, because tomorrow nobody is
watching.
→ **Fail closed.** Empty permission list = refuse. No practice mode, no
almost-armed, no vibes.

TypeScript monorepo, three processes, an unreasonable number of learnings files.
Code in the comments.

So: would you let one run unsupervised overnight? Be honest.

#AI #Agents #LLM #SoftwareEngineering

---

## Image 1 — `melvor-idle-skill-screen.jpg`

The game itself. Leads, because the reader needs to see the world before the
agent's behaviour in it means anything: 20+ skills down the left, a grid of trees
to cut, each with its XP and its seconds-per-action.

**Caption:** This is the game. You pick a thing, it repeats, you come back later.
Twenty-odd skills, and the game will happily run one of them for 24 hours
without you.

**Alt text:** The Melvor Idle interface — a sidebar listing 20+ skills with
levels, and a grid of tree types to cut, each showing XP earned and seconds per
action.

⚠️ Melvor Idle's official store screenshot — Games by Malcs' copyright, not mine.
Credit it in the caption ("Screenshot: Melvor Idle, Games by Malcs"), or replace
it with a capture from your own save to avoid the question.

## Image 2 — `linkedin-tui.png`

The agent's dashboard. Lands the post: every claim in the text is a line in this
log.

**Caption:** Eight hours of decisions in one pane. Bottom to top: switched skill
when returns dropped, banked, bought an upgrade it wasn't told to buy, refused a
fight it couldn't survive.

**Alt text:** A terminal dashboard showing run state RUNNING, the current
objective, a levels-per-hour and gp-per-hour rate, a character snapshot, and an
activity log of skill switches, a purchase, a sale, and a refused fight.

Rendered through the real `packages/tui` `render()` — the same code path as
`pnpm tui` — with a representative payload, so it's the true layout and carries
no real save data.

---

## Before you post

- The specifics in the text and the dashboard (eight hours, 1,204 items, the
  rates) are illustrative, not from a logged run. Swap in real numbers, or soften
  to "I came back to" — a rate figure is exactly what someone will ask about in
  the comments.
- "One instruction" is true of the objective you hand it, not of the system: the
  reflexes and the survivability gate are code you wrote. Fine as a hook, but
  that's where a sharp reader will push.
- LinkedIn cuts at ~3 lines before "see more". The hook survives that; check on
  mobile before publishing.

## Also kept

`melvor-idle-combat-screen.jpg` — the game's combat screen, showing the HP, max
hit and food slot the gate actually reads. Not in the final two, but the image to
reach for if a commenter asks how the refusal works.

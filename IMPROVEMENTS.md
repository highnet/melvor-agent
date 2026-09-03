# Improvement backlog

Compiled from an eleven-agent audit of the repo — safety, rate modelling,
planning, combat, idle systems, observability, architecture, bank and economy,
the knowledge dump, unattended autonomy, and a per-skill sweep — plus a separate
audit of every mastery- and modifier-driven accessor the game exposes.

Roughly a hundred findings, deduped to the list below and ordered by expected
value rather than by effort. Every entry was verified against the code or
`vendor/melvor-typings/gameTypes/*.d.ts`; the few things that could not be
verified say so rather than guessing at them.

**Convention:** `[x]` done, `[ ]` open. Effort S/M/L. Where separate agents found
the same thing independently it is marked *(n×)* — that is a signal, not noise.

---

## Recurring shapes

Three patterns account for most of the list, and naming them is more useful than
any single entry.

1. **A guard that looks present and is not.** Food had every protection except
   the one that mattered. `deathsSinceStart` is only ever reset, never
   incremented. The combat gate's food check is dead code on the path that
   actually executes.
2. **A model that prices what produces and not what costs.** Mining charged the
   swing and not the respawn; Thieving charged the steal and not the stun; a
   chain charges its last step and not the tree beneath it.
3. **A dump that records what a thing *is* and not what it *costs and yields*.**
   Realms without unlock requirements, shop purchases without prices, recipes
   without inputs — each made a real question unanswerable, and each got
   answered with a guess instead.

A fourth, rarer and worse: **two readings of the same fact that disagree.** The
Township summary reported 0% health while the repair reflex correctly computed
100% and did nothing. Neither looked broken alone.

---

## Done

- [x] **The agent wears valuables into fights that give it nothing, and death
      takes one** — M. `Player.applyDeathPenalty()` (player.d.ts:410) is
      documented verbatim as *"Removes an item from the player's equipment on
      death"*. This character has died **55 times**. It is currently wearing a
      **Thiever's Cape** (3,900 GP, a Thieving reward and not a shop item, so
      losing it is not a purchase away) and a **Jeweled Necklace** (5,000 GP),
      neither of which contributes anything to a fight, plus **Bronze Arrows** in
      the quiver that a Staff of Air cannot fire.
      This is the forbidden category, not a tuning matter: the standing rule is
      the agent may die but may not take irreversible actions, and losing an
      unbuyable item to a random roll is exactly that. Worse, `fillEmptySlots`
      *adds* to the exposure -- an empty slot is filled with whatever scores
      best, which is how the necklace got on in the first place ("A Jeweled
      Necklace sat in the bank with an empty neck slot ... the choosing was
      not").
      The fix is to strip what does not earn its place before a fight and put it
      back after -- the `withTownBiome` / `withBuyQuantity` shape, applied to
      equipment. Note the adjacent work that already exists: `readGearUpgrades`
      now knows about style switches, `dominatesEquipmentStats` compares stats
      per key, and `readUnusableCombatStyles` already describes ammunition the
      equipped weapon cannot fire. What is missing is the idea that a slot can be
      worth *emptying*.
      Care needed in two places: the Summon slot and the Barrier Gem may be
      consumed or contribute in ways the stat comparison does not see, and the
      operator's own selections are their state -- so this should strip what
      demonstrably contributes nothing, not everything it cannot score.
      Fixed, and the shipped source made it a bigger win than the brief
      assumed. `applyDeathPenalty` (f_00019a.js:2628-2643) rolls uniformly over
      the *whole* equipment array: `deathPenaltyPriority` defaults to 0
      (item.d.ts:197) and only the Decoy Idol sets -1, and the empty-slot
      placeholder is an ordinary item with the default too
      (f_00019d.js:346-362) -- so **empty slots are in the roll** and taking an
      item off converts its ticket into a blank rather than merely removing it.
      This array is 19 entries with 9 occupied, so the Cape and the Necklace
      were 1/19 each on all 55 deaths.
      `reflex.stripValuables` is one more clause beside `removePenalisingGear`
      rather than a second path: that one acts on gear that *actively hurts*
      the style, this one on gear the fight has no use for, and it inherits the
      ordering that reflex already documents -- after the bank reflexes,
      because unequipping needs a free bank slot and this bank runs 53 of 64.
      It fires only while `inCombat`, so the Thiever's Cape keeps its Stealth
      and its +10% Thieving GP the rest of the day.
      `reflex.restoreValuables` is the load-bearing half and is deliberately
      broader: `!inCombat && stashed` is one observation covering death, abort,
      victory and disengage alike, and `reloadGame` restores separately since a
      reload takes the page and the stash with it. Nothing added makes the
      agent fight less or gates a fight on gear state.
      The two cautions were both real and both settled from the data rather
      than by exclusion alone. A *combat* familiar carries `summoningMaxhit`
      and `consumesOn: PlayerSummonAttack` while the equipped Ent is a
      Woodcutting tablet -- the stat test alone would have stripped the wrong
      one of the pair, so the Summon slots are excluded outright and the
      synergy the planner arranges cannot be broken by a reflex. And the Basic
      Barrier Gem is the proof that "no combat stats" is not "inert": its
      `flatBarrierDamage` does **not** set `Modifier.isCombat`
      (modifiers.d.ts:295) yet plainly acts in a fight, which is why the rule
      is deny-by-default over an explicit table instead of a filter on that
      flag. See `learnings/game-state.md`.

- [x] **A fight is offered at full price while the selected attack spell cannot be
      cast** — M. Every combat goal has been blocked all evening and nothing in
      the candidate list says so. Both Fight Leech objectives were abandoned with
      `Wind Strike is selected but the bank cannot pay for it (needs 1x Mind
      Rune)` -- a Staff of Air is equipped, a Magic attack spell is selected, and
      the bank holds zero Mind Runes. Meanwhile `221. Fight Leech ... 200 HP
      (defence 10), ~84 kills/h, ~16,744 damage/h` is listed as available with
      full pricing, and a grep of the whole candidate text for "Wind Strike" or
      "Mind Rune" returns nothing.
      The executor's refusal is correct and legible; the *candidate* is the lie.
      Recipes already do this properly -- `Magic: Superheat II — Earth Rune from
      Runecrafting: Earth Rune — needs Earth Rune 1/3` blocks with a stated
      reason **and names the producer**. A fight should do the same: block it,
      say which spell is selected, which rune is missing, and which Runecrafting
      recipe makes it. Note the fix is not to change the selected spell -- that
      is the operator's, and today's `withBuyQuantity` / `withTownBiome` work
      established that the operator's UI selections are their state.
      Five goals depend on this: `ranged-20`, `defence-20`, `hp-40`, `prayer-20`,
      `first-dungeon`.
      Fixed by making the executor's own precondition a reader.
      `cannotAttackRefusal` becomes the exported `readCannotAttackReason`,
      returning the refusal *and* the shortfall as items; `readUnfightableCombat`
      turns that into one high-severity blocked line naming the spell, the rune
      and the Runecrafting recipe that makes it, and `combatEnumeration`
      withholds every fight, dungeon and combat event behind it. One line and
      not two hundred: the blocked window is twelve, and the live report already
      carried seventy low-severity fight lines competing for it.
      Two further refusals were wrong, both settled by reading the shipped
      `Player.attack` out of the nw.js cache rather than guessing. The magic cost
      is `getRuneCosts` (player.d.ts:163), not raw `runesRequired` — it subtracts
      the runes the equipped staff provides, which is why the refusal named one
      rune while 253 of the other sat in the bank. And ranged ammunition is a
      *type* comparison, not a count: counting quantity let 981 Bronze Arrows arm
      a crossbow that fires bolts, and refused a Slingshot for a quiver the game
      never looks at. `startCombatEvent` had no such precondition at all and now
      has one.
      The guard cannot starve its own precondition, and that was checked: runes,
      ammunition and a different weapon are a Runecrafting candidate, the quiver
      reflex and an equip candidate respectively — not one of them a fight.

- [x] **`reflex.repairTownship` never succeeds and never stops** — S. Fired once
      a minute, indefinitely, always warning `state unchanged after call:
      {"buildingId":"melvorF:Miners_Pit","biomeId":"melvorF:Mountains","count":1,
      "efficiency":85} -> {identical}`. Root cause found and fixed, not bounded.
      `Township.repairBuilding(building, render?)` (township.d.ts:723) is the
      game's own button callback and reads `currentTownBiome` (:423) for the
      biome, opening with `if (biome === undefined) return;`. The agent never
      opens the town page, so that early return was *every* repair it ever made:
      nothing spent, nothing changed, nothing thrown. `canAffordRepair(building,
      biome)` (:691) does take the biome, and kept truthfully answering yes
      about a biome the repair would never look at -- so the offer stayed valid
      and the reflex retried forever. The biome lead in this entry was half
      right: the biome is the problem, but it is dropped on the way in rather
      than crossed on the way out.
      `buildTownshipBuilding` had already met this with `buildBuilding` and
      solved it; that scoping is now a shared `withTownBiome` helper both paths
      use. `repairAllBuildings` was never affected -- it iterates every biome
      itself.
      Settled without an eval channel by reading the shipped game: the Steam
      build loads `steam.melvoridle.com`, and the brotli-compressed township
      bundle sits in the nw.js HTTP cache. See `learnings/mod-api.md`.

- [x] **The sell reflex ate the food chain** — S. Live log, three consecutive
      lines: `cooking.cook ok`, `reflex.liquidateSurplus fired`,
      `cooking.cook refused: missing ingredients for melvorAoD:Halibut`. The
      raw fish were sold out from under the cook consuming them, the objective
      was abandoned as "the game refuses it in this state", and the plan
      advanced past the one step that would have produced food. It had happened
      before unnoticed -- 259 cooked Seahorse and their raw stock went the same
      way earlier in the session. The larder guard could not catch it because it
      asks `item instanceof FoodItem` and a raw fish is not food, it is what
      food is made of; so the guard held the meals and sold the means of making
      more. `saleExclusionReason` now withholds cooking inputs too, but only
      while the larder is under the 40-meal floor -- Raw Poison Fish is one of
      the best GP rates on the board and is ordinary stock once there is food.

- [x] **A plan step whose target is already met completes instantly and drains
      the plan** — S. Observed twice: a three-step plan asked for Cooking 44 and
      Fishing 40 when Cooking was already 44 and Fishing 42, so both steps were
      satisfied the moment they were queued, completed without doing anything,
      and the plan emptied within minutes -- the operator's own report was "we
      are skipping through the steps without doing them". `rungFor`
      (`packages/planner/src/mcp-tools.ts`) clamps a target *down* when it
      exceeds the budget but has no notion of one already reached; it projected
      "~0min" and said only that this was "a short rung". Both tools now refuse
      a step whose criteria as queued already hold -- refuse and not raise,
      because the caller read a stale level and every number they might be
      raised to is equally stale, so the refusal names the current reading
      instead. Checked per *criterion*, not per level: a stock target for
      something already banked drains a plan the same way. A step behind another
      step is judged only on criteria that cannot regress, which keeps "mine 200
      Gold Ore, then smelt" queueable; the rest is left to step start, where the
      mod now logs a completion inside ten seconds as one that did nothing.

- [x] **The stopgap adopted work whose inputs lasted one action** — S. Found
      while investigating the above. `Runecrafting: Smoke Rune` was adopted for a
      thirty-minute budget, crafted for three seconds and was refused for
      missing materials twice, a minute after the same with Alt Magic's Item
      Alchemy. Not a `canAfford` gap -- the log shows `Runecrafting.craft ok`
      with Smoke Rune selected before the refusal, so combination rune costs are
      read correctly and one action really was affordable, which is all
      `canAfford` claims. `sustainableMinutes` already had the answer and only
      ever reached the label, so both candidates said "inputs run out almost
      immediately" to a chooser that reads numbers. Now carried on the candidate
      as `sustainMinutes` and filtered on.

- [x] **Food is not auto-liquidated** *(2×)* — S. `sellToEscapeFullBank` sells the
      cheapest stack, and cheap food is the cheapest thing in a bank. One call
      from "bank full" to "starved".
- [x] **Auto Eat ownership no longer disables the food guards** — S. It is only
      `autoEatThreshold > 0`; with zero meals it switched off cooking, eating,
      the starvation stop and the warning together.
- [x] **`set_objective` no longer destroys the plan step it interrupts** *(2×)* — S.
- [x] **`revive()` no longer double-starts both clocks** — S. Two policy timers
      meant every irreversible action dispatched twice.
- [x] **Thieving priced from `getNPCInterval`, and failure charges its stun**
      *(2×)* — S. It read zero unless Thieving was already the running skill.
- [x] **The stale Thieving notice is gone** — S. It told the planner to disbelieve
      the rates the fix above had just made correct.
- [x] **Township health reports the real figure** — S. `data.healthPercent` reads
      0 on a full town; the summary now uses the same computation the reflex does.
- [x] **Mining respawn amortised**, over the mastery-adjusted `getRockMaxHP` — S.
- [x] **Mastery-aware intervals for every skill**, not just Woodcutting — M.
- [x] **Mastery-scaled yield and XP**, from the game's own accessors — S.
- [x] **Locked realms are never offered as candidates** — S.
- [x] **`abyssalLevel` is read for Into the Abyss content** — S.
- [x] **Township repair is a reflex** — S.
- [x] **Character select is automatic after a reload** — M.
- [x] **`reloadGame` stops damaging activity before saving** — S.
- [x] **Dump: realm unlock requirements, shop cost and ownership, and all 1,520
      skill recipes** with inputs, product and sale value — M.

## Critical — correctness or safety, do next

- [ ] **A level-only screen ranks equal to a proven one** — M. Not built,
      deliberately: scoped by the operator, and noted here so the scoping has
      the evidence. The fight that killed the character (death 56, Sweaty
      Monster: combat level 27, defence 24, the hardest target on the board) was
      passed by `combat screen passed` with the words *"Screened on levels only,
      not proven survivable"* and two `uncertainties` entries printed beside it.
      The caveat informed and did not bind: nothing downstream reads
      `uncertainties`, so a target the screen cannot vouch for sorts identically
      to one the full gate proved. This is *a number computed for a sentence is
      invisible to the code* in its most expensive form. The fix is ranking, not
      refusal — **the aim is choosing better targets, not fighting less**; making
      the agent avoid damage was tried earlier the same day and was the wrong
      lesson.
- [ ] **`upgradeGear` re-equips the same item forever** — S. The sixth loop of
      this class, found while chasing the fight thrash and left alone to keep
      that fix reviewable. On 2026-09-03 at 15:58 the log holds 89 identical
      `equipment.equip ok — itemId "melvorF:Staff_of_Air" -> "melvorD:Steel_Scimitar"`
      lines from the policy tier on the 3s clock, each followed by
      `reflex.upgradeGear fired` on the reflex clock — *two* tiers each swapping
      the weapon, at 15:58:10.916 / 15:58:11.403, 15:58:13.902 / 15:58:14.484,
      and so on for four minutes. The two disagree about which weapon is better
      and undo each other, which is the "one opinion per question" rule broken
      the other way from the valuables strip. `reflex.repairTownship: state
      unchanged after call` appears 381 times the same day and wants the same
      look.
- [ ] **A level target for a fight is never sized against the rate** — S.
      `rungFor` returns `{ level: targetLevel, note: null }` unchanged when the
      candidate has no `params.skillId`, which is every combat candidate. Now
      that a fight carries a real Hitpoints criterion, that criterion is the one
      shape with no guard — the exact asymmetry *a parameter nothing has ever
      passed* records for stock targets. It needs the combat candidate's own
      Hitpoints XP/h, which `readFightPricing` is the natural place to supply.
- [ ] **`successFor` still drops a target silently for any kind it cannot
      express** — S. Fights are fixed; the general hole is not. A blanket
      refusal is the wrong shape, because `targetLevel` is a required argument
      every caller passes including the genuinely one-shot sales and purchases
      the `[]` branch exists for, so refusing on "could not express it" would
      break them. The right fix is to name the *sustained* kinds — the ones that
      train while they run — and refuse when one of those produces no criterion,
      so the next `fight_monster`-shaped kind fails loudly instead of queueing an
      objective that can never complete.

- [x] **Death is never detected** *(2×)* — S. `deathsSinceStart` (agent.ts:302) is
      only ever assigned 0, so `abortWhen.deathsExceed` can never fire and the
      `death` trigger is never sent. Poll
      `game.stats.Combat.get(CombatStats.Deaths)` (statistics.d.ts:420,
      statTracker.d.ts:9) — that route needs no patching assumption.
- [x] **One throwing reader disables the whole reflex tier, permanently** *(2×)* —
      S. `runReflexes` builds its outcome array by calling every reader eagerly,
      and `onGameTick` has no try/catch, so one corrupt bank entry removes eating,
      the starvation stop and loot collection for the rest of the run while the
      policy tier still reports a healthy skill.
- [x] **No game-loop heartbeat** *(2×)* — S/M. The stuck detector runs *on* the
      clock that fails. Count ticks before the throttle and compare from the
      independent policy timer.
- [x] **Passive cooking fills a stockpile nobody collects** — S. Output does not
      go to the bank, `readMealCount` never sees it, so the cooking reflex fires
      forever and the meal count never moves. This is the mechanical form of the
      starvation death. `Cooking.stockpileItems` (cooking.d.ts:78).
- [x] **Aborting on the HP/food floor does not stop the damage** — M. The abort
      returns before the disengage path and emits no action, so at 14% HP the
      agent clears its objective and keeps fighting.
- [x] **`stopWhenStarving` cannot fire in combat** — S. `CombatManager` implements
      `PassiveAction`, so `activeAction` is undefined in a plain fight and
      `damagingSkillId` resolves to null; the stop callback cannot end a fight
      either.
- [x] **`blocked` is a permanent latch** *(2×)* — S. One malformed snapshot ends
      the night; recover as soon as a snapshot parses again.
- [x] **An offline-loop cycle silently re-arms a blocked agent** — S. Suspension
      restores to `running` without re-running any guard, defeating the character
      allowlist on a timer.
- [x] **The quiver is unwatched mid-fight** — S. Ammo is checked at engage and
      never again; an empty quiver is a silent zero-damage stall.
- [x] **The farm planting reflex is plot-category-blind** — S. It only ever
      considers plot `[0]`, so one Herb plot can livelock planting while
      allotment plots sit empty beside it.

## Rates and economics

- [x] **Passive-regen rocks now declare that their rate is unverified** — S. The
      suggested bound was implemented and measured: one HP per
      `passiveRegenInterval` came out 3.3x above the realised rate, so the model
      is known-wrong. `regenRockHP` (rockTicking.d.ts:176) restores an amount not
      stated in the typings and nothing exposes a sustained yield, so the rate is
      left as the upper bound it is and the label says so.
- [x] **No artisan skill reports GP at all, and no chain nets its inputs** *(3×)*
      — M. Smithing, Crafting, Fletching, Herblore, Runecrafting, Summoning,
      Cooking, Firemaking, Astrology and Alt Magic all read 0 GP/h, so a planner
      asked to raise GP can only see gathering and Thieving.
- [x] **Alt Magic shows 0 GP/h and is offered with no rune check** — M.
      `getAlchemyGP` (altMagic.d.ts:142) is the game's dedicated GP action;
      separately `canAfford` falls through to `return true` for every spell.
- [x] **Every Firemaking log is priced at its own interval** — S.
      `FiremakingLog.baseInterval` (firemakingTicks.d.ts:35) with modifiers from
      `modifyInterval` (skill.d.ts:426), which is action-scoped and so answers
      during enumeration where `actionInterval` throws. Ranking no longer
      degenerates to base XP and no longer inverts.
- [x] **Fishing assumes every action lands the fish**, and offers fish whose area
      needs an unequipped item — S. `getAreaChances` splits fish/junk/special.
      Whether a junk roll still pays XP is not stated in the typings.
- [x] **Cooking ignores a ~30% base failure rate** — S. `getRecipeSuccessChance`,
      `baseSuccessChance = 70`.
- [x] **Harvesting declares its vein decay unpriced** — S. Structurally identical
      to the mining respawn trap, but with no honest correction available: a vein
      decays through `reduceVeinIntensity` (harvesting.d.ts:109) past each
      product's `minIntensityPercent` (:16), and the decay per action is not
      stated in the typings. The rate stands as an upper bound and the label
      names it as one.
- [x] **Mining applies its interval modifiers, and prices its gems** — M. It was
      the only skill on the board using a raw constant; `modifyInterval`
      (skill.d.ts:426) takes the rock as an argument and so does not need an
      active selection. Gems now come from `getRockGemChance`
      (rockTicking.d.ts:154), `getRockSuperiorGemChance` (:155) and
      `chanceToDoubleGems` (:153), priced by `DropTable.getAverageDropValue`
      (utils.d.ts:458) rather than by picking a representative gem.
- [x] **Agility's lap rate is built from base constants** — S. The fix for a 3.5×
      overstatement reintroduced mastery blindness for the same skill; it also
      sums every built obstacle rather than the contiguous course.
- [x] **Woodcutting cuts one tree when `treeCutLimit` allows several** — M. The
      executor actively deselects the others, so the improvement is unreachable
      by construction rather than merely unused.
- [x] **"Output worth if sold" satisfies GP goals** — S. `goals.ts` treats
      `gpPerHour > 0` as earning money, so mining a gem "advances" a GP goal while
      moving GP by exactly zero. Split the two fields.
- [x] **Realised rates are never compared against advertised ones** *(3×)* — M.
      The one mechanism that would have caught every other rate bug on this list.
      Needs `skillId`/`recipeId` on `QualitySample`.
- [x] **Monster fights are the only candidates carrying no rate at all** — M.
      Thieving prices itself completely: "hits up to 3.2 (2% of current HP) —
      6,766 xp/h — 4.00 levels/h — 72,490 gp/h". A fight carries drops and goal
      tags only, so all ~60 sort identically and the planner cannot tell a
      level-1 Chicken from a level-27 Sweaty Monster. This became the largest
      gap the moment Auto Eat was bought, since five remaining goals are
      combat-shaped: `ranged-20`, `defence-20`, `hp-40`, `prayer-20` and
      `first-dungeon`. Needs XP/h per skill trained, a damage estimate reusing
      the existing combat gate rather than a second estimator, and the level
      requirement so an out-of-reach fight blocks with a stated reason. Watch
      for the `modifyPrimaryProductQuantity` trap: if a combat quantity getter
      rolls the same way, an hour must not be priced off one call.

- [x] **Ranged cannot be trained at all and nothing says so** — S. All three
      questions settled; the premise in the title turned out to be half wrong.

      **Why nothing was equippable.** Not a mystery in the code:
      `readEquipCandidates` calls `game.checkRequirements(item.equipRequirements,
      false)` (equipment.ts) and, on false, does a bare `continue`. The style
      filters below it never ran — a crossbow against a Staff of Air is a
      `switchesStyle` candidate, which bypasses both the penalty filter and the
      stat sum — so the requirement check is the only thing that could have
      dropped them. The refusal and the reason were computed one line apart and
      only the refusal survived. `readUnusableCombatStyles` now reports the
      reason, and `readRefillableAmmo` applies the same gate, which it did not:
      it would have handed the quiver reflex a stack `equipItem` refuses.

      **Which level each crossbow needs is still unverified**, and deliberately
      not guessed. It is exactly what the dump could not say.

      **The dump now carries it.** New `equipment` section: `validSlots`,
      `equipRequirements`, `attackType`, `ammoType`, `ammoTypeRequired`. Scoped
      to `game.items.equipment` (namespaceRegistry.d.ts:116) rather than added
      to the 3,748-row item table — the fields are empty on the ~1,800 items
      that are not equipment, and the game already maintains the subset, so the
      split costs nothing. Required rather than `.default()`ed, per the policy
      note in `dump-schema.ts`: the next arm regenerates. **Residual: read the
      regenerated dump and record the actual crossbow and arrow levels.**

      **The goal should not be `blocked`.** `blocked` in `GoalStatus` means one
      thing today — a goal named in another goal's `requires:` that is
      measurable and unmet (goals.ts:435) — and it withholds the goal from
      `goalsAdvancedBy`, so every fight would stop being tagged as advancing
      Ranged. That would be wrong, because Ranged is reachable. From the dump:
      Normal Shortbow is Fletching 1 from Normal Shortbow (u) + 1 Bowstring;
      the unstrung bow is Fletching 1 from 1 Normal Logs; Normal Tree is
      Woodcutting 1 and Woodcutting is 60; the bank holds the Bowstring and the
      shop sells more at 24 GP with no requirement and no buy limit. Bronze
      Arrows are Fletching 1 from Bronze Arrowtips (Smithing 1, one Bronze Bar)
      and Headless Arrows (15 Arrow Shafts, of which 4,322 are banked, and 15
      Feathers at 8 GP in the shop). Every input is held, mined or under 100 GP.

      So the honest answer is not "unobtainable, mark it blocked" but "obtainable
      and nobody said how" — which is `readBlockedOpportunities`' job, not
      `goals.ts`'. Putting equipment reachability into goal evaluation would put
      an inferred route where the file currently does snapshot arithmetic, and
      that inference is what a fabricated `requires:` already cost the Abyssal
      goal. See `learnings/game-state.md`.

- [x] **What undoes a verified equip** — S. Nothing in the game does. Two tiers
      of this agent were equipping different weapons into one slot on different
      clocks, and the log said so plainly once it was read for *periods* rather
      than for content. `equipment.equip ok — Staff_of_Air -> Steel_Scimitar`
      recurs at 2,986–3,002ms, which is `POLICY_INTERVAL_MS` and not the
      1,000ms reflex throttle; only the objective executor writes an `adapter`
      line, the reflex tier writes `reflex.X fired` and nothing else; every
      adapter line reads `before: Staff_of_Air`; and the journal holds the
      objective doing the asking (`equip_item`, Steel Scimitar, `successWhen:
      []`, aborted on its 3-minute budget). The swapping stops within half a
      second of that objective being replaced. So the record's attribution was
      the wrong way round — `reflex.upgradeGear` was putting the *staff* back,
      and its log line names no item.
      Two defects let it: `readGearUpgrades` had no notion of a **style
      switch**, which `readEquipCandidates` has had all along and hands to the
      planner labelled "a strategy choice rather than an upgrade"; and
      `statScore` summed **`attackSpeed`** as a benefit — milliseconds per
      swing, where lower is better, at 2,400–3,000 against single-digit
      bonuses, so for two weapons the score *was* the attack interval, ranked
      backwards. 3,000/2,400 = 1.24 clears the reflex's 1.2 margin one way and
      fails it the other, which is exactly the one-sided swap observed. Both
      fixed; `attackSpeed` is now compared in its own direction by
      `dominatesEquipmentStats` too. `StuckEquipWatch` is neither wrong nor
      unnecessary — it bounded the loop and the shape recurs, the game's own
      `checkEquipmentRequirements` included — but its comments asserted a cause
      that was false and its operator message blamed the game; both corrected.
      It was never live-confirmed and still has not been.

- [x] **A spell's consumed item is chosen once and never revisited** — S. Fixed.
      `chooseSelection` now also answers whether the game's *live* selection is
      still admissible, and the "already casting" short-circuit is conditional
      on that answer. Deliberately re-selects on **staleness, not preference**:
      gone from the bank, newly covered by a sell guard, or absent altogether —
      never merely "something cheaper appeared", which would churn the fuel on
      every tie broken differently and disturb a running cast for nothing. It
      costs no extra work, which is the whole argument for doing it every call:
      the precondition already walked the offered list on every call and threw
      the answer away. The projection now carries the selection alongside the
      spell so `act` can prove a refresh landed — `selectItemOnClick` is a UI
      callback whose behaviour against a running cast the typings do not state.

- [x] **Whether `getDoublingChance` is already inside
      `modifyPrimaryProductQuantity`** — S. Not stated in the typings. Settle it
      by measurement, never by reasoning. **It is** — and the measurement found
      the worse half of it: `modifyPrimaryProductQuantity` *rolls* the doubling,
      so it is a sample rather than a getter, and pricing an hour off one call
      made every rate a coin flip. 73 polled reports, live: Gold Bar alternated
      between exactly 212,400 and exactly 468,000 GP/h with `xp/h` fixed at
      36,000 throughout. That is the same finding as the 2x swing observed
      across Smithing and Mining forty minutes apart — two independent flips
      landing together, not a global modifier expiring. `productYieldFor` now
      takes the expectation: it samples until the coin has shown both faces —
      which is what identifies the un-doubled quantity — and divides the roll
      out with `getDoublingChance`, falling back to the mean whenever the
      evidence or the getter will not support that. A first attempt using the
      *minimum* of 8 samples was merged and reverted: a minimum is exact until
      the pass where every sample doubled, and then it is wrong by exactly 2x,
      which is the same defect one level down. See `learnings/game-state.md`.

## Stock-shaped objectives — what was left open

- [x] **Every goal and every plan step was level-shaped, and the stock shape had
      no data behind it** — M. `parseCondition` accepts `item <id> >= <n>` and
      `GOALS.md` used it zero times against 15 `skill`, 2 `total` and 1 `shop`;
      `successFor`'s own comment says `item_qty_at_least` "has existed in the
      contract, in `criteria.ts` and in the panel the whole time; nothing could
      ever set one, so it may as well not have existed". The plumbing worked and
      the habit never formed, which is what "craft Mind Runes to Runecrafting
      49" — a level target for a stock problem — cost.
      The numbers were never missing. `missingInputs` returns `{ itemId, need,
      have }`, `readTaskWantedQuantities` a map of item to quantity, and the
      blocked list already printed a producer, an item and a number in one
      sentence. `Candidate.produces` now names what an action banks and how
      fast, `Candidate.suggestedStock` carries a shortfall to the candidate that
      would fill it, and `stockRungFor` sizes a stock target against the budget
      and against `sustainMinutes` the way `rungFor` sizes a level. Both tools'
      descriptions show both shapes; the confirmation no longer prints `Target:
      level NaN`. See `learnings/README.md`.

- [ ] **A combat shortfall produces no stock demand, and that is the case that
      started this** — M. What combat actually needed was enough runes to keep
      casting, and the rune shortfall for a selected attack spell is not in the
      blocked-recipe walk at all: it is the still-open first entry on this list,
      "a fight is offered at full price while the selected attack spell cannot
      be cast". When that entry is done it should emit a `StockDemand` the same
      way `readBlockedOpportunities` now does, and the scale is available on the
      same terms — `attackInterval` is on the snapshot, so casts per hour times
      runes per cast is one hour of fighting, exactly the derivation used for a
      blocked recipe. Deliberately not guessed at here: the fight candidate does
      not yet know which spell is selected or what it costs, and inventing that
      join would put an inference where a reading belongs.

- [ ] **`suggestedStock` has one demand per item and no way to say a second
      consumer wants the same thing** — S. `mergeDemands` keeps the largest and
      drops the rest, on the argument that consumers are not run at once so the
      larger covers the smaller. True for the quantity and false for the
      *reason*: "a Township task wants 250 and Superheat wants 5,400" is a
      stronger case for producing than either alone, and only the second is
      shown. Carry the runners-up in the `why` rather than the quantity; the
      quantity must stay the largest, never the sum.

- [ ] **A stock target is sized against one candidate, not against the plan** —
      M. `stockRungFor` asks what *this* candidate can produce in *this* step's
      budget. A plan whose first step mines the ore its second step smelts has a
      materials ceiling that step one is about to lift, and only the first step
      is sized at all for exactly that reason. That is honest and it is also a
      ceiling on how much a plan can be checked: "mine 200 ore, then smelt 200
      bars" is still unverifiable end to end. Doing better needs the projection
      to carry state forward between steps, which is the arithmetic-dressed-as-
      foresight this repo has been right to refuse so far — so it wants a
      deliberate decision, not a quiet extension.

- [ ] **`produces.perHour` is unverified against a realised count** — S. Every
      other rate on a candidate is now compared against measurement through
      `measureAgainstClaim`, which was "the one mechanism that would have caught
      every other rate bug on this list". `perHour` has no such comparison, and
      it is now load-bearing: it decides whether a target is clamped. The
      machinery mostly exists — `QualitySample` carries `skillId`/`recipeId`
      already — and what is missing is a banked-quantity series to difference.
      Until then a wrong `perHour` clamps a good target with a confident note,
      which is the failure mode this repo has paid for twice.

## Planning

- [x] **Plan steps cannot carry a quantity target** — S. `set_objective` has
      `untilItemId`/`untilQuantity` and `set_plan` does not, so "mine 200 ore,
      then smelt" is unsayable — which is exactly the chain shape that matters.
- [x] **No candidate says how long its inputs last** — S/M. `canAfford` checks a
      single action, so a smelt advertising 15,600 xp/h can run twenty seconds.
- [x] **The blocked list discards its rates and never links a missing input to the
      candidate that produces it** — M. That single join turns it into a chain
      planner.
- [x] **The queued plan is invisible** — M. Only a count is reported, so staleness
      cannot be detected and revision is all-or-nothing.
- [x] **`nextRung` is dead code** — S. Exported, imported, never called — so
      target levels are guesses, causing both the thrash and the timeout it was
      written to prevent.
- [x] **Nothing enforces a commitment floor** — M. Mastery rewards staying, and
      ranking is instantaneous.
- [x] **Goal DAG: an unmeasurable prerequisite blocks its dependents forever**, and
      `requires` is skipped entirely for goals with no `done:` — S/M.

## Autonomy

- [x] **No autonomous selling** *(3×)* — M. Every guard already exists; only the
      reflex is missing. This is why GP freezes while the bank fills and an
      operator has to sell by hand every forty minutes.
- [x] **Character-select auto-load is one-shot against a hardcoded URL** — S. It
      now retries every 3s for two minutes, against the URL the operator
      configured — remembered in localStorage, the one store that exists on that
      screen — and stops only when a character is actually loaded.
- [x] **The stuck detector hammers a planner that always returns empty** — M.
      Exponential backoff from 1min to 10min, and after four unanswered
      escalations it says so in `needsAttention`, which `/dashboard` exposes for
      an external check.
- [x] **Settings are PUT over HTTP every 3s** — S. ~9,600 writes a night, and when
      the service is down the warning floods a 300-record queue, evicting every
      real diagnostic before it can ship.
- [x] **`suspended` has no timeout and stops reporting entirely** — S. It now
      pushes a state-only report every tick while suspended, and forces itself
      out after ten minutes with a `stuck_detected` replan and an escalation.
- [x] **Auto-arm runs before anything checks what offline progression did** — M.
      The automatic path refuses on a risen death counter, HP below the fraction
      the policy tier aborts at, or no food with no Auto Eat. Arming by hand is
      untouched: the operator is present and can judge.

## Observability

- [x] **Nothing counted a repeated failure, so four loops each cost a day** — M.
      `act` now keeps two ledgers, both keyed on `(name, JSON(before))` and both
      reporting once on the transition: a run of `no_state_change` against an
      unmoved projection (five, matching `ACTION_FAILURE_LIMIT`), and a run of
      `ok` from an identical starting state (five inside sixty seconds), which
      is the shape the equip and Agility loops actually had — they never failed.
      A third counter, at forty, covers a projection that moves every tick and
      would otherwise disable the detector silently. Reports, never refuses:
      a legitimately retried action looks the same, and an adapter that declines
      real work is worse than one that is noisy. Written up in
      `learnings/game-state.md`.
- [x] **The stuck ledgers do not ride out on the report** — S. Their finding was
      appended to the `ActionResult` detail, which both tiers log, so it reached
      `data/logs/*.jsonl` — but the policy tier puts the detail in the structured
      payload rather than the message, so a `STUCK` line was greppable and
      visible nowhere a person looks. Findings now ride out on
      `readAdapterFailures()`, the counted list that already reaches the panel
      and the state summary, marked `kind: 'stuck'` so they get their own
      sentence: "guarded read failed at" would send a reader hunting a renamed
      getter for a loop. They rank ahead of the reads unconditionally rather
      than by count — the summary prints five, the live game already carries
      six read sites at 655 apiece, so a loop ordered by count would never be
      printed at all. The counter increments only on the ledgers' own
      once-per-transition report, so it counts stuck runs and never stuck
      passes. Written up in `learnings/game-state.md`.
- [x] **`shop.buyItemOnClick` leaves `buyQuantity` where the agent set it** — S.
      `withBuyQuantity` in `shop.ts` now sets it, buys inside a `try`, and
      restores it in the `finally`, the shape `withTownBiome` and
      `withBuildQuantity` already use. Deliberately a third small copy rather
      than a shared helper: `buyQuantity` (shop.d.ts:232) is a plain number,
      while `currentTownBiome` is optional and has to be restored to *absent*
      rather than to `undefined`, so one abstraction over all three would have
      to carry that distinction into every call site to save five lines each.
      Not a correctness bug for the agent, only a surprise for the operator.
- [ ] **Two thirds of the button-callback audit could not be finished** — M. The
      nw.js cache only decompresses to 17 files while the game runs (Bank,
      Player, CombatManager, Cartography, Township, Game, skill bases); Cooking,
      Farming, Agility, Archaeology, Thieving, Astrology, Alt Magic, Potions,
      Slayer and the shop live in the block files the running game holds open.
      Those `perform` calls are structurally protected — each passes everything
      explicitly, or the adapter sets the selection immediately before — but not
      proven. Re-dump the cache once with the game closed and finish the sweep;
      `learnings/game-state.md` lists exactly which methods are outstanding.
- [x] **`get_recent_activity` reads the last report, not the durable log** *(2×)* —
      S. Records *are* written to `data/logs/*.jsonl` and never read back, which
      is why every post-mortem in this session hit "Log is empty".
- [x] **The journal is never written** *(4×)* — M. `addJournalEntry` has exactly
      one caller, a test. `get_journal` can only ever say "Nothing attempted yet",
      so the planner cannot see what it already abandoned.
- [x] **Quality samples do not survive a reload** — M. The one metric restarts at
      zero, and diagnosis is then suppressed for the next thirty minutes.
- [x] **The blocked list is `slice(0, 12)` with no severity** — M. Producers set
      a severity, criticals are never cut, each tier has reserved slots, and the
      overflow line names what was dropped.
- [x] **The panel shows none of the diagnostics it ships**, and hides service
      health behind a closed disclosure — S. Critical blocked items and the
      escalation are promoted to warnings; the service earns a row only when it
      is unhealthy.
- [x] **The stale-build check is broken again** — S. BUILD_INFO is written to
      both locations from the same instant the bundle carries, the check reads
      `MELVOR_CT_DIR` first, and stamps are compared as parsed instants with a
      ±5s tolerance.

## Coverage — systems the agent does not use

- [x] **`spendMasteryPool` can silently destroy checkpoint bonuses** — M. The game
      ships a confirmation dialog for exactly this loss (settings.d.ts:80). It
      also lowers skill-pet chance. The spend now refuses when the projected
      post-spend pool XP would revoke a checkpoint, asked of the game's own
      `getActiveMasteryPoolBonusCount(realm, xp)` (skill.d.ts:730) rather than of
      thresholds recomputed here, and it fails *closed*: a count that cannot be
      read refuses rather than proceeding. The candidate label carries the pool
      percent and the next checkpoint, so the choice can be made before the
      refusal. **Still open:** the better policy — bank up to the next checkpoint
      and spend only the surplus — is not implemented, because the pool XP a
      level-up charges is not stated in the typings.
      `levelUpMasteryWithPoolXP` (skill.d.ts:689) takes a level count and says
      nothing about its price, so the cost is estimated from `exp.levelToXP`
      (utils.d.ts:234) against `getMasteryXP`. That estimate is compared against
      the realised cost after every successful spend and a mismatch is recorded
      through `safe.ts`, so a wrong model surfaces as a counter instead of as a
      bonus that quietly went missing. Settle it by measurement before building
      a surplus policy on top of it.
- [x] **Nothing the agent must save for is ever a candidate** — S. Every shop
      reader filters on affordability, so Auto Eat does not exist as a target
      until the million GP is already banked.
- [x] **Upgrade chains: the reflex buys the cheapest tier, not the best affordable**
      — S. `getLowestUpgradeInChain`, `upgradeChains`.
- [x] **Skilling outfits score zero** — M. `statScore` sums equipment stats, and an
      outfit's value is in modifiers — so Township's entire payoff is unwearable.
      `readModifierGear` surfaces owned modifier-bearing gear with the game's own
      effect descriptions, and the one comparison that needs no pricing is now
      acted on: an item whose `modifiers` the *game* scoped to the skill being
      trained (`ModifierValue extends ModifierScope`, modifiers.d.ts:129, :19)
      against an empty slot, or against a worn item with no modifiers of any kind
      that it dominates key by key. Empty slots are also ordered so the fill
      reflex takes the relevant outfit rather than whatever came first in bank
      order — which used to decide the slot permanently, since a zero stat sum
      can never displace anything afterwards.
      **Still open, deliberately:** no modifier is given a weight, and any swap
      that would displace modifier-bearing gear is left to the planner and says
      so in its label. A modifier's worth depends on what the run is doing (+5%
      Mining mastery XP is everything to a miner and nothing to a fisher), so a
      weight would be a guess presented as a measurement — the exact failure that
      made a Steel Platebody outscore what it replaced. The domination check is
      key-by-key rather than a sum for the same reason: a sum is what let that
      platebody's melee defence drown out its ranged penalty.
- [x] **Potions lapse silently** — S. `toggleAutoReusePotion` is now called by a
      reflex, but only for a potion *already active* with a replacement banked —
      the planner chose the potion, this only stops the choice expiring. Polarity
      settled and written down: `autoReuseActions` is documented as the actions
      potions should **not** be re-used for, so the set is never read; the action
      asserts `autoReusePotionsForAction` either side of the toggle, which makes
      a wrong reading cost one reversible call rather than a silent inversion.
- [x] **Township building is one-at-a-time and upgrade-blind** — M.
      `getBuildingCountRemainingForLevelUp` turns it into a targeted objective.
- [x] **Slayer: an accepted task has no fight candidate** — M. `readSlayerTaskTarget`
      turns `slayerTask.monster` into a prioritised `fight_monster` candidate with
      kills remaining in the label, area resolved from `game.slayerAreas` and
      enterability checked, so a refused task lands in the blocked list saying it
      is the deadlock rather than one line among two hundred.
- [x] **Attack-style candidates never say which skill they train** — S.
      `AttackStyle.experienceGain` is the game's own answer, and this is the only
      lever on four combat goals.
- [x] **Prayer 20 is structurally unreachable** — M. `buryBonesWhenHeld` converts
      bones under a point reserve and `activateCheapestPrayer` spends the points
      in combat, which is the only source of Prayer XP there is.
      `dropUnpayablePrayers` was also never wired into the chain at all; it is now,
      and the two conditions are disjoint so neither can undo the other.
- [x] **Dig-site maps can be selected but never created** — M. When the last map's
      charges run out Archaeology vanishes with no way back, and the agent makes
      paper forever. `createNewMapForDigSite` (cartography.d.ts:389).
- [x] **Charged equipment burns out unnoticed** — S. `readEquipmentCharges` reads
      `getCharges` for every worn item marked with `consumesChargesOn`, and a
      spent or nearly-spent one is reported. It is the failure with no symptom:
      the item stays worn, every reading looks right, and the rate just drops.
- [x] **`Bank.lostItems` is never read** — S. `readLostItems` reports what the
      game recorded as discarded, as a receipt separate from the countdown. It is
      a floor rather than a total — the typings do not say when the map is
      cleared — but a non-empty map is proof, never a false positive.

## Architecture

- [x] **Test files are excluded from every typecheck config** — M. `test` is now in
      every package's `include`; eight wrong fixtures fell out, including the
      `ActionResult` one and two reads of a property that only exists on the
      other variant of a union.
- [x] **Mirrored predicates have already drifted** — M. `mining-respawn.test.ts`,
      `mastery-scaling.test.ts` and `product-chance.test.ts` now import the real
      functions; an `installFakeGame` helper in `test/fixtures.ts` stubs the
      global for the one that reads `game.mining`.
- [x] **`candidates.ts` is five modules, and `agent.ts` is a 1,959-line god class
      that no test imports** — M/L. `candidates.ts` went 2,919 -> 377 lines across
      8 modules (`recipes`, `rates`, `pricing`, `affordability`,
      `gather-candidates`, `disposal`, `blocked`); `agent.ts` gave up five
      testable pieces (`death-watch`, `loop-stall`, `journal`, `metrics`,
      `quality-window`) with 30 new tests driving them. No test assertion was
      altered and a mechanical comment-line diff confirmed 0 comments lost.
      Four seams were rejected with reasons -- extracting `runReflexes` would
      have produced tests asserting "it called the reader".
- [x] **~100 silent `catch {}` against one reporting helper** — S. `adapter/safe.ts`
      counts every guarded read by site; 122 catches across 23 files now name
      theirs, and the tally rides out on the report, the TUI and the MCP state
      summary. The two `safely`s and the two `safeNumber`s are one set.
- [x] **The reachability gate is inert in CI** — S. The silent `return` guards are
      `skipIf`, so a check that cannot run is reported as SKIPPED rather than
      PASSED — in `skill-ids.test.ts` and `skill-coverage.test.ts` too. The false
      "the dump is committed state" docstring is corrected.
      `pnpm docs:coverage:check` is now in CI, which needed the generator to stop
      blanking its dump-derived section on a machine with no dump.
      **Still open:** a redacted registry-only fixture (ids and names, no save
      state) would let those three files assert rather than skip. It cannot be
      written by inference — guessing ids is the bug that made
      `melvorD:AltMagic` produce no candidates for the life of the repo — so it
      has to come from a real dump.
- [x] **`ActionResult` evidence is never consumed above the adapter** — M.
      `summariseObserved` turns the before/after projection into a described
      magnitude where the two shapes can be compared and says nothing where they
      cannot, so an adapter line now reads `ok — level +0, active false -> true`
      rather than `ok`. `NoMovementWatch` feeds on it: the counter an
      objective's own `successWhen` names — skill **XP**, not level, which moves
      too rarely to watch — must move, and eight verified action rounds *and*
      five flat minutes are both required before it logs an error and requests a
      `stuck_detected` replan. Both thresholds because a false alarm replans a
      healthy objective, and the policy tier ticks every three seconds. It sits
      beside `detectStuck` rather than inside it: that asks whether the
      character is going anywhere over fifteen minutes, this asks whether the
      number *this objective* was chosen to move is moving. Surfaced in
      `get_agent_state` next to the "Delivering: N xp/h" line, which catches the
      other half — a rate modelled wrong, rather than actions that achieve
      nothing.

## Dump

- [x] **Mining rocks are dumped without HP or respawn** — S. Which is why
      depletion had to be measured by hand.
- [x] **Monsters have no stats, only a combat level** — S.
- [x] **No drop has a quantity, and no currency drop is recorded** — M. The dump
- [x] **Monsters have no stats, only a combat level** — S. Neither `levels` nor
      `equipmentStats` is captured, which is why the pre-fight screen can compare
      levels but cannot calibrate a threshold on equipment bonuses.
- [x] **No drop has a quantity, and no currency drop is recorded** — M. The dump
      currently says the agent's main GP source yields nothing.
- [x] **Alt Magic, Herblore and Firemaking store product and cost under names the
      generic dumper does not read** — M. 131 blank rows, each of which read
      exactly like an Agility obstacle — a recipe that genuinely produces
      nothing. None of the three is a single-product recipe, so none was forced
      into that shape. Alt Magic's `produces` (altMagic.d.ts:75) is
      `AltMagicProductionID | AnyItem` — an item on some spells, a currency
      sentinel on others — recorded as `altMagicProduction` with the sentinel
      *named* rather than left as a bare number, and its `specialCost` (:74),
      which names a *class* of item no cost list can hold, as
      `altMagicSpecialCost`. Herblore's `potions` (herblore.d.ts:9) is four
      items off one ingredient list, gated by `tierMasteryLevels` (:78): all
      four are recorded with the level that unlocks each, because naming one
      would be wrong about the other three. Firemaking's drops are chance-gated
      through `getPrimaryProductInfo` / `getSecondaryProductInfo`
      (firemakingTicks.d.ts:149, 156), so they carry the game's own chance and
      quantity; its input — `FiremakingLog.log` (:34), which is not an
      `itemCosts` entry — is now charged, so a log is no longer a free input.
      The two enums are spelled out as literals: both are plain `declare enum`s
      (altMagic.d.ts:19-27, 28-37) that the runtime bundle may carry no value
      for, and an id neither map knows is kept as `Unknown(n)` against a
      counted fallback rather than dropped.
- [x] **384 recipes report `baseExperience: 0`** — S. Abyssal content, whose XP
      lives in `baseAbyssalExperience`.
- [x] **Agility build costs are recorded as per-action inputs** — M. A one-time
      cost mislabelled as consumption, feeding wrong profit arithmetic.
- [x] **143 shop purchases report `gpCost: 0`**, which reads as free — S.
- [x] **There is still no flat item table** — M. Sale values exist only where a
      recipe happens to produce the item.
- [x] **Sections are silently truncated** — S. `herbloreRecipes` says 12 while
      `skillRecipes` says 72, and nothing records that a cut was made.

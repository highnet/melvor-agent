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
- [ ] **Whether `getDoublingChance` is already inside
      `modifyPrimaryProductQuantity`** — S. Not stated in the typings. Settle it
      by measurement, never by reasoning.

## Planning

- [x] **Plan steps cannot carry a quantity target** — S. `set_objective` has
      `untilItemId`/`untilQuantity` and `set_plan` does not, so "mine 200 ore,
      then smelt" is unsayable — which is exactly the chain shape that matters.
- [x] **No candidate says how long its inputs last** — S/M. `canAfford` checks a
      single action, so a smelt advertising 15,600 xp/h can run twenty seconds.
- [x] **The blocked list discards its rates and never links a missing input to the
      candidate that produces it** — M. That single join turns it into a chain
      planner.
- [ ] **The queued plan is invisible** — M. Only a count is reported, so staleness
      cannot be detected and revision is all-or-nothing.
- [ ] **`nextRung` is dead code** — S. Exported, imported, never called — so
      target levels are guesses, causing both the thrash and the timeout it was
      written to prevent.
- [ ] **Nothing enforces a commitment floor** — M. Mastery rewards staying, and
      ranking is instantaneous.
- [ ] **Goal DAG: an unmeasurable prerequisite blocks its dependents forever**, and
      `requires` is skipped entirely for goals with no `done:` — S/M.

## Autonomy

- [x] **No autonomous selling** *(3×)* — M. Every guard already exists; only the
      reflex is missing. This is why GP freezes while the bank fills and an
      operator has to sell by hand every forty minutes.
- [ ] **Character-select auto-load is one-shot against a hardcoded URL** — S. If
      the service is a few seconds late, the night is lost anyway.
- [ ] **The stuck detector hammers a planner that always returns empty** — M.
      Every three seconds, all night, with no escalation path.
- [x] **Settings are PUT over HTTP every 3s** — S. ~9,600 writes a night, and when
      the service is down the warning floods a 300-record queue, evicting every
      real diagnostic before it can ship.
- [ ] **`suspended` has no timeout and stops reporting entirely** — S.
- [ ] **Auto-arm runs before anything checks what offline progression did** — M.

## Observability

- [x] **`get_recent_activity` reads the last report, not the durable log** *(2×)* —
      S. Records *are* written to `data/logs/*.jsonl` and never read back, which
      is why every post-mortem in this session hit "Log is empty".
- [x] **The journal is never written** *(4×)* — M. `addJournalEntry` has exactly
      one caller, a test. `get_journal` can only ever say "Nothing attempted yet",
      so the planner cannot see what it already abandoned.
- [x] **Quality samples do not survive a reload** — M. The one metric restarts at
      zero, and diagnosis is then suppressed for the next thirty minutes.
- [ ] **The blocked list is `slice(0, 12)` with no severity** — M. A food
      countdown competes with "Yew unlocks at 60" on position alone.
- [ ] **The panel shows none of the diagnostics it ships**, and hides service
      health behind a closed disclosure — S.
- [ ] **The stale-build check is broken again** — S. It walks up from
      `process.cwd()` while the build writes to `MELVOR_CT_DIR`, and it compares
      timestamps as sliced strings.

## Coverage — systems the agent does not use

- [ ] **`spendMasteryPool` can silently destroy checkpoint bonuses** — M. The game
      ships a confirmation dialog for exactly this loss (settings.d.ts:80). It
      also lowers skill-pet chance.
- [x] **Nothing the agent must save for is ever a candidate** — S. Every shop
      reader filters on affordability, so Auto Eat does not exist as a target
      until the million GP is already banked.
- [x] **Upgrade chains: the reflex buys the cheapest tier, not the best affordable**
      — S. `getLowestUpgradeInChain`, `upgradeChains`.
- [ ] **Skilling outfits score zero** — M. `statScore` sums equipment stats, and an
      outfit's value is in modifiers — so Township's entire payoff is unwearable.
- [ ] **Potions lapse silently** — S. `toggleAutoReusePotion` is never called.
- [ ] **Township building is one-at-a-time and upgrade-blind** — M.
      `getBuildingCountRemainingForLevelUp` turns it into a targeted objective.
- [ ] **Slayer: an accepted task has no fight candidate** — M. Take a task, block
      every future task behind it, and have nothing that advances it.
- [x] **Attack-style candidates never say which skill they train** — S.
      `AttackStyle.experienceGain` is the game's own answer, and this is the only
      lever on four combat goals.
- [ ] **Prayer 20 is structurally unreachable** — M. Burying and activation are
      both candidates nobody picks, and the only prayer reflex turns them *off*.
- [ ] **Dig-site maps can be selected but never created** — M. When the last map's
      charges run out Archaeology vanishes with no way back, and the agent makes
      paper forever. `createNewMapForDigSite` (cartography.d.ts:389).
- [ ] **Charged equipment burns out unnoticed** — S. `game.itemCharges` appears
      nowhere in the mod.
- [ ] **`Bank.lostItems` is never read** — S. The game records exactly what was
      discarded at a full bank; we warn speculatively instead.

## Architecture

- [ ] **Test files are excluded from every typecheck config** — M. The
      `ActionResult` fixture that 865 lines of reflex tests rest on does not match
      the type it claims.
- [ ] **Mirrored predicates have already drifted** — M. `mining-respawn.test.ts`
      pins the static `maxHP` the implementation deliberately moved away from. A
      `globalThis.game` stub already works elsewhere in the suite.
- [ ] **`candidates.ts` is five modules, and `agent.ts` is a 1,959-line god class
      that no test imports** — M/L.
- [ ] **~100 silent `catch {}` against one reporting helper** — S. A changed
      accessor makes candidates vanish with no signal at all.
- [ ] **The reachability gate is inert in CI** — S. `data/` is gitignored, so every
      assertion returns early.
- [ ] **`ActionResult` evidence is never consumed above the adapter** — M.

## Dump

- [ ] **Mining rocks are dumped without HP or respawn** — S. Which is why
      depletion had to be measured by hand.
- [ ] **Monsters have no stats, only a combat level** — S.
- [ ] **No drop has a quantity, and no currency drop is recorded** — M. The dump
      currently says the agent's main GP source yields nothing.
- [ ] **Alt Magic, Herblore and Firemaking store product and cost under names the
      generic dumper does not read** — M. 131 blank rows.
- [ ] **384 recipes report `baseExperience: 0`** — S. Abyssal content, whose XP
      lives in `baseAbyssalExperience`.
- [ ] **Agility build costs are recorded as per-action inputs** — M. A one-time
      cost mislabelled as consumption, feeding wrong profit arithmetic.
- [ ] **143 shop purchases report `gpCost: 0`**, which reads as free — S.
- [ ] **There is still no flat item table** — M. Sale values exist only where a
      recipe happens to produce the item.
- [ ] **Sections are silently truncated** — S. `herbloreRecipes` says 12 while
      `skillRecipes` says 72, and nothing records that a cut was made.

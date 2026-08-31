# Goals

<!--
  Copy to GOALS.md. Long-horizon direction for the planning agent.

  A goal is a DESTINATION and should stay far away. The agent turns it into
  "rungs" — objectives sized to finish in about an hour — so it gets feedback
  without re-litigating the destination every few minutes.

  Annotations in HTML comments keep completion machine-checkable, so the agent
  cannot decide it has finished something it has not:

    <!-- done: skill melvorD:Woodcutting >= 50 -->
    <!-- done: currency melvorD:GP >= 50000 -->
    <!-- done: item melvorD:Oak_Logs >= 1000 -->
    <!-- done: total >= 500 -->
    <!-- advances: melvorD:Woodcutting, gp -->
    <!-- requires: some-other-goal-id -->

  A goal with no `done:` is read as intent but reported as unmeasurable.
  The agent may append proposals; it never edits or completes your lines.
-->

- Bank 50,000 GP so Auto Eat is affordable. <!-- id: gp-for-autoeat --> <!-- done: currency melvorD:GP >= 50000 --> <!-- advances: gp -->
- Own Auto Eat so combat stops being refused. <!-- id: auto-eat --> <!-- requires: gp-for-autoeat -->
- Woodcutting to 50 for the better log tiers. <!-- done: skill melvorD:Woodcutting >= 50 --> <!-- advances: melvorD:Woodcutting -->
- Total level 300. <!-- done: total >= 300 -->

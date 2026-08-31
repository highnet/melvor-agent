<!--
  Copy to USER.md. Standing operator directives for the planning agent.
  Loaded into every planning call and treated as binding.

  Write imperatives, not observations. "Never spend below 50k GP" is a
  directive the planner can follow; "the user seems cautious about money" is
  something it has to interpret, and interpretation drifts.

  Supersede in place. Edit a directive that changes rather than adding a
  contradicting one below it — append-only preference history reliably makes
  models answer from the stale value.
-->

- Never spend below 50,000 GP. <!-- observed: 2026-08-31, active -->
- Prefer unlocking new content over levelling something already high.
- Never engage combat without Auto Eat owned.

# Changelog

Managed by [release-please](https://github.com/googleapis/release-please) from
Conventional Commits. Entries below this point are generated; do not edit by hand.

## 0.1.0

Initial working agent. Full history predates Conventional Commits and is in
`git log`; the short version:

- Adapter layer with the `ActionResult` contract — every action returns
  before/after evidence, because the game's own return types are inconsistent.
- 16 startable skills: 3 gathering, 6 artisan (one shared routine), 7 individual.
- Selling and shop purchases — the transitions the project exists for.
- Combat behind a deterministic survivability gate, advisory by default.
- Pure policy tier with 84 tests; generated `docs/API.md` with a CI drift check.
- Terminal dashboard and a local Hono service for durable state.

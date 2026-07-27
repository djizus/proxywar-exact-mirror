# Agent Instructions

- This repository is an AGPL boundary around the canonical ProxyWar engine.
- It reconstructs and reports game state only. Do not add Gandhi strategy here.
- Keep the IPC surface to `ingest`, `project`, and `finalize` unless the
  protocol itself changes.
- Lifecycle events must be passive observations of canonical per-tick execution.
  Keep them compact; do not add hypothetical action simulation or full route paths.
- Execution-state observation is read-only. Never call PRNG,
  destination-selection, path-advance, path-rebuild, or read-destructive engine
  methods, and never expose PRNG state, attack heap contents, or full paths.
- Report capability availability per group and omit only the affected group when
  an engine internal is missing or renamed. A schema bump must stay additive so
  consumers can gate on the reported version.
- Keep every passive sidecar out of the canonical state hash and out of
  completed-record parity comparison.
- Route projection must remain bound to the current exact tick/hash and use
  fresh, cache-disabled pathfinding state. Never return a full path, call
  destination selection, mutate runner-owned caches, advance an execution, or
  describe a future route as exact. Stale or non-exact authority must return a
  typed refusal, not a best-effort answer.
- Pin the upstream submodule and generated bundle together.
- Run `npm test` before publishing a commit consumed by an agent.

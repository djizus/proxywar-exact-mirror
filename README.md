# ProxyWar Exact Mirror

AGPL-licensed deterministic state reconstruction for the ProxyWar Coworld
protocol. The package pins the canonical ProxyWar source as a Git submodule,
bundles the engine and Pangaea/World map assets, and exposes three operations:

- `ingest(globalFrame)` advances a live mirror and validates the public frame.
- `project({ tick, stateHash, routes })` projects bounded transport paths
  against exact-current canonical water geometry.
- `finalize(gameRecord)` independently replays the completed official record
  and compares it with the live mirror using compact tick/hash references.

Schema-4 ingest results include a compact `transportLifecycle` batch. The
mirror observes every canonical engine tick between public snapshots and
reports transport launch, motion-plan, retreat, arrival, attack-conversion,
destruction, and path-failure events. Full water paths are not exposed. A
motion plan provides exact post-launch path length and projected completion;
pre-launch routes remain estimates owned by the consuming policy.

Schema 4 also exposes passive sidecars outside the canonical `GameState`:
per-tick economy and attack deltas, exact trade/train payout events, constructed
unit counts, MIRV launches, shared-border edge counts, rail topology, and
port/trade-ship/train spawn state. Rail topology includes compact construction,
snap, and destruction events in canonical capture order with a match-monotonic
sequence; the events report segment endpoints and lengths, not duplicate full
paths. Initial terrain and changed water-component
connectivity use run-length encoding. The terrain sidecar includes the exact
byte layout needed to decode magnitude and terrain class without emitting
duplicate per-tile streams. Initial terrain is emitted once, while event
batches cover only newly advanced ticks; point-in-time sidecars are retained
across duplicate or non-state ingests.

The schema-4 `executionState` sidecar passively reads the pinned engine's
point-in-time execution list. It reports compact summaries for 14 independent
capability groups: `attacks`, `constructions`, `transports`, `tradeShips`,
`ports`, `trainStations`, `trains`, `retreats`, `nukes`, `samInterceptions`,
`warships`, `diplomacy`, `playerTiming`, and `staggerCounters`.

`capabilities` always carries an entry per group with `available` and, when
unavailable, a `reason`. Status is independent per group: a missing or renamed
engine internal omits only that group's payload and leaves the rest usable, so
consumers fail open per capability rather than discarding the whole sidecar.

Observation is strictly read-only. The observer does not call PRNG,
destination-selection, path-advance, path-rebuild, or read-destructive methods,
and it never advances an execution. It does not expose PRNG state, attack heap
contents, or full movement paths.

The schema-4 `project` operation accepts 1–64 unique
`{ source, destination }` tile pairs and preserves their input order. The
request is accepted only when its tick and canonical state hash match the
mirror's current exact state; otherwise it returns a typed refusal with the
current state reference and one of `mirror_not_ready`, `mirror_advancing`,
`mirror_not_exact`, `stale_tick`, or `state_hash_mismatch`. A refusal is a
normal, non-fatal outcome — the mirror stays exact and the caller decides
without projection support. Malformed hashes, tile IDs, duplicate pairs, and
oversized batches use the normal IPC error envelope. Successful entries report
reachability and, when
reachable, canonical current path length, one tick per transport step,
traversal duration, and projected arrival duration/tick for a transport
initialized on the bound current turn. The arrival estimate includes the
pinned execution loop's one-tick motion-start boundary. These are exact-current
geometry projections, not guarantees that a future transport action will
launch, retain the same geometry, or arrive at that tick.

Projection reconstructs the pinned engine's production water-path stack with
fresh search buffers and hierarchical path caching disabled. It reads the
current maps and water graph but does not write the runner-owned graph cache,
advance an execution, select a source/destination, or draw randomness. Results
include the current water-graph version and whether the canonical hierarchical
or small-graph fallback algorithm was used. Full paths are never returned.

All passive sidecars, including `executionState`, remain outside the canonical
state hash and completed-record parity comparison. Adding, omitting, or changing
a sidecar therefore cannot change a state hash or manufacture a parity
divergence.

Every result carries its `schemaVersion` plus the immutable Coworld, ProxyWar
commit, and game-image identity used by the worker. Consumers must verify that
identity before using an exact state as live action authority, and must gate
schema-4 features (`executionState`, `project`) on the reported schema version
rather than assuming them: earlier pinned commits report schema 3 and expose
only `ingest` and `finalize`.

Roster identity is retained from the opening snapshot so accepted decisions
remain replayable when their owner is eliminated during the same interval and
is absent from the next public player list.

State hashes preserve exact integer and tile data while canonicalizing derived
floating-point values to 11 significant digits. This covers the measured
cross-runtime drift in derived and in-flight troop values while retaining much
more precision than policy decisions consume. Raw state values remain intact.

The worker uses Node IPC with advanced serialization so the normalized
`GameState.tileState` remains a `Uint16Array`. It never receives player tokens
or strategy configuration. Requests are the discriminated `ingest` and
`project` and `finalize` operations and require a non-empty string or
non-negative safe integer ID. Package declarations expose the request, result,
refusal, error-envelope, and schema-4 sidecar types.

```bash
git submodule update --init
npm run setup
npm run build
npm test
```

The pinned source is `0xNad/ProxyWar` commit
`84bb064ad199f1e14f0cf45046395bb95c7ce2fe`.

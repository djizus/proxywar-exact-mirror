# ProxyWar Exact Mirror

AGPL-licensed deterministic state reconstruction for the ProxyWar Coworld
protocol. The package pins the canonical ProxyWar source as a Git submodule,
bundles the engine and Pangaea/World map assets, and exposes two operations:

- `ingest(globalFrame)` advances a live mirror and validates the public frame.
- `finalize(gameRecord)` independently replays the completed official record
  and compares it with the live mirror using compact tick/hash references.

Every result carries the immutable Coworld, ProxyWar commit, and game-image
identity used by the worker. Consumers must verify that identity before using
an exact state as live action authority.

Roster identity is retained from the opening snapshot so accepted decisions
remain replayable when their owner is eliminated during the same interval and
is absent from the next public player list.

State hashes preserve exact integer and tile data while canonicalizing derived
floating-point values to 11 significant digits. This covers the measured
cross-runtime drift in derived and in-flight troop values while retaining much
more precision than policy decisions consume. Raw state values remain intact.

The worker uses Node IPC with advanced serialization so the normalized
`GameState.tileState` remains a `Uint16Array`. It never receives player tokens
or strategy configuration.

```bash
git submodule update --init
npm run setup
npm run build
npm test
```

The pinned source is `0xNad/ProxyWar` commit
`84bb064ad199f1e14f0cf45046395bb95c7ce2fe`.

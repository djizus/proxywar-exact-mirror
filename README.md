# ProxyWar Exact Mirror

AGPL-licensed deterministic state reconstruction for the ProxyWar Coworld
protocol. The package pins the canonical ProxyWar source as a Git submodule,
bundles the engine and Pangaea/World map assets, and exposes two operations:

- `ingest(globalFrame)` advances a live mirror and validates the public frame.
- `finalize(gameRecord)` independently replays the completed official record
  and compares it with the live mirror using compact tick/hash references.

Roster identity is retained from the opening snapshot so accepted decisions
remain replayable when their owner is eliminated during the same interval and
is absent from the next public player list.

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

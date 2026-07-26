export type MirrorRequestID = string | number;

export type IngestMirrorRequest = {
  id: MirrorRequestID;
  type: "ingest";
  frame: unknown;
};

export type FinalizeMirrorRequest = {
  id: MirrorRequestID;
  type: "finalize";
  gameRecord: unknown;
};

export type MirrorRequest = IngestMirrorRequest | FinalizeMirrorRequest;

export type MirrorIPCResult =
  | {
    id: MirrorRequestID;
    ok: true;
    result: MirrorIngestResult | MirrorFinalizeResult;
  }
  | {
    id: MirrorRequestID | null;
    ok: false;
    error: string;
  };

export type EngineIdentity = {
  coworldID: string;
  coworldVersion: string;
  proxyWarCommit: string;
  gameImage: string;
};

export type MirrorStatus =
  | "bootstrapping"
  | "exact"
  | "lagging"
  | "diverged"
  | "unavailable";

export type GameState = {
  schemaVersion: 1;
  tick: number;
  phase: "spawn" | "active" | "finished";
  map: {
    name: string;
    size: string;
    width: number;
    height: number;
    landTiles: number;
    falloutTiles: number;
  };
  players: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  attacks: Array<Record<string, unknown>>;
  diplomacy: { alliances: Array<Record<string, unknown>> };
  winner: { kind: "player" | "team"; id: string | number } | null;
  tileState: Uint16Array;
  rulesRef: EngineIdentity;
  source: { mode: "exact"; status: MirrorStatus; hash: string };
};

export type ParityResult = {
  ok: boolean;
  checked: string[];
  mismatches: Array<{ path: string; expected: unknown; actual: unknown }>;
};

export type TransportLifecycleEvent = {
  eventID: string;
  type:
    | "launch_observed"
    | "launch_failed"
    | "plan_updated"
    | "retreat_started"
    | "arrived"
    | "attack_converted"
    | "friendly_returned"
    | "retreat_returned"
    | "destroyed"
    | "path_failed";
  tick: number;
  unitID: number | null;
  ownerPlayerID: string | null;
  targetPlayerID: string | null;
  sourceTile?: number | null;
  currentTile?: number | null;
  requestedTile?: number | null;
  targetTile?: number | null;
  troops?: number;
  planID?: number;
  pathLength?: number;
  ticksPerStep?: number;
  projectedCompletionTick?: number;
  attackID?: string;
  destroyerPlayerID?: string | null;
  terminalOwnerClass?: "self" | "friendly" | "hostile" | "neutral";
  terminalOwnerSmallID?: number | null;
};

export type TransportLifecycleBatch = {
  schemaVersion: 1;
  fromTick: number;
  toTick: number;
  events: TransportLifecycleEvent[];
};

export type IntegerRuns = Array<[value: number, length: number]>;

export type TerrainByteLayout = {
  readonly magnitudeMask: number;
  readonly landMask: number;
  readonly oceanMask: number;
  readonly shorelineMask: number;
  readonly landMagnitudeThresholds: readonly number[];
  readonly typeLegend: readonly string[];
};

export type StaticTerrainSidecar = {
  schemaVersion: 1;
  tick: number;
  encoding: "uint8-rle";
  length: number;
  runs: IntegerRuns;
  byteLayout: TerrainByteLayout;
};

export type WaterComponentsSidecar = {
  schemaVersion: 1;
  tick: number;
  graphVersion: number;
  encoding: "int32-rle";
  length: number;
  runs: IntegerRuns;
};

export type EconomyPlayerDelta = {
  playerID: string;
  clientID: string;
  work: string;
  war: string;
  trade: string;
  steal: string;
  trainSelf: string;
  trainOther: string;
};

export type AttackPlayerDelta = {
  playerID: string;
  clientID: string;
  sent: string;
  received: string;
  cancelled: string;
};

export type TickBatch<T> = {
  schemaVersion: 1;
  fromTick: number;
  toTick: number;
  ticks: Array<{ tick: number; players: T[] }>;
};

export type TradeCompletionEvent =
  | {
    tick: number;
    payout: string;
    sourcePortOwnerPlayerID: string;
    destinationPortOwnerPlayerID: string;
    captured: false;
    provenance: "exact_stats_call";
  }
  | {
    tick: number;
    payout: string;
    originalSourcePortOwnerPlayerID: string;
    capturedRecipientPlayerID: string;
    captured: true;
    provenance: "exact_stats_call";
  };

export type TrainStopEvent = {
  tick: number;
  payout: string;
  trainOwnerPlayerID: string;
  stationOwnerPlayerID: string;
  provenance: "exact_stats_call";
};

export type EventBatch<T> = {
  schemaVersion: 1;
  fromTick: number;
  toTick: number;
  events: T[];
};

export type UnitsConstructedSidecar = {
  schemaVersion: 1;
  tick: number;
  players: Array<{
    playerID: string;
    smallID: number;
    counts: Record<string, number>;
  }>;
};

export type MirvLaunchesSidecar = {
  schemaVersion: 1;
  tick: number;
  count: string;
};

export type BorderTargetsSidecar = {
  schemaVersion: 1;
  tick: number;
  pairs: Array<{
    playerAID: string;
    playerBID: string;
    edges: number;
  }>;
};

export type RailroadSummary = {
  id: number;
  startTile: number | null;
  endTile: number | null;
  tileCount: number;
};

export type RailLifecycleEvent =
  | {
    sequence: number;
    tick: number;
    type: "constructed";
    railroad: RailroadSummary;
  }
  | {
    sequence: number;
    tick: number;
    type: "snapped";
    originalRailroadID: number;
    railroads: [RailroadSummary, RailroadSummary];
  }
  | {
    sequence: number;
    tick: number;
    type: "destroyed";
    railroadID: number;
  };

export type RailTopologySidecar = {
  schemaVersion: 1;
  tick: number;
  fromTick: number;
  toTick: number;
  railroads: Array<{ id: number; tiles: number[] }>;
  events: RailLifecycleEvent[];
};

export type SpawnUnitState = {
  unitID: number;
  ownerPlayerID: string | null;
  tile: number;
  level: number;
  active: boolean;
  underConstruction: boolean;
  hasTrainStation: boolean;
};

export type SpawnStateSidecar = {
  schemaVersion: 1;
  tick: number;
  ports: SpawnUnitState[];
  tradeShips: Array<SpawnUnitState & {
    targetUnitID: number | null;
    targetOwnerPlayerID: string | null;
  }>;
  trains: Array<SpawnUnitState & {
    trainType: string | null;
    loaded: boolean | null;
    reachedTarget: boolean;
    targetUnitID: number | null;
  }>;
};

export type PassiveSidecars = {
  economyStats: TickBatch<EconomyPlayerDelta>;
  tradeCompletions: EventBatch<TradeCompletionEvent>;
  trainStops: EventBatch<TrainStopEvent>;
  unitsConstructed: UnitsConstructedSidecar;
  attackStats: TickBatch<AttackPlayerDelta>;
  mirvLaunches: MirvLaunchesSidecar;
  borderTargets: BorderTargetsSidecar;
  staticTerrain: StaticTerrainSidecar | null;
  waterComponents: WaterComponentsSidecar | null;
  railTopology: RailTopologySidecar;
  spawnState: SpawnStateSidecar;
};

export type MirrorIngestResult = PassiveSidecars & {
  schemaVersion: 3;
  status: MirrorStatus;
  engine: EngineIdentity;
  snapshotCount: number;
  state: GameState | null;
  transportLifecycle: TransportLifecycleBatch;
  parity: ParityResult | null;
  incident: Record<string, unknown> | null;
};

export type MirrorFinalizeResult = {
  schemaVersion: 3;
  status: MirrorStatus;
  engine: EngineIdentity;
  liveStateRef: { tick: number; status: MirrorStatus; hash: string } | null;
  officialStateRef: { tick: number; status: MirrorStatus; hash: string } | null;
  parity: ParityResult;
  incident: Record<string, unknown> | null;
};

export function parseMirrorRequest(message: unknown): MirrorRequest {
  if (!isRecord(message)) {
    throw new Error("mirror request must be an object");
  }
  const id = parseMirrorRequestID(message.id);
  if (message.type === "ingest") {
    return { id, type: "ingest", frame: message.frame };
  }
  if (message.type === "finalize") {
    return { id, type: "finalize", gameRecord: message.gameRecord };
  }
  throw new Error(
    `unknown mirror operation ${String(message.type)}; expected ingest or finalize`,
  );
}

export function mirrorRequestIDForError(message: unknown): MirrorRequestID | null {
  if (!isRecord(message)) return null;
  try {
    return parseMirrorRequestID(message.id);
  } catch {
    return null;
  }
}

function parseMirrorRequestID(value: unknown): MirrorRequestID {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  throw new Error(
    "mirror request id must be a non-empty string or non-negative safe integer",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

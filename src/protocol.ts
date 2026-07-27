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

export const MAX_PROJECT_ROUTES = 64;

export type TransportRouteCandidate = {
  source: number;
  destination: number;
};

export type MirrorProjectQuery = {
  tick: number;
  stateHash: string;
  routes: TransportRouteCandidate[];
};

export type ProjectMirrorRequest = MirrorProjectQuery & {
  id: MirrorRequestID;
  type: "project";
};

export type MirrorRequest =
  | IngestMirrorRequest
  | FinalizeMirrorRequest
  | ProjectMirrorRequest;

export type MirrorIPCSuccessResult = {
  id: MirrorRequestID;
  ok: true;
  result: MirrorIngestResult | MirrorFinalizeResult | MirrorProjectResult;
};

export type MirrorIPCErrorResult = {
  id: MirrorRequestID | null;
  ok: false;
  error: string;
};

export type MirrorIPCResult = MirrorIPCSuccessResult | MirrorIPCErrorResult;

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

export type ExecutionStateCapabilityName =
  | "attacks"
  | "constructions"
  | "transports"
  | "tradeShips"
  | "ports"
  | "trainStations"
  | "trains"
  | "retreats"
  | "nukes"
  | "samInterceptions"
  | "warships"
  | "diplomacy"
  | "playerTiming"
  | "staggerCounters";

export type ExecutionStateCapability = {
  available: boolean;
  reason?: string;
};

export type ExecutionPathProgress = {
  pathIndex: number;
  pathLength: number;
  remainingSteps: number;
};

export type WaterPathExecutionState = {
  graphVersion: number;
  pendingGraphVersion: number;
  stagger: number;
  staggerCountdown: number;
  progress: ExecutionPathProgress | null;
};

export type AttackExecutionState = {
  attackID: string | null;
  ownerPlayerID: string;
  targetPlayerID: string | null;
  initialized: boolean;
  startTroops: number | null;
  removesOwnerTroops: boolean;
  currentTroops: number | null;
  sourceTile: number | null;
  borderSize: number | null;
  frontierSize: number;
  retreating: boolean;
  retreated: boolean;
};

export type ConstructionExecutionState = {
  ownerPlayerID: string;
  constructionType: string;
  requestedTile: number;
  rocketDirectionUp: boolean | null;
  structureUnitID: number | null;
  ticksUntilComplete: number | null;
};

export type TransportExecutionState = {
  unitID: number | null;
  ownerPlayerID: string;
  originalOwnerPlayerID: string;
  targetPlayerID: string | null;
  requestedTile: number;
  sourceTile: number | null;
  currentTile: number | null;
  destinationTile: number | null;
  retreatDestinationTile: number | null;
  troops: number;
  retreating: boolean;
  lastMoveTick: number | null;
  ticksPerMove: number;
  motionPlanID: number;
  motionPlanDestinationTile: number | null;
  path: WaterPathExecutionState | null;
};

export type TradeShipExecutionState = {
  unitID: number | null;
  originalOwnerPlayerID: string;
  currentOwnerPlayerID: string | null;
  sourcePortUnitID: number;
  destinationPortUnitID: number;
  currentTile: number | null;
  wasCaptured: boolean;
  tilesTraveled: number;
  motionPlanID: number;
  motionPlanDestinationTile: number | null;
  path: WaterPathExecutionState | null;
};

export type PortExecutionState = {
  unitID: number;
  ownerPlayerID: string;
  initialized: boolean;
  checkOffset: number | null;
  tradeShipSpawnRejections: number;
  rollPhase: "due" | "waiting" | null;
  nextRollTick: number | null;
};

export type TrainStationExecutionState = {
  unitID: number;
  ownerPlayerID: string;
  stationID: number | null;
  stationTile: number | null;
  clusterSize: number | null;
  spawnTrains: boolean;
  lastSpawnTick: number;
  spawnCooldownTicks: number;
  nextEligibleSpawnTick: number;
};

export type TrainExecutionState = {
  unitID: number | null;
  ownerPlayerID: string;
  sourceStationID: number;
  sourceUnitID: number;
  destinationStationID: number;
  destinationUnitID: number;
  currentRailroadID: number | null;
  currentRailOffset: number;
  speed: number;
  spacing: number;
  hasCargo: boolean;
  tradeStopsVisited: number;
  carUnitIDs: number[];
};

export type RetreatExecutionState =
  | {
    kind: "attack";
    ownerPlayerID: string;
    attackID: string;
    startTick: number | null;
    executeAtTick: number | null;
    retreatOrdered: boolean;
  }
  | {
    kind: "transport";
    ownerPlayerID: string;
    unitID: number;
  };

export type NukeExecutionState = {
  unitID: number | null;
  ownerPlayerID: string;
  nukeType: string;
  sourceTile: number | null;
  destinationTile: number;
  speed: number;
  waitTicks: number;
  trajectoryIndex: number | null;
  trajectoryLength: number | null;
  targetable: boolean | null;
  targetedBySAM: boolean | null;
};

export type SAMInterceptionExecutionState =
  | {
    kind: "launcher";
    launcherUnitID: number | null;
    ownerPlayerID: string;
    plans: Array<{
      targetUnitID: number;
      interceptionTile: number | null;
      interceptionTick: number | null;
      reachable: boolean;
    }>;
  }
  | {
    kind: "missile";
    missileUnitID: number | null;
    launcherUnitID: number;
    ownerPlayerID: string;
    targetUnitID: number;
    targetTile: number;
    speed: number;
    progress: ExecutionPathProgress | null;
  };

export type WarshipExecutionState = {
  unitID: number | null;
  ownerPlayerID: string | null;
  tile: number | null;
  health: number | null;
  state: string | null;
  patrolTile: number | null;
  retreatPortTile: number | null;
  targetUnitID: number | null;
  targetTile: number | null;
  lastCombatTick: number | null;
  lastShellAttackTick: number;
  lastManualMoveTick: number;
  lastObservedPatrolTile: number | null;
  activeHealingRemainder: number;
  alreadySentShellTargetUnitIDs: number[];
  path: WaterPathExecutionState | null;
};

export type DiplomacyExecutionState = {
  alliances: Array<{
    allianceID: number;
    requestorPlayerID: string;
    recipientPlayerID: string;
    createdAtTick: number;
    expiresAtTick: number;
    requestorAgreedToExtend: boolean;
    recipientAgreedToExtend: boolean;
  }>;
  requests: Array<{
    requestorPlayerID: string;
    recipientPlayerID: string;
    createdAtTick: number;
    rejectAfterTick: number;
    status: "pending" | "accepted" | "rejected";
  }>;
};

export type PlayerTimingExecutionState = {
  playerID: string;
  lastTileChangeTick: number;
  markedTraitorTick: number;
  lastDeleteUnitTick: number;
  lastEmbargoAllTick: number;
  lastClusterCalculationTick: number | null;
  clusterCalculationPeriod: number | null;
  targets: Array<{ targetPlayerID: string; tick: number }>;
  lastDonationTicks: Array<{ recipientPlayerID: string; tick: number }>;
  lastEmojiTicks: Array<{ recipientSmallID: number | string; tick: number }>;
  lastAllianceRequestTicks: Array<{
    recipientPlayerID: string;
    tick: number;
  }>;
};

export type ExecutionStateSidecar = {
  schemaVersion: 1;
  tick: number;
  capabilities: Record<
    ExecutionStateCapabilityName,
    ExecutionStateCapability
  >;
  attacks?: AttackExecutionState[];
  constructions?: ConstructionExecutionState[];
  transports?: TransportExecutionState[];
  tradeShips?: TradeShipExecutionState[];
  ports?: PortExecutionState[];
  trainStations?: TrainStationExecutionState[];
  trains?: TrainExecutionState[];
  retreats?: RetreatExecutionState[];
  nukes?: NukeExecutionState[];
  samInterceptions?: SAMInterceptionExecutionState[];
  warships?: WarshipExecutionState[];
  diplomacy?: DiplomacyExecutionState;
  playerTiming?: PlayerTimingExecutionState[];
  staggerCounters?: {
    transportShips: number;
    tradeShips: number;
  };
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
  executionState: ExecutionStateSidecar;
};

export type MirrorIngestResult = PassiveSidecars & {
  schemaVersion: 4;
  status: MirrorStatus;
  engine: EngineIdentity;
  snapshotCount: number;
  state: GameState | null;
  transportLifecycle: TransportLifecycleBatch;
  parity: ParityResult | null;
  incident: Record<string, unknown> | null;
};

export type MirrorFinalizeResult = {
  schemaVersion: 4;
  status: MirrorStatus;
  engine: EngineIdentity;
  liveStateRef: { tick: number; status: MirrorStatus; hash: string } | null;
  officialStateRef: { tick: number; status: MirrorStatus; hash: string } | null;
  parity: ParityResult;
  incident: Record<string, unknown> | null;
};

export type TransportRouteProjection = TransportRouteCandidate & {
  reachable: boolean;
  pathLength?: number;
  ticksPerStep?: number;
  traversalDurationTicks?: number;
  projectedArrivalDurationTicks?: number;
  projectedArrivalTick?: number;
};

export type WaterProjectionGeometry = {
  provenance: "exact_current_water_geometry";
  algorithm: "canonical_water_hierarchical" | "canonical_water_simple";
  waterGraphVersion: number;
};

export type MirrorProjectSuccessResult = {
  schemaVersion: 4;
  operation: "project";
  outcome: "success";
  engine: EngineIdentity;
  tick: number;
  stateHash: string;
  geometry: WaterProjectionGeometry;
  routes: TransportRouteProjection[];
};

export type MirrorProjectRefusalCode =
  | "mirror_not_ready"
  | "mirror_advancing"
  | "mirror_not_exact"
  | "stale_tick"
  | "state_hash_mismatch";

export type MirrorProjectRefusalResult = {
  schemaVersion: 4;
  operation: "project";
  outcome: "refused";
  engine: EngineIdentity;
  requested: {
    tick: number;
    stateHash: string;
  };
  currentStateRef: {
    tick: number;
    status: MirrorStatus;
    hash: string;
  } | null;
  refusal: {
    code: MirrorProjectRefusalCode;
    message: string;
  };
};

export type MirrorProjectResult =
  | MirrorProjectSuccessResult
  | MirrorProjectRefusalResult;

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
  if (message.type === "project") {
    return {
      id,
      type: "project",
      ...parseMirrorProjectQuery(message),
    };
  }
  throw new Error(
    `unknown mirror operation ${String(message.type)}; expected ingest, finalize, or project`,
  );
}

export function parseMirrorProjectQuery(value: unknown): MirrorProjectQuery {
  if (!isRecord(value)) {
    throw new Error("project request must be an object");
  }
  const tick = parseNonNegativeSafeInteger(value.tick, "project tick");
  if (
    typeof value.stateHash !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(value.stateHash)
  ) {
    throw new Error(
      "project stateHash must be a lowercase sha256:<64 hex digits> value",
    );
  }
  if (!Array.isArray(value.routes)) {
    throw new Error("project routes must be an array");
  }
  if (value.routes.length === 0) {
    throw new Error("project routes must contain at least one route");
  }
  if (value.routes.length > MAX_PROJECT_ROUTES) {
    throw new Error(
      `project routes exceeds the deterministic cap of ${MAX_PROJECT_ROUTES}`,
    );
  }

  const seen = new Set<string>();
  const routes = value.routes.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`project routes[${index}] must be an object`);
    }
    const source = parseNonNegativeSafeInteger(
      candidate.source,
      `project routes[${index}].source`,
    );
    const destination = parseNonNegativeSafeInteger(
      candidate.destination,
      `project routes[${index}].destination`,
    );
    const key = `${source}:${destination}`;
    if (seen.has(key)) {
      throw new Error(
        `project routes contains duplicate source/destination pair ${key}`,
      );
    }
    seen.add(key);
    return { source, destination };
  });

  return { tick, stateHash: value.stateHash, routes };
}

export function mirrorRequestIDForError(message: unknown): MirrorRequestID | null {
  if (!isRecord(message)) return null;
  try {
    return parseMirrorRequestID(message.id);
  } catch {
    return null;
  }
}

function parseNonNegativeSafeInteger(value: unknown, name: string): number {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  throw new Error(`${name} must be a non-negative safe integer`);
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

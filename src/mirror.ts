import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGameRunner, type GameRunner } from "../vendor/proxywar/src/core/GameRunner.ts";
import { AttackExecution } from "../vendor/proxywar/src/core/execution/AttackExecution.ts";
import { BoatRetreatExecution } from "../vendor/proxywar/src/core/execution/BoatRetreatExecution.ts";
import { ConstructionExecution } from "../vendor/proxywar/src/core/execution/ConstructionExecution.ts";
import { NukeExecution } from "../vendor/proxywar/src/core/execution/NukeExecution.ts";
import { PlayerExecution } from "../vendor/proxywar/src/core/execution/PlayerExecution.ts";
import { PortExecution } from "../vendor/proxywar/src/core/execution/PortExecution.ts";
import { RetreatExecution } from "../vendor/proxywar/src/core/execution/RetreatExecution.ts";
import { SAMLauncherExecution } from "../vendor/proxywar/src/core/execution/SAMLauncherExecution.ts";
import { SAMMissileExecution } from "../vendor/proxywar/src/core/execution/SAMMissileExecution.ts";
import { TradeShipExecution } from "../vendor/proxywar/src/core/execution/TradeShipExecution.ts";
import { TrainExecution } from "../vendor/proxywar/src/core/execution/TrainExecution.ts";
import { TrainStationExecution } from "../vendor/proxywar/src/core/execution/TrainStationExecution.ts";
import { TransportShipExecution } from "../vendor/proxywar/src/core/execution/TransportShipExecution.ts";
import { WarshipExecution } from "../vendor/proxywar/src/core/execution/WarshipExecution.ts";
import { AStarWater } from "../vendor/proxywar/src/core/pathfinding/algorithms/AStar.Water.ts";
import { AStarWaterHierarchical } from "../vendor/proxywar/src/core/pathfinding/algorithms/AStar.WaterHierarchical.ts";
import { ComponentCheckTransformer } from "../vendor/proxywar/src/core/pathfinding/transformers/ComponentCheckTransformer.ts";
import { MiniMapTransformer } from "../vendor/proxywar/src/core/pathfinding/transformers/MiniMapTransformer.ts";
import { ShoreCoercingTransformer } from "../vendor/proxywar/src/core/pathfinding/transformers/ShoreCoercingTransformer.ts";
import { SmoothingWaterTransformer } from "../vendor/proxywar/src/core/pathfinding/transformers/SmoothingWaterTransformer.ts";
import type { PathFinder } from "../vendor/proxywar/src/core/pathfinding/types.ts";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  TerrainType,
  UnitType,
  type Game,
  type Unit,
} from "../vendor/proxywar/src/core/game/Game.ts";
import { GameMapImpl } from "../vendor/proxywar/src/core/game/GameMap.ts";
import type { GameMapLoader } from "../vendor/proxywar/src/core/game/GameMapLoader.ts";
import type {
  ErrorUpdate,
  GameUpdateViewData,
} from "../vendor/proxywar/src/core/game/GameUpdates.ts";
import { GameUpdateType } from "../vendor/proxywar/src/core/game/GameUpdates.ts";
import {
  unpackMotionPlans,
  type GridPathPlan,
} from "../vendor/proxywar/src/core/game/MotionPlans.ts";
import type { GameStartInfo, Intent, Turn } from "../vendor/proxywar/src/core/Schemas.ts";
import {
  ATTACK_INDEX_CANCEL,
  ATTACK_INDEX_RECV,
  ATTACK_INDEX_SENT,
  GOLD_INDEX_STEAL,
  GOLD_INDEX_TRADE,
  GOLD_INDEX_TRAIN_OTHER,
  GOLD_INDEX_TRAIN_SELF,
  GOLD_INDEX_WAR,
  GOLD_INDEX_WORK,
} from "../vendor/proxywar/src/core/StatsSchemas.ts";
import type {
  AttackPlayerDelta,
  BorderTargetsSidecar,
  EconomyPlayerDelta,
  EventBatch,
  ExecutionPathProgress,
  ExecutionStateCapability,
  ExecutionStateCapabilityName,
  ExecutionStateSidecar,
  GameState,
  MirrorFinalizeResult,
  MirrorIngestResult,
  MirrorProjectQuery,
  MirrorProjectRefusalCode,
  MirrorProjectResult,
  MirrorStatus,
  ParityResult,
  PassiveSidecars,
  RailLifecycleEvent,
  RailroadSummary,
  SpawnStateSidecar,
  SpawnUnitState,
  StaticTerrainSidecar,
  TerrainByteLayout,
  TickBatch,
  TradeCompletionEvent,
  TrainStopEvent,
  TransportLifecycleBatch,
  TransportLifecycleEvent,
  UnitsConstructedSidecar,
  WaterComponentsSidecar,
  WaterPathExecutionState,
} from "./protocol.ts";
import { parseMirrorProjectQuery } from "./protocol.ts";

export * from "./protocol.ts";

process.env.GAME_ENV ??= "dev";

export const ENGINE_IDENTITY = Object.freeze({
  coworldID: "cow_5d275752-ff30-4f5c-a1c1-6db56b518ef2",
  coworldVersion: "0.1.11",
  proxyWarCommit: "84bb064ad199f1e14f0cf45046395bb95c7ce2fe",
  gameImage: "public.ecr.aws/q5f4m8t9/cogames@sha256:71341d0c0b701dc13f0e8afc45b05c2fed94e8cdad8579c0d4b0745de9441d70",
});

export const CANONICAL_TERRAIN_BYTE_LAYOUT = deriveTerrainByteLayout();

const HASH_SIGNIFICANT_DIGITS = 11;

type TrackedTransport = {
  unitID: number;
  ownerPlayerID: string | null;
  targetPlayerID: string | null;
  sourceTile: number;
  targetTile: number | null;
  troops: number;
  retreating: boolean;
};

type PendingArrival = {
  unitID: number;
  ownerPlayerID: string | null;
  targetPlayerID: string | null;
  targetTile: number | null;
  troops: number;
  tick: number;
};

type BoatIntentContext = {
  clientID: string;
  ownerPlayerID: string | null;
  requestedTile: number;
  targetPlayerID: string | null;
  troops: number;
};

type StatsSnapshot = Map<string, {
  playerID: string;
  clientID: string;
  gold: bigint[];
  attacks: bigint[];
}>;

type SidecarTickSnapshot = {
  stats: StatsSnapshot;
};

type WithoutTick<T> = T extends unknown ? Omit<T, "tick"> : never;
type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence"> : never;

export class ExactMirror {
  private runner: GameRunner | null = null;
  private status: MirrorStatus = "bootstrapping";
  private snapshotCount = 0;
  private lastSequence = 0;
  private readonly clientByAgent = new Map<string, string>();
  private readonly clientByName = new Map<string, string>();
  private latestState: GameState | null = null;
  private incident: Record<string, unknown> | null = null;
  private readonly mapLoader: StaticMapLoader;
  private readonly transportLifecycle = new TransportLifecycleObserver();
  private readonly passiveSidecars = new PassiveSidecarObserver();
  private latestTransportBatch: TransportLifecycleBatch = emptyTransportBatch(0, 0);
  private latestSidecars: PassiveSidecars = emptyPassiveSidecars(0, 0);

  constructor(options: { mapRoot?: string } = {}) {
    this.mapLoader = new StaticMapLoader(options.mapRoot ?? defaultMapRoot());
  }

  async ingest(frame: unknown): Promise<MirrorIngestResult> {
    const currentTick = this.runner?.game.ticks() ?? 0;
    this.latestTransportBatch = emptyTransportBatch(currentTick, currentTick);
    this.latestSidecars = resetPassiveBatches(this.latestSidecars, currentTick);
    if (this.status === "diverged" || this.status === "unavailable") {
      return this.result(null);
    }
    const global = asRecord(frame);
    if (global?.type !== "state") return this.result(null);
    const count = integer(global.snapshotCount);
    const snapshot = asRecord(global.snapshot);
    if (snapshot === null || count === null || count === 0) return this.result(null);
    if (count === this.snapshotCount) return this.result(null);
    if (count !== this.snapshotCount + 1) {
      return this.diverge("global_snapshot_gap", {
        expectedSnapshotCount: this.snapshotCount + 1,
        receivedSnapshotCount: count,
      });
    }

    try {
      if (this.runner === null) await this.bootstrap(global, snapshot);
      this.latestTransportBatch = await this.advance(snapshot);
      this.snapshotCount = count;
      const state = captureGameState(this.runner!.game, this.status);
      const parity = comparePublicSnapshot(state, global, snapshot);
      if (!parity.ok) {
        this.latestState = state;
        return this.diverge("public_snapshot_parity", { parity });
      }
      this.status = "exact";
      state.source.status = "exact";
      this.latestState = state;
      return this.result(parity);
    } catch (error) {
      return this.diverge("mirror_execution_failure", {
        error: String((error as Error)?.stack ?? error).slice(0, 8_000),
      });
    }
  }

  async finalize(gameRecord: unknown): Promise<MirrorFinalizeResult> {
    const official = await replayGameRecord(gameRecord, { mapLoader: this.mapLoader });
    const parity = this.latestState === null
      ? { ok: false, checked: [], mismatches: [{ path: "mirror", expected: "state", actual: null }] }
      : compareStates(this.latestState, official);
    return {
      schemaVersion: 4,
      status: parity.ok && this.status !== "diverged" ? this.status : "diverged",
      engine: ENGINE_IDENTITY,
      liveStateRef: stateRef(this.latestState),
      officialStateRef: stateRef(official),
      parity,
      incident: this.incident,
    };
  }

  state(): GameState | null {
    return this.latestState;
  }

  project(value: MirrorProjectQuery): MirrorProjectResult {
    const query = parseMirrorProjectQuery(value);
    const currentStateRef = stateRef(this.latestState);
    if (this.runner === null || this.latestState === null) {
      return projectRefusal(
        query,
        currentStateRef,
        "mirror_not_ready",
        "the mirror has no exact current state",
      );
    }
    if (this.status !== "exact") {
      return projectRefusal(
        query,
        currentStateRef,
        "mirror_not_exact",
        `the mirror status is ${this.status}`,
      );
    }
    if (this.runner.game.ticks() !== this.latestState.tick) {
      return projectRefusal(
        query,
        currentStateRef,
        "mirror_advancing",
        "the canonical runner is advancing beyond the latest validated state",
      );
    }
    if (query.tick !== this.latestState.tick) {
      return projectRefusal(
        query,
        currentStateRef,
        "stale_tick",
        `requested tick ${query.tick} does not match current tick ${this.latestState.tick}`,
      );
    }
    if (query.stateHash !== this.latestState.source.hash) {
      return projectRefusal(
        query,
        currentStateRef,
        "state_hash_mismatch",
        "requested stateHash does not match the current canonical state",
      );
    }

    const game = this.runner.game;
    for (let index = 0; index < query.routes.length; index++) {
      const route = query.routes[index];
      if (!game.isValidRef(route.source)) {
        throw new Error(
          `project routes[${index}].source is outside the current map`,
        );
      }
      if (!game.isValidRef(route.destination)) {
        throw new Error(
          `project routes[${index}].destination is outside the current map`,
        );
      }
    }

    const projection = passiveCanonicalWaterPathFinder(game);
    const routes = query.routes.map(({ source, destination }) => {
      const path = projection.pathFinder.findPath(source, destination);
      if (path === null || path.length === 0) {
        return { source, destination, reachable: false };
      }
      const pathLength = path.length;
      const ticksPerStep = 1;
      const traversalDurationTicks = Math.max(0, pathLength - 1) *
        ticksPerStep;
      const projectedArrivalDurationTicks =
        ticksPerStep + traversalDurationTicks;
      return {
        source,
        destination,
        reachable: true,
        pathLength,
        ticksPerStep,
        traversalDurationTicks,
        projectedArrivalDurationTicks,
        projectedArrivalTick: query.tick + projectedArrivalDurationTicks,
      };
    });

    return {
      schemaVersion: 4,
      operation: "project",
      outcome: "success",
      engine: ENGINE_IDENTITY,
      tick: query.tick,
      stateHash: query.stateHash,
      geometry: {
        provenance: "exact_current_water_geometry",
        algorithm: projection.algorithm,
        waterGraphVersion: game.waterGraphVersion(),
      },
      routes,
    };
  }

  private async bootstrap(global: Record<string, unknown>, snapshot: Record<string, unknown>): Promise<void> {
    if (this.snapshotCount !== 0 || integer(global.snapshotCount) !== 1) {
      throw new Error("mirror must observe snapshot zero and bootstrap from snapshot one");
    }
    const config = asRecord(global.config);
    const publicPlayers = records(snapshot.players);
    if (config === null || publicPlayers.length === 0) throw new Error("bootstrap frame lacks config or players");
    this.rememberRoster(publicPlayers);
    const gameStartInfo = buildGameStartInfo(config, publicPlayers);
    this.runner = await withSilentEngine(() => createGameRunner(
      gameStartInfo,
      undefined,
      this.mapLoader,
      (update) => {
        this.transportLifecycle.captureRunnerUpdate(update);
        this.passiveSidecars.captureRunnerUpdate(update);
      },
    ));
    this.passiveSidecars.captureInitial(this.runner.game);
  }

  private async advance(snapshot: Record<string, unknown>): Promise<TransportLifecycleBatch> {
    const targetTick = integer(snapshot.tick);
    if (targetTick === null || targetTick < this.runner!.game.ticks()) {
      throw new Error(`invalid target tick ${String(snapshot.tick)}`);
    }
    const intents = this.acceptedIntents(snapshot);
    if (this.runner!.game.ticks() === 0) {
      const connected = this.runner!.game.players().map((player) => ({
        type: "mark_disconnected",
        clientID: player.clientID(),
        isDisconnected: false,
      }));
      intents.set(0, [...connected, ...(intents.get(0) ?? [])] as Intent[]);
    }
    const fromTick = this.runner!.game.ticks();
    this.transportLifecycle.beginBatch(fromTick);
    this.passiveSidecars.beginBatch(fromTick);
    while (this.runner!.game.ticks() < targetTick) {
      const turnNumber = this.runner!.game.ticks();
      const turn: Turn = { turnNumber, intents: (intents.get(turnNumber) ?? []) as Turn["intents"] };
      const before = this.transportLifecycle.beforeTick(this.runner!.game);
      const sidecarBefore = this.passiveSidecars.beforeTick(this.runner!.game);
      const boatIntents = boatIntentContexts(this.runner!.game, turn.intents);
      this.runner!.addTurn(turn);
      const executed = await withSilentEngine(() => this.runner!.executeNextTick());
      if (!executed) throw new Error(`canonical runner rejected turn ${turnNumber}`);
      this.transportLifecycle.afterTick(this.runner!.game, before, boatIntents);
      this.passiveSidecars.afterTick(this.runner!.game, sidecarBefore);
    }
    this.latestSidecars = this.passiveSidecars.endBatch(this.runner!.game, targetTick);
    return this.transportLifecycle.endBatch(targetTick);
  }

  private acceptedIntents(snapshot: Record<string, unknown>): Map<number, Intent[]> {
    const players = records(snapshot.players);
    this.rememberRoster(players);
    const result = new Map<number, Intent[]>();
    for (const decision of records(snapshot.decisions)) {
      const sequence = integer(decision.sequence);
      if (sequence === null || sequence <= this.lastSequence) continue;
      if (sequence !== this.lastSequence + 1) {
        throw new Error(`decision sequence gap: expected ${this.lastSequence + 1}, received ${sequence}`);
      }
      this.lastSequence = sequence;
      if (decision.accepted !== true || decision.intentSummary === "none") continue;
      const turn = integer(decision.turnNumber);
      if (turn === null) throw new Error(`decision ${sequence} lacks turnNumber`);
      const parsed = JSON.parse(String(decision.intentSummary));
      const clientID = this.clientByAgent.get(String(decision.agentID ?? "")) || this.clientByName.get(String(decision.username ?? ""));
      if (!clientID) throw new Error(`decision ${sequence} has no roster client`);
      const batch = result.get(turn) ?? [];
      batch.push({ ...parsed, clientID });
      result.set(turn, batch);
    }
    return result;
  }

  private rememberRoster(players: Array<Record<string, unknown>>): void {
    for (const player of players) {
      const clientID = nonempty(player.clientID);
      if (clientID === null) continue;
      rememberIdentity(this.clientByAgent, nonempty(player.agentID), clientID, "agentID");
      rememberIdentity(this.clientByName, nonempty(player.username), clientID, "username");
    }
  }

  private diverge(
    reason: string,
    detail: Record<string, unknown>,
  ): MirrorIngestResult {
    this.status = "diverged";
    if (this.latestState) this.latestState.source.status = "diverged";
    this.incident = {
      schemaVersion: 1,
      reason,
      snapshotCount: this.snapshotCount,
      tick: this.runner?.game.ticks() ?? null,
      lastStateHash: this.latestState?.source.hash ?? null,
      engine: ENGINE_IDENTITY,
      ...detail,
    };
    return this.result(null);
  }

  private result(parity: ParityResult | null): MirrorIngestResult {
    return {
      schemaVersion: 4,
      status: this.status,
      engine: ENGINE_IDENTITY,
      snapshotCount: this.snapshotCount,
      state: this.latestState,
      transportLifecycle: this.latestTransportBatch,
      ...this.latestSidecars,
      parity,
      incident: this.incident,
    };
  }
}

function projectRefusal(
  query: MirrorProjectQuery,
  currentStateRef: ReturnType<typeof stateRef>,
  code: MirrorProjectRefusalCode,
  message: string,
): MirrorProjectResult {
  return {
    schemaVersion: 4,
    operation: "project",
    outcome: "refused",
    engine: ENGINE_IDENTITY,
    requested: {
      tick: query.tick,
      stateHash: query.stateHash,
    },
    currentStateRef,
    refusal: { code, message },
  };
}

function passiveCanonicalWaterPathFinder(game: Game): {
  pathFinder: PathFinder<number>;
  algorithm:
    | "canonical_water_hierarchical"
    | "canonical_water_simple";
} {
  const miniMap = game.miniMap();
  const graph = game.miniWaterGraph();
  if (graph === null || graph.nodeCount < 100) {
    const simple = new AStarWater(miniMap);
    const shore = new ShoreCoercingTransformer(simple, miniMap);
    return {
      pathFinder: new MiniMapTransformer(shore, game.map(), miniMap),
      algorithm: "canonical_water_simple",
    };
  }

  // This recreates PathFinding.Water's canonical stack but deliberately uses
  // fresh search buffers and disables AbstractGraph path writes. The graph and
  // maps are read-only inputs owned by the current canonical game.
  const hierarchical = new AStarWaterHierarchical(miniMap, graph, {
    cachePaths: false,
  });
  const componentCheck = new ComponentCheckTransformer(
    hierarchical,
    (tile: number) => graph.getComponentId(tile),
  );
  const smoothing = new SmoothingWaterTransformer(componentCheck, miniMap);
  const shore = new ShoreCoercingTransformer(smoothing, miniMap);
  return {
    pathFinder: new MiniMapTransformer(shore, game.map(), miniMap),
    algorithm: "canonical_water_hierarchical",
  };
}

class TransportLifecycleObserver {
  private events: TransportLifecycleEvent[] = [];
  private tracked = new Map<number, TrackedTransport>();
  private pendingArrivals: PendingArrival[] = [];
  private latestRunnerUpdate: GameUpdateViewData | null = null;
  private fromTick = 0;
  private eventSequence = 0;

  beginBatch(fromTick: number): void {
    this.fromTick = fromTick;
    this.events = [];
    this.latestRunnerUpdate = null;
  }

  captureRunnerUpdate(update: GameUpdateViewData | ErrorUpdate): void {
    if ("tick" in update) this.latestRunnerUpdate = update;
  }

  beforeTick(game: Game): Map<number, Unit> {
    return new Map(
      game.units()
        .filter((unit) => unit.type() === UnitType.TransportShip)
        .map((unit) => [unit.id(), unit]),
    );
  }

  afterTick(
    game: Game,
    before: Map<number, Unit>,
    boatIntents: BoatIntentContext[],
  ): void {
    const tick = game.ticks();
    const after = this.beforeTick(game);
    const spawnedByOwner = new Map<string, TrackedTransport[]>();

    for (const [unitID, unit] of after) {
      const previous = before.get(unitID);
      if (previous === undefined) {
        const transport = transportRecord(game, unit);
        this.tracked.set(unitID, transport);
        const ownerKey = transport.ownerPlayerID ?? "";
        const spawned = spawnedByOwner.get(ownerKey) ?? [];
        spawned.push(transport);
        spawnedByOwner.set(ownerKey, spawned);
        this.emit({
          type: "launch_observed",
          tick,
          unitID,
          ownerPlayerID: transport.ownerPlayerID,
          targetPlayerID: transport.targetPlayerID,
          sourceTile: transport.sourceTile,
          currentTile: unit.tile(),
          targetTile: transport.targetTile,
          troops: transport.troops,
        });
        continue;
      }

      const tracked = this.tracked.get(unitID) ?? transportRecord(game, unit);
      const retreating = unit.transportShipState().isRetreating;
      if (!tracked.retreating && retreating) {
        this.emit({
          type: "retreat_started",
          tick,
          unitID,
          ownerPlayerID: tracked.ownerPlayerID,
          targetPlayerID: tracked.targetPlayerID,
          currentTile: unit.tile(),
          targetTile: nullableInteger(unit.targetTile()),
          troops: unit.troops(),
        });
      }
      this.tracked.set(unitID, {
        ...tracked,
        targetTile: nullableInteger(unit.targetTile()),
        troops: unit.troops(),
        retreating,
      });
    }

    for (const intent of boatIntents) {
      const candidates = spawnedByOwner.get(intent.ownerPlayerID ?? "") ?? [];
      const match = candidates.find((entry) =>
        Math.abs(entry.troops - intent.troops) <= 1
      ) ?? candidates[0];
      if (match !== undefined) {
        candidates.splice(candidates.indexOf(match), 1);
        continue;
      }
      this.emit({
        type: "launch_failed",
        tick,
        unitID: null,
        ownerPlayerID: intent.ownerPlayerID,
        targetPlayerID: intent.targetPlayerID,
        requestedTile: intent.requestedTile,
        troops: intent.troops,
      });
    }

    for (const [unitID, unit] of before) {
      if (after.has(unitID) || unit.isActive()) continue;
      const tracked = this.tracked.get(unitID) ?? transportRecord(game, unit);
      this.observeTerminal(game, unit, tracked, tick);
      this.tracked.delete(unitID);
    }

    this.observeMotionPlans(after, tick);
    this.observeAttackConversions(game, tick);
    this.latestRunnerUpdate = null;
  }

  endBatch(toTick: number): TransportLifecycleBatch {
    return {
      schemaVersion: 1,
      fromTick: this.fromTick,
      toTick,
      events: this.events.map((event) => ({ ...event })),
    };
  }

  private observeTerminal(
    game: Game,
    unit: Unit,
    tracked: TrackedTransport,
    tick: number,
  ): void {
    const currentTile = unit.tile();
    const targetTile = nullableInteger(unit.targetTile()) ?? tracked.targetTile;
    const retreating = unit.transportShipState().isRetreating || tracked.retreating;
    const common = {
      tick,
      unitID: tracked.unitID,
      ownerPlayerID: tracked.ownerPlayerID,
      targetPlayerID: tracked.targetPlayerID,
      sourceTile: tracked.sourceTile,
      currentTile,
      targetTile,
      troops: unit.troops(),
      ...terminalOwner(game, currentTile, tracked.ownerPlayerID),
    };

    if (unit.wasDestroyedByEnemy()) {
      this.emit({
        type: "destroyed",
        ...common,
        destroyerPlayerID: identifier(unit.destroyer()?.id()),
      });
      return;
    }
    if (retreating) {
      this.emit({ type: "retreat_returned", ...common });
      return;
    }
    if (targetTile !== null && currentTile === targetTile) {
      const owner = playerByID(game, tracked.ownerPlayerID);
      const target = playerByID(game, tracked.targetPlayerID);
      if (owner !== null && target !== null && owner.isFriendly(target)) {
        this.emit({ type: "friendly_returned", ...common });
        return;
      }
      this.emit({ type: "arrived", ...common });
      this.pendingArrivals.push({
        unitID: tracked.unitID,
        ownerPlayerID: tracked.ownerPlayerID,
        targetPlayerID: tracked.targetPlayerID,
        targetTile,
        troops: unit.troops(),
        tick,
      });
      return;
    }
    this.emit({ type: "path_failed", ...common });
  }

  private observeMotionPlans(
    active: Map<number, Unit>,
    tick: number,
  ): void {
    const packed = this.latestRunnerUpdate?.packedMotionPlans;
    if (packed === undefined) return;
    for (const plan of unpackMotionPlans(packed)) {
      if (plan.kind !== "grid") continue;
      const unit = active.get(plan.unitId);
      const tracked = this.tracked.get(plan.unitId);
      if (unit === undefined || tracked === undefined) continue;
      this.emit(planEvent(plan, unit, tracked, tick));
    }
  }

  private observeAttackConversions(
    game: Game,
    tick: number,
  ): void {
    if (this.pendingArrivals.length === 0) return;
    const attacks = game.allPlayers()
      .filter((player) => player.isPlayer())
      .flatMap((player) => player.outgoingAttacks());
    const remaining: PendingArrival[] = [];
    const claimed = new Set<string>();
    for (const arrival of this.pendingArrivals) {
      const match = attacks.find((attack) =>
        !claimed.has(attack.id()) &&
        identifier(attack.attacker().id()) === arrival.ownerPlayerID &&
        identifier(attack.target().id()) === arrival.targetPlayerID &&
        nullableInteger(attack.sourceTile()) === arrival.targetTile
      );
      if (match !== undefined) {
        claimed.add(match.id());
        this.emit({
          type: "attack_converted",
          tick,
          unitID: arrival.unitID,
          ownerPlayerID: arrival.ownerPlayerID,
          targetPlayerID: arrival.targetPlayerID,
          targetTile: arrival.targetTile,
          troops: match.troops(),
          attackID: match.id(),
        });
      } else if (tick - arrival.tick <= 2) {
        remaining.push(arrival);
      }
    }
    this.pendingArrivals = remaining;
  }

  private emit(
    event: Omit<TransportLifecycleEvent, "eventID">,
  ): void {
    this.events.push({
      eventID: `${event.tick}:${event.unitID ?? "none"}:${event.type}:${this.eventSequence++}`,
      ...event,
    });
  }
}

class PassiveSidecarObserver {
  private fromTick = 0;
  private economyTicks: TickBatch<EconomyPlayerDelta>["ticks"] = [];
  private attackTicks: TickBatch<AttackPlayerDelta>["ticks"] = [];
  private tradeEvents: TradeCompletionEvent[] = [];
  private trainEvents: TrainStopEvent[] = [];
  private pendingTradeEvents: Array<WithoutTick<TradeCompletionEvent>> = [];
  private pendingTrainEvents: Array<WithoutTick<TrainStopEvent>> = [];
  private pendingExternalTrainStops: Array<{
    payout: string;
    stationOwnerPlayerID: string;
  }> = [];
  private railroads = new Map<number, number[]>();
  private railEvents: RailLifecycleEvent[] = [];
  private nextRailEventSequence = 1;
  private initialTerrain: StaticTerrainSidecar | null = null;
  private emitInitialTerrain = false;
  private waterGraphVersion: number | null = null;

  captureInitial(game: Game): void {
    if (this.initialTerrain !== null) return;
    const terrain = new Array<number>(game.width() * game.height());
    for (let tile = 0; tile < terrain.length; tile++) {
      terrain[tile] = game.terrainByte(tile);
    }
    this.initialTerrain = {
      schemaVersion: 1,
      tick: game.ticks(),
      encoding: "uint8-rle",
      length: terrain.length,
      runs: encodeIntegerRuns(terrain),
      byteLayout: CANONICAL_TERRAIN_BYTE_LAYOUT,
    };
    this.emitInitialTerrain = true;
    this.attachStatsHooks(game);
  }

  beginBatch(fromTick: number): void {
    this.fromTick = fromTick;
    this.economyTicks = [];
    this.attackTicks = [];
    this.tradeEvents = [];
    this.trainEvents = [];
    this.railEvents = [];
  }

  captureRunnerUpdate(update: GameUpdateViewData | ErrorUpdate): void {
    if (!("tick" in update)) return;
    for (const entry of update.updates[GameUpdateType.RailroadConstructionEvent] ?? []) {
      this.railroads.set(entry.id, [...entry.tiles]);
      this.emitRailEvent({
        tick: update.tick,
        type: "constructed",
        railroad: summarizeRailroad(entry.id, entry.tiles),
      });
    }
    for (const entry of update.updates[GameUpdateType.RailroadSnapEvent] ?? []) {
      this.railroads.delete(entry.originalId);
      this.railroads.set(entry.newId1, [...entry.tiles1]);
      this.railroads.set(entry.newId2, [...entry.tiles2]);
      this.emitRailEvent({
        tick: update.tick,
        type: "snapped",
        originalRailroadID: entry.originalId,
        railroads: [
          summarizeRailroad(entry.newId1, entry.tiles1),
          summarizeRailroad(entry.newId2, entry.tiles2),
        ],
      });
    }
    // A newly snapped segment can be destroyed later in the same canonical
    // tick, so destruction must win when grouped update types are reconciled.
    for (const entry of update.updates[GameUpdateType.RailroadDestructionEvent] ?? []) {
      this.railroads.delete(entry.id);
      this.emitRailEvent({
        tick: update.tick,
        type: "destroyed",
        railroadID: entry.id,
      });
    }
  }

  beforeTick(game: Game): SidecarTickSnapshot {
    return { stats: statsSnapshot(game) };
  }

  afterTick(game: Game, before: SidecarTickSnapshot): void {
    const tick = game.ticks();
    const after = statsSnapshot(game);
    const economyPlayers: EconomyPlayerDelta[] = [];
    const attackPlayers: AttackPlayerDelta[] = [];

    for (const player of game.allPlayers().filter((entry) => entry.isPlayer())) {
      const playerID = String(player.id());
      const prior = before.stats.get(playerID);
      const current = after.get(playerID);
      if (current === undefined) continue;
      const gold = {
        work: deltaAt(current.gold, prior?.gold, GOLD_INDEX_WORK),
        war: deltaAt(current.gold, prior?.gold, GOLD_INDEX_WAR),
        trade: deltaAt(current.gold, prior?.gold, GOLD_INDEX_TRADE),
        steal: deltaAt(current.gold, prior?.gold, GOLD_INDEX_STEAL),
        trainSelf: deltaAt(current.gold, prior?.gold, GOLD_INDEX_TRAIN_SELF),
        trainOther: deltaAt(current.gold, prior?.gold, GOLD_INDEX_TRAIN_OTHER),
      };
      if (Object.values(gold).some((value) => value !== "0")) {
        economyPlayers.push({
          playerID,
          clientID: current.clientID,
          ...gold,
        });
      }
      const attacks = {
        sent: deltaAt(current.attacks, prior?.attacks, ATTACK_INDEX_SENT),
        received: deltaAt(current.attacks, prior?.attacks, ATTACK_INDEX_RECV),
        cancelled: deltaAt(current.attacks, prior?.attacks, ATTACK_INDEX_CANCEL),
      };
      if (Object.values(attacks).some((value) => value !== "0")) {
        attackPlayers.push({
          playerID,
          clientID: current.clientID,
          ...attacks,
        });
      }
    }
    if (economyPlayers.length > 0) {
      this.economyTicks.push({ tick, players: economyPlayers });
    }
    if (attackPlayers.length > 0) {
      this.attackTicks.push({ tick, players: attackPlayers });
    }
    this.flushObservedEvents(tick);
  }

  endBatch(game: Game, toTick: number): PassiveSidecars {
    const staticTerrain = this.emitInitialTerrain ? this.initialTerrain : null;
    this.emitInitialTerrain = false;
    const graphVersion = game.waterGraphVersion();
    const waterComponents = this.waterGraphVersion === graphVersion
      ? null
      : captureWaterComponents(game, graphVersion);
    this.waterGraphVersion = graphVersion;
    return {
      economyStats: tickBatch(this.fromTick, toTick, this.economyTicks),
      tradeCompletions: eventBatch(this.fromTick, toTick, this.tradeEvents),
      trainStops: eventBatch(this.fromTick, toTick, this.trainEvents),
      unitsConstructed: captureUnitsConstructed(game),
      attackStats: tickBatch(this.fromTick, toTick, this.attackTicks),
      mirvLaunches: {
        schemaVersion: 1,
        tick: toTick,
        count: game.stats().numMirvsLaunched().toString(),
      },
      borderTargets: captureBorderTargets(game),
      staticTerrain,
      waterComponents,
      railTopology: {
        schemaVersion: 1,
        tick: toTick,
        fromTick: this.fromTick,
        toTick,
        railroads: [...this.railroads]
          .sort(([left], [right]) => left - right)
          .map(([id, tiles]) => ({ id, tiles: [...tiles] })),
        events: [...this.railEvents],
      },
      spawnState: captureSpawnState(game),
      executionState: captureExecutionState(game),
    };
  }

  private emitRailEvent(
    event: WithoutSequence<RailLifecycleEvent>,
  ): void {
    this.railEvents.push({
      sequence: this.nextRailEventSequence++,
      ...event,
    } as RailLifecycleEvent);
  }

  private attachStatsHooks(game: Game): void {
    const stats = game.stats();
    const boatArriveTrade = stats.boatArriveTrade.bind(stats);
    stats.boatArriveTrade = (source, destination, gold) => {
      boatArriveTrade(source, destination, gold);
      this.pendingTradeEvents.push({
        payout: String(gold),
        sourcePortOwnerPlayerID: String(source.id()),
        destinationPortOwnerPlayerID: String(destination.id()),
        captured: false,
        provenance: "exact_stats_call",
      });
    };
    const boatCapturedTrade = stats.boatCapturedTrade.bind(stats);
    stats.boatCapturedTrade = (recipient, originalSource, gold) => {
      boatCapturedTrade(recipient, originalSource, gold);
      this.pendingTradeEvents.push({
        payout: String(gold),
        originalSourcePortOwnerPlayerID: String(originalSource.id()),
        capturedRecipientPlayerID: String(recipient.id()),
        captured: true,
        provenance: "exact_stats_call",
      });
    };
    const trainExternalTrade = stats.trainExternalTrade.bind(stats);
    stats.trainExternalTrade = (stationOwner, gold) => {
      trainExternalTrade(stationOwner, gold);
      this.pendingExternalTrainStops.push({
        payout: String(gold),
        stationOwnerPlayerID: String(stationOwner.id()),
      });
    };
    const trainSelfTrade = stats.trainSelfTrade.bind(stats);
    stats.trainSelfTrade = (trainOwner, gold) => {
      trainSelfTrade(trainOwner, gold);
      const payout = String(gold);
      const externalIndex = this.pendingExternalTrainStops
        .findLastIndex((entry) => entry.payout === payout);
      const external = externalIndex === -1
        ? null
        : this.pendingExternalTrainStops.splice(externalIndex, 1)[0];
      this.pendingTrainEvents.push({
        payout,
        trainOwnerPlayerID: String(trainOwner.id()),
        stationOwnerPlayerID: external?.stationOwnerPlayerID ?? String(trainOwner.id()),
        provenance: "exact_stats_call",
      });
    };
  }

  private flushObservedEvents(tick: number): void {
    this.tradeEvents.push(...this.pendingTradeEvents.map((event) => ({
      tick,
      ...event,
    })));
    this.trainEvents.push(...this.pendingTrainEvents.map((event) => ({
      tick,
      ...event,
    })));
    this.pendingTradeEvents = [];
    this.pendingTrainEvents = [];
    if (this.pendingExternalTrainStops.length > 0) {
      throw new Error("unpaired exact train stop stats call");
    }
  }
}

function emptyTransportBatch(
  fromTick: number,
  toTick: number,
): TransportLifecycleBatch {
  return { schemaVersion: 1, fromTick, toTick, events: [] };
}

function emptyPassiveSidecars(
  fromTick: number,
  toTick: number,
): PassiveSidecars {
  return {
    economyStats: tickBatch(fromTick, toTick, []),
    tradeCompletions: eventBatch(fromTick, toTick, []),
    trainStops: eventBatch(fromTick, toTick, []),
    unitsConstructed: { schemaVersion: 1, tick: toTick, players: [] },
    attackStats: tickBatch(fromTick, toTick, []),
    mirvLaunches: { schemaVersion: 1, tick: toTick, count: "0" },
    borderTargets: { schemaVersion: 1, tick: toTick, pairs: [] },
    staticTerrain: null,
    waterComponents: null,
    railTopology: {
      schemaVersion: 1,
      tick: toTick,
      fromTick,
      toTick,
      railroads: [],
      events: [],
    },
    spawnState: {
      schemaVersion: 1,
      tick: toTick,
      ports: [],
      tradeShips: [],
      trains: [],
    },
    executionState: emptyExecutionState(toTick),
  };
}

function resetPassiveBatches(
  current: PassiveSidecars,
  tick: number,
): PassiveSidecars {
  return {
    ...current,
    economyStats: tickBatch(tick, tick, []),
    tradeCompletions: eventBatch(tick, tick, []),
    trainStops: eventBatch(tick, tick, []),
    attackStats: tickBatch(tick, tick, []),
    staticTerrain: null,
    waterComponents: null,
    railTopology: {
      ...current.railTopology,
      tick,
      fromTick: tick,
      toTick: tick,
      events: [],
    },
  };
}

function tickBatch<T>(
  fromTick: number,
  toTick: number,
  ticks: TickBatch<T>["ticks"],
): TickBatch<T> {
  return { schemaVersion: 1, fromTick, toTick, ticks };
}

function eventBatch<T>(
  fromTick: number,
  toTick: number,
  events: T[],
): EventBatch<T> {
  return { schemaVersion: 1, fromTick, toTick, events };
}

function statsSnapshot(game: Game): StatsSnapshot {
  const stats = game.stats().stats();
  return new Map(game.allPlayers()
    .filter((player) => player.isPlayer() && player.clientID() !== null)
    .map((player) => {
      const clientID = String(player.clientID());
      const current = stats[clientID];
      return [String(player.id()), {
        playerID: String(player.id()),
        clientID,
        gold: bigintArray(current?.gold),
        attacks: bigintArray(current?.attacks),
      }];
    }));
}

function bigintArray(value: unknown): bigint[] {
  return Array.isArray(value)
    ? value.map((entry) => BigInt(String(entry ?? 0)))
    : [];
}

function deltaAt(
  current: bigint[],
  previous: bigint[] | undefined,
  index: number,
): string {
  return ((current[index] ?? 0n) - (previous?.[index] ?? 0n)).toString();
}

function captureUnitsConstructed(game: Game): UnitsConstructedSidecar {
  const types = Object.values(UnitType).sort();
  return {
    schemaVersion: 1,
    tick: game.ticks(),
    players: game.allPlayers().filter((player) => player.isPlayer())
      .sort((left, right) => left.smallID() - right.smallID())
      .map((player) => ({
        playerID: String(player.id()),
        smallID: player.smallID(),
        counts: Object.fromEntries(types.map((type) => [
          type,
          player.unitsConstructed(type),
        ])),
      })),
  };
}

function captureBorderTargets(game: Game): BorderTargetsSidecar {
  const counts = new Map<string, {
    playerAID: string;
    playerBID: string;
    edges: number;
  }>();
  for (const player of game.allPlayers().filter((entry) => entry.isPlayer())) {
    for (const tile of player.borderTiles()) {
      for (const neighbor of game.neighbors(tile)) {
        if (neighbor <= tile) continue;
        const other = game.owner(neighbor);
        if (!other.isPlayer() || other.id() === player.id()) continue;
        const left = player.smallID() < other.smallID() ? player : other;
        const right = left === player ? other : player;
        const key = `${left.smallID()}:${right.smallID()}`;
        const current = counts.get(key) ?? {
          playerAID: String(left.id()),
          playerBID: String(right.id()),
          edges: 0,
        };
        current.edges++;
        counts.set(key, current);
      }
    }
  }
  return {
    schemaVersion: 1,
    tick: game.ticks(),
    pairs: [...counts.values()].sort((left, right) =>
      left.playerAID.localeCompare(right.playerAID) ||
      left.playerBID.localeCompare(right.playerBID)),
  };
}

function captureWaterComponents(
  game: Game,
  graphVersion: number,
): WaterComponentsSidecar {
  const components = new Array<number>(game.width() * game.height());
  for (let tile = 0; tile < components.length; tile++) {
    components[tile] = game.isWater(tile)
      ? game.getWaterComponent(tile) ?? -1
      : -1;
  }
  return {
    schemaVersion: 1,
    tick: game.ticks(),
    graphVersion,
    encoding: "int32-rle",
    length: components.length,
    runs: encodeIntegerRuns(components),
  };
}

const EXECUTION_CAPABILITIES: readonly ExecutionStateCapabilityName[] = [
  "attacks",
  "constructions",
  "transports",
  "tradeShips",
  "ports",
  "trainStations",
  "trains",
  "retreats",
  "nukes",
  "samInterceptions",
  "warships",
  "diplomacy",
  "playerTiming",
  "staggerCounters",
];

type RuntimeRecord = Record<string, unknown>;

function emptyExecutionState(tick: number): ExecutionStateSidecar {
  return {
    schemaVersion: 1,
    tick,
    capabilities: Object.fromEntries(EXECUTION_CAPABILITIES.map((name) => [
      name,
      { available: false, reason: "mirror_not_bootstrapped" },
    ])) as Record<ExecutionStateCapabilityName, ExecutionStateCapability>,
  };
}

function captureExecutionState(game: Game): ExecutionStateSidecar {
  // Keep this observer read-only. In particular, WaterPathFinder.rebuilt
  // resets on read, pathfinder stepping/path creation advances caches,
  // Unit.warshipState writes a derived flag, and destination helpers draw
  // randomness. Read their backing state and compact counts only.
  const result = {
    schemaVersion: 1 as const,
    tick: game.ticks(),
    capabilities: {} as Record<
      ExecutionStateCapabilityName,
      ExecutionStateCapability
    >,
  } as ExecutionStateSidecar;
  const output = result as unknown as RuntimeRecord;
  const executions = callArray(game, "executions");

  const capture = (
    name: ExecutionStateCapabilityName,
    observer: () => unknown,
  ): void => {
    try {
      output[name] = observer();
      result.capabilities[name] = { available: true };
    } catch (error) {
      delete output[name];
      result.capabilities[name] = {
        available: false,
        reason: String((error as Error)?.message ?? error).slice(0, 500),
      };
    }
  };

  capture("attacks", () => executions
    .filter((execution) =>
      execution instanceof AttackExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "AttackExecution", [
        "attack",
        "startTroops",
        "_owner",
        "_targetID",
        "sourceTile",
        "removeTroops",
        "toConquer",
      ]);
      const attack = nullableObject(state.attack, "AttackExecution.attack");
      const frontier = executionInternals(
        state.toConquer,
        "AttackExecution.toConquer",
        ["size"],
      );
      const frontierSize = callFiniteNumber(frontier, "size");
      return {
        attackID: attack === null ? null : callString(attack, "id"),
        ownerPlayerID: objectIdentifier(state._owner, "AttackExecution._owner"),
        targetPlayerID: identifier(state._targetID),
        initialized: attack !== null,
        startTroops: nullableFiniteNumber(state.startTroops),
        removesOwnerTroops: requiredBoolean(
          state.removeTroops,
          "AttackExecution.removeTroops",
        ),
        currentTroops: attack === null
          ? null
          : callFiniteNumber(attack, "troops"),
        sourceTile: nullableInteger(state.sourceTile),
        borderSize: attack === null
          ? null
          : callNonnegativeInteger(attack, "borderSize"),
        frontierSize,
        retreating: attack === null ? false : callBoolean(attack, "retreating"),
        retreated: attack === null ? false : callBoolean(attack, "retreated"),
      };
    })
    .sort(byJSON));

  capture("constructions", () => executions
    .filter((execution) =>
      execution instanceof ConstructionExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "ConstructionExecution", [
        "player",
        "constructionType",
        "tile",
        "rocketDirectionUp",
        "structure",
      ]);
      return {
        ownerPlayerID: objectIdentifier(
          state.player,
          "ConstructionExecution.player",
        ),
        constructionType: String(state.constructionType),
        requestedTile: requiredInteger(
          state.tile,
          "ConstructionExecution.tile",
        ),
        rocketDirectionUp: typeof state.rocketDirectionUp === "boolean"
          ? state.rocketDirectionUp
          : null,
        structureUnitID: nullableObjectID(
          state.structure,
          "ConstructionExecution.structure",
        ),
        ticksUntilComplete: nullableFiniteNumber(state.ticksUntilComplete),
      };
    })
    .sort(byJSON));

  capture("transports", () => executions
    .filter((execution) =>
      execution instanceof TransportShipExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "TransportShipExecution", [
        "attacker",
        "originalOwner",
        "ref",
        "troops",
        "ticksPerMove",
        "motionPlanId",
        "motionPlanDst",
      ]);
      const boat = nullableObject(state.boat, "TransportShipExecution.boat");
      return {
        unitID: boat === null ? null : callNonnegativeInteger(boat, "id"),
        ownerPlayerID: objectIdentifier(
          state.attacker,
          "TransportShipExecution.attacker",
        ),
        originalOwnerPlayerID: objectIdentifier(
          state.originalOwner,
          "TransportShipExecution.originalOwner",
        ),
        targetPlayerID: nullableObjectIdentifier(
          state.target,
          "TransportShipExecution.target",
        ),
        requestedTile: requiredInteger(
          state.ref,
          "TransportShipExecution.ref",
        ),
        sourceTile: nullableInteger(state.src),
        currentTile: boat === null ? null : callNonnegativeInteger(boat, "tile"),
        destinationTile: nullableInteger(state.dst),
        retreatDestinationTile: nullableInteger(
          state.retreatDst === false ? null : state.retreatDst,
        ),
        troops: requiredFiniteNumber(
          state.troops,
          "TransportShipExecution.troops",
        ),
        retreating: boat === null
          ? false
          : callTransportRetreating(boat),
        lastMoveTick: nullableFiniteNumber(state.lastMove),
        ticksPerMove: requiredFiniteNumber(
          state.ticksPerMove,
          "TransportShipExecution.ticksPerMove",
        ),
        motionPlanID: requiredInteger(
          state.motionPlanId,
          "TransportShipExecution.motionPlanId",
        ),
        motionPlanDestinationTile: nullableInteger(state.motionPlanDst),
        path: nullableWaterPathState(state.pathFinder),
      };
    })
    .sort(byJSON));

  capture("tradeShips", () => executions
    .filter((execution) =>
      execution instanceof TradeShipExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "TradeShipExecution", [
        "origOwner",
        "srcPort",
        "_dstPort",
        "wasCaptured",
        "tilesTraveled",
        "motionPlanId",
        "motionPlanDst",
        "pathFinder",
      ]);
      const ship = nullableObject(state.tradeShip, "TradeShipExecution.tradeShip");
      return {
        unitID: ship === null ? null : callNonnegativeInteger(ship, "id"),
        originalOwnerPlayerID: objectIdentifier(
          state.origOwner,
          "TradeShipExecution.origOwner",
        ),
        currentOwnerPlayerID: ship === null
          ? null
          : objectIdentifier(
            callObject(ship, "owner"),
            "TradeShipExecution.tradeShip.owner",
          ),
        sourcePortUnitID: objectID(
          state.srcPort,
          "TradeShipExecution.srcPort",
        ),
        destinationPortUnitID: objectID(
          state._dstPort,
          "TradeShipExecution._dstPort",
        ),
        currentTile: ship === null ? null : callNonnegativeInteger(ship, "tile"),
        wasCaptured: requiredBoolean(
          state.wasCaptured,
          "TradeShipExecution.wasCaptured",
        ),
        tilesTraveled: requiredInteger(
          state.tilesTraveled,
          "TradeShipExecution.tilesTraveled",
        ),
        motionPlanID: requiredInteger(
          state.motionPlanId,
          "TradeShipExecution.motionPlanId",
        ),
        motionPlanDestinationTile: nullableInteger(state.motionPlanDst),
        path: nullableWaterPathState(state.pathFinder),
      };
    })
    .sort(byJSON));

  capture("ports", () => executions
    .filter((execution) =>
      execution instanceof PortExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "PortExecution", [
        "port",
        "mg",
        "checkOffset",
        "tradeShipSpawnRejections",
      ]);
      const initialized = state.mg !== undefined && state.checkOffset !== undefined;
      const checkOffset = nullableFiniteNumber(state.checkOffset);
      const phase = checkOffset === null
        ? null
        : (game.ticks() + checkOffset) % 10;
      return {
        unitID: objectID(state.port, "PortExecution.port"),
        ownerPlayerID: objectIdentifier(
          callObject(state.port, "owner"),
          "PortExecution.port.owner",
        ),
        initialized,
        checkOffset,
        tradeShipSpawnRejections: requiredInteger(
          state.tradeShipSpawnRejections,
          "PortExecution.tradeShipSpawnRejections",
        ),
        rollPhase: phase === null ? null : phase === 0 ? "due" : "waiting",
        nextRollTick: phase === null
          ? null
          : game.ticks() + ((10 - phase) % 10),
      };
    })
    .sort(byJSON));

  capture("trainStations", () => executions
    .filter((execution) =>
      execution instanceof TrainStationExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "TrainStationExecution", [
        "unit",
        "station",
        "spawnTrains",
        "lastSpawnTick",
        "ticksCooldown",
      ]);
      const station = nullableObject(
        state.station,
        "TrainStationExecution.station",
      );
      const cooldown = requiredInteger(
        state.ticksCooldown,
        "TrainStationExecution.ticksCooldown",
      );
      const lastSpawnTick = requiredInteger(
        state.lastSpawnTick,
        "TrainStationExecution.lastSpawnTick",
      );
      const cluster = station === null ? null : callNullableObject(
        station,
        "getCluster",
      );
      return {
        unitID: objectID(state.unit, "TrainStationExecution.unit"),
        ownerPlayerID: objectIdentifier(
          callObject(state.unit, "owner"),
          "TrainStationExecution.unit.owner",
        ),
        stationID: station === null
          ? null
          : requiredInteger(station.id, "TrainStation.id"),
        stationTile: station === null
          ? null
          : callNonnegativeInteger(station, "tile"),
        clusterSize: cluster === null
          ? null
          : callNonnegativeInteger(cluster, "size"),
        spawnTrains: state.spawnTrains === true,
        lastSpawnTick,
        spawnCooldownTicks: cooldown,
        nextEligibleSpawnTick: lastSpawnTick + cooldown,
      };
    })
    .sort(byJSON));

  capture("trains", () => executions
    .filter((execution) =>
      execution instanceof TrainExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "TrainExecution", [
        "train",
        "cars",
        "player",
        "source",
        "destination",
        "currentRailroad",
        "currentTile",
        "speed",
        "spacing",
        "hasCargo",
        "_tradeStopsVisited",
      ]);
      const train = nullableObject(state.train, "TrainExecution.train");
      const source = executionInternals(
        state.source,
        "TrainExecution.source",
        ["id", "unit"],
      );
      const destination = executionInternals(
        state.destination,
        "TrainExecution.destination",
        ["id", "unit"],
      );
      const railroad = nullableObject(
        state.currentRailroad,
        "TrainExecution.currentRailroad",
      );
      const underlyingRailroad = railroad === null
        ? null
        : executionInternals(
          executionInternals(
            railroad,
            "TrainExecution.currentRailroad",
            ["railroad"],
          ).railroad,
          "TrainExecution.currentRailroad.railroad",
          ["id"],
        );
      const cars = requiredArray(state.cars, "TrainExecution.cars");
      return {
        unitID: train === null ? null : callNonnegativeInteger(train, "id"),
        ownerPlayerID: objectIdentifier(
          state.player,
          "TrainExecution.player",
        ),
        sourceStationID: requiredInteger(
          source.id,
          "TrainExecution.source.id",
        ),
        sourceUnitID: objectID(
          source.unit,
          "TrainExecution.source.unit",
        ),
        destinationStationID: requiredInteger(
          destination.id,
          "TrainExecution.destination.id",
        ),
        destinationUnitID: objectID(
          destination.unit,
          "TrainExecution.destination.unit",
        ),
        currentRailroadID: underlyingRailroad === null
          ? null
          : requiredInteger(
            underlyingRailroad.id,
            "TrainExecution.currentRailroad.railroad.id",
          ),
        currentRailOffset: requiredInteger(
          state.currentTile,
          "TrainExecution.currentTile",
        ),
        speed: requiredFiniteNumber(state.speed, "TrainExecution.speed"),
        spacing: requiredFiniteNumber(state.spacing, "TrainExecution.spacing"),
        hasCargo: requiredBoolean(
          state.hasCargo,
          "TrainExecution.hasCargo",
        ),
        tradeStopsVisited: requiredInteger(
          state._tradeStopsVisited,
          "TrainExecution._tradeStopsVisited",
        ),
        carUnitIDs: cars.map((car, index) =>
          objectID(car, `TrainExecution.cars[${index}]`)
        ).sort((left, right) => left - right),
      };
    })
    .sort(byJSON));

  capture("retreats", () => [
    ...executions
      .filter((execution) =>
        execution instanceof RetreatExecution && execution.isActive()
      )
      .map((execution) => {
        const state = executionInternals(execution, "RetreatExecution", [
          "player",
          "attackID",
          "startTick",
          "retreatOrdered",
        ]);
        const startTick = nullableFiniteNumber(state.startTick);
        return {
          kind: "attack" as const,
          ownerPlayerID: objectIdentifier(
            state.player,
            "RetreatExecution.player",
          ),
          attackID: requiredString(
            state.attackID,
            "RetreatExecution.attackID",
          ),
          startTick,
          executeAtTick: startTick === null ? null : startTick + 20,
          retreatOrdered: requiredBoolean(
            state.retreatOrdered,
            "RetreatExecution.retreatOrdered",
          ),
        };
      }),
    ...executions
      .filter((execution) =>
        execution instanceof BoatRetreatExecution && execution.isActive()
      )
      .map((execution) => {
        const state = executionInternals(execution, "BoatRetreatExecution", [
          "player",
          "unitID",
        ]);
        return {
          kind: "transport" as const,
          ownerPlayerID: objectIdentifier(
            state.player,
            "BoatRetreatExecution.player",
          ),
          unitID: requiredInteger(
            state.unitID,
            "BoatRetreatExecution.unitID",
          ),
        };
      }),
  ].sort(byJSON));

  capture("nukes", () => executions
    .filter((execution) =>
      execution instanceof NukeExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "NukeExecution", [
        "nuke",
        "nukeType",
        "player",
        "src",
        "dst",
        "speed",
        "waitTicks",
      ]);
      const nuke = nullableObject(state.nuke, "NukeExecution.nuke");
      return {
        unitID: nuke === null ? null : callNonnegativeInteger(nuke, "id"),
        ownerPlayerID: objectIdentifier(state.player, "NukeExecution.player"),
        nukeType: String(state.nukeType),
        sourceTile: nullableInteger(state.src),
        destinationTile: requiredInteger(state.dst, "NukeExecution.dst"),
        speed: requiredFiniteNumber(state.speed, "NukeExecution.speed"),
        waitTicks: requiredInteger(
          state.waitTicks,
          "NukeExecution.waitTicks",
        ),
        trajectoryIndex: nuke === null
          ? null
          : callNonnegativeInteger(nuke, "trajectoryIndex"),
        trajectoryLength: nuke === null
          ? null
          : callArray(nuke, "trajectory").length,
        targetable: nuke === null ? null : callBoolean(nuke, "isTargetable"),
        targetedBySAM: nuke === null
          ? null
          : callBoolean(nuke, "targetedBySAM"),
      };
    })
    .sort(byJSON));

  capture("samInterceptions", () => [
    ...executions
      .filter((execution) =>
        execution instanceof SAMLauncherExecution && execution.isActive()
      )
      .map((execution) => {
        const state = executionInternals(execution, "SAMLauncherExecution", [
          "player",
          "sam",
        ]);
        const sam = nullableObject(state.sam, "SAMLauncherExecution.sam");
        const targeting = nullableObject(
          state.targetingSystem,
          "SAMLauncherExecution.targetingSystem",
        );
        const plans = targeting === null
          ? []
          : [...requiredMap(
            executionInternals(
              targeting,
              "SAMTargetingSystem",
              ["precomputedNukes"],
            ).precomputedNukes,
            "SAMTargetingSystem.precomputedNukes",
          )].map(([targetUnitID, plan]) => {
            const interception = nullableObject(
              plan,
              "SAMTargetingSystem.precomputedNukes plan",
            );
            return {
              targetUnitID: requiredInteger(
                targetUnitID,
                "SAM interception targetUnitID",
              ),
              interceptionTile: interception === null
                ? null
                : requiredInteger(
                  interception.tile,
                  "SAM interception tile",
                ),
              interceptionTick: interception === null
                ? null
                : requiredInteger(
                  interception.tick,
                  "SAM interception tick",
                ),
              reachable: interception !== null,
            };
          }).sort(byJSON);
        return {
          kind: "launcher" as const,
          launcherUnitID: sam === null
            ? null
            : callNonnegativeInteger(sam, "id"),
          ownerPlayerID: objectIdentifier(
            state.player,
            "SAMLauncherExecution.player",
          ),
          plans,
        };
      }),
    ...executions
      .filter((execution) =>
        execution instanceof SAMMissileExecution && execution.isActive()
      )
      .map((execution) => {
        const state = executionInternals(execution, "SAMMissileExecution", [
          "SAMMissile",
          "ownerUnit",
          "_owner",
          "target",
          "targetTile",
          "speed",
          "pathFinder",
        ]);
        const missile = nullableObject(
          state.SAMMissile,
          "SAMMissileExecution.SAMMissile",
        );
        return {
          kind: "missile" as const,
          missileUnitID: missile === null
            ? null
            : callNonnegativeInteger(missile, "id"),
          launcherUnitID: objectID(
            state.ownerUnit,
            "SAMMissileExecution.ownerUnit",
          ),
          ownerPlayerID: objectIdentifier(
            state._owner,
            "SAMMissileExecution._owner",
          ),
          targetUnitID: objectID(
            state.target,
            "SAMMissileExecution.target",
          ),
          targetTile: requiredInteger(
            state.targetTile,
            "SAMMissileExecution.targetTile",
          ),
          speed: requiredFiniteNumber(
            state.speed,
            "SAMMissileExecution.speed",
          ),
          progress: nullablePathProgress(state.pathFinder),
        };
      }),
  ].sort(byJSON));

  capture("warships", () => executions
    .filter((execution) =>
      execution instanceof WarshipExecution && execution.isActive()
    )
    .map((execution) => {
      const state = executionInternals(execution, "WarshipExecution", [
        "lastShellAttack",
        "lastManualMoveTickRetreatDisabled",
        "lastObservedPatrolTile",
        "activeHealingRemainder",
        "alreadySentShell",
        "pathfinder",
      ]);
      const warship = nullableObject(state.warship, "WarshipExecution.warship");
      const unitState = warship === null
        ? null
        : nullableObject(
          executionInternals(warship, "Warship unit", ["_warshipState"])
            ._warshipState,
          "Warship unit._warshipState",
        );
      if (unitState !== null) {
        executionInternals(unitState, "Warship unit._warshipState", [
          "state",
          "patrolTile",
          "lastCombatTick",
        ]);
      }
      return {
        unitID: warship === null ? null : callNonnegativeInteger(warship, "id"),
        ownerPlayerID: warship === null
          ? null
          : objectIdentifier(callObject(warship, "owner"), "Warship owner"),
        tile: warship === null ? null : callNonnegativeInteger(warship, "tile"),
        health: warship === null ? null : callFiniteNumber(warship, "health"),
        state: unitState === null ? null : String(unitState.state),
        patrolTile: unitState === null ? null : nullableInteger(unitState.patrolTile),
        retreatPortTile: unitState === null
          ? null
          : nullableInteger(unitState.retreatPort),
        targetUnitID: warship === null
          ? null
          : nullableObjectID(callNullableObject(warship, "targetUnit"), "Warship target"),
        targetTile: warship === null
          ? null
          : nullableInteger(callUnknown(warship, "targetTile")),
        lastCombatTick: unitState === null
          ? null
          : nullableFiniteNumber(unitState.lastCombatTick),
        lastShellAttackTick: requiredFiniteNumber(
          state.lastShellAttack,
          "WarshipExecution.lastShellAttack",
        ),
        lastManualMoveTick: requiredFiniteNumber(
          state.lastManualMoveTickRetreatDisabled,
          "WarshipExecution.lastManualMoveTickRetreatDisabled",
        ),
        lastObservedPatrolTile: nullableInteger(state.lastObservedPatrolTile),
        activeHealingRemainder: requiredFiniteNumber(
          state.activeHealingRemainder,
          "WarshipExecution.activeHealingRemainder",
        ),
        alreadySentShellTargetUnitIDs: [...requiredSet(
          state.alreadySentShell,
          "WarshipExecution.alreadySentShell",
        )].map((unit) =>
          objectID(unit, "WarshipExecution.alreadySentShell unit")
        ).sort((left, right) => left - right),
        path: nullableWaterPathState(state.pathfinder),
      };
    })
    .sort(byJSON));

  capture("diplomacy", () => {
    const requests = new Set(
      game.allPlayers().flatMap((player) => player.outgoingAllianceRequests()),
    );
    const duration = game.config().allianceRequestDuration();
    return {
      alliances: game.alliances().map((alliance) => ({
        allianceID: alliance.id(),
        requestorPlayerID: String(alliance.requestor().id()),
        recipientPlayerID: String(alliance.recipient().id()),
        createdAtTick: alliance.createdAt(),
        expiresAtTick: alliance.expiresAt(),
        requestorAgreedToExtend: alliance.agreedToExtend(alliance.requestor()),
        recipientAgreedToExtend: alliance.agreedToExtend(alliance.recipient()),
      })).sort(byJSON),
      requests: [...requests].map((request) => ({
        requestorPlayerID: String(request.requestor().id()),
        recipientPlayerID: String(request.recipient().id()),
        createdAtTick: request.createdAt(),
        rejectAfterTick: request.createdAt() + duration,
        status: request.status(),
      })).sort(byJSON),
    };
  });

  capture("playerTiming", () => {
    const playerExecutions = new Map(executions
      .filter((execution) =>
        execution instanceof PlayerExecution && execution.isActive()
      )
      .map((execution) => {
        const state = executionInternals(execution, "PlayerExecution", [
          "player",
          "lastCalc",
          "ticksPerClusterCalc",
        ]);
        return [
          objectIdentifier(state.player, "PlayerExecution.player"),
          state,
        ] as const;
      }));
    return game.allPlayers().filter((player) => player.isPlayer())
      .map((player) => {
        const state = executionInternals(player, "PlayerImpl", [
          "_lastTileChange",
          "markedTraitorTick",
          "lastDeleteUnitTick",
          "lastEmbargoAllTick",
          "targets_",
          "sentDonations",
          "outgoingEmojis_",
          "pastOutgoingAllianceRequests",
        ]);
        const playerID = String(player.id());
        const playerExecution = playerExecutions.get(playerID);
        return {
          playerID,
          lastTileChangeTick: requiredFiniteNumber(
            state._lastTileChange,
            "PlayerImpl._lastTileChange",
          ),
          markedTraitorTick: requiredFiniteNumber(
            state.markedTraitorTick,
            "PlayerImpl.markedTraitorTick",
          ),
          lastDeleteUnitTick: requiredFiniteNumber(
            state.lastDeleteUnitTick,
            "PlayerImpl.lastDeleteUnitTick",
          ),
          lastEmbargoAllTick: requiredFiniteNumber(
            state.lastEmbargoAllTick,
            "PlayerImpl.lastEmbargoAllTick",
          ),
          lastClusterCalculationTick: playerExecution === undefined
            ? null
            : requiredFiniteNumber(
              playerExecution.lastCalc,
              "PlayerExecution.lastCalc",
            ),
          clusterCalculationPeriod: playerExecution === undefined
            ? null
            : requiredInteger(
              playerExecution.ticksPerClusterCalc,
              "PlayerExecution.ticksPerClusterCalc",
            ),
          targets: requiredArray(state.targets_, "PlayerImpl.targets_")
            .map((entry) => {
              const target = executionInternals(entry, "Player target", [
                "target",
                "tick",
              ]);
              return {
                targetPlayerID: objectIdentifier(
                  target.target,
                  "Player target.target",
                ),
                tick: requiredFiniteNumber(target.tick, "Player target.tick"),
              };
            }).sort(byJSON),
          lastDonationTicks: latestTicksByRecipient(
            requiredArray(state.sentDonations, "PlayerImpl.sentDonations"),
            "Player donation",
          ),
          lastEmojiTicks: latestEmojiTicks(
            requiredArray(state.outgoingEmojis_, "PlayerImpl.outgoingEmojis_"),
          ),
          lastAllianceRequestTicks: latestAllianceRequestTicks(
            requiredArray(
              state.pastOutgoingAllianceRequests,
              "PlayerImpl.pastOutgoingAllianceRequests",
            ),
          ),
        };
      }).sort(byJSON);
  });

  capture("staggerCounters", () => {
    // These counters are process-static in the pinned engine. The worker owns
    // one mirror, so a direct read is the exact next-allocation state without
    // mutating the counter or exposing either pathfinder's PRNG.
    const transports = executionInternals(
      TransportShipExecution,
      "TransportShipExecution constructor",
      ["_staggerCounter"],
    );
    const tradeShips = executionInternals(
      TradeShipExecution,
      "TradeShipExecution constructor",
      ["_staggerCounter"],
    );
    return {
      transportShips: requiredInteger(
        transports._staggerCounter,
        "TransportShipExecution._staggerCounter",
      ),
      tradeShips: requiredInteger(
        tradeShips._staggerCounter,
        "TradeShipExecution._staggerCounter",
      ),
    };
  });

  return result;
}

function executionInternals(
  value: unknown,
  label: string,
  fields: readonly string[],
): RuntimeRecord {
  const record = asRecord(value) ??
    (typeof value === "function" ? value as unknown as RuntimeRecord : null);
  if (record === null) throw new Error(`${label} is unavailable`);
  for (const field of fields) {
    if (!(field in record)) throw new Error(`${label}.${field} is unavailable`);
  }
  return record;
}

function nullableObject(value: unknown, label: string): RuntimeRecord | null {
  if (value === null || value === undefined) return null;
  return executionInternals(value, label, []);
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
  return value;
}

function requiredMap(value: unknown, label: string): Map<unknown, unknown> {
  if (!(value instanceof Map)) throw new Error(`${label} is not a map`);
  return value;
}

function requiredSet(value: unknown, label: string): Set<unknown> {
  if (!(value instanceof Set)) throw new Error(`${label} is not a set`);
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} is not boolean`);
  return value;
}

function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is not a finite number`);
  }
  return value;
}

function nullableFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredInteger(value: unknown, label: string): number {
  const result = requiredFiniteNumber(value, label);
  if (!Number.isInteger(result)) throw new Error(`${label} is not an integer`);
  return result;
}

function callUnknown(
  value: unknown,
  method: string,
  ...args: unknown[]
): unknown {
  const record = executionInternals(value, "execution object", [method]);
  const fn = record[method];
  if (typeof fn !== "function") throw new Error(`${method} is not callable`);
  return fn.apply(value, args);
}

function callObject(value: unknown, method: string): RuntimeRecord {
  return executionInternals(callUnknown(value, method), `${method} result`, []);
}

function callNullableObject(
  value: unknown,
  method: string,
): RuntimeRecord | null {
  return nullableObject(callUnknown(value, method), `${method} result`);
}

function callArray(value: unknown, method: string): unknown[] {
  return requiredArray(callUnknown(value, method), `${method} result`);
}

function callFiniteNumber(value: unknown, method: string): number {
  return requiredFiniteNumber(callUnknown(value, method), `${method} result`);
}

function callNonnegativeInteger(value: unknown, method: string): number {
  const result = requiredInteger(callUnknown(value, method), `${method} result`);
  if (result < 0) throw new Error(`${method} result is negative`);
  return result;
}

function callString(value: unknown, method: string): string {
  return requiredString(callUnknown(value, method), `${method} result`);
}

function callBoolean(value: unknown, method: string): boolean {
  return requiredBoolean(callUnknown(value, method), `${method} result`);
}

function objectIdentifier(value: unknown, label: string): string {
  const id = callUnknown(value, "id");
  if (id === null || id === undefined) throw new Error(`${label}.id is null`);
  return String(id);
}

function nullableObjectIdentifier(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return identifier(callUnknown(value, "id"));
}

function objectID(value: unknown, label: string): number {
  if (value === null || value === undefined) {
    throw new Error(`${label} is unavailable`);
  }
  return callNonnegativeInteger(value, "id");
}

function nullableObjectID(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return objectID(value, label);
}

function callTransportRetreating(boat: RuntimeRecord): boolean {
  const state = callObject(boat, "transportShipState");
  return requiredBoolean(
    state.isRetreating,
    "transportShipState.isRetreating",
  );
}

function nullableWaterPathState(value: unknown): WaterPathExecutionState | null {
  if (value === null || value === undefined) return null;
  const state = executionInternals(value, "WaterPathFinder", [
    "_waterGraphVersion",
    "_pendingVersion",
    "_stagger",
    "_staggerCountdown",
    "inner",
  ]);
  return {
    graphVersion: requiredInteger(
      state._waterGraphVersion,
      "WaterPathFinder._waterGraphVersion",
    ),
    pendingGraphVersion: requiredInteger(
      state._pendingVersion,
      "WaterPathFinder._pendingVersion",
    ),
    stagger: requiredInteger(state._stagger, "WaterPathFinder._stagger"),
    staggerCountdown: requiredInteger(
      state._staggerCountdown,
      "WaterPathFinder._staggerCountdown",
    ),
    progress: nullablePathProgress(state.inner),
  };
}

function nullablePathProgress(value: unknown): ExecutionPathProgress | null {
  if (value === null || value === undefined) return null;
  const state = executionInternals(value, "PathFinderStepper", [
    "path",
    "pathIndex",
  ]);
  if (state.path === null) return null;
  const pathLength = requiredArray(
    state.path,
    "PathFinderStepper.path",
  ).length;
  const pathIndex = requiredInteger(
    state.pathIndex,
    "PathFinderStepper.pathIndex",
  );
  return {
    pathIndex,
    pathLength,
    remainingSteps: Math.max(0, pathLength - pathIndex),
  };
}

function latestTicksByRecipient(
  values: unknown[],
  label: string,
): Array<{ recipientPlayerID: string; tick: number }> {
  const latest = new Map<string, number>();
  for (const value of values) {
    const entry = executionInternals(value, label, ["recipient", "tick"]);
    const recipientPlayerID = objectIdentifier(
      entry.recipient,
      `${label}.recipient`,
    );
    const tick = requiredFiniteNumber(entry.tick, `${label}.tick`);
    latest.set(recipientPlayerID, Math.max(latest.get(recipientPlayerID) ?? -1, tick));
  }
  return [...latest].map(([recipientPlayerID, tick]) => ({
    recipientPlayerID,
    tick,
  })).sort(byJSON);
}

function latestEmojiTicks(
  values: unknown[],
): Array<{ recipientSmallID: number | string; tick: number }> {
  const latest = new Map<number | string, number>();
  for (const value of values) {
    const entry = executionInternals(value, "Player emoji", [
      "recipientID",
      "createdAt",
    ]);
    if (
      typeof entry.recipientID !== "number" &&
      typeof entry.recipientID !== "string"
    ) {
      throw new Error("Player emoji.recipientID is invalid");
    }
    const tick = requiredFiniteNumber(entry.createdAt, "Player emoji.createdAt");
    latest.set(
      entry.recipientID,
      Math.max(latest.get(entry.recipientID) ?? -1, tick),
    );
  }
  return [...latest].map(([recipientSmallID, tick]) => ({
    recipientSmallID,
    tick,
  })).sort(byJSON);
}

function latestAllianceRequestTicks(
  values: unknown[],
): Array<{ recipientPlayerID: string; tick: number }> {
  const latest = new Map<string, number>();
  for (const request of values) {
    const recipientPlayerID = objectIdentifier(
      callObject(request, "recipient"),
      "AllianceRequest.recipient",
    );
    const tick = callFiniteNumber(request, "createdAt");
    latest.set(
      recipientPlayerID,
      Math.max(latest.get(recipientPlayerID) ?? -1, tick),
    );
  }
  return [...latest].map(([recipientPlayerID, tick]) => ({
    recipientPlayerID,
    tick,
  })).sort(byJSON);
}

function captureSpawnState(game: Game): SpawnStateSidecar {
  const units = game.units();
  // Availability basis: the canonical Game/Unit APIs expose current ports,
  // trade ships, and trains, but not PortExecution's private spawn-rejection
  // pity or TrainStationExecution's private lastSpawnTick. They are omitted
  // here rather than reconstructed or estimated.
  return {
    schemaVersion: 1,
    tick: game.ticks(),
    ports: units.filter((unit) => unit.type() === UnitType.Port)
      .map(spawnUnit)
      .sort(byUnitID),
    tradeShips: units.filter((unit) => unit.type() === UnitType.TradeShip)
      .map((unit) => ({
        ...spawnUnit(unit),
        targetUnitID: unit.targetUnit()?.id() ?? null,
        targetOwnerPlayerID: identifier(unit.targetUnit()?.owner().id()),
      }))
      .sort(byUnitID),
    trains: units.filter((unit) => unit.type() === UnitType.Train)
      .map((unit) => ({
        ...spawnUnit(unit),
        trainType: unit.trainType() ?? null,
        loaded: unit.isLoaded() ?? null,
        reachedTarget: unit.reachedTarget(),
        targetUnitID: unit.targetUnit()?.id() ?? null,
      }))
      .sort(byUnitID),
  };
}

function summarizeRailroad(
  id: number,
  tiles: number[],
): RailroadSummary {
  return {
    id,
    startTile: tiles[0] ?? null,
    endTile: tiles.at(-1) ?? null,
    tileCount: tiles.length,
  };
}

function spawnUnit(unit: Unit): SpawnUnitState {
  return {
    unitID: unit.id(),
    ownerPlayerID: identifier(unit.owner().id()),
    tile: unit.tile(),
    level: unit.level(),
    active: unit.isActive(),
    underConstruction: unit.isUnderConstruction(),
    hasTrainStation: unit.hasTrainStation(),
  };
}

function byUnitID(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return Number(left.unitID) - Number(right.unitID);
}

function encodeIntegerRuns(values: number[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  for (const value of values) {
    const last = runs.at(-1);
    if (last !== undefined && last[0] === value) {
      last[1]++;
    } else {
      runs.push([value, 1]);
    }
  }
  return runs;
}

function terminalOwner(
  game: Game,
  tile: number,
  ownerPlayerID: string | null,
): Pick<TransportLifecycleEvent, "terminalOwnerClass" | "terminalOwnerSmallID"> {
  if (!game.isValidRef(tile)) {
    return { terminalOwnerClass: "neutral", terminalOwnerSmallID: null };
  }
  const terminal = game.owner(tile);
  if (!terminal.isPlayer()) {
    return { terminalOwnerClass: "neutral", terminalOwnerSmallID: null };
  }
  const owner = playerByID(game, ownerPlayerID);
  return {
    terminalOwnerClass: owner !== null && terminal.id() === owner.id()
      ? "self"
      : owner !== null && owner.isFriendly(terminal)
        ? "friendly"
        : "hostile",
    terminalOwnerSmallID: terminal.smallID(),
  };
}

function boatIntentContexts(
  game: Game,
  intents: Turn["intents"],
): BoatIntentContext[] {
  return intents.flatMap((intent) => {
    if (intent.type !== "boat") return [];
    const player = game.playerByClientID(intent.clientID);
    return [{
      clientID: intent.clientID,
      ownerPlayerID: identifier(player?.id()),
      requestedTile: intent.dst,
      targetPlayerID: game.isValidRef(intent.dst)
        ? identifier(game.owner(intent.dst).id())
        : null,
      troops: intent.troops,
    }];
  });
}

function transportRecord(
  game: Game,
  unit: Unit,
): TrackedTransport {
  const targetTile = nullableInteger(unit.targetTile());
  return {
    unitID: unit.id(),
    ownerPlayerID: identifier(unit.owner().id()),
    targetPlayerID: targetTile !== null && game.isValidRef(targetTile)
      ? identifier(game.owner(targetTile).id())
      : null,
    sourceTile: unit.tile(),
    targetTile,
    troops: unit.troops(),
    retreating: unit.transportShipState().isRetreating,
  };
}

function planEvent(
  plan: GridPathPlan,
  unit: Unit,
  tracked: TrackedTransport,
  tick: number,
): Omit<TransportLifecycleEvent, "eventID"> {
  return {
    type: "plan_updated",
    tick,
    unitID: tracked.unitID,
    ownerPlayerID: tracked.ownerPlayerID,
    targetPlayerID: tracked.targetPlayerID,
    sourceTile: tracked.sourceTile,
    currentTile: unit.tile(),
    targetTile: nullableInteger(unit.targetTile()),
    troops: unit.troops(),
    planID: plan.planId,
    pathLength: plan.path.length,
    ticksPerStep: plan.ticksPerStep,
    projectedCompletionTick:
      plan.startTick +
      Math.max(0, plan.path.length - 1) * Math.max(1, plan.ticksPerStep),
  };
}

function playerByID(
  game: Game,
  playerID: string | null,
): ReturnType<Game["player"]> | null {
  if (playerID === null) return null;
  try {
    const player = game.player(playerID);
    return player.isPlayer() ? player : null;
  } catch {
    return null;
  }
}

function identifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value);
  return result === "" || result === "0" ? null : result;
}

function nullableInteger(value: unknown): number | null {
  const result = Number(value);
  return Number.isInteger(result) && result >= 0 ? result : null;
}

export async function replayGameRecord(value: unknown, options: { mapLoader?: GameMapLoader; mapRoot?: string } = {}): Promise<GameState> {
  const record = asRecord(value);
  const info = asRecord(record?.info);
  if (record === null || info === null) throw new Error("invalid game record");
  const loader = options.mapLoader ?? new StaticMapLoader(options.mapRoot ?? defaultMapRoot());
  const runner = await withSilentEngine(() => createGameRunner(info as unknown as GameStartInfo, undefined, loader, () => undefined));
  const turns = new Map(records(record.turns).map((turn) => [integer(turn.turnNumber), turn]));
  const totalTurns = integer(info.num_turns) ?? Math.max(0, ...[...turns.keys()].filter((entry): entry is number => entry !== null)) + 1;
  for (let turnNumber = 0; turnNumber < totalTurns; turnNumber++) {
    const source = turns.get(turnNumber);
    runner.addTurn({
      turnNumber,
      intents: Array.isArray(source?.intents) ? source.intents as Turn["intents"] : [],
    });
    const executed = await withSilentEngine(() => runner.executeNextTick());
    if (!executed) throw new Error(`official replay rejected turn ${turnNumber}`);
  }
  return captureGameState(runner.game, "exact");
}

export function captureGameState(game: Game, status: MirrorStatus = "exact"): GameState {
  const tileState = new Uint16Array(game.width() * game.height());
  for (let tile = 0; tile < tileState.length; tile++) tileState[tile] = game.tileState(tile);
  const canonicalPlayers = game.allPlayers().filter((player) => player.isPlayer());
  const players = canonicalPlayers.map((player) => ({
    clientID: player.clientID(),
    playerID: player.id(),
    smallID: player.smallID(),
    name: player.name(),
    type: player.type(),
    isAlive: player.isAlive(),
    isDisconnected: player.isDisconnected(),
    isTraitor: player.isTraitor(),
    hasSpawned: player.hasSpawned(),
    spawnTile: player.spawnTile() ?? null,
    tilesOwned: player.numTilesOwned(),
    borderTiles: player.borderTiles().size,
    sharedBorderPlayerIDs: canonicalPlayers
      .filter((other) => other.id() !== player.id() && player.sharesBorderWith(other))
      .map((other) => other.id())
      .sort(),
    attackablePlayerIDs: canonicalPlayers
      .filter((other) => other.id() !== player.id() && player.sharesBorderWith(other) && player.canAttackPlayer(other))
      .map((other) => other.id())
      .sort(),
    troops: player.troops(),
    maxTroops: game.config().maxTroops(player),
    troopRatio: player.troops() / Math.max(1, game.config().maxTroops(player)),
    landShare: player.numTilesOwned() / Math.max(1, game.numLandTiles()),
    dominationShare: player.numTilesOwned() / Math.max(1, game.numLandTiles() - game.numTilesWithFallout()),
    gold: player.gold().toString(),
    targets: player.targets().map((other) => other.id()).sort(),
    embargoes: player.getEmbargoes().map((entry) => ({
      targetPlayerID: entry.target.id(),
      createdAt: entry.createdAt,
      temporary: entry.isTemporary,
    })).sort(byJSON),
    relations: canonicalPlayers.filter((other) => other.id() !== player.id()).map((other) => ({
      playerID: other.id(),
      relation: player.relation(other),
    })).sort(byJSON),
    incomingAllianceRequests: player.incomingAllianceRequests().map((entry) => entry.requestor().id()).sort(),
    outgoingAllianceRequests: player.outgoingAllianceRequests().map((entry) => entry.recipient().id()).sort(),
    betrayals: player.betrayals(),
  })).sort((left, right) => left.smallID - right.smallID);
  const units = game.units().map((unit) => jsonSafe(unit.toUpdate()) as Record<string, unknown>)
    .sort((left, right) => Number(left.id) - Number(right.id));
  const attacks = canonicalPlayers.flatMap((player) => player.outgoingAttacks().map((attack) => ({
    id: attack.id(),
    attackerPlayerID: attack.attacker().id(),
    targetPlayerID: attack.target().id(),
    troops: attack.troops(),
    retreating: attack.retreating(),
    retreated: attack.retreated(),
    sourceTile: attack.sourceTile(),
    borderSize: attack.borderSize(),
  }))).sort(byJSON);
  const alliances = game.alliances().map((alliance) => ({
    id: alliance.id(),
    requestorPlayerID: alliance.requestor().id(),
    recipientPlayerID: alliance.recipient().id(),
    createdAt: alliance.createdAt(),
    expiresAt: alliance.expiresAt(),
  })).sort(byJSON);
  const winner = game.getWinner();
  const state = {
    schemaVersion: 1 as const,
    tick: game.ticks(),
    phase: (winner ? "finished" : game.inSpawnPhase() ? "spawn" : "active") as GameState["phase"],
    map: {
      name: String(game.config().gameConfig().gameMap),
      size: String(game.config().gameConfig().gameMapSize),
      width: game.width(),
      height: game.height(),
      landTiles: game.numLandTiles(),
      falloutTiles: game.numTilesWithFallout(),
    },
    players,
    units,
    attacks,
    diplomacy: { alliances },
    winner: winner === null ? null : typeof winner !== "string" && winner.isPlayer()
      ? { kind: "player" as const, id: winner.id() }
      : { kind: "team" as const, id: winner },
    tileState,
    rulesRef: ENGINE_IDENTITY,
    source: { mode: "exact" as const, status, hash: "" },
  };
  state.source.hash = canonicalStateHash(state);
  return state;
}

export function compareStates(left: GameState, right: GameState): ParityResult {
  const checked = ["tick", "map", "players", "units", "attacks", "diplomacy", "winner", "tileState"];
  if (left.source.hash === right.source.hash) return { ok: true, checked, mismatches: [] };
  const mismatches: ParityResult["mismatches"] = [];
  for (const key of checked.filter((entry) => entry !== "tileState")) {
    const a = jsonSafe((left as unknown as Record<string, unknown>)[key]);
    const b = jsonSafe((right as unknown as Record<string, unknown>)[key]);
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      mismatches.push({ path: key, expected: mismatchValue(b), actual: mismatchValue(a) });
    }
  }
  let tileMismatchCount = 0;
  const examples: Array<{ tile: number; expected: number; actual: number }> = [];
  const length = Math.max(left.tileState.length, right.tileState.length);
  for (let tile = 0; tile < length; tile++) {
    if (left.tileState[tile] === right.tileState[tile]) continue;
    tileMismatchCount++;
    if (examples.length < 100) examples.push({ tile, expected: right.tileState[tile], actual: left.tileState[tile] });
  }
  if (tileMismatchCount) mismatches.push({ path: "tileState", expected: { mismatchCount: tileMismatchCount, examples }, actual: { mismatchCount: tileMismatchCount, examples } });
  return { ok: mismatches.length === 0, checked, mismatches };
}

function stateRef(
  state: GameState | null,
): { tick: number; status: MirrorStatus; hash: string } | null {
  if (state === null) return null;
  return { tick: state.tick, status: state.source.status, hash: state.source.hash };
}

function mismatchValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const json = JSON.stringify(value);
  return {
    count: Array.isArray(value) ? value.length : Object.keys(value as Record<string, unknown>).length,
    hash: `sha256:${createHash("sha256").update(json).digest("hex")}`,
  };
}

export function encodeStateJSON(state: GameState): Record<string, unknown> {
  return {
    ...state,
    tileState: {
      encoding: "uint16-rle",
      length: state.tileState.length,
      runs: encodeRuns(state.tileState),
    },
  };
}

function comparePublicSnapshot(state: GameState, global: Record<string, unknown>, snapshot: Record<string, unknown>): ParityResult {
  const mismatches: ParityResult["mismatches"] = [];
  compareValue(mismatches, "tick", state.tick, integer(snapshot.tick));
  const map = asRecord(global.map);
  if (map) {
    compareValue(mismatches, "map.width", state.map.width, integer(map.width));
    compareValue(mismatches, "map.height", state.map.height, integer(map.height));
    compareValue(mismatches, "map.name", state.map.name, String(map.gameMap ?? ""));
    compareValue(mismatches, "map.size", state.map.size, String(map.gameMapSize ?? ""));
  }
  for (const publicPlayer of records(snapshot.players)) {
    const player = state.players.find((entry) => entry.clientID === publicPlayer.clientID);
    if (!player) {
      mismatches.push({ path: `players.${String(publicPlayer.clientID)}`, expected: "present", actual: null });
      continue;
    }
    for (const [name, publicName] of [["playerID", "playerID"], ["isAlive", "isAlive"], ["hasSpawned", "hasSpawned"], ["tilesOwned", "tilesOwned"], ["troops", "troops"], ["gold", "gold"]] as const) {
      compareValue(mismatches, `players.${String(player.playerID)}.${name}`, player[name], publicPlayer[publicName]);
    }
    for (const tile of numbers(publicPlayer.tiles)) {
      const expectedOwner = Number(player.smallID);
      const actualOwner = state.tileState[tile] & 0xfff;
      if (actualOwner !== expectedOwner) mismatches.push({ path: `tiles.${tile}.owner`, expected: expectedOwner, actual: actualOwner });
    }
    const expectedUnits = records(publicPlayer.units).map((unit) => `${String(unit.type)}:${Number(unit.tile)}`).sort();
    const actualUnits = state.units.filter((unit) => Number(unit.ownerID) === Number(player.smallID) && ["City", "Factory", "Defense Post", "Port"].includes(String(unit.unitType)))
      .map((unit) => `${String(unit.unitType)}:${Number(unit.pos)}`).sort();
    if (JSON.stringify(expectedUnits) !== JSON.stringify(actualUnits)) {
      mismatches.push({ path: `players.${String(player.playerID)}.publicUnits`, expected: expectedUnits, actual: actualUnits });
    }
  }
  return { ok: mismatches.length === 0, checked: ["tick", "map", "players", "sampledOwnership", "publicUnits"], mismatches };
}

function buildGameStartInfo(config: Record<string, unknown>, players: Record<string, unknown>[]): GameStartInfo {
  return {
    gameID: "COWRLD01",
    lobbyCreatedAt: 0,
    config: {
      gameMap: enumValue(GameMapType, config.map),
      gameMapSize: enumValue(GameMapSize, config.map_size),
      gameMode: GameMode.FFA,
      gameType: GameType.Private,
      difficulty: enumValue(Difficulty, config.difficulty),
      nations: "disabled",
      donateGold: true,
      donateTroops: true,
      bots: 0,
      infiniteGold: false,
      infiniteTroops: false,
      instantBuild: false,
      randomSpawn: false,
      disabledUnits: [],
      startingGold: 200000,
      maxPlayers: integer(config.player_count) ?? players.length,
    },
    players: players.map((player) => ({
      clientID: String(player.clientID),
      username: String(player.username),
      clanTag: null,
      isLobbyCreator: false,
    })),
  };
}

class StaticMapLoader implements GameMapLoader {
  constructor(private readonly root: string) {}
  getMapData(map: GameMapType) {
    const directory = join(this.root, String(map).toLowerCase().replace(/\s+/g, ""));
    return {
      mapBin: () => readFile(join(directory, "map.bin")),
      map4xBin: () => readFile(join(directory, "map4x.bin")),
      map16xBin: () => readFile(join(directory, "map16x.bin")),
      manifest: async () => JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")),
      webpPath: join(directory, "thumbnail.webp"),
    };
  }
}

export function canonicalStateHash(state: Omit<GameState, "source"> & { source: GameState["source"] }): string {
  const hash = createHash("sha256");
  const { tileState, source, ...summary } = state;
  hash.update(stableJSON(summary));
  hash.update(Buffer.from(tileState.buffer, tileState.byteOffset, tileState.byteLength));
  return `sha256:${hash.digest("hex")}`;
}

function stableJSON(value: unknown): string {
  return JSON.stringify(sortValue(jsonSafe(value)));
}
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortValue(entry)]));
  return value;
}
function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) {
    return Number(value.toPrecision(HASH_SIGNIFICANT_DIGITS));
  }
  if (value instanceof Set) return [...value].map(jsonSafe).sort(byJSON);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, jsonSafe(entry)]));
  return value;
}
function encodeRuns(values: Uint16Array): number[][] {
  if (values.length === 0) return [];
  const runs: number[][] = [];
  let value = values[0];
  let length = 1;
  for (let index = 1; index < values.length; index++) {
    if (values[index] === value) length++;
    else { runs.push([value, length]); value = values[index]; length = 1; }
  }
  runs.push([value, length]);
  return runs;
}
function compareValue(mismatches: ParityResult["mismatches"], path: string, actual: unknown, expected: unknown): void {
  if (String(actual) !== String(expected)) mismatches.push({ path, expected, actual });
}
function rememberIdentity(map: Map<string, string>, key: string | null, clientID: string, field: string): void {
  if (key === null) return;
  const known = map.get(key);
  if (known !== undefined && known !== clientID) {
    throw new Error(`roster ${field} ${key} changed client from ${known} to ${clientID}`);
  }
  map.set(key, clientID);
}
function nonempty(value: unknown): string | null {
  const result = String(value ?? "").trim();
  return result ? result : null;
}
function deriveTerrainByteLayout(): Readonly<TerrainByteLayout> {
  const bitCount = Uint8Array.BYTES_PER_ELEMENT * 8;
  const maximumByte = (2 ** bitCount) - 1;
  const bitMasks = Array.from({ length: bitCount }, (_, bit) => 2 ** bit);
  const probe = (terrainByte: number): GameMapImpl =>
    new GameMapImpl(1, 1, Uint8Array.of(terrainByte), 0);
  const predicateMask = (
    predicate: (map: GameMapImpl) => boolean,
  ): number => bitMasks.reduce(
    (mask, bitMask) => predicate(probe(bitMask)) ? mask | bitMask : mask,
    0,
  );

  const landMask = predicateMask((map) => map.isLand(0));
  const oceanMask = predicateMask((map) => map.isOcean(0));
  const shorelineMask = predicateMask((map) => map.isShoreline(0));
  const magnitudeMask = probe(maximumByte).magnitude(0);
  const landMagnitudeThresholds: number[] = [];
  const landTerrainTypes: TerrainType[] = [];
  let previousType: TerrainType | null = null;
  for (let magnitude = 0; magnitude <= magnitudeMask; magnitude++) {
    const terrainType = probe(landMask | magnitude).terrainType(0);
    if (terrainType === previousType) continue;
    if (previousType !== null) landMagnitudeThresholds.push(magnitude);
    landTerrainTypes.push(terrainType);
    previousType = terrainType;
  }
  const waterTerrainTypes = [
    probe(0).terrainType(0),
    probe(oceanMask).terrainType(0),
  ];
  const typeLegend = [...landTerrainTypes, ...waterTerrainTypes].map(
    (terrainType) => String(TerrainType[terrainType]).toLowerCase(),
  );

  return Object.freeze({
    magnitudeMask,
    landMask,
    oceanMask,
    shorelineMask,
    landMagnitudeThresholds: Object.freeze(landMagnitudeThresholds),
    typeLegend: Object.freeze(typeLegend),
  });
}
function defaultMapRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), "maps"); }
function enumValue<T extends Record<string, string>>(values: T, value: unknown): T[keyof T] {
  const selected = Object.values(values).find((entry) => entry.toLowerCase() === String(value).toLowerCase());
  if (!selected) throw new Error(`unsupported enum value ${String(value)}`);
  return selected as T[keyof T];
}
function asRecord(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(asRecord).filter((entry): entry is Record<string, unknown> => entry !== null) : []; }
function numbers(value: unknown): number[] { return Array.isArray(value) ? value.map(Number).filter(Number.isInteger) : []; }
function integer(value: unknown): number | null { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : null; }
function byJSON(left: unknown, right: unknown): number { return JSON.stringify(left).localeCompare(JSON.stringify(right)); }

async function withSilentEngine<T>(operation: () => T | Promise<T>): Promise<T> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => undefined;
  console.warn = () => undefined;
  console.error = () => undefined;
  try {
    return await operation();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

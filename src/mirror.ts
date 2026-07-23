import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createGameRunner, type GameRunner } from "../vendor/proxywar/src/core/GameRunner.ts";
import {
  Difficulty,
  GameMapSize,
  GameMapType,
  GameMode,
  GameType,
  UnitType,
  type Game,
  type Unit,
} from "../vendor/proxywar/src/core/game/Game.ts";
import type { GameMapLoader } from "../vendor/proxywar/src/core/game/GameMapLoader.ts";
import type {
  ErrorUpdate,
  GameUpdateViewData,
} from "../vendor/proxywar/src/core/game/GameUpdates.ts";
import {
  unpackMotionPlans,
  type GridPathPlan,
} from "../vendor/proxywar/src/core/game/MotionPlans.ts";
import type { GameStartInfo, Intent, Turn } from "../vendor/proxywar/src/core/Schemas.ts";

process.env.GAME_ENV ??= "dev";

export const ENGINE_IDENTITY = Object.freeze({
  coworldID: "cow_5d275752-ff30-4f5c-a1c1-6db56b518ef2",
  coworldVersion: "0.1.11",
  proxyWarCommit: "84bb064ad199f1e14f0cf45046395bb95c7ce2fe",
  gameImage: "public.ecr.aws/q5f4m8t9/cogames@sha256:71341d0c0b701dc13f0e8afc45b05c2fed94e8cdad8579c0d4b0745de9441d70",
});

const HASH_SIGNIFICANT_DIGITS = 11;

export type MirrorStatus = "bootstrapping" | "exact" | "lagging" | "diverged" | "unavailable";

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
  rulesRef: typeof ENGINE_IDENTITY;
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
};

export type TransportLifecycleBatch = {
  schemaVersion: 1;
  fromTick: number;
  toTick: number;
  events: TransportLifecycleEvent[];
};

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
  private latestTransportBatch: TransportLifecycleBatch = emptyTransportBatch(0, 0);

  constructor(options: { mapRoot?: string } = {}) {
    this.mapLoader = new StaticMapLoader(options.mapRoot ?? defaultMapRoot());
  }

  async ingest(frame: unknown): Promise<Record<string, unknown>> {
    const currentTick = this.runner?.game.ticks() ?? 0;
    this.latestTransportBatch = emptyTransportBatch(currentTick, currentTick);
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

  async finalize(gameRecord: unknown): Promise<Record<string, unknown>> {
    const official = await replayGameRecord(gameRecord, { mapLoader: this.mapLoader });
    const parity = this.latestState === null
      ? { ok: false, checked: [], mismatches: [{ path: "mirror", expected: "state", actual: null }] }
      : compareStates(this.latestState, official);
    return {
      schemaVersion: 2,
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
      (update) => this.transportLifecycle.captureRunnerUpdate(update),
    ));
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
    while (this.runner!.game.ticks() < targetTick) {
      const turnNumber = this.runner!.game.ticks();
      const turn: Turn = { turnNumber, intents: (intents.get(turnNumber) ?? []) as Turn["intents"] };
      const before = this.transportLifecycle.beforeTick(this.runner!.game);
      const boatIntents = boatIntentContexts(this.runner!.game, turn.intents);
      this.runner!.addTurn(turn);
      const executed = await withSilentEngine(() => this.runner!.executeNextTick());
      if (!executed) throw new Error(`canonical runner rejected turn ${turnNumber}`);
      this.transportLifecycle.afterTick(this.runner!.game, before, boatIntents);
    }
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

  private diverge(reason: string, detail: Record<string, unknown>): Record<string, unknown> {
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

  private result(parity: ParityResult | null): Record<string, unknown> {
    return {
      schemaVersion: 2,
      status: this.status,
      engine: ENGINE_IDENTITY,
      snapshotCount: this.snapshotCount,
      state: this.latestState,
      transportLifecycle: this.latestTransportBatch,
      parity,
      incident: this.incident,
    };
  }
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

function emptyTransportBatch(
  fromTick: number,
  toTick: number,
): TransportLifecycleBatch {
  return { schemaVersion: 1, fromTick, toTick, events: [] };
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
    winner: winner === null ? null : "isPlayer" in winner && winner.isPlayer()
      ? { kind: "player" as const, id: winner.id() }
      : { kind: "team" as const, id: String((winner as { id?: () => unknown }).id?.() ?? winner) },
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

function stateRef(state: GameState | null): Record<string, unknown> | null {
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

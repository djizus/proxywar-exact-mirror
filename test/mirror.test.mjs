import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CANONICAL_TERRAIN_BYTE_LAYOUT,
  canonicalStateHash,
  ENGINE_IDENTITY,
  ExactMirror,
  encodeStateJSON,
} from "../dist/mirror.mjs";

const names = [
  "Richard Higgins", "James Boggs", "Auri", "docxology", "Ron SWGY", "RelhAlpha",
  "K1Z odin free", "K1Z katanasan", "K1Z juryoku koku", "K1Z Hrafn", "Sefirot", "daveey",
];
const clients = [
  "ZfJsVWEg", "Qfw6Lj6w", "W6ShVkxn", "4UaEMZuJ", "AEQvm1e6", "DXPkGocK",
  "WruoXSEv", "uWtSRx6W", "2PR9B2Bk", "JqaMpBN2", "XjcM28yS", "HnP6DYM2",
];
const playerIDs = [
  "c4o8gv6v", "28k1hctz", "r5o3pta1", "xbt2wt14", "9h8tnrym", "25ze9gxs",
  "idjkf73n", "sjh3tur2", "2rmhbq4h", "x262ww19", "1wy62oh4", "a6xyjvhc",
];
const spawnTurns = [
  [1072586, 1218602, 617498, 498354, 621396, 1129100, 994502, 1080668, 751428, 866466, 601156, 246312],
  [1072586, 1208632, 617498, 494334, 1333674, 628394, 994502, 517574, 1080668, 1376618, 249490, 247586],
  [1088580, 1216626, 877134, 659476, 629398, 500334, 628394, 1333674, 1080668, 373314, 673074, 997490],
];
const openingCanonicalHash = "sha256:faa56c5a3791ba09cbc3712aa21a6940c1e07b35312f48ef4e316a2c70e07b42";
const sidecarNames = [
  "economyStats",
  "tradeCompletions",
  "trainStops",
  "unitsConstructed",
  "attackStats",
  "mirvLaunches",
  "borderTargets",
  "staticTerrain",
  "waterComponents",
  "railTopology",
  "spawnState",
];

test("bootstraps an exact World mirror from the first public snapshot", async () => {
  const mirror = new ExactMirror();
  const result = await mirror.ingest(openingFrame());

  assert.equal(result.status, "exact");
  assert.equal(result.schemaVersion, 3);
  assert.deepEqual(result.engine, ENGINE_IDENTITY);
  assert.equal(result.parity.ok, true);
  assert.equal(result.state.tick, 400);
  assert.equal(result.state.players.length, 12);
  assert.ok(result.state.players.every((player) => Array.isArray(player.sharedBorderPlayerIDs)));
  assert.ok(result.state.players.every((player) => Array.isArray(player.attackablePlayerIDs)));
  assert.ok(result.state.players.every((player) => player.maxTroops > 0));
  assert.equal(result.state.tileState.length, 2_000_000);
  assert.match(result.state.source.hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(canonicalStateHash(result.state), result.state.source.hash);
  assert.equal(result.state.source.hash, openingCanonicalHash);
  assert.equal("economyStats" in result.state, false);
  assert.equal(result.economyStats.schemaVersion, 1);
  assert.equal(result.economyStats.toTick, result.state.tick);
  assert.equal(result.unitsConstructed.tick, result.state.tick);
  assert.equal(result.unitsConstructed.players.length, 12);
  assert.equal(result.attackStats.toTick, result.state.tick);
  assert.equal(result.mirvLaunches.count, "0");
  assert.equal(result.borderTargets.tick, result.state.tick);
  assert.equal(result.staticTerrain.encoding, "uint8-rle");
  assert.equal(result.staticTerrain.length, result.state.tileState.length);
  assert.deepEqual(
    result.staticTerrain.byteLayout,
    CANONICAL_TERRAIN_BYTE_LAYOUT,
  );
  assert.equal(result.waterComponents.encoding, "int32-rle");
  assert.equal(result.waterComponents.length, result.state.tileState.length);
  assert.equal(result.railTopology.tick, result.state.tick);
  assert.equal(result.railTopology.fromTick, 0);
  assert.equal(result.railTopology.toTick, result.state.tick);
  assert.deepEqual(result.railTopology.events, []);
  assert.equal(result.spawnState.tick, result.state.tick);

  const encoded = encodeStateJSON(result.state);
  assert.equal(encoded.tileState.encoding, "uint16-rle");
  assert.equal(encoded.tileState.length, 2_000_000);
});

test("fixture sidecars are deterministic, exact, and compact outside canonical state", async () => {
  const leftMirror = new ExactMirror();
  const rightMirror = new ExactMirror();
  const [left, right] = await Promise.all([
    leftMirror.ingest(openingFrame()),
    rightMirror.ingest(openingFrame()),
  ]);
  const leftSidecars = Object.fromEntries(sidecarNames.map((name) => [name, left[name]]));
  const rightSidecars = Object.fromEntries(sidecarNames.map((name) => [name, right[name]]));

  assert.deepEqual(leftSidecars, rightSidecars);
  assert.equal(left.state.source.hash, openingCanonicalHash);
  assert.equal("staticTerrain" in left.state, false);
  assert.equal("waterComponents" in left.state, false);
  assert.ok(left.staticTerrain.runs.length < left.staticTerrain.length);
  assert.ok(left.waterComponents.runs.length < left.waterComponents.length);
  const serializedBytes = Buffer.byteLength(JSON.stringify(leftSidecars));
  const rawSidecarBytes =
    left.staticTerrain.length * Uint8Array.BYTES_PER_ELEMENT +
    left.waterComponents.length * Int32Array.BYTES_PER_ELEMENT;
  assert.ok(
    serializedBytes < rawSidecarBytes,
    `expected compact sidecars (${serializedBytes} bytes) below raw terrain/connectivity arrays (${rawSidecarBytes} bytes)`,
  );

  assertTerrainMatchesCanonical(
    left.staticTerrain,
    leftMirror.runner.game,
  );
});

test("a confirmed global snapshot gap permanently diverges the match", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const gap = await mirror.ingest({ ...openingFrame(), snapshotCount: 3 });
  assert.equal(gap.status, "diverged");
  assert.equal(gap.incident.reason, "global_snapshot_gap");

  const repeated = await mirror.ingest({ ...openingFrame(), snapshotCount: 2 });
  assert.equal(repeated.status, "diverged");
});

test("resolves an interval decision after its player leaves the current roster", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const frame = structuredClone(openingFrame());
  frame.snapshotCount = 2;
  frame.snapshot.players = frame.snapshot.players.slice(1);
  frame.snapshot.decisions = [{
    sequence: 37,
    agentID: "opportunistic-agent-1",
    username: names[0],
    turnNumber: 400,
    accepted: true,
    intentSummary: JSON.stringify({ type: "emoji", recipient: clients[1], emoji: 25 }),
  }];

  const result = await mirror.ingest(frame);
  assert.equal(result.status, "exact");
  assert.equal(result.snapshotCount, 2);
  assert.equal(result.parity.ok, true);
});

test("diverges when a public identity changes client", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const frame = structuredClone(openingFrame());
  frame.snapshotCount = 2;
  frame.snapshot.decisions = [];
  frame.snapshot.players[0].clientID = "replacement-client";

  const result = await mirror.ingest(frame);
  assert.equal(result.status, "diverged");
  assert.equal(result.incident.reason, "mirror_execution_failure");
  assert.match(result.incident.error, /changed client/);
});

test("completed official replay matches the independently reconstructed live state", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const result = await mirror.finalize(openingGameRecord());
  assert.equal(result.status, "exact");
  assert.deepEqual(result.engine, ENGINE_IDENTITY);
  assert.equal(result.parity.ok, true);
  assert.equal(result.liveStateRef.tick, 400);
  assert.equal(result.officialStateRef.tick, 400);
  assert.equal(result.liveStateRef.hash, result.officialStateRef.hash);
});

test("canonical hashes ignore cross-runtime last-bit noise in derived floats", async () => {
  const result = await new ExactMirror().ingest(openingFrame());
  const left = structuredClone(result.state);
  const right = structuredClone(result.state);
  left.players[1].maxTroops = 595107.9344554027;
  left.players[1].troopRatio = 0.4056642266430604;
  left.attacks = [{ troops: 197.5591664912373 }];
  right.players[1].maxTroops = 595107.9344554028;
  right.players[1].troopRatio = 0.40566422664306034;
  right.attacks = [{ troops: 197.55916649224935 }];

  assert.equal(canonicalStateHash(left), canonicalStateHash(right));
});

test("captures a transport motion plan and terminal event between public snapshots", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const expansionDecisions = expansionWaveDecisions();
  const expanded = await mirror.ingest(intervalFrame({
    snapshotCount: 2,
    tick: 1_300,
    decisions: expansionDecisions,
  }));
  assert.equal(expanded.status, "exact");
  assert.ok(expanded.economyStats.ticks.length > 0);
  assert.ok(expanded.attackStats.ticks.length > 0);
  assert.ok(expanded.attackStats.ticks.some((tick) =>
    tick.players.some((player) => BigInt(player.sent) > 0n)
  ));
  assert.ok(expanded.borderTargets.pairs.every((pair) => pair.edges > 0));
  assert.equal(
    new Set(expanded.borderTargets.pairs.map((pair) =>
      `${pair.playerAID}:${pair.playerBID}`
    )).size,
    expanded.borderTargets.pairs.length,
  );
  const boat = findBoatIntent(mirror);

  const launchFrame = intervalFrame({
    snapshotCount: 3,
    tick: 1_301,
    decisions: [{
      sequence: 37 + expansionDecisions.length,
      agentID: `opportunistic-agent-${boat.playerIndex + 1}`,
      username: names[boat.playerIndex],
      turnNumber: 1_300,
      accepted: true,
      intentSummary: JSON.stringify({
        type: "boat",
        dst: boat.targetTile,
        troops: 1_000,
      }),
    }],
  });
  const launched = await mirror.ingest(launchFrame);
  const launch = launched.transportLifecycle.events.find(
    (event) => event.type === "launch_observed",
  );
  const plan = launched.transportLifecycle.events.find(
    (event) => event.type === "plan_updated" && event.unitID === launch?.unitID,
  );

  assert.equal(launched.status, "exact");
  assert.ok(launched.unitsConstructed.players.some((player) =>
    player.counts.Transport > 0
  ));
  assert.ok(launch, "expected a transport launch event");
  assert.ok(plan, "expected a transport motion plan");
  assert.ok(plan.pathLength >= 2);
  assert.ok(plan.projectedCompletionTick > 1_301);

  const completed = await mirror.ingest(intervalFrame({
    snapshotCount: 4,
    tick: plan.projectedCompletionTick + 2,
    decisions: [],
  }));
  const terminal = completed.transportLifecycle.events.find(
    (event) =>
      event.unitID === launch.unitID &&
      ["arrived", "friendly_returned", "retreat_returned", "destroyed", "path_failed"].includes(event.type),
  );

  assert.equal(completed.status, "exact");
  assert.ok(terminal, "expected an exact terminal transport event");
  assert.equal(terminal.type, "arrived");
  assert.ok(
    ["self", "friendly", "hostile", "neutral"].includes(terminal.terminalOwnerClass),
  );
  assert.ok(Number.isInteger(terminal.terminalOwnerSmallID));
  assert.ok(
    completed.transportLifecycle.events.some(
      (event) =>
        event.type === "attack_converted" &&
        event.unitID === launch.unitID &&
        typeof event.attackID === "string",
    ),
    "expected the landing to bind to its resulting land attack",
  );
});

test("reports an accepted boat intent that cannot spawn", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const frame = intervalFrame({
    snapshotCount: 2,
    tick: 401,
    decisions: [{
      sequence: 37,
      agentID: "opportunistic-agent-1",
      username: names[0],
      turnNumber: 400,
      accepted: true,
      intentSummary: JSON.stringify({ type: "boat", dst: -1, troops: 1_000 }),
    }],
  });
  const result = await mirror.ingest(frame);

  assert.equal(result.status, "exact");
  assert.equal(result.transportLifecycle.events.length, 1);
  assert.equal(result.transportLifecycle.events[0].type, "launch_failed");
  assert.equal(result.transportLifecycle.events[0].unitID, null);
});

test("observes exact economy participants and retains point sidecars on no-op ingest", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const [source, destination] = mirror.runner.game.players();
  mirror.runner.game.stats().boatArriveTrade(source, destination, 12_345n);
  mirror.runner.game.stats().trainExternalTrade(destination, 678n);
  mirror.runner.game.stats().trainSelfTrade(source, 678n);
  const frame = intervalFrame({
    snapshotCount: 2,
    tick: 401,
    decisions: [],
  });
  const observed = await mirror.ingest(frame);

  assert.deepEqual(observed.tradeCompletions.events, [{
    tick: 401,
    payout: "12345",
    sourcePortOwnerPlayerID: String(source.id()),
    destinationPortOwnerPlayerID: String(destination.id()),
    captured: false,
    provenance: "exact_stats_call",
  }]);
  assert.deepEqual(observed.trainStops.events, [{
    tick: 401,
    payout: "678",
    trainOwnerPlayerID: String(source.id()),
    stationOwnerPlayerID: String(destination.id()),
    provenance: "exact_stats_call",
  }]);

  const repeated = await mirror.ingest(frame);
  assert.equal(repeated.unitsConstructed.players.length, 12);
  assert.equal(repeated.unitsConstructed.tick, 401);
  assert.equal(repeated.mirvLaunches.count, observed.mirvLaunches.count);
  assert.deepEqual(repeated.spawnState, observed.spawnState);
  assert.deepEqual(repeated.tradeCompletions.events, []);
  assert.deepEqual(repeated.trainStops.events, []);
  assert.equal(repeated.staticTerrain, null);
  assert.equal(repeated.waterComponents, null);
});

test("captures non-empty port, trade ship, and train spawn state exactly", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const expansionDecisions = expansionWaveDecisions();
  await mirror.ingest(intervalFrame({
    snapshotCount: 2,
    tick: 1_300,
    decisions: expansionDecisions,
  }));
  const game = mirror.runner.game;
  for (const player of game.players()) player.addGold(1_000_000n);
  const portCandidates = game.players()
    .map((player) => ({ player, tile: findPortTile(game, player) }))
    .filter((candidate) => candidate.tile !== null);
  assert.ok(
    portCandidates.length >= 2,
    "expanded fixture needs two coastal port sites",
  );
  const [{ player: source, tile: sourcePortTile }, {
    player: destination,
    tile: destinationPortTile,
  }] = portCandidates;
  const sourcePort = source.buildUnit("Port", sourcePortTile, {});
  const destinationPort = destination.buildUnit("Port", destinationPortTile, {});
  const tradeShipTile = game.neighbors(sourcePortTile)
    .find((tile) => game.isWater(tile));
  assert.notEqual(tradeShipTile, undefined, "fixture port needs adjacent water");
  const tradeShip = source.buildUnit("Trade Ship", tradeShipTile, {
    targetUnit: destinationPort,
  });
  const train = source.buildUnit("Train", sourcePortTile, {
    trainType: "Engine",
    targetUnit: destinationPort,
    loaded: true,
  });

  const observed = await mirror.ingest(intervalFrame({
    snapshotCount: 3,
    tick: 1_300,
    decisions: [],
  }));

  assert.deepEqual(
    observed.spawnState.ports.map((unit) => unit.unitID),
    [sourcePort.id(), destinationPort.id()],
  );
  assert.deepEqual(observed.spawnState.tradeShips, [{
    unitID: tradeShip.id(),
    ownerPlayerID: String(source.id()),
    tile: tradeShipTile,
    level: 1,
    active: true,
    underConstruction: false,
    hasTrainStation: false,
    targetUnitID: destinationPort.id(),
    targetOwnerPlayerID: String(destination.id()),
  }]);
  assert.deepEqual(observed.spawnState.trains, [{
    unitID: train.id(),
    ownerPlayerID: String(source.id()),
    tile: sourcePortTile,
    level: 1,
    active: true,
    underConstruction: false,
    hasTrainStation: false,
    trainType: "Engine",
    loaded: true,
    reachedTarget: false,
    targetUnitID: destinationPort.id(),
  }]);
});

test("emits changed water components after a canonical water graph rebuild", async () => {
  const mirror = new ExactMirror();
  const opening = await mirror.ingest(openingFrame());
  const game = mirror.runner.game;
  const convertedTiles = findWaterConversionTiles(game);
  assert.ok(
    convertedTiles.length >= 3,
    "fixture needs three unowned land tiles in one minimap cell",
  );
  game.config().gameConfig().waterNukes = true;
  for (const tile of convertedTiles) game.queueWaterConversion(tile);

  const observed = await mirror.ingest(intervalFrame({
    snapshotCount: 2,
    tick: 401,
    decisions: [],
  }));

  assert.equal(observed.status, "exact");
  assert.ok(convertedTiles.every((tile) => game.isWater(tile)));
  assert.ok(
    observed.waterComponents.graphVersion >
      opening.waterComponents.graphVersion,
  );
  assert.equal(
    rleValueAt(observed.waterComponents.runs, convertedTiles[0]),
    game.getWaterComponent(convertedTiles[0]) ?? -1,
  );
});

test("same-tick railroad destruction wins over a snap-created segment in the emitted batch", async () => {
  const mirror = new ExactMirror();
  await mirror.ingest(openingFrame());
  const observer = mirror.passiveSidecars;
  observer.beginBatch(400);
  observer.railroads.set(1, [9]);
  const updates = Array.from({ length: 23 }, () => []);
  updates[17].push({
    id: 20,
    tiles: [20, 21, 22],
  });
  updates[18].push({
    originalId: 1,
    newId1: 2,
    newId2: 3,
    tiles1: [10],
    tiles2: [11],
  });
  updates[16].push({ id: 2 });

  observer.captureRunnerUpdate({
    tick: 401,
    updates,
    packedTileUpdates: new Uint32Array(),
    playerNameViewData: {},
  });

  const emitted = observer.endBatch(mirror.runner.game, 401).railTopology;
  assert.deepEqual(emitted.railroads, [
    { id: 3, tiles: [11] },
    { id: 20, tiles: [20, 21, 22] },
  ]);
  assert.deepEqual(emitted.events, [
    {
      sequence: 1,
      tick: 401,
      type: "constructed",
      railroad: { id: 20, startTile: 20, endTile: 22, tileCount: 3 },
    },
    {
      sequence: 2,
      tick: 401,
      type: "snapped",
      originalRailroadID: 1,
      railroads: [
        { id: 2, startTile: 10, endTile: 10, tileCount: 1 },
        { id: 3, startTile: 11, endTile: 11, tileCount: 1 },
      ],
    },
    {
      sequence: 3,
      tick: 401,
      type: "destroyed",
      railroadID: 2,
    },
  ]);
  assert.equal("tiles" in emitted.events[1].railroads[0], false);

  observer.beginBatch(401);
  const nextUpdates = Array.from({ length: 23 }, () => []);
  nextUpdates[17].push({ id: 21, tiles: [30, 31] });
  observer.captureRunnerUpdate({
    tick: 402,
    updates: nextUpdates,
    packedTileUpdates: new Uint32Array(),
    playerNameViewData: {},
  });
  const nextBatch = observer.endBatch(mirror.runner.game, 402).railTopology;
  assert.equal(nextBatch.events[0].sequence, 4);
});

test("worker validates operation and request IDs while retaining numeric requests", async () => {
  const worker = fork(
    fileURLToPath(new URL("../dist/worker.mjs", import.meta.url)),
    [],
    {
      serialization: "advanced",
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  try {
    const backward = await workerRequest(worker, {
      id: 7,
      type: "ingest",
      frame: openingFrame(),
    });
    assert.equal(backward.id, 7);
    assert.equal(backward.ok, true);
    assert.equal(backward.result.status, "exact");
    assert.ok(backward.result.state.tileState instanceof Uint16Array);
    assert.equal(backward.result.state.source.hash, openingCanonicalHash);

    const invalidOperation = await workerRequest(worker, {
      id: "invalid-operation",
      type: "inspect",
    });
    assert.deepEqual(
      { id: invalidOperation.id, ok: invalidOperation.ok },
      { id: "invalid-operation", ok: false },
    );
    assert.match(invalidOperation.error, /expected ingest or finalize/);

    const invalidID = await workerRequest(worker, {
      id: { nested: true },
      type: "ingest",
      frame: null,
    });
    assert.equal(invalidID.id, null);
    assert.equal(invalidID.ok, false);
    assert.match(invalidID.error, /request id must be/);
  } finally {
    worker.kill("SIGTERM");
    if (worker.exitCode === null) await once(worker, "exit");
  }
});

function assertTerrainMatchesCanonical(sidecar, game) {
  const layout = sidecar.byteLayout;
  let tile = 0;
  for (const [raw, length] of sidecar.runs) {
    assert.ok(
      Number.isInteger(raw) && raw >= 0 && raw <= 255,
      `invalid uint8 terrain value ${raw}`,
    );
    for (let offset = 0; offset < length; offset++, tile++) {
      if (
        raw !== game.terrainByte(tile) ||
        Boolean(raw & layout.landMask) !== game.isLand(tile) ||
        Boolean(raw & layout.oceanMask) !== game.isOcean(tile) ||
        Boolean(raw & layout.shorelineMask) !== game.isShoreline(tile) ||
        (raw & layout.magnitudeMask) !== game.magnitude(tile)
      ) {
        assert.fail(`terrain metadata disagrees with canonical GameMap at tile ${tile}`);
      }
    }
  }
  assert.equal(tile, sidecar.length);
}

function findPortTile(game, player) {
  for (const tile of player.tiles()) {
    if (
      game.isLand(tile) &&
      game.isShoreline(tile) &&
      game.neighbors(tile).some((neighbor) => game.isWater(neighbor))
    ) {
      return tile;
    }
  }
  return null;
}

function findWaterConversionTiles(game) {
  for (let y = 0; y < game.height(); y += 2) {
    for (let x = 0; x < game.width(); x += 2) {
      const tiles = [];
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          if (!game.isValidCoord(x + dx, y + dy)) continue;
          const tile = game.ref(x + dx, y + dy);
          if (game.isLand(tile) && !game.hasOwner(tile)) tiles.push(tile);
        }
      }
      if (tiles.length >= 3) return tiles;
    }
  }
  return [];
}

function expansionWaveDecisions() {
  return Array.from({ length: 8 }, (_, wave) =>
    names.map((username, playerIndex) => ({
      sequence: 37 + wave * names.length + playerIndex,
      agentID: `opportunistic-agent-${playerIndex + 1}`,
      username,
      turnNumber: 400 + wave * 100,
      accepted: true,
      intentSummary: JSON.stringify({
        type: "attack",
        targetID: null,
        troops: 20_000,
      }),
    }))
  ).flat();
}

function workerRequest(worker, message) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (response) => {
      cleanup();
      resolve(response);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`mirror worker exited code=${code} signal=${signal}`));
    };
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    worker.send(message, (error) => {
      if (error) onError(error);
    });
  });
}

function findBoatIntent(mirror) {
  const runner = mirror.runner;
  const game = runner.game;
  const players = game.players().filter((player) => player.isPlayer());
  const candidates = [];
  for (let playerIndex = 0; playerIndex < players.length; playerIndex++) {
    const player = players[playerIndex];
    for (const target of players) {
      if (target === player || target.spawnTile() === undefined) continue;
      const targetTile = target.spawnTile();
      const buildables = runner.playerBuildables(
        player.id(),
        game.x(targetTile),
        game.y(targetTile),
        ["Transport"],
      );
      if (!buildables.some((entry) => entry.type === "Transport" && entry.canBuild)) {
        continue;
      }
      candidates.push({
        playerIndex,
        targetTile,
        distance: Math.hypot(
          game.x(targetTile) - game.x(player.spawnTile()),
          game.y(targetTile) - game.y(player.spawnTile()),
        ),
      });
    }
  }
  candidates.sort((left, right) => left.distance - right.distance);
  assert.ok(candidates.length > 0, "opening fixture needs a legal transport route");
  return candidates[0];
}

function intervalFrame({ snapshotCount, tick, decisions }) {
  const frame = openingFrame();
  frame.snapshotCount = snapshotCount;
  frame.snapshot.tick = tick;
  frame.snapshot.turnNumber = tick;
  frame.snapshot.players = [];
  frame.snapshot.decisions = decisions;
  return frame;
}

function rleValueAt(runs, target) {
  let offset = 0;
  for (const [value, length] of runs) {
    if (target < offset + length) return value;
    offset += length;
  }
  throw new Error(`RLE index ${target} exceeds decoded length ${offset}`);
}

function openingFrame() {
  const players = names.map((username, index) => ({
    agentID: `opportunistic-agent-${index + 1}`,
    clientID: clients[index],
    playerID: playerIDs[index],
    username,
    isAlive: true,
    hasSpawned: true,
    tilesOwned: 52,
    troops: 62518,
    gold: "209800",
    tiles: [],
    units: [],
  }));
  const decisions = spawnTurns.flatMap((tiles, turnIndex) => tiles.map((tile, playerIndex) => ({
    sequence: turnIndex * 12 + playerIndex + 1,
    agentID: `opportunistic-agent-${playerIndex + 1}`,
    username: names[playerIndex],
    turnNumber: turnIndex * 100,
    accepted: true,
    intentSummary: JSON.stringify({ type: "spawn", tile }),
  })));
  return {
    type: "state",
    event: "snapshot",
    snapshotCount: 1,
    config: {
      players: names.map((name) => ({ name })),
      max_decision_steps: 500,
      turns_per_decision_step: 100,
      max_decision_ms: 15000,
      map: "World",
      map_size: "Normal",
      difficulty: "Easy",
      player_count: 12,
    },
    map: { width: 2000, height: 1000, gameMap: "World", gameMapSize: "Normal" },
    snapshot: {
      label: "After spawn",
      turnNumber: 400,
      tick: 400,
      phase: "active",
      players,
      decisions,
    },
  };
}

function openingGameRecord() {
  const intents = spawnTurns.map((tiles, turnIndex) => ({
    turnNumber: turnIndex * 100,
    intents: [
      ...(turnIndex === 0 ? clients.map((clientID) => ({ type: "mark_disconnected", clientID, isDisconnected: false })) : []),
      ...tiles.map((tile, playerIndex) => ({ type: "spawn", tile, clientID: clients[playerIndex] })),
    ],
  }));
  return {
    info: {
      gameID: "COWRLD01",
      lobbyCreatedAt: 0,
      config: {
        gameMap: "World",
        gameMapSize: "Normal",
        gameMode: "Free For All",
        gameType: "Private",
        difficulty: "Easy",
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
        maxPlayers: 12,
      },
      players: names.map((username, index) => ({
        clientID: clients[index],
        username,
        clanTag: null,
        isLobbyCreator: false,
      })),
      num_turns: 400,
    },
    turns: intents,
  };
}

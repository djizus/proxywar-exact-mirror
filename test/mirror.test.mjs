import assert from "node:assert/strict";
import test from "node:test";

import { canonicalStateHash, ExactMirror, encodeStateJSON } from "../dist/mirror.mjs";

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

test("bootstraps an exact World mirror from the first public snapshot", async () => {
  const mirror = new ExactMirror();
  const result = await mirror.ingest(openingFrame());

  assert.equal(result.status, "exact");
  assert.equal(result.parity.ok, true);
  assert.equal(result.state.tick, 400);
  assert.equal(result.state.players.length, 12);
  assert.ok(result.state.players.every((player) => Array.isArray(player.sharedBorderPlayerIDs)));
  assert.ok(result.state.players.every((player) => Array.isArray(player.attackablePlayerIDs)));
  assert.ok(result.state.players.every((player) => player.maxTroops > 0));
  assert.equal(result.state.tileState.length, 2_000_000);
  assert.match(result.state.source.hash, /^sha256:[0-9a-f]{64}$/);

  const encoded = encodeStateJSON(result.state);
  assert.equal(encoded.tileState.encoding, "uint16-rle");
  assert.equal(encoded.tileState.length, 2_000_000);
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

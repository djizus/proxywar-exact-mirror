export * from "./protocol.mjs";

import type {
  GameState,
  MirrorFinalizeResult,
  MirrorIngestResult,
  MirrorStatus,
  ParityResult,
} from "./protocol.mjs";

export declare const ENGINE_IDENTITY: Readonly<{
  coworldID: string;
  coworldVersion: string;
  proxyWarCommit: string;
  gameImage: string;
}>;

export declare const CANONICAL_TERRAIN_BYTE_LAYOUT: Readonly<{
  magnitudeMask: number;
  landMask: number;
  oceanMask: number;
  shorelineMask: number;
  landMagnitudeThresholds: readonly number[];
  typeLegend: readonly string[];
}>;

export declare class ExactMirror {
  constructor(options?: { mapRoot?: string });
  ingest(frame: unknown): Promise<MirrorIngestResult>;
  finalize(gameRecord: unknown): Promise<MirrorFinalizeResult>;
  state(): GameState | null;
}

export declare function replayGameRecord(
  value: unknown,
  options?: { mapLoader?: unknown; mapRoot?: string },
): Promise<GameState>;

export declare function captureGameState(
  game: unknown,
  status?: MirrorStatus,
): GameState;

export declare function compareStates(
  left: GameState,
  right: GameState,
): ParityResult;

export declare function encodeStateJSON(
  state: GameState,
): Record<string, unknown>;

export declare function canonicalStateHash(
  state: Omit<GameState, "source"> & { source: GameState["source"] },
): string;

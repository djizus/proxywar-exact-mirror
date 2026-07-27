import {
  ExactMirror,
  mirrorRequestIDForError,
  parseMirrorRequest,
  type MirrorIPCResult,
  type MirrorRequest,
} from "./mirror.ts";

const mirror = new ExactMirror({ mapRoot: process.env.PROXYWAR_MIRROR_MAP_ROOT });

process.on("message", (message: unknown) => {
  void handle(message).then(
    (response) => process.send?.(response),
    (error): void => {
      const response: MirrorIPCResult = {
        id: mirrorRequestIDForError(message),
        ok: false,
        error: String((error as Error)?.stack ?? error).slice(0, 8_000),
      };
      process.send?.(response);
    },
  );
});

async function handle(message: unknown): Promise<MirrorIPCResult> {
  const request = parseMirrorRequest(message);
  if (request.type === "ingest") {
    return {
      id: request.id,
      ok: true,
      result: await mirror.ingest(request.frame),
    };
  }
  if (request.type === "project") {
    return {
      id: request.id,
      ok: true,
      result: mirror.project(request),
    };
  }
  return finalize(request);
}

async function finalize(
  request: Extract<MirrorRequest, { type: "finalize" }>,
): Promise<MirrorIPCResult> {
  return {
    id: request.id,
    ok: true,
    result: await mirror.finalize(request.gameRecord),
  };
}

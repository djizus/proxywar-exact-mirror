import { ExactMirror } from "./mirror.ts";

const mirror = new ExactMirror({ mapRoot: process.env.PROXYWAR_MIRROR_MAP_ROOT });

process.on("message", (message: unknown) => {
  void handle(message).then(
    (response) => process.send?.(response),
    (error) => process.send?.({
      id: requestID(message),
      ok: false,
      error: String((error as Error)?.stack ?? error).slice(0, 8_000),
    }),
  );
});

async function handle(message: unknown): Promise<Record<string, unknown>> {
  const request = message !== null && typeof message === "object" ? message as Record<string, unknown> : {};
  if (request.type === "ingest") {
    return { id: request.id, ok: true, result: await mirror.ingest(request.frame) };
  }
  if (request.type === "finalize") {
    return { id: request.id, ok: true, result: await mirror.finalize(request.gameRecord) };
  }
  throw new Error(`unknown mirror operation ${String(request.type)}`);
}

function requestID(message: unknown): unknown {
  return message !== null && typeof message === "object" ? (message as Record<string, unknown>).id : null;
}

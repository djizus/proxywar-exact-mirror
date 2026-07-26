/* ProxyWar exact mirror: AGPL-3.0-only; corresponding source at https://github.com/djizus/proxywar-exact-mirror */

// src/protocol.ts
function parseMirrorRequest(message) {
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
    `unknown mirror operation ${String(message.type)}; expected ingest or finalize`
  );
}
function mirrorRequestIDForError(message) {
  if (!isRecord(message)) return null;
  try {
    return parseMirrorRequestID(message.id);
  } catch {
    return null;
  }
}
function parseMirrorRequestID(value) {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(
    "mirror request id must be a non-empty string or non-negative safe integer"
  );
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export {
  mirrorRequestIDForError,
  parseMirrorRequest
};

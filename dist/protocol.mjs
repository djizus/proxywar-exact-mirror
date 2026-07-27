/* ProxyWar exact mirror: AGPL-3.0-only; corresponding source at https://github.com/djizus/proxywar-exact-mirror */

// src/protocol.ts
var MAX_PROJECT_ROUTES = 64;
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
  if (message.type === "project") {
    return {
      id,
      type: "project",
      ...parseMirrorProjectQuery(message)
    };
  }
  throw new Error(
    `unknown mirror operation ${String(message.type)}; expected ingest, finalize, or project`
  );
}
function parseMirrorProjectQuery(value) {
  if (!isRecord(value)) {
    throw new Error("project request must be an object");
  }
  const tick = parseNonNegativeSafeInteger(value.tick, "project tick");
  if (typeof value.stateHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.stateHash)) {
    throw new Error(
      "project stateHash must be a lowercase sha256:<64 hex digits> value"
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
      `project routes exceeds the deterministic cap of ${MAX_PROJECT_ROUTES}`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const routes = value.routes.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`project routes[${index}] must be an object`);
    }
    const source = parseNonNegativeSafeInteger(
      candidate.source,
      `project routes[${index}].source`
    );
    const destination = parseNonNegativeSafeInteger(
      candidate.destination,
      `project routes[${index}].destination`
    );
    const key = `${source}:${destination}`;
    if (seen.has(key)) {
      throw new Error(
        `project routes contains duplicate source/destination pair ${key}`
      );
    }
    seen.add(key);
    return { source, destination };
  });
  return { tick, stateHash: value.stateHash, routes };
}
function mirrorRequestIDForError(message) {
  if (!isRecord(message)) return null;
  try {
    return parseMirrorRequestID(message.id);
  } catch {
    return null;
  }
}
function parseNonNegativeSafeInteger(value, name) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`${name} must be a non-negative safe integer`);
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
  MAX_PROJECT_ROUTES,
  mirrorRequestIDForError,
  parseMirrorProjectQuery,
  parseMirrorRequest
};

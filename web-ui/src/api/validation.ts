import { APPLICATION_API_VERSION } from "./application-api";
import type { BackendSnapshot } from "./application-api";

/** Check the wire version before the UI uses metadata from an adapter. */
export function validateSnapshot(snapshot: BackendSnapshot): BackendSnapshot {
  if (!snapshot || snapshot.apiVersion !== APPLICATION_API_VERSION) {
    throw new Error("Unsupported Ponlet backend API version");
  }
  if (!Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
    throw new Error("Invalid Ponlet event sequence");
  }
  if (!new Set(["direct-udp", "webrtc", "derp", "unknown"]).has(snapshot.transport)) {
    throw new Error("Invalid Ponlet transport path");
  }
  if (!Array.isArray(snapshot.received)) {
    throw new Error("Invalid received item list");
  }
  for (const item of snapshot.received) {
    if (
      !item ||
      typeof item.name !== "string" ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.localPathOrHandle !== "string"
    ) {
      throw new Error("Invalid received item");
    }
  }
  if (snapshot.receivedMessages !== undefined) {
    if (!Array.isArray(snapshot.receivedMessages)) {
      throw new Error("Invalid received message history");
    }
    let previous = -1;
    for (const message of snapshot.receivedMessages) {
      if (
        !message ||
        typeof message.text !== "string" ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= previous ||
        message.sequence > snapshot.sequence
      ) {
        throw new Error("Invalid received message history");
      }
      previous = message.sequence;
    }
  }
  return snapshot;
}

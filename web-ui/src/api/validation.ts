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
  return snapshot;
}

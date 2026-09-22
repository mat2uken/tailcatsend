import { createHash } from "node:crypto";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const snapshot = (page) => page.evaluate(() => window.__ponletBackend?.snapshot?.());
export const nativeSnapshot = (page) => page.evaluate(() => window.__TAURI_INTERNALS__?.invoke("ponlet_snapshot"));

export async function waitFor(read, predicate, description, timeout = 90_000, interval = 150) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (last && predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`${description}: timed out; last snapshot=${JSON.stringify(last)}`);
}

export const waitForSnapshot = (page, predicate, description, timeout) =>
  waitFor(() => snapshot(page), predicate, description, timeout);
export const waitForNativeSnapshot = (page, predicate, description, timeout) =>
  waitFor(() => nativeSnapshot(page), predicate, description, timeout);

export function assertTransport(value, label) {
  if (!["direct-udp", "webrtc", "derp"].includes(value.transport)) {
    throw new Error(`${label} reported an unknown transport: ${value.transport}`);
  }
  const expected = process.env.PONLET_TEST_TRANSPORT;
  if (expected && value.transport !== expected) {
    throw new Error(`${label} did not use ${expected}: ${value.transport}`);
  }
}

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke as nativeInvoke } from "@tauri-apps/api/core";
import { initialSnapshot } from "../src/api/application-api.ts";
import { startJsonNotifications } from "../src/backends/json-notifications.ts";
import { createBackend } from "../src/backends/tauri.ts";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const cleanups = new Set();
const snapshot = (sequence) => ({ ...initialSnapshot(), sequence });
const textEvent = (sequence) => ({
  type: "text",
  sequence,
  incoming: true,
  text: `text ${sequence}`,
});
const pending = () => new Promise(() => {});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function observe(handler) {
  const events = [];
  const invoke = vi.fn(handler);
  const listeners = new Set([(event) => events.push(event)]);
  const stop = startJsonNotifications(invoke, listeners);
  cleanups.add(stop);
  return { events, invoke, listeners, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  nativeInvoke.mockReset();
});
afterEach(() => {
  for (const stop of cleanups) {
    stop();
  }
  cleanups.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("recovers an initial subscribe failure through snapshot and a new subscription", async () => {
  let subscriptions = 0;
  let waits = 0;
  const { events, invoke } = observe(async (command) => {
    if (command === "ponlet_subscribe") {
      if (++subscriptions === 1) {
        throw new Error("temporary subscribe failure");
      }
      return snapshot(4);
    }
    if (command === "ponlet_snapshot") {
      return snapshot(3);
    }
    if (command === "ponlet_wait_event") {
      return ++waits === 1 ? textEvent(5) : pending();
    }
  });
  await vi.advanceTimersByTimeAsync(249);
  expect(subscriptions).toBe(1);
  expect(events).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(events.map((event) => event.sequence)).toEqual([3, 4, 5]);
  const ids = invoke.mock.calls
    .filter(([command]) => command === "ponlet_subscribe")
    .map(([, args]) => args.subscriptionId);
  expect(ids[0]).not.toBe(ids[1]);
  expect(invoke).toHaveBeenCalledWith("ponlet_unsubscribe", { subscriptionId: ids[0] });
  expect(new Set(invoke.mock.calls.map(([command]) => command))).toEqual(
    new Set(["ponlet_subscribe", "ponlet_unsubscribe", "ponlet_snapshot", "ponlet_wait_event"]),
  );
});

it("recovers a failed wait without delivering old snapshots or rewinding the cursor", async () => {
  let subscriptions = 0;
  let waits = 0;
  const { events, invoke } = observe(async (command) => {
    if (command === "ponlet_subscribe") {
      return snapshot(++subscriptions === 1 ? 10 : 9);
    }
    if (command === "ponlet_snapshot") {
      return snapshot(8);
    }
    if (command === "ponlet_wait_event") {
      if (++waits === 1) {
        return textEvent(12);
      }
      if (waits === 2) {
        throw new Error("temporary wait failure");
      }
      if (waits === 3) {
        return [textEvent(11), textEvent(12), textEvent(13)];
      }
      return pending();
    }
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(events.map((event) => event.sequence)).toEqual([10, 12, 13]);
  const cursors = invoke.mock.calls
    .filter(([command]) => command === "ponlet_wait_event")
    .map(([, args]) => args.lastSequence);
  expect(cursors).toEqual([10, 12, 12, 13]);
});

it("backs off repeated read failures and stops its timer on dispose", async () => {
  let snapshots = 0;
  const { invoke, stop } = observe(async (command) => {
    if (command === "ponlet_subscribe") {
      throw new Error("subscribe failed");
    }
    if (command === "ponlet_snapshot") {
      snapshots++;
      throw new Error("snapshot failed");
    }
  });
  await vi.advanceTimersByTimeAsync(250);
  expect(snapshots).toBe(1);
  await vi.advanceTimersByTimeAsync(499);
  expect(snapshots).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(snapshots).toBe(2);
  stop();
  const calls = invoke.mock.calls.length;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(invoke.mock.calls).toHaveLength(calls);
});

it("unsubscribes again after a late subscribe response and emits nothing after dispose", async () => {
  const subscription = deferred();
  const { events, invoke, stop } = observe(async (command) => {
    if (command === "ponlet_subscribe") {
      return subscription.promise;
    }
    if (command === "ponlet_wait_event") {
      return pending();
    }
  });
  const id = invoke.mock.calls[0][1].subscriptionId;
  stop();
  expect(invoke).toHaveBeenCalledWith("ponlet_unsubscribe", { subscriptionId: id });
  subscription.resolve(snapshot(20));
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual([]);
  expect(invoke.mock.calls.filter(([command]) => command === "ponlet_unsubscribe")).toHaveLength(2);
  expect(invoke.mock.calls.some(([command]) => command === "ponlet_wait_event")).toBe(false);
});

it("ignores a late wait response after dispose and does not schedule recovery", async () => {
  const wait = deferred();
  const { events, invoke, stop } = observe(async (command) => {
    if (command === "ponlet_subscribe") {
      return snapshot(0);
    }
    if (command === "ponlet_wait_event") {
      return wait.promise;
    }
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(events.map((event) => event.sequence)).toEqual([0]);
  stop();
  wait.resolve(textEvent(1));
  await vi.advanceTimersByTimeAsync(10_000);
  expect(events.map((event) => event.sequence)).toEqual([0]);
  expect(vi.getTimerCount()).toBe(0);
  expect(invoke.mock.calls.some(([command]) => command === "ponlet_snapshot")).toBe(false);
});

it("stops remaining events in a batch when a listener disposes the subscription", async () => {
  const wait = deferred();
  const { events, listeners, stop } = observe(async (command) => {
    if (command === "ponlet_subscribe") {
      return snapshot(1);
    }
    if (command === "ponlet_wait_event") {
      return wait.promise;
    }
  });
  await vi.advanceTimersByTimeAsync(0);
  listeners.add(() => stop());
  wait.resolve([textEvent(2), textEvent(3)]);
  await vi.advanceTimersByTimeAsync(0);
  expect(events.map((event) => event.sequence)).toEqual([1, 2]);
});

it("does not retry create, join or send while the adapter recovers JSON notifications", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("binary scheme unavailable");
    }),
  );
  vi.stubGlobal("ponletbin", undefined);
  let waits = 0;
  nativeInvoke.mockImplementation(async (command) => {
    if (command === "ponlet_subscribe" || command === "ponlet_snapshot") {
      return snapshot(1);
    }
    if (command === "ponlet_wait_event") {
      if (++waits === 1) {
        throw new Error("notification interrupted");
      }
      return pending();
    }
    if (["ponlet_create_invite", "ponlet_join", "ponlet_send_text"].includes(command)) {
      throw new Error("operation interrupted after acceptance");
    }
  });
  const backend = createBackend();
  try {
    await vi.advanceTimersByTimeAsync(0);
    await expect(backend.createInvite()).rejects.toThrow("after acceptance");
    await expect(backend.join("invite")).rejects.toThrow("after acceptance");
    await expect(backend.sendText("once")).rejects.toThrow("after acceptance");
    await vi.advanceTimersByTimeAsync(250);
    expect(waits).toBe(2);
    for (const operation of ["ponlet_create_invite", "ponlet_join", "ponlet_send_text"]) {
      expect(nativeInvoke.mock.calls.filter(([command]) => command === operation)).toHaveLength(1);
    }
  } finally {
    await backend.dispose();
  }
});

import type { BackendEvent, BackendSnapshot } from "../api/application-api";
import { validateSnapshot } from "../api/validation";

type NotificationCommand =
  | "ponlet_snapshot"
  | "ponlet_subscribe"
  | "ponlet_unsubscribe"
  | "ponlet_wait_event";

type NotificationInvoke = <T>(
  command: NotificationCommand,
  args?: Record<string, unknown>,
) => Promise<T>;

/** Recover read notifications only. Mutating commands never pass through this loop. */
export function startJsonNotifications(
  invoke: NotificationInvoke,
  listeners: Set<(event: BackendEvent) => void>,
): () => void {
  let active = true;
  let generation = 0;
  let lastSequence = -1;
  let subscriptionId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resumeBackoff: (() => void) | undefined;
  const prefix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const current = (epoch: number): boolean => active && generation === epoch;
  const unsubscribe = (id: string): void => {
    void invoke("ponlet_unsubscribe", { subscriptionId: id }).catch(() => undefined);
  };
  const deliver = (value: BackendEvent | Array<BackendEvent>, epoch: number): void => {
    for (const event of Array.isArray(value) ? value : [value]) {
      if (!current(epoch)) {
        return;
      }
      if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) {
        throw new Error("Invalid Ponlet event sequence");
      }
      if (event.sequence <= lastSequence) {
        continue;
      }
      if (event.type === "snapshot") {
        validateSnapshot(event.snapshot);
        if (event.snapshot.sequence !== event.sequence) {
          throw new Error("Mismatched Ponlet snapshot sequence");
        }
      }
      lastSequence = event.sequence;
      for (const listener of listeners) {
        if (!current(epoch)) {
          return;
        }
        listener(event);
      }
    }
  };
  const deliverSnapshot = (value: BackendSnapshot, epoch: number): void => {
    if (current(epoch)) {
      const snapshot = validateSnapshot(value);
      deliver({ type: "snapshot", sequence: snapshot.sequence, snapshot }, epoch);
    }
  };
  const backoff = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
      resumeBackoff = resolve;
      timer = setTimeout(() => {
        timer = undefined;
        resumeBackoff = undefined;
        resolve();
      }, milliseconds);
    });

  const run = async (): Promise<void> => {
    let recovering = false;
    let retryDelay = 250;
    while (active) {
      const epoch = ++generation;
      const id = `${prefix}-${epoch}`;
      subscriptionId = id;
      try {
        if (recovering) {
          // Refresh state/history missed by the failed notification request.
          const snapshot = await invoke<BackendSnapshot>("ponlet_snapshot");
          if (!current(epoch)) {
            return;
          }
          deliverSnapshot(snapshot, epoch);
          if (!current(epoch)) {
            return;
          }
        }
        const snapshot = await invoke<BackendSnapshot>("ponlet_subscribe", {
          subscriptionId: id,
        });
        if (!current(epoch)) {
          return;
        }
        deliverSnapshot(snapshot, epoch);
        while (current(epoch)) {
          const event = await invoke<BackendEvent | Array<BackendEvent> | null>(
            "ponlet_wait_event",
            { subscriptionId: id, lastSequence: Math.max(0, lastSequence) },
          );
          if (!current(epoch)) {
            return;
          }
          if (event) {
            deliver(event, epoch);
          }
          retryDelay = 250;
        }
      } catch {
        recovering = true;
      } finally {
        // Also runs after a subscribe reply arriving after dispose, when the
        // earlier unsubscribe may have reached native before registration.
        unsubscribe(id);
        if (subscriptionId === id) {
          subscriptionId = undefined;
        }
      }
      if (!active) {
        return;
      }
      await backoff(retryDelay);
      retryDelay = Math.min(retryDelay * 2, 4000);
    }
  };
  void run();
  return () => {
    if (!active) {
      return;
    }
    active = false;
    generation++;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    resumeBackoff?.();
    resumeBackoff = undefined;
    if (subscriptionId) {
      unsubscribe(subscriptionId);
    }
  };
}

import type { BackendEvent, BackendSnapshot } from "./api/application-api";
import { resolvePublicUrl } from "./lib/public-url";

interface TelemetryBridge {
  isEnabled(): boolean;
  logEvent(name: string, params: Record<string, string | number>): void;
  setEnabled(enabled: boolean): void;
}

declare global {
  interface Window {
    __tailcatTelemetry?: TelemetryBridge;
  }
}

export function readTelemetryPreference(): boolean {
  try {
    // The interim WebView checkbox and the Slint website used different keys.
    // Preserve either existing opt-out until the user changes the setting.
    return (
      !["false", "off"].includes(localStorage.getItem("ponlet.telemetry") ?? "") &&
      localStorage.getItem("telemetry_enabled") !== "0"
    );
  } catch {
    return false;
  }
}

let initialization: Promise<void> | undefined;
let enabled = readTelemetryPreference();
const pending: Array<{ name: string; params: Record<string, string | number> }> = [];

async function script(path: string, module = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const element = document.createElement("script");
    element.src = resolvePublicUrl(path, document.baseURI);
    if (module) {
      element.type = "module";
    }
    element.onload = () => resolve();
    element.onerror = () => {
      element.remove();
      reject(new Error("Telemetry unavailable"));
    };
    document.head.append(element);
  });
}

export async function initializeWebTelemetry(): Promise<void> {
  if (!enabled) {
    return;
  }
  initialization ??= (async () => {
    // Sync the old SDK key before loading a script that may initialize Firebase.
    try {
      localStorage.setItem("telemetry_enabled", enabled ? "1" : "0");
    } catch {
      return;
    }
    if (!window.__tailcatTelemetry) {
      await script("assets/firebase-config.js");
      await script("assets/telemetry.js", true);
    }
    window.__tailcatTelemetry?.setEnabled(enabled);
    log("app_start", { platform: "web" });
    for (const event of pending.splice(0)) {
      log(event.name, event.params);
    }
  })().catch(() => {
    initialization = undefined;
  });
  await initialization;
}

export async function getTelemetryEnabled(): Promise<boolean> {
  return enabled;
}

export async function setTelemetryEnabled(value: boolean): Promise<void> {
  // Persist before changing SDK collection; a failed write leaves the setting intact.
  localStorage.setItem("ponlet.telemetry", String(value));
  localStorage.setItem("telemetry_enabled", value ? "1" : "0");
  enabled = value;
  if (!value) {
    pending.length = 0;
  }
  window.__tailcatTelemetry?.setEnabled(value);
  if (value) {
    void initializeWebTelemetry();
  }
}

function log(name: string, params: Record<string, string | number> = {}): void {
  if (!enabled) {
    return;
  }
  if (window.__tailcatTelemetry) {
    window.__tailcatTelemetry.logEvent(name, params);
  } else if (pending.length < 100) {
    pending.push({ name, params });
  }
}

export function textSent(text: string): void {
  const length = [...text].length;
  log("text_message_sent", {
    length_bucket:
      length <= 20 ? "xs" : length <= 100 ? "s" : length <= 500 ? "m" : length <= 2000 ? "l" : "xl",
  });
}

/** Only enum values and coarse counts leave this observer. Never pass text,
 * filenames, paths, invitation URLs, or error messages to the SDK. */
export function telemetryObserver(): (event: BackendEvent) => void {
  let sequence = -1;
  let previous: BackendSnapshot | undefined;
  let transferStart = 0;
  return (event) => {
    if (event.sequence <= sequence) {
      return;
    }
    sequence = event.sequence;
    if (event.type === "snapshot") {
      const current = event.snapshot;
      if (current.state === "awaiting-peer" && previous?.inviteUrl !== current.inviteUrl) {
        log("session_created", { transport: current.transport });
      } else if (
        current.state === "connected" &&
        previous?.state !== "connected" &&
        previous?.state !== "transferring"
      ) {
        log("peer_connected", { transport: current.transport });
      } else if (current.transfer && current.transfer.id !== previous?.transfer?.id) {
        transferStart = performance.now();
        log("transfer_started", {
          transport: current.transport,
          direction: current.transfer.incoming ? "receive" : "send",
        });
      }
      previous = current;
    } else if (event.type === "terminal") {
      log(
        event.status === "completed" ? "transfer_completed" : "transfer_cancelled",
        event.status === "completed"
          ? { duration_ms: Math.max(0, Math.round(performance.now() - transferStart)) }
          : { reason: event.status === "cancelled" ? "user" : "error" },
      );
    } else if (event.type === "text" && event.incoming) {
      const length = [...event.text].length;
      log("text_message_received", {
        length_bucket:
          length <= 20
            ? "xs"
            : length <= 100
              ? "s"
              : length <= 500
                ? "m"
                : length <= 2000
                  ? "l"
                  : "xl",
      });
    }
  };
}

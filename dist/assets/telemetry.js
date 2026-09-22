// Firebase Analytics adapter loaded by web-ui/src/telemetry.ts.
// Invalid configuration and unavailable Analytics leave event delivery disabled.
// Existing opt-out preferences and queued events are preserved.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
  getAnalytics,
  isSupported as isAnalyticsSupported,
  logEvent,
  setAnalyticsCollectionEnabled,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-analytics.js";
const LS_KEY = "telemetry_enabled";
const MAX_QUEUE = 100;

const config = window.__FIREBASE_CONFIG__ || null;
const valid = isConfigValid(config);
let enabled = readEnabled();
let analyticsInstance = null;
let analyticsSupported = true;
let ready = false;
let started = false;
let failed = false;
const queue = [];

function isConfigValid(cfg) {
  if (!cfg || !cfg.apiKey || !cfg.projectId || !cfg.appId || !cfg.measurementId) return false;
  if (String(cfg.apiKey).indexOf("PLACEHOLDER") !== -1) return false;
  if (String(cfg.measurementId).indexOf("PLACEHOLDER") !== -1) return false;
  return true;
}

function readEnabled() {
  try {
    const v = window.localStorage.getItem(LS_KEY);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch (e) {
    /* storage unavailable */
  }
  return true; // default: enabled (opt-out style)
}

function persistEnabled(v) {
  try {
    window.localStorage.setItem(LS_KEY, v ? "1" : "0");
  } catch (e) {
    /* storage unavailable */
  }
}

function enqueue(args) {
  if (queue.length < MAX_QUEUE) {
    queue.push(args);
  }
}

function flushQueue() {
  const pending = queue.splice(0, queue.length);
  for (const item of pending) {
    api.logEvent(item[0], item[1]);
  }
}

async function init() {
  if (!valid || !enabled || started) return;
  started = true;
  try {
    const app = initializeApp(config);

    // Analytics may be unsupported (no IndexedDB, restricted storage...).
    try {
      analyticsSupported = await isAnalyticsSupported();
    } catch (e) {
      analyticsSupported = false;
    }
    if (analyticsSupported) {
      analyticsInstance = getAnalytics(app);
    } else {
      console.warn("[Telemetry] Analytics not supported in this environment");
    }

    ready = true;
    if (analyticsInstance) {
      // Reflect the persisted opt-out at the SDK level.
      setAnalyticsCollectionEnabled(analyticsInstance, enabled);
    }
    flushQueue();
  } catch (e) {
    // Network blocked, CSP, CDN unreachable... stay a silent no-op.
    failed = true;
    queue.length = 0;
    console.warn("[Telemetry] Firebase init skipped:", e);
  }
}

const api = {
  setEnabled: function (v) {
    enabled = !!v;
    persistEnabled(enabled);
    if (!enabled) {
      // Stop SDK-level collection and drop queued events.
      queue.length = 0;
      if (ready && analyticsInstance) {
        try {
          setAnalyticsCollectionEnabled(analyticsInstance, false);
        } catch (e) {
          /* never break the app for telemetry */
        }
      }
      return;
    }
    if (ready && analyticsInstance) {
      try {
        setAnalyticsCollectionEnabled(analyticsInstance, true);
      } catch (e) {
        /* never break the app for telemetry */
      }
    } else if (valid && !failed) {
      init();
    }
  },
  logEvent: function (name, params) {
    if (!enabled || !valid || failed) return;
    if (!analyticsSupported) return;
    if (!ready || !analyticsInstance) {
      enqueue([name, params]);
      return;
    }
    try {
      logEvent(analyticsInstance, name, params || {});
    } catch (e) {
      /* never break the app for telemetry */
    }
  },
};

window.__tailcatTelemetry = api;

if (valid && enabled) {
  init();
}

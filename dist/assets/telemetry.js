// TailSend Web telemetry bridge (Firebase Analytics + Remote Config).
//
// Loaded from index.html as an ES module; the Firebase JS SDK is imported
// directly from the gstatic CDN (no bundler required). It exposes
// window.__tailcatTelemetry, which the Rust (WASM) side calls via
// wasm-bindgen. This module executes before the wasm loader module in
// index.html, so the bridge is always in place when Rust starts.
//
// Behavior:
// - If the config in firebase-config.js still contains PLACEHOLDER values,
//   Firebase is never initialized and every call is a no-op.
// - If Analytics is not supported in this environment (e.g. IndexedDB
//   disabled), the Analytics side falls back to no-ops; Remote Config is
//   still attempted when a valid config is present.
// - Calls made while initialization is in flight are queued and replayed
//   once Firebase is ready.
// - Opt-out is persisted in localStorage key "telemetry_enabled"
//   (default "1") and enforced with setAnalyticsCollectionEnabled().
//
// Crashlytics has no web SDK, so nothing is implemented for it here.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
    getAnalytics,
    isSupported as isAnalyticsSupported,
    logEvent,
    setAnalyticsCollectionEnabled,
    setUserProperties,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-analytics.js";
import {
    getRemoteConfig,
    fetchAndActivate,
    getValue,
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-remote-config.js";

const LS_KEY = "telemetry_enabled";
const MAX_QUEUE = 100;

const config = window.__FIREBASE_CONFIG__ || null;
const valid = isConfigValid(config);
let enabled = readEnabled();
let analyticsInstance = null;
let rcInstance = null;
let analyticsSupported = true;
let ready = false;
let failed = false;
const queue = [];
const pendingUserProps = {};

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
    } catch (e) { /* storage unavailable */ }
    return true; // default: enabled (opt-out style)
}

function persistEnabled(v) {
    try {
        window.localStorage.setItem(LS_KEY, v ? "1" : "0");
    } catch (e) { /* storage unavailable */ }
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
    if (!valid || !enabled || ready || failed) return;
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

        try {
            rcInstance = getRemoteConfig(app);
            rcInstance.settings = {
                minimumFetchIntervalMillis: 43200 * 1000,
                fetchTimeoutMillis: 5000,
            };
            rcInstance.defaultConfig = {
                announcement_text: "",
            };
            await fetchAndActivate(rcInstance);
        } catch (e) {
            console.warn("[Telemetry] Remote Config unavailable:", e);
            rcInstance = null;
        }

        ready = true;
        if (analyticsInstance) {
            // Reflect the persisted opt-out at the SDK level.
            setAnalyticsCollectionEnabled(analyticsInstance, enabled);
            for (const name of Object.keys(pendingUserProps)) {
                try {
                    setUserProperties(analyticsInstance, { [name]: pendingUserProps[name] });
                } catch (e) { /* never break the app for telemetry */ }
            }
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
    /** True when the bridge is active (valid config, not failed). */
    isSupported: function () {
        return valid && !failed;
    },
    isEnabled: function () {
        return enabled;
    },
    setEnabled: function (v) {
        enabled = !!v;
        persistEnabled(enabled);
        if (!enabled) {
            // Stop SDK-level collection and drop queued events.
            queue.length = 0;
            if (ready && analyticsInstance) {
                try {
                    setAnalyticsCollectionEnabled(analyticsInstance, false);
                } catch (e) { /* never break the app for telemetry */ }
            }
            return;
        }
        if (ready && analyticsInstance) {
            try {
                setAnalyticsCollectionEnabled(analyticsInstance, true);
            } catch (e) { /* never break the app for telemetry */ }
        } else if (valid && !failed) {
            init();
        }
    },
    setUserProperty: function (name, value) {
        if (!enabled || !valid || failed || !analyticsSupported) return;
        if (!ready || !analyticsInstance) {
            pendingUserProps[name] = String(value);
            return;
        }
        try {
            setUserProperties(analyticsInstance, { [name]: String(value) });
        } catch (e) { /* never break the app for telemetry */ }
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
        } catch (e) { /* never break the app for telemetry */ }
    },
    /** Remote Config string. Returns defaultValue (or null) when unavailable. */
    remoteString: function (key, defaultValue) {
        if (!enabled || !valid || failed || !ready || !rcInstance) {
            return defaultValue === undefined ? null : defaultValue;
        }
        try {
            const v = getValue(rcInstance, key);
            const s = v ? v.asString() : "";
            if (s) return s;
        } catch (e) { /* fall through to default */ }
        return defaultValue === undefined ? null : defaultValue;
    }
};

window.__tailcatTelemetry = api;

// Convenience alias for inline scripts in index.html.
window.telemetryEvent = function (name, params) {
    api.logEvent(name, params);
};

if (valid && enabled) {
    init();
}

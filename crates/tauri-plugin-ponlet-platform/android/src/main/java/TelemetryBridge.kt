package jp.yasagure.ponlet.platform

import android.content.Context
import android.os.Build
import android.os.Bundle
import com.google.android.gms.tasks.Tasks
import com.google.firebase.FirebaseApp
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.crashlytics.FirebaseCrashlytics
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Ordinary event failures remain no-op; privacy operations return explicit safe error codes. */
object TelemetryBridge {
    private const val PREFS_NAME = "telemetry_prefs"
    private const val KEY_ENABLED = "telemetry_enabled"
    val executor = Executors.newSingleThreadExecutor()
    private val enableGuard = PrivacyEnableGuard()
    /** Called on IPC receipt, before entering the serial queue or waiting for network. */
    fun receivePrivacyIntent(): Long {
        val token = enableGuard.receivedIntent()
        applicationEventsAllowed = false
        return token
    }
    fun beginDesiredIntent(token: Long, enabled: Boolean) = enableGuard.beginIntent(token, enabled)
    private val processId = PrivacyStartupGate.processId
    // App Check provider, manifest/startup ordering and retention are not configured here.
    private var privacyConfig = PrivacyConfig.DISABLED
    private val privacyTransport: PrivacyTransport? = null
    @Volatile private var ready = false
    @Volatile private var startupAuthorizedThisProcess = false
    private var privacyInitializationFailure: String? = null
    @Volatile private var applicationEventsAllowed = false
    private var appContext: Context? = null
    private var analytics: FirebaseAnalytics? = null
    private var crashlytics: FirebaseCrashlytics? = null
    private var coordinator: PrivacyCoordinator? = null

    fun initialize(context: Context, optOut: Boolean): Boolean {
        appContext = context.applicationContext
        applicationEventsAllowed = false
        privacyConfig = PrivacyBuildConfiguration.read(context).copy(startupGateVerified = startupAuthorizedThisProcess)
        if (privacyConfig.featureEnabled) PrivacyStartupGate.prepare(context)
        val preferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (optOut && !preferences.edit().putBoolean(KEY_ENABLED, false).commit())
            throw PrivacyFault("storage_commit_failed")
        bootstrap(context)
        if (privacyConfig.featureEnabled) {
            try {
                val privacy = privacy(context)
                if (optOut) privacy.setDesiredEnabled(false)
                return privacy.bootstrap()
            } catch (error: Exception) {
                applicationEventsAllowed = false
                privacyInitializationFailure = (error as? PrivacyFault)?.code ?: "native_privacy_unavailable"
                // Diagnostic initialization must not prevent file transfer, including offline/restore recovery.
                return preferences.getBoolean(KEY_ENABLED, true)
            }
        }
        return initAndEnabled(context)
    }
    fun bootstrap(context: Context) {
        appContext = context.applicationContext
        privacyConfig = PrivacyBuildConfiguration.read(context).copy(startupGateVerified = startupAuthorizedThisProcess)
        if (privacyConfig.featureEnabled && !startupAuthorizedThisProcess) {
            if (!privacyConfig.startupComponentsVerified) { privacyInitializationFailure = "native_integration_unverified"; return }
            val decision = try {
                PrivacyStartupGate.sdkDecision(context, PrivacyStore(context).load(), PrivacyKeystore())
            } catch (_: Exception) { PrivacySafetyPolicy.Startup.BLOCK_RESTORE }
            privacyConfig = privacyConfig.copy(startupGateVerified = PrivacySafetyPolicy.allowsSdk(decision))
            if (!PrivacySafetyPolicy.allowsSdk(decision)) { privacyInitializationFailure = "sdk_migration_required"; return }
            startupAuthorizedThisProcess = true
        }
        if (ready) return
        try {
            if (FirebaseApp.initializeApp(context) == null) return
            analytics = FirebaseAnalytics.getInstance(context)
            crashlytics = FirebaseCrashlytics.getInstance()
            ready = true
        } catch (_: Exception) { ready = false }
    }
    fun initAndEnabled(context: Context): Boolean {
        val enabled = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)
        if (privacyConfig.featureEnabled) return privacy(context).bootstrap()
        applyCollectionEnabled(enabled && enableGuard.mayEnable())
        applicationEventsAllowed = enabled && enableGuard.mayEnable()
        return enabled
    }
    fun logEvent(name: String, params: Map<String, String>) {
        if (!ready || !applicationEventsAllowed || !enableGuard.mayEnable()) return
        try { analytics?.logEvent(name, Bundle().apply { params.forEach { (k, v) -> putString(k, v) } }) }
        catch (_: Exception) { }
    }
    fun setUserProperty(name: String, value: String) {
        if (!ready || !applicationEventsAllowed || !enableGuard.mayEnable()) return
        try { analytics?.setUserProperty(name, value) } catch (_: Exception) { }
    }
    fun setEnabled(enabled: Boolean) {
        applicationEventsAllowed = false
        val context = appContext ?: throw PrivacyFault("native_not_initialized")
        if (privacyConfig.featureEnabled) { privacy(context).setDesiredEnabled(enabled); return }
        // Existing default ON and persisted OFF semantics stay the same; failed writes are now reported.
        if (!context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, enabled).commit()) {
            applyCollectionEnabled(false)
            throw PrivacyFault("storage_commit_failed")
        }
        applyCollectionEnabled(enabled && enableGuard.mayEnable())
        applicationEventsAllowed = enabled && enableGuard.mayEnable()
    }
    fun diagnosticsCapabilities(context: Context): JSONObject {
        if (privacyConfig.featureEnabled && privacyInitializationFailure == null) return privacy(context).capabilities()
        return JSONObject().put("schemaVersion", 1).put("platform", "android")
            .put("featureEnabled", privacyConfig.featureEnabled).put("configured", privacyConfig.isConfigured()).put("signedNativeReady", false)
            .put("backendAvailable", false).put("localDeletionAvailable", false).put("remoteDeletionAvailable", false)
            .put("policyVersion", privacyConfig.policyVersion ?: JSONObject.NULL).put("unavailableReason", privacyInitializationFailure ?: "feature_disabled")
    }
    fun diagnosticsStatus(context: Context): JSONObject = if (privacyInitializationFailure != null)
        try { privacy(context).initializationBlocked(privacyInitializationFailure!!).json() }
        catch (_: Exception) { DiagnosticsStatus("blocked", null, false, false, false, false, listOf(privacyInitializationFailure!!), "pending", "pending", "registration_pending").json() }
        else if (privacyConfig.featureEnabled) privacy(context).refreshStatus().json()
        else DiagnosticsStatus("idle", null, false, false, false, false, emptyList(), "pending", "pending",
            if (context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getBoolean(KEY_ENABLED, true)) "enabled" else "disabled_persisted").json()
    fun diagnosticsRequest(context: Context, scope: String, confirmed: Boolean): JSONObject =
        enabledPrivacy(context).request(scope, confirmed).json()
    fun diagnosticsRetry(context: Context): JSONObject = enabledPrivacy(context).retry().json()
    fun diagnosticsContinue(context: Context): JSONObject = enabledPrivacy(context).continueAfterRestart().json()
    private fun enabledPrivacy(context: Context): PrivacyCoordinator {
        if (!privacyConfig.featureEnabled) throw PrivacyFault("feature_disabled")
        return privacy(context)
    }
    private fun privacy(context: Context): PrivacyCoordinator = coordinator ?: PrivacyCoordinator(
        privacyConfig, PrivacyStore(context), FirebasePrivacySdk(), PrivacyKeystore(), privacyTransport,
        { applicationEventsAllowed = false }, { applicationEventsAllowed = it && enableGuard.mayEnable() }, processId,
        mayEnable = { enableGuard.mayEnable() },
    ).also { coordinator = it }
    private class FirebasePrivacySdk : PrivacySdk {
        override val available get() = ready && analytics != null && crashlytics != null
        private fun requireSdk() { if (!available) throw PrivacyFault("sdk_unavailable") }
        override fun collection(analytics: Boolean, crashlytics: Boolean) {
            requireSdk()
            // Independent calls: a failure in one must not prevent attempting the other.
            var failed = false
            var sdkFailed = false
            if (analytics || crashlytics) {
                if (!privacyConfig.isReady()) throw PrivacyFault("native_integration_unverified")
                if (!enableGuard.mayEnable()) throw PrivacyFault("enable_superseded")
                appContext?.let(PrivacyStartupGate::recordMaySend)
                appContext?.let(PrivacyComponentGate::openAfterBind)
            } else {
                try { appContext?.let(PrivacyComponentGate::close) } catch (_: Exception) { failed = true }
            }
            // A component/marker failure must not prevent either independent public SDK stop call.
            try { TelemetryBridge.analytics!!.setAnalyticsCollectionEnabled(analytics) } catch (_: Exception) { sdkFailed = true }
            try { TelemetryBridge.crashlytics!!.setCrashlyticsCollectionEnabled(crashlytics) } catch (_: Exception) { sdkFailed = true }
            if (!sdkFailed && !analytics && !crashlytics) {
                try { appContext?.let(PrivacyStartupGate::recordDisabled) } catch (_: Exception) { failed = true }
            }
            if (failed || sdkFailed) throw PrivacyFault("collection_change_failed")
        }
        override fun bindAnalytics(id: String) { requireSdk(); analytics!!.setUserId(id) }
        override fun bindCrashlytics(id: String) { requireSdk(); crashlytics!!.setUserId(id) }
        override fun oldAnalyticsInstanceId(): String? {
            requireSdk()
            return try { Tasks.await(analytics!!.appInstanceId, 10, TimeUnit.SECONDS) }
            catch (_: InterruptedException) { Thread.currentThread().interrupt(); throw PrivacyFault("sdk_wait_interrupted") }
        }
        override fun resetAnalytics() { requireSdk(); analytics!!.resetAnalyticsData() }
        override fun clearAnalyticsUserId() { requireSdk(); analytics!!.setUserId(null) }
        override fun clearCrashlyticsUserId() { requireSdk(); crashlytics!!.setUserId("") }
        override fun crashCollectionEnabled(): Boolean { requireSdk(); return crashlytics!!.isCrashlyticsCollectionEnabled }
        override fun deleteUnsentCrashReports() { requireSdk(); crashlytics!!.deleteUnsentReports() }
    }
    fun osVersion(): String = Build.VERSION.RELEASE ?: ""
    fun language(): String = Locale.getDefault().language
    private fun applyCollectionEnabled(enabled: Boolean) {
        var failed = !ready
        if (enabled) { try { appContext?.let(PrivacyStartupGate::recordMaySend) } catch (_: Exception) { } }
        try { analytics?.setAnalyticsCollectionEnabled(enabled) } catch (_: Exception) { failed = true }
        try { crashlytics?.setCrashlyticsCollectionEnabled(enabled) } catch (_: Exception) { failed = true }
        // A feature-disabled preparatory build can create safe next-process OFF evidence.
        if (!enabled && !failed) { try { appContext?.let(PrivacyStartupGate::recordDisabled) } catch (_: Exception) { } }
    }
}

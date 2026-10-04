package jp.yasagure.ponlet.platform

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.database.Cursor
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Runs before the default Firebase provider. No Firebase API is called here. */
class PrivacyStartupProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        context?.let { PrivacyStartupGate.prepare(it) }
        return true
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}

object PrivacyBuildConfiguration {
    fun read(context: Context): PrivacyConfig {
        val data = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
        fun text(name: String) = data?.get(name)?.toString()?.takeIf { it.isNotBlank() }
        fun flag(name: String) = text(name) == "true"
        return PrivacyConfig(
            featureEnabled = flag("ponlet_privacy_feature_enabled"),
            apiOrigin = text("ponlet_privacy_api_origin"), audience = text("ponlet_privacy_audience"),
            policyVersion = text("ponlet_privacy_policy_version"),
            receiptRetentionDays = text("ponlet_privacy_receipt_days")?.toIntOrNull(),
            lateArrivalObservationDays = text("ponlet_privacy_observation_days")?.toIntOrNull(),
            retiredKeyPolicy = text("ponlet_privacy_retired_key_policy"),
            backupExclusionVerified = text("ponlet_privacy_backup_rules_version") == "1",
            protocolIntegrationVerified = flag("ponlet_privacy_protocol_verified"),
            startupComponentsVerified = flag("ponlet_privacy_components_verified"),
        )
    }
}

/** Non-backed-up evidence. A backed-up boolean detects restore even when the queue is excluded. */
object PrivacyStartupGate {
    val processId: String = UUID.randomUUID().toString()
    private const val MARKER = "privacy_initialized_once"
    private const val WITNESS = "ponlet_privacy_install.json"
    @Volatile private var prepared = false
    @Volatile private var failure: String? = null
    private fun legacy(context: Context) = context.getSharedPreferences("telemetry_prefs", Context.MODE_PRIVATE)
    private fun file(context: Context) = AtomicFile(File(context.noBackupFilesDir, WITNESS))
    private fun read(context: Context): JSONObject? = file(context).let {
        if (!it.baseFile.exists()) null else JSONObject(it.openRead().use { stream -> stream.readBytes().toString(Charsets.UTF_8) })
    }
    private fun write(context: Context, value: JSONObject) {
        val target = file(context)
        val output = target.startWrite()
        try { output.write(value.toString().toByteArray(Charsets.UTF_8)); target.finishWrite(output) }
        catch (error: Exception) { target.failWrite(output); throw PrivacyFault("startup_evidence_write_failed") }
    }
    fun restoreDetected(context: Context): Boolean = legacy(context).getBoolean(MARKER, false) && !file(context).baseFile.exists()

    @Synchronized fun prepare(context: Context) {
        if (prepared) return
        prepared = true
        try {
            if (!PrivacyBuildConfiguration.read(context).featureEnabled) {
                PrivacyComponentGate.restoreLegacyDefaults(context); return
            }
            PrivacyComponentGate.close(context)
            if (restoreDetected(context)) { failure = "restore_recovery_required"; return }
            var witness = read(context)
            if (witness == null) {
                // Any pre-existing private data makes this an unknown upgrade/restore, not a fresh install.
                val root = File(context.applicationInfo.dataDir)
                val previousData = listOf("shared_prefs", "files", "databases").any { name ->
                    File(root, name).listFiles()?.isNotEmpty() == true
                }
                if (previousData) { failure = "sdk_migration_required"; return }
                witness = JSONObject().put("schemaVersion", 1).put("mode", "fresh_disabled")
                    .put("processId", processId).put("installId", UUID.randomUUID().toString())
                write(context, witness)
            }
            if (!legacy(context).edit().putBoolean(MARKER, true).commit()) throw PrivacyFault("storage_commit_failed")
        } catch (_: Exception) { failure = "startup_evidence_unavailable" }
    }

    fun sdkDecision(context: Context, state: PrivacyState, keys: PrivacyKeystore): PrivacySafetyPolicy.Startup {
        prepare(context)
        val feature = PrivacyBuildConfiguration.read(context).featureEnabled
        if (!feature) return PrivacySafetyPolicy.Startup.LEGACY
        if (failure != null) return if (restoreDetected(context)) PrivacySafetyPolicy.Startup.BLOCK_RESTORE else PrivacySafetyPolicy.Startup.BLOCK_MIGRATION
        val witness = try { read(context) } catch (_: Exception) { null }
        val mode = witness?.optString("mode")
        val keyPresent = state.active?.let { runCatching { keys.exists(it.keyAlias) }.getOrDefault(false) } ?: false
        return PrivacySafetyPolicy.startup(feature, restoreDetected(context), mode == "fresh_disabled",
            mode == "sdk_disabled" && witness?.optString("processId") != processId,
            state.active != null, keyPresent,
            state.active?.analyticsCoverageStartAt != null && state.active?.crashlyticsCoverageStartAt != null &&
                state.active?.retention?.workerConfirmed == true,
            state.desiredEnabled)
    }
    /** Called only after BOTH public SDK set-collection(false) methods returned successfully. */
    @Synchronized fun recordDisabled(context: Context) {
        val witness = read(context) ?: JSONObject().put("schemaVersion", 1).put("installId", UUID.randomUUID().toString())
        write(context, witness.put("mode", "sdk_disabled").put("processId", processId))
        if (!legacy(context).edit().putBoolean(MARKER, true).commit()) throw PrivacyFault("storage_commit_failed")
    }
    /** Save before enabling either SDK, so a process death cannot leave a stale fresh/disabled proof. */
    @Synchronized fun recordMaySend(context: Context) {
        val witness = read(context) ?: JSONObject().put("schemaVersion", 1).put("installId", UUID.randomUUID().toString())
        write(context, witness.put("mode", "sdk_may_send").put("processId", processId))
    }
}

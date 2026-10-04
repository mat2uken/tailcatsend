package jp.yasagure.ponlet.platform

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.nullableString(key: String): String? =
    if (isNull(key) || !has(key)) null else PrivacyResponseRules.requireString(get(key))
internal fun JSONObject.nullableObject(key: String): JSONObject? =
    if (isNull(key) || !has(key)) null else getJSONObject(key)

data class PendingEnrollment(val requestId: String, val keyAlias: String, val publicKeyThumbprint: String? = null) {
    fun json() = JSONObject().put("requestId", requestId).put("keyAlias", keyAlias)
        .put("publicKeyThumbprint", publicKeyThumbprint ?: JSONObject.NULL)
    companion object { fun read(o: JSONObject) = PendingEnrollment(o.getString("requestId"), o.getString("keyAlias"), o.nullableString("publicKeyThumbprint")) }
}
data class RetentionSnapshot(val policyVersion: String, val receiptDays: Int, val observationDays: Int,
    val retiredKeyPolicy: String, val workerMappingDays: Int? = null, val workerConfirmed: Boolean = false) {
    init {
        require(policyVersion.matches(Regex("[a-zA-Z0-9_-]{1,80}")) && PrivacySafetyPolicy.validRetention(receiptDays, observationDays, retiredKeyPolicy))
        require(!workerConfirmed || (workerMappingDays != null &&
            PrivacySafetyPolicy.workerRetentionMatches(receiptDays.toLong(), workerMappingDays.toLong(), retiredKeyPolicy, receiptDays, retiredKeyPolicy)))
    }
    fun json() = JSONObject().put("policyVersion", policyVersion).put("receiptDays", receiptDays)
        .put("observationDays", observationDays).put("retiredKeyPolicy", retiredKeyPolicy)
        .put("workerMappingDays", workerMappingDays ?: JSONObject.NULL).put("workerConfirmed", workerConfirmed)
    companion object {
        fun read(o: JSONObject) = RetentionSnapshot(o.getString("policyVersion"),
            PrivacyResponseRules.requireInteger(o.get("receiptDays"), 1, 3650).toInt(),
            PrivacyResponseRules.requireInteger(o.get("observationDays"), 1, 3650).toInt(), o.getString("retiredKeyPolicy"),
            if (!o.has("workerMappingDays") || o.isNull("workerMappingDays")) null else
                PrivacyResponseRules.requireInteger(o.get("workerMappingDays"), 1, 3650).toInt(),
            o.has("workerConfirmed") && PrivacyResponseRules.requireBoolean(o.get("workerConfirmed")))
        fun from(config: PrivacyConfig, mappingDays: Int): RetentionSnapshot? = if (config.isConfigured())
            RetentionSnapshot(config.policyVersion!!, config.receiptRetentionDays!!, config.lateArrivalObservationDays!!,
                config.retiredKeyPolicy!!, mappingDays, true) else null
    }
}
data class AcknowledgedClientState(val futureTelemetry: String, val analyticsLocal: String, val crashlyticsLocal: String) {
    fun json() = JSONObject().put("futureTelemetry", futureTelemetry).put("analyticsLocal", analyticsLocal).put("crashlyticsLocal", crashlyticsLocal)
    companion object { fun read(o: JSONObject) = AcknowledgedClientState(PrivacyResponseRules.requireString(o.get("futureTelemetry")), PrivacyResponseRules.requireString(o.get("analyticsLocal")), PrivacyResponseRules.requireString(o.get("crashlyticsLocal"))) }
}
data class BoundEpoch(
    val epochId: String, val keyAlias: String, val analyticsUserId: String,
    val crashlyticsUserId: String, val issuedAt: String, val policyVersion: String,
    val analyticsCoverageStartAt: Long? = null, val crashlyticsCoverageStartAt: Long? = null,
    val retention: RetentionSnapshot? = null,
) {
    init {
        require(epochId.matches(Regex("[A-Za-z0-9_-]{16,128}")))
        require(analyticsUserId.matches(Regex("[A-Za-z0-9_-]{22,128}")))
        require(crashlyticsUserId.matches(Regex("[A-Za-z0-9_-]{22,128}")))
        require(analyticsUserId != crashlyticsUserId)
    }
    fun json() = JSONObject().put("epochId", epochId).put("keyAlias", keyAlias)
        .put("analyticsUserId", analyticsUserId).put("crashlyticsUserId", crashlyticsUserId)
        .put("issuedAt", issuedAt).put("policyVersion", policyVersion)
        .put("analyticsCoverageStartAt", analyticsCoverageStartAt ?: JSONObject.NULL)
        .put("crashlyticsCoverageStartAt", crashlyticsCoverageStartAt ?: JSONObject.NULL)
        .put("retention", retention?.json() ?: JSONObject.NULL)
    companion object { fun read(o: JSONObject) = BoundEpoch(o.getString("epochId"), o.getString("keyAlias"),
        o.getString("analyticsUserId"), o.getString("crashlyticsUserId"), o.getString("issuedAt"), o.getString("policyVersion"),
        if (o.isNull("analyticsCoverageStartAt")) null else o.getLong("analyticsCoverageStartAt"),
        if (o.isNull("crashlyticsCoverageStartAt")) null else o.getLong("crashlyticsCoverageStartAt"),
        o.nullableObject("retention")?.let(RetentionSnapshot::read)) }
}
data class RemoteProviderState(val state: String, val errorCode: String?, val additionalSubmissionRequired: Boolean) {
    fun json() = JSONObject().put("state", state).put("errorCode", errorCode ?: JSONObject.NULL)
        .put("additionalSubmissionRequired", additionalSubmissionRequired)
    companion object { fun read(o: JSONObject) = RemoteProviderState(o.getString("state"), o.nullableString("errorCode"),
        if (o.has("additionalSubmissionRequired")) PrivacyResponseRules.requireBoolean(o.get("additionalSubmissionRequired")) else false) }
}
data class PrivacyTicket(
    val requestId: String, val scope: String, val epoch: BoundEpoch?, val startedInProcess: String,
    val createdAt: Long, val snapshotState: String = "pending", val oldAnalyticsInstanceId: String? = null,
    val analyticsLocal: String = "pending", val crashlyticsLocal: String = "restart_required",
    val serverAccepted: Boolean = false, val analyticsSubmitted: Boolean = false,
    val crashlyticsSubmitted: Boolean = false, val failures: List<String> = emptyList(),
    val nextRetryAt: Long = 0, val serverRequestId: String? = null,
    val remoteState: String? = null, val analyticsProvider: RemoteProviderState? = null,
    val crashlyticsProvider: RemoteProviderState? = null,
    val settledEvidenceAt: Long? = null, val lastLocalMutationAt: Long = createdAt,
    val lastRemoteObservedAt: Long? = null,
    val retention: RetentionSnapshot? = null, val acknowledgedClientState: AcknowledgedClientState? = null,
    val serverClientContinuation: String? = null,
) {
    fun json() = JSONObject().put("requestId", requestId).put("scope", scope)
        .put("epoch", epoch?.json() ?: JSONObject.NULL).put("startedInProcess", startedInProcess)
        .put("createdAt", createdAt).put("snapshotState", snapshotState)
        .put("oldAnalyticsInstanceId", oldAnalyticsInstanceId ?: JSONObject.NULL)
        .put("analyticsLocal", analyticsLocal).put("crashlyticsLocal", crashlyticsLocal)
        .put("serverAccepted", serverAccepted).put("analyticsSubmitted", analyticsSubmitted)
        .put("crashlyticsSubmitted", crashlyticsSubmitted).put("failures", JSONArray(failures))
        .put("nextRetryAt", nextRetryAt).put("serverRequestId", serverRequestId ?: JSONObject.NULL)
        .put("remoteState", remoteState ?: JSONObject.NULL)
        .put("analyticsProvider", analyticsProvider?.json() ?: JSONObject.NULL)
        .put("crashlyticsProvider", crashlyticsProvider?.json() ?: JSONObject.NULL)
        .put("settledEvidenceAt", settledEvidenceAt ?: JSONObject.NULL).put("settledEvidenceClock", "http_date_upper_bound_v1")
        .put("lastLocalMutationAt", lastLocalMutationAt)
        .put("lastRemoteObservedAt", lastRemoteObservedAt ?: JSONObject.NULL)
        .put("retention", retention?.json() ?: JSONObject.NULL)
        .put("acknowledgedClientState", acknowledgedClientState?.json() ?: JSONObject.NULL)
        .put("serverClientContinuation", serverClientContinuation ?: JSONObject.NULL)
    companion object { fun read(o: JSONObject): PrivacyTicket {
        val failures = o.getJSONArray("failures")
        return PrivacyTicket(o.getString("requestId"), o.getString("scope"), o.nullableObject("epoch")?.let(BoundEpoch::read),
            o.getString("startedInProcess"), o.getLong("createdAt"), o.getString("snapshotState"), o.nullableString("oldAnalyticsInstanceId"),
            o.getString("analyticsLocal"), o.getString("crashlyticsLocal"), o.getBoolean("serverAccepted"),
            o.getBoolean("analyticsSubmitted"), o.getBoolean("crashlyticsSubmitted"),
            (0 until failures.length()).map { failures.getString(it) }, o.getLong("nextRetryAt"), o.nullableString("serverRequestId"), o.nullableString("remoteState"),
            o.nullableObject("analyticsProvider")?.let(RemoteProviderState::read),
            o.nullableObject("crashlyticsProvider")?.let(RemoteProviderState::read),
            if (o.nullableString("settledEvidenceClock") != "http_date_upper_bound_v1" || o.isNull("settledEvidenceAt") || !o.has("settledEvidenceAt")) null else o.getLong("settledEvidenceAt"),
            o.optLong("lastLocalMutationAt", o.getLong("createdAt")),
            if (o.isNull("lastRemoteObservedAt") || !o.has("lastRemoteObservedAt")) null else o.getLong("lastRemoteObservedAt"),
            o.nullableObject("retention")?.let(RetentionSnapshot::read),
            o.nullableObject("acknowledgedClientState")?.let(AcknowledgedClientState::read), o.nullableString("serverClientContinuation"))
    } }
}
data class ExpiredPrivacyReceipt(val requestId: String, val expiredAt: Long, val keyCleanupPending: Boolean,
    val logicalRequestId: String = requestId) {
    // requestId is the canonical server ID shown in UI; logicalRequestId keeps the explicit local selection stable.
    fun json() = JSONObject().put("requestId", requestId).put("expiredAt", expiredAt).put("keyCleanupPending", keyCleanupPending)
        .put("logicalRequestId", logicalRequestId)
    companion object { fun read(o: JSONObject) = ExpiredPrivacyReceipt(o.getString("requestId"), o.getLong("expiredAt"),
        o.getBoolean("keyCleanupPending"), o.nullableString("logicalRequestId") ?: o.getString("requestId")) }
}
data class RetiredKeyCleanup(val requestId: String, val keyAlias: String) {
    fun json() = JSONObject().put("requestId", requestId).put("keyAlias", keyAlias)
    companion object { fun read(o: JSONObject) = RetiredKeyCleanup(o.getString("requestId"), o.getString("keyAlias")) }
}
data class PrivacyState(
    val desiredEnabled: Boolean, val active: BoundEpoch? = null, val pending: PendingEnrollment? = null,
    val tickets: List<PrivacyTicket> = emptyList(), val failedClosed: Boolean = false,
    val expiredReceipts: List<ExpiredPrivacyReceipt> = emptyList(), val cleanupKeys: List<RetiredKeyCleanup> = emptyList(),
    val currentRequestId: String? = null,
) {
    fun json() = JSONObject().put("schemaVersion", 1).put("desiredEnabled", desiredEnabled)
        .put("active", active?.json() ?: JSONObject.NULL).put("pending", pending?.json() ?: JSONObject.NULL)
        .put("tickets", JSONArray(tickets.map { it.json() })).put("failedClosed", failedClosed)
        .put("expiredReceipts", JSONArray(expiredReceipts.map { it.json() })).put("cleanupKeys", JSONArray(cleanupKeys.map { it.json() }))
        .put("currentRequestId", currentRequestId ?: JSONObject.NULL)
    companion object { fun read(o: JSONObject): PrivacyState {
        PrivacyResponseRules.requireSchemaVersion(o.get("schemaVersion"))
        val array = o.getJSONArray("tickets")
        val tickets = (0 until array.length()).map { PrivacyTicket.read(array.getJSONObject(it)) }
        val expired = o.optJSONArray("expiredReceipts")?.let { a ->
            (0 until a.length()).map { ExpiredPrivacyReceipt.read(a.getJSONObject(it)) } } ?: emptyList()
        val cleanup = o.optJSONArray("cleanupKeys")?.let { a ->
            (0 until a.length()).map { RetiredKeyCleanup.read(a.getJSONObject(it)) } } ?: emptyList()
        val current = PrivacySafetyPolicy.currentRequest(o.nullableString("currentRequestId"),
            tickets.map { it.requestId }.toTypedArray(), expired.map { it.logicalRequestId }.toTypedArray())
        return PrivacyState(o.getBoolean("desiredEnabled"), o.nullableObject("active")?.let(BoundEpoch::read),
            o.nullableObject("pending")?.let(PendingEnrollment::read), tickets, o.getBoolean("failedClosed"), expired, cleanup, current)
    } }

}

/** Dedicated non-backed-up queue. Stop intent and old target are atomic within this file.
 *  Legacy opt-out is a second durable mirror, not an atomic cross-file transaction.
 */
class PrivacyStore(private val context: Context) {
    private val preferences = context.getSharedPreferences("ponlet_privacy_state", Context.MODE_PRIVATE)
    private val legacy = context.getSharedPreferences("telemetry_prefs", Context.MODE_PRIVATE)
    fun load(): PrivacyState = try {
        if (PrivacyStartupGate.restoreDetected(context)) throw PrivacyFault("restore_recovery_required")
        var serialized = preferences.getString("privacy_state_v1", null)
        // Only supports the unpublished prototype layout; no shipped release used this key.
        if (serialized == null) {
            legacy.getString("privacy_state_v1", null)?.let { old ->
                val migrated = PrivacyState.read(JSONObject(old))
                writePrimary(migrated)
                if (!legacy.edit().remove("privacy_state_v1").commit()) throw PrivacyFault("migration_cleanup_failed")
                serialized = old
            }
        } else if (legacy.contains("privacy_state_v1")) {
            if (!legacy.edit().remove("privacy_state_v1").commit()) throw PrivacyFault("migration_cleanup_failed")
        }
        val enabled = legacy.getBoolean("telemetry_enabled", true)
        if (serialized == null) PrivacyState(enabled) else {
            val saved = PrivacyState.read(JSONObject(serialized!!))
            val effective = PrivacySafetyPolicy.effectiveDesired(true, saved.desiredEnabled, enabled)
            if (PrivacySafetyPolicy.needsLegacyStopMirror(true, saved.desiredEnabled, enabled)) {
                // Recover a crash between primary stop-intent commit and opt-out mirror commit, before SDK init.
                if (!legacy.edit().putBoolean("telemetry_enabled", false).commit()) throw PrivacyFault("storage_mirror_failed")
            }
            val recovered = saved.copy(desiredEnabled = effective)
            if (recovered != saved) writePrimary(recovered)
            recovered
        }
    } catch (error: PrivacyFault) { throw error }
      catch (_: Exception) { throw PrivacyFault("storage_corrupt") }
    private fun writePrimary(state: PrivacyState) {
        val ok = try { preferences.edit().putBoolean("telemetry_enabled", state.desiredEnabled)
            .putString("privacy_state_v1", state.json().toString()).commit() } catch (_: Exception) { false }
        if (!ok) throw PrivacyFault("storage_commit_failed")
    }
    fun commit(state: PrivacyState) {
        writePrimary(state) // Atomic stop intent + stable request + old epoch/IDs, before any SDK reset.
        val mirrored = try { legacy.edit().putBoolean("telemetry_enabled", state.desiredEnabled).commit() }
            catch (_: Exception) { false }
        if (!mirrored) throw PrivacyFault("storage_mirror_failed")
    }
}

package jp.yasagure.ponlet.platform

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

interface PrivacySdk {
    val available: Boolean
    fun collection(analytics: Boolean, crashlytics: Boolean)
    fun bindAnalytics(id: String)
    fun bindCrashlytics(id: String)
    fun oldAnalyticsInstanceId(): String?
    fun resetAnalytics()
    fun clearAnalyticsUserId()
    fun clearCrashlyticsUserId()
    fun crashCollectionEnabled(): Boolean
    fun deleteUnsentCrashReports()
}

data class PreviousPrivacyRequest(val requestId: String, val serverAccepted: Boolean,
    val analyticsSubmitted: Boolean, val crashlyticsSubmitted: Boolean, val restartRequired: Boolean, val state: String,
    val remoteState: String? = null, val analyticsProvider: RemoteProviderState? = null,
    val crashlyticsProvider: RemoteProviderState? = null,
    val retentionExpired: Boolean = false, val keyCleanupPending: Boolean = false) {
    fun json() = JSONObject().put("requestId", requestId).put("serverAccepted", serverAccepted)
        .put("providerAccepted", JSONObject().put("analytics", analyticsSubmitted).put("crashlytics", crashlyticsSubmitted))
        .put("restartRequired", restartRequired).put("state", state)
        .put("retentionExpired", retentionExpired).put("keyCleanupPending", keyCleanupPending)
        .put("remoteState", remoteState ?: JSONObject.NULL)
        .put("providerStates", JSONObject().put("analytics", analyticsProvider?.json() ?: JSONObject.NULL)
            .put("crashlytics", crashlyticsProvider?.json() ?: JSONObject.NULL))
}

data class DiagnosticsStatus(
    val state: String, val requestId: String?, val serverAccepted: Boolean,
    val analyticsSubmitted: Boolean, val crashlyticsSubmitted: Boolean,
    val restartRequired: Boolean, val partialFailures: List<String>,
    val analyticsLocal: String, val crashlyticsLocal: String, val futureTelemetry: String,
    val previousRequests: List<PreviousPrivacyRequest> = emptyList(),
    val remoteState: String? = null, val analyticsProvider: RemoteProviderState? = null,
    val crashlyticsProvider: RemoteProviderState? = null,
    val retentionExpired: Boolean = false, val keyCleanupPending: Boolean = false,
) {
    fun json() = JSONObject().put("schemaVersion", 1).put("state", state)
        .put("requestId", requestId ?: JSONObject.NULL).put("serverAccepted", serverAccepted)
        .put("providerAccepted", JSONObject().put("analytics", analyticsSubmitted).put("crashlytics", crashlyticsSubmitted))
        .put("restartRequired", restartRequired).put("partialFailures", JSONArray(partialFailures))
        .put("excludedData", JSONArray(listOf("legacy_unbound", "mlkit")))
        .put("analyticsLocal", analyticsLocal).put("crashlyticsLocal", crashlyticsLocal).put("futureTelemetry", futureTelemetry)
        .put("previousRequests", JSONArray(previousRequests.map { it.json() }))
        .put("retentionExpired", retentionExpired).put("keyCleanupPending", keyCleanupPending)
        .put("remoteState", remoteState ?: JSONObject.NULL)
        .put("providerStates", JSONObject().put("analytics", analyticsProvider?.json() ?: JSONObject.NULL)
            .put("crashlytics", crashlyticsProvider?.json() ?: JSONObject.NULL))
}

/** Single-owner coordinator. All operations run on the native serial executor, never the UI thread. */
class PrivacyCoordinator(
    private val config: PrivacyConfig,
    private val store: PrivacyStore,
    private val sdk: PrivacySdk,
    private val keys: PrivacyKeystore,
    private val transport: PrivacyTransport?,
    private val stopApplicationEvents: () -> Unit,
    private val allowApplicationEvents: (Boolean) -> Unit,
    private val processId: String,
    private val now: () -> Long = System::currentTimeMillis,
    private val newId: () -> String = { UUID.randomUUID().toString() },
    private val mayEnable: () -> Boolean = { true },
) {
    private var state = store.load()
    private var operationFailure: String? = null
    private var storageUncertain = false
    private var collectionEnabledThisProcess = false
    private fun stopEvents() { collectionEnabledThisProcess = false; stopApplicationEvents() }
    private fun futureState(): String = when {
        storageUncertain -> "persistence_incomplete"
        !state.desiredEnabled -> "disabled_persisted"
        config.featureEnabled && (!collectionEnabledThisProcess || !mayEnable()) -> "registration_pending"
        else -> "enabled"
    }
    private fun recoverStorage() {
        if (storageUncertain) { state = store.load(); storageUncertain = false }
    }

    @Synchronized fun capabilities(): JSONObject = JSONObject().put("schemaVersion", 1).put("platform", "android")
        .put("featureEnabled", config.featureEnabled).put("configured", config.isConfigured())
        .put("signedNativeReady", config.isReady()).put("backendAvailable", transport?.available == true)
        .put("localDeletionAvailable", config.isLocalReady() && sdk.available)
        .put("remoteDeletionAvailable", config.isReady() && sdk.available && transport?.available == true && (state.active != null || state.tickets.any { it.scope == "bound_remote" && it.epoch != null }))
        .put("policyVersion", config.policyVersion ?: JSONObject.NULL)
        .put("unavailableReason", when {
            !config.featureEnabled -> "feature_disabled"
            !config.isConfigured() -> "not_configured"
            !config.isReady() -> "native_integration_unverified"
            transport?.available != true -> "app_check_unavailable"
            !sdk.available -> "sdk_unavailable"
            else -> JSONObject.NULL
        })

    /** Called before normal telemetry event/property dispatch. Default-ON preference is untouched. */
    @Synchronized fun bootstrap(): Boolean {
        recoverStorage()
        if (!config.featureEnabled) return state.desiredEnabled
        drainRetiredKeys()
        stopEvents()
        try { sdk.collection(false, false) } catch (error: Exception) {
            operationFailure = safeCode(error); return state.desiredEnabled
        }
        // Resume local work first; a missing server must never block stopping local collection.
        state.tickets.filter { it.crashlyticsLocal in setOf("restart_required", "pending", "failed", "unavailable") || it.analyticsLocal in setOf("pending", "failed", "unavailable") }
            .map { it.requestId }.forEach { continueLocal(it) }
        if (state.desiredEnabled) enrollAndBind()
        return state.desiredEnabled
    }

    @Synchronized fun setDesiredEnabled(enabled: Boolean) {
        recoverStorage()
        stopEvents()
        save(state.copy(desiredEnabled = enabled))
        sdk.collection(false, false)
        if (!config.featureEnabled) { sdk.collection(enabled, enabled); allowApplicationEvents(enabled); return }
        if (enabled) enrollAndBind() else operationFailure = null
    }

    private fun enrollAndBind() {
        if (!state.desiredEnabled || state.failedClosed || !mayEnable()) return
        if (state.tickets.any { it.analyticsLocal != "reset_requested" || it.crashlyticsLocal != "delete_queued" }) {
            operationFailure = "local_continuation_required"; return
        }
        if (!config.isReady() || transport?.available != true) { operationFailure = "registration_unavailable"; return }
        try {
            var epoch = state.active
            if (epoch == null) {
                var pending = state.pending
                if (pending == null) {
                    val id = newId()
                    pending = PendingEnrollment(id, "ponlet_privacy_$id")
                    save(state.copy(pending = pending)) // Stable identity before key creation/network.
                }
                if (pending.publicKeyThumbprint != null && !keys.exists(pending.keyAlias)) throw PrivacyFault("key_unavailable")
                keys.createForPendingEnrollment(pending.keyAlias)
                val currentKid = keys.kid(pending.keyAlias)
                if (pending.publicKeyThumbprint != null && pending.publicKeyThumbprint != currentKid) throw PrivacyFault("key_unavailable")
                if (pending.publicKeyThumbprint == null) {
                    pending = pending.copy(publicKeyThumbprint = currentKid)
                    save(state.copy(pending = pending)) // Proof identity is durable before the first enrollment request.
                }
                val registered = transport.enroll(pending)
                // Retired identifiers are NEVER reused for a new active epoch.
                if (state.tickets.any { it.epoch?.epochId == registered.epochId ||
                        it.epoch?.analyticsUserId == registered.analyticsUserId || it.epoch?.crashlyticsUserId == registered.crashlyticsUserId })
                    throw PrivacyFault("retired_epoch_reused")
                save(state.copy(active = registered, pending = null))
                epoch = registered
            }
            // Unverified old snapshots cannot authorize resume or early retention cleanup.
            if (epoch.retention?.workerConfirmed != true) throw PrivacyFault("retention_unverified")
            // Restored backup with no key cannot silently create a replacement identity.
            if (!keys.exists(epoch.keyAlias)) throw PrivacyFault("key_unavailable")
            sdk.bindAnalytics(epoch.analyticsUserId)
            epoch = epoch.copy(analyticsCoverageStartAt = epoch.analyticsCoverageStartAt ?: now())
            save(state.copy(active = epoch))
            sdk.bindCrashlytics(epoch.crashlyticsUserId)
            epoch = epoch.copy(crashlyticsCoverageStartAt = epoch.crashlyticsCoverageStartAt ?: now())
            save(state.copy(active = epoch))
            if (!mayEnable()) { operationFailure = "enable_superseded"; return }
            sdk.collection(true, true)
            // An opt-out can arrive while the SDK call is in progress. Do not reopen event dispatch.
            if (!mayEnable()) { sdk.collection(false, false); operationFailure = "enable_superseded"; return }
            collectionEnabledThisProcess = true
            allowApplicationEvents(true)
            operationFailure = null
        } catch (error: Exception) {
            stopEvents()
            runCatching { sdk.collection(false, false) }
            operationFailure = safeCode(error)
        }
    }

    @Synchronized fun request(scope: String, confirmed: Boolean): DiagnosticsStatus {
        recoverStorage()
        if (!confirmed || scope !in setOf("local", "bound_remote")) throw PrivacyFault("confirmation_required")
        if (!config.featureEnabled) throw PrivacyFault("feature_disabled")
        if (!config.isLocalReady()) throw PrivacyFault("native_integration_unverified")
        if (scope == "bound_remote" && (!config.isReady() || transport?.available != true)) throw PrivacyFault("not_configured")
        if (state.active == null && state.tickets.isNotEmpty()) {
            // Repeated deletion still means STOP, even if a later ON is waiting for registration.
            // Preserve identity, but do not let retry() re-enable after finishing old local work.
            stopEvents()
            save(state.copy(desiredEnabled = false))
            return retry()
        }
        if (scope == "bound_remote" && state.active == null) throw PrivacyFault("no_bound_epoch")
        stopEvents() // Even a failed durable write keeps this process silent.
        val ticket = PrivacyTicket(newId(), scope, state.active, processId, now(),
            retention = state.active?.retention) // Unknown old policy is retained, never guessed from current config.
        try {
            // Atomically stop, snapshot the bound IDs/key and retire active epoch BEFORE any reset.
            save(state.copy(desiredEnabled = false, active = null, pending = if (state.active == null) state.pending else null, tickets = state.tickets + ticket,
                currentRequestId = ticket.requestId))
        } catch (error: Exception) {
            runCatching { sdk.collection(false, false) }
            operationFailure = safeCode(error)
            return status()
        }
        continueLocal(ticket.requestId)
        if (scope == "bound_remote") submit(ticket.requestId)
        return status()
    }

    private fun continueLocal(id: String) {
        var ticket = state.tickets.first { it.requestId == id }
        operationFailure = null
        try { sdk.collection(false, false) } catch (error: Exception) {
            updateTicket(ticket.copy(failures = (ticket.failures + safeCode(error)).distinct())); return
        }
        ticket = ticket.copy(failures = ticket.failures.filterNot { PrivacySafetyPolicy.resolvedStopFailure(it) })
        updateTicket(ticket)
        if (!sdk.available) {
            updateTicket(ticket.copy(analyticsLocal = "unavailable", crashlyticsLocal = "unavailable",
                failures = (ticket.failures + "sdk_unavailable").distinct())); return
        }
        if (PrivacySafetyPolicy.retrySnapshot(ticket.snapshotState, ticket.analyticsLocal)) {
            val oldId = try { sdk.oldAnalyticsInstanceId() } catch (_: Exception) {
                // Per-ticket evidence survives subsequent items in a multi-history retry.
                updateTicket(ticket.copy(failures = (ticket.failures + "snapshot_unavailable").distinct()))
                return // Keep all IDs and reset pending; no fallback to a new ID.
            }
            ticket = ticket.copy(snapshotState = if (oldId.isNullOrBlank()) "unavailable" else "captured",
                oldAnalyticsInstanceId = oldId?.takeIf { it.isNotBlank() },
                failures = ticket.failures.filterNot { it == "snapshot_unavailable" })
            updateTicket(ticket) // No reset occurs until THIS commit is durable. Storage failure stops this batch.
        }
        if (ticket.analyticsLocal in setOf("pending", "failed", "unavailable")) {
            ticket = if (ticket.snapshotState == "captured") {
                try {
                    sdk.resetAnalytics()
                    sdk.clearAnalyticsUserId()
                    ticket.copy(analyticsLocal = "reset_requested", failures = ticket.failures.filterNot { it == "analytics_reset_failed" || it == "old_id_unavailable" })
                } catch (_: Exception) { ticket.copy(analyticsLocal = "failed", failures = (ticket.failures + "analytics_reset_failed").distinct()) }
            } else {
                // Safe stop, but cannot claim preserved pre-reset identifiers or reset completion.
                ticket.copy(analyticsLocal = "failed", failures = (ticket.failures + "old_id_unavailable").distinct())
            }
            updateTicket(ticket)
        }
        if (ticket.crashlyticsLocal in setOf("restart_required", "pending", "failed", "unavailable")) {
            ticket = try {
                // A same-process collection override alone is not proof that Crashlytics stopped.
                if (ticket.startedInProcess == processId || sdk.crashCollectionEnabled()) {
                    ticket.copy(crashlyticsLocal = "restart_required")
                } else {
                    sdk.deleteUnsentCrashReports()
                    sdk.clearCrashlyticsUserId()
                    ticket.copy(crashlyticsLocal = "delete_queued", failures = ticket.failures.filterNot { it == "crash_local_failed" })
                }
            } catch (_: Exception) { ticket.copy(crashlyticsLocal = "failed", failures = (ticket.failures + "crash_local_failed").distinct()) }
            updateTicket(ticket)
        }
    }

    @Synchronized fun continueAfterRestart(): DiagnosticsStatus {
        recoverStorage()
        if (!config.featureEnabled) throw PrivacyFault("feature_disabled")
        if (!config.isLocalReady()) throw PrivacyFault("native_integration_unverified")
        state.tickets.map { it.requestId }.forEach { id ->
            continueLocal(id)
            val ticket = state.tickets.first { it.requestId == id }
            if (ticket.serverAccepted && ticket.scope == "bound_remote") {
                try { mergeReceipt(ticket.requestId, transportOrFail().clientState(ticket)) } catch (error: Exception) { recordFailure(ticket, error) }
            }
        }
        if (state.desiredEnabled) enrollAndBind()
        return status()
    }

    @Synchronized fun retry(): DiagnosticsStatus {
        recoverStorage()
        if (!config.featureEnabled) throw PrivacyFault("feature_disabled")
        if (!config.isLocalReady()) throw PrivacyFault("native_integration_unverified")
        state.tickets.map { it.requestId }.forEach { id ->
            continueLocal(id)
            val ticket = state.tickets.first { it.requestId == id }
            if (ticket.scope == "bound_remote" && now() >= ticket.nextRetryAt) submit(id)
        }
        if (state.desiredEnabled) enrollAndBind()
        return status()
    }
    private fun submit(id: String) {
        try { recoverStorage() } catch (error: Exception) { operationFailure = safeCode(error); return }
        val ticket = state.tickets.first { it.requestId == id }
        if (ticket.epoch == null) return
        try {
            val remote = transportOrFail()
            val receipt = if (ticket.serverAccepted) remote.clientState(ticket) else remote.submit(ticket)
            mergeReceipt(id, receipt)
        } catch (error: Exception) { recordFailure(ticket, error) }
    }
    private fun mergeReceipt(id: String, receipt: PrivacyReceipt) {
        val ticket = state.tickets.first { it.requestId == id }
        updateTicket(ticket.copy(serverAccepted = true, serverRequestId = receipt.requestId,
            analyticsSubmitted = ticket.analyticsSubmitted || receipt.analyticsSubmitted,
            crashlyticsSubmitted = ticket.crashlyticsSubmitted || receipt.crashlyticsSubmitted,
            nextRetryAt = 0, failures = (ticket.failures.filterNot { it in REMOTE_ERRORS || it in PROVIDER_ERRORS } + receipt.failures).distinct(),
            remoteState = receipt.remoteState, analyticsProvider = receipt.analyticsProvider, crashlyticsProvider = receipt.crashlyticsProvider,
            acknowledgedClientState = receipt.acknowledgedClientState, serverClientContinuation = receipt.clientContinuation,
            settledEvidenceAt = if (receipt.remoteState == "provider_submitted" &&
                receipt.analyticsProvider.state == "submitted" && receipt.crashlyticsProvider.state == "submitted" &&
                !receipt.analyticsProvider.additionalSubmissionRequired && !receipt.crashlyticsProvider.additionalSubmissionRequired &&
                PrivacySafetyPolicy.acknowledgedAndSettled(ticket.analyticsLocal, ticket.crashlyticsLocal,
                    receipt.acknowledgedClientState.futureTelemetry, receipt.acknowledgedClientState.analyticsLocal,
                    receipt.acknowledgedClientState.crashlyticsLocal, receipt.clientContinuation) &&
                receipt.serverObservedAt != null)
                ticket.settledEvidenceAt ?: PrivacyHttpTime.settledAnchorMillis(receipt.serverObservedAt) else null,
            lastRemoteObservedAt = PrivacySafetyPolicy.advanceServerClock(ticket.lastRemoteObservedAt, receipt.serverObservedAt)))
        operationFailure = null
    }
    private fun notificationPending(ticket: PrivacyTicket): Boolean = ticket.scope == "bound_remote" && ticket.serverAccepted &&
        PrivacySafetyPolicy.needsClientNotification(ticket.analyticsLocal, ticket.crashlyticsLocal,
            ticket.acknowledgedClientState?.futureTelemetry, ticket.acknowledgedClientState?.analyticsLocal,
            ticket.acknowledgedClientState?.crashlyticsLocal, ticket.serverClientContinuation)
    private fun latestLocalAcknowledged(ticket: PrivacyTicket): Boolean =
        PrivacySafetyPolicy.acknowledgedAndSettled(ticket.analyticsLocal, ticket.crashlyticsLocal,
            ticket.acknowledgedClientState?.futureTelemetry, ticket.acknowledgedClientState?.analyticsLocal,
            ticket.acknowledgedClientState?.crashlyticsLocal, ticket.serverClientContinuation)
    /** Refresh first sends unacknowledged local progress; this NEVER creates a new deletion. */
    @Synchronized fun refreshStatus(): DiagnosticsStatus {
        recoverStorage()
        if (!config.isReady() || transport?.available != true) return status()
        state.tickets.filter { it.scope == "bound_remote" && it.serverAccepted && now() >= it.nextRetryAt }
            .forEach { ticket ->
                try {
                    val remote = transportOrFail()
                    val latest = state.tickets.first { it.requestId == ticket.requestId }
                    val receipt = if (notificationPending(latest)) remote.clientState(latest) else remote.status(latest)
                    mergeReceipt(latest.requestId, receipt)
                }
                catch (error: Exception) { recordFailure(ticket, error) }
            }
        purgeExpired()
        return status()
    }
    private fun purgeExpired() {
        if (!config.isLocalReady()) return
        val expiring = state.tickets.filter { ticket ->
            val epoch = ticket.epoch ?: return@filter false
            val alias = epoch.keyAlias
            val referenced = state.active?.keyAlias == alias || state.pending?.keyAlias == alias ||
                state.tickets.any { it.requestId != ticket.requestId && it.epoch?.keyAlias == alias }
            val retention = ticket.retention ?: return@filter false
            if (!retention.workerConfirmed || retention.policyVersion != epoch.policyVersion) return@filter false
            PrivacySafetyPolicy.mayPurge(ticket.lastRemoteObservedAt ?: 0, retention.receiptDays, retention.observationDays,
                ticket.serverAccepted, ticket.analyticsProvider?.state == "submitted", ticket.crashlyticsProvider?.state == "submitted",
                ticket.analyticsLocal == "reset_requested", ticket.crashlyticsLocal == "delete_queued",
                ticket.analyticsProvider?.additionalSubmissionRequired != false || ticket.crashlyticsProvider?.additionalSubmissionRequired != false,
                ticket.remoteState != "provider_submitted", ticket.settledEvidenceAt ?: 0, referenced,
                latestLocalAcknowledged(ticket))
        }
        if (expiring.isNotEmpty()) {
            val ids = expiring.map { it.requestId }.toSet()
            // Persist redacted records and the cleanup queue before touching Keystore.
            save(state.copy(tickets = state.tickets.filterNot { it.requestId in ids },
                expiredReceipts = state.expiredReceipts + expiring.map { ExpiredPrivacyReceipt(it.serverRequestId ?: it.requestId, now(), true, logicalRequestId = it.requestId) },
                cleanupKeys = state.cleanupKeys + expiring.map { RetiredKeyCleanup(it.serverRequestId ?: it.requestId, it.epoch!!.keyAlias) }))
        }
        drainRetiredKeys()
    }
    private fun drainRetiredKeys() {
        if (!config.isLocalReady()) return
        state.cleanupKeys.toList().forEach { cleanup ->
            val referenced = state.active?.keyAlias == cleanup.keyAlias || state.pending?.keyAlias == cleanup.keyAlias ||
                state.tickets.any { it.epoch?.keyAlias == cleanup.keyAlias }
            if (referenced) { operationFailure = "retired_key_still_referenced"; return@forEach }
            try {
                keys.deleteRetired(cleanup.keyAlias)
                save(state.copy(cleanupKeys = state.cleanupKeys.filterNot { it == cleanup },
                    expiredReceipts = state.expiredReceipts.map { if (it.requestId == cleanup.requestId) it.copy(keyCleanupPending = false) else it }))
            } catch (_: Exception) { operationFailure = "key_cleanup_pending"; return }
        }
    }
    private fun transportOrFail(): PrivacyTransport {
        recoverStorage()
        if (!config.isReady() || transport?.available != true) throw PrivacyFault("not_configured")
        return transport
    }
    private fun recordFailure(ticket: PrivacyTicket, error: Exception) {
        try { recoverStorage() } catch (storageError: Exception) { operationFailure = safeCode(storageError); return }
        val latest = state.tickets.find { it.requestId == ticket.requestId } ?: return
        val code = safeCode(error)
        // Permission/protocol failures require operator/user action; do not spin or invent a new request.
        val terminal = code in setOf("idempotency_conflict", "app_attestation_rejected", "invalid_request", "key_unavailable")
        val delay = maxOf(30_000L, (error as? PrivacyFault)?.retryAfterMs ?: 0)
        val after = if (terminal) Long.MAX_VALUE else PrivacyHttpTime.saturatingAdd(now(), delay)
        updateTicket(latest.copy(failures = (latest.failures + code).distinct(), nextRetryAt = after,
            lastRemoteObservedAt = PrivacySafetyPolicy.advanceServerClock(latest.lastRemoteObservedAt, (error as? PrivacyFault)?.serverObservedAt)))
    }
    private fun updateTicket(ticket: PrivacyTicket) {
        val old = state.tickets.first { it.requestId == ticket.requestId }
        val changedLocal = old.analyticsLocal != ticket.analyticsLocal || old.crashlyticsLocal != ticket.crashlyticsLocal
        val next = if (changedLocal) ticket.copy(lastLocalMutationAt = now(), settledEvidenceAt = null) else ticket
        save(state.copy(tickets = state.tickets.map { if (it.requestId == ticket.requestId) next else it }))
    }
    private fun save(next: PrivacyState) {
        try { store.commit(next); state = next } catch (error: Exception) {
            stopEvents(); storageUncertain = true; operationFailure = safeCode(error); throw error
        }
    }
    @Synchronized fun initializationBlocked(code: String): DiagnosticsStatus {
        operationFailure = code
        return status()
    }
    @Synchronized fun status(): DiagnosticsStatus {
        val current = state.currentRequestId
        val ticket = state.tickets.find { it.requestId == current }
        val pendingNotification = ticket?.let(::notificationPending) == true
        val failures = ((ticket?.failures ?: emptyList()) + listOfNotNull(operationFailure) +
            if (pendingNotification) listOf("client_state_pending") else emptyList()).distinct()
        val restart = ticket?.crashlyticsLocal == "restart_required"
        val display = when {
            storageUncertain || operationFailure in setOf("native_integration_unverified", "sdk_migration_required", "restore_recovery_required", "key_unavailable") -> "blocked"
            ticket?.remoteState == "operator_action_required" || failures.any { it in setOf("provider_action_required", "late_arrival_verification_required") } -> "blocked"
            ticket != null && PrivacySafetyPolicy.requiresLocalRetry(ticket.analyticsLocal, ticket.crashlyticsLocal, failures.isNotEmpty()) ->
                if (ticket.nextRetryAt == Long.MAX_VALUE) "blocked" else "retry_wait"
            pendingNotification || ticket?.remoteState == "retrying" -> "retry_wait"
            restart -> "restart_required"
            ticket?.analyticsSubmitted == true && ticket.crashlyticsSubmitted -> "provider_submitted"
            ticket?.serverAccepted == true -> "accepted"
            failures.isNotEmpty() -> if (ticket?.nextRetryAt == Long.MAX_VALUE || ticket == null) "blocked" else "retry_wait"
            ticket?.snapshotState == "pending" -> "snapshot_pending"
            ticket != null -> "disabled_persisted"
            else -> "idle"
        }
        val expired = state.expiredReceipts.find { it.logicalRequestId == current }
        val expiredHistory = state.expiredReceipts.filterNot { it.logicalRequestId == current }.map {
            PreviousPrivacyRequest(it.requestId, true, true, true, false, "provider_submitted", retentionExpired = true, keyCleanupPending = it.keyCleanupPending)
        }
        val history = expiredHistory + state.tickets.filterNot { it.requestId == current }.map { old -> PreviousPrivacyRequest(old.serverRequestId ?: old.requestId,
                old.serverAccepted, old.analyticsSubmitted, old.crashlyticsSubmitted, old.crashlyticsLocal == "restart_required",
                when { old.remoteState == "operator_action_required" -> "blocked"
                    PrivacySafetyPolicy.requiresLocalRetry(old.analyticsLocal, old.crashlyticsLocal, old.failures.isNotEmpty()) ->
                        if (old.nextRetryAt == Long.MAX_VALUE) "blocked" else "retry_wait"
                    notificationPending(old) || old.remoteState == "retrying" -> "retry_wait"
                    old.crashlyticsLocal == "restart_required" -> "restart_required"
                    old.analyticsSubmitted && old.crashlyticsSubmitted -> "provider_submitted"
                    old.serverAccepted -> "accepted"
                    old.failures.isNotEmpty() -> "blocked"
                    else -> "disabled_persisted" }, old.remoteState, old.analyticsProvider, old.crashlyticsProvider) }
        if (expired != null) return DiagnosticsStatus(if (storageUncertain || expired.keyCleanupPending) "blocked" else "provider_submitted",
            expired.requestId, true, true, true, false, failures, "reset_requested", "delete_queued",
            futureState(),
            history, retentionExpired = true, keyCleanupPending = expired.keyCleanupPending)
        return DiagnosticsStatus(display, ticket?.serverRequestId ?: ticket?.requestId, ticket?.serverAccepted ?: false,
            ticket?.analyticsSubmitted ?: false, ticket?.crashlyticsSubmitted ?: false, restart, failures,
            ticket?.analyticsLocal ?: "pending", ticket?.crashlyticsLocal ?: "pending",
            futureState(),
            history, ticket?.remoteState, ticket?.analyticsProvider, ticket?.crashlyticsProvider)
    }
    companion object {
        private val PROVIDER_ERRORS = setOf("provider_action_required", "provider_retry_wait", "late_arrival_verification_required")
        private val REMOTE_ERRORS = setOf("remote_unavailable", "remote_timeout", "not_configured", "rate_limited", "invalid_proof", "expired_challenge", "not_found")
        private fun safeCode(error: Exception) = (error as? PrivacyFault)?.code ?: "native_operation_failed"
    }
}

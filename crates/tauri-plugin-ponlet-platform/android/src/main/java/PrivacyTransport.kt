package jp.yasagure.ponlet.platform

import org.json.JSONObject
import java.net.URL
import java.util.concurrent.TimeUnit
import java.util.concurrent.ScheduledThreadPoolExecutor
import javax.net.ssl.HttpsURLConnection

fun interface PrivacyAppCheck { fun token(): String }
data class PrivacyReceipt(val requestId: String, val analyticsSubmitted: Boolean, val crashlyticsSubmitted: Boolean, val failures: List<String> = emptyList(),
    val remoteState: String, val analyticsProvider: RemoteProviderState, val crashlyticsProvider: RemoteProviderState,
    val serverObservedAt: Long? = null, val acknowledgedClientState: AcknowledgedClientState,
    val clientContinuation: String)
interface PrivacyTransport {
    val available: Boolean
    fun enroll(pending: PendingEnrollment): BoundEpoch
    fun submit(ticket: PrivacyTicket): PrivacyReceipt
    fun status(ticket: PrivacyTicket): PrivacyReceipt
    fun clientState(ticket: PrivacyTicket): PrivacyReceipt
}

/** No instance is installed in this patch. Provider/setup validation must precede use. */
class SignedPrivacyTransport(
    private val config: PrivacyConfig, private val keys: PrivacyKeystore,
    private val appCheck: PrivacyAppCheck,
) : PrivacyTransport {
    private var lastResponseServerTime: Long? = null
    private fun JSONObject.text(name: String): String = PrivacyResponseRules.requireString(get(name))
    private fun checkedResult(body: JSONObject): JSONObject {
        try { PrivacyResponseRules.requireSchemaVersion(body.get("schemaVersion")); return body }
        catch (_: Exception) { throw PrivacyFault("invalid_response") }
    }
    override val available get() = config.isReady()
    override fun enroll(pending: PendingEnrollment): BoundEpoch {
        requireReady()
        val publicJwk = keys.publicJwk(pending.keyAlias)
        val body = JSONObject().put("schemaVersion", 1).put("enrollmentRequestId", pending.requestId)
            .put("platform", "android").put("publicJwk", publicJwk)
        val result = checkedResult(signed("POST", "/v1/enrollments", body, pending.keyAlias, null, publicJwk, true))
        if (result.text("policyVersion") != config.policyVersion) throw PrivacyFault("policy_mismatch")
        val retention = result.getJSONObject("retention")
        val receiptDays = PrivacyResponseRules.requireInteger(retention.get("receiptDays"), 1, 3650)
        val mappingDays = PrivacyResponseRules.requireInteger(retention.get("mappingDays"), 1, 3650)
        if (!PrivacySafetyPolicy.workerRetentionMatches(receiptDays, mappingDays, retention.text("retiredKeyPolicy"),
                config.receiptRetentionDays, config.retiredKeyPolicy)) throw PrivacyFault("retention_mismatch")
        return BoundEpoch(PrivacyResponseRules.requireServiceId(result.get("epochId"), "epoch"), pending.keyAlias,
            PrivacyResponseRules.requireServiceId(result.get("analyticsUserId"), "ga"),
            PrivacyResponseRules.requireServiceId(result.get("crashlyticsUserId"), "crash"),
            PrivacyResponseRules.requireTimestamp(result.get("issuedAt")), result.text("policyVersion"), retention = RetentionSnapshot.from(config, mappingDays.toInt()))
    }
    override fun submit(ticket: PrivacyTicket): PrivacyReceipt {
        val epoch = ticket.epoch ?: throw PrivacyFault("no_bound_epoch")
        val body = JSONObject().put("schemaVersion", 1).put("requestId", ticket.requestId).put("epochId", epoch.epochId)
            .put("intent", "delete_bound_diagnostics_and_stop").put("policyVersion", epoch.policyVersion)
            .put("clientState", localState(ticket))
        return receipt(signed("POST", "/v1/requests", body, epoch.keyAlias, epoch.epochId, null, true), ticket)
    }
    override fun status(ticket: PrivacyTicket): PrivacyReceipt {
        val epoch = ticket.epoch ?: throw PrivacyFault("no_bound_epoch")
        return receipt(signed("GET", requestPath(ticket), null, epoch.keyAlias, epoch.epochId, null, false), ticket)
    }
    override fun clientState(ticket: PrivacyTicket): PrivacyReceipt {
        val epoch = ticket.epoch ?: throw PrivacyFault("no_bound_epoch")
        return receipt(signed("POST", requestPath(ticket) + "/client-state", JSONObject().put("schemaVersion", 1)
            .put("clientState", localState(ticket)), epoch.keyAlias, epoch.epochId, null, false), ticket)
    }
    private fun localState(ticket: PrivacyTicket) = JSONObject().put("futureTelemetry", "disabled_persisted")
        .put("analyticsLocal", ticket.analyticsLocal).put("crashlyticsLocal", ticket.crashlyticsLocal)
    private fun requestPath(ticket: PrivacyTicket): String {
        val id = ticket.serverRequestId ?: ticket.requestId
        try { PrivacyResponseRules.requireUuid(id) } catch (_: Exception) { throw PrivacyFault("invalid_receipt") }
        return "/v1/requests/$id"
    }
    private fun receipt(result: JSONObject, ticket: PrivacyTicket): PrivacyReceipt {
        checkedResult(result)
        val id = result.text("requestId")
        try { PrivacyResponseRules.requireUuid(id) } catch (_: Exception) { throw PrivacyFault("invalid_receipt") }
        // A duplicate retired epoch may return its original request ID; bind subsequent polling to it.
        PrivacyResponseRules.requireTimestamp(result.get("acceptedAt"))
        if (ticket.serverRequestId != null && ticket.serverRequestId != id) throw PrivacyFault("receipt_mismatch")
        val providers = result.getJSONObject("providers")
        fun parseProvider(name: String): RemoteProviderState {
            val provider = providers.getJSONObject(name)
            val state = PrivacyResponseRules.requireProviderState(provider.get("state"))
            PrivacyResponseRules.requireProviderTimestamps(name, state,
                if (provider.has("deletionRequestTime")) provider.get("deletionRequestTime") else null,
                if (provider.has("targetCompleteTime")) provider.get("targetCompleteTime") else null)
            if (provider.text("completionEvidence") != if (state == "submitted") "submission_only" else "none")
                throw PrivacyFault("invalid_receipt")
            val errorCode = provider.nullableString("errorCode")
            if (errorCode != null && !errorCode.matches(Regex("[a-z0-9_]{1,80}"))) throw PrivacyFault("invalid_receipt")
            return RemoteProviderState(state, errorCode, if (provider.has("additionalSubmissionRequired"))
                PrivacyResponseRules.requireBoolean(provider.get("additionalSubmissionRequired")) else false)
        }
        val analytics = parseProvider("analytics")
        val crashlytics = parseProvider("crashlytics")
        val remoteState = PrivacyResponseRules.requireOverallState(result.get("state"), analytics.state,
            analytics.additionalSubmissionRequired, crashlytics.state, crashlytics.additionalSubmissionRequired)
        if (result.text("completionEvidence") != PrivacyResponseRules.expectedCompletionEvidence(analytics.state, crashlytics.state))
            throw PrivacyFault("invalid_receipt")
        val failures = listOf(analytics, crashlytics).flatMap { provider -> listOfNotNull(
            if (provider.state == "operator_action_required") "provider_action_required" else null,
            if (provider.state == "retry_wait") "provider_retry_wait" else null,
            if (provider.additionalSubmissionRequired) "late_arrival_verification_required" else null)
        }.distinct()
        val acknowledged = AcknowledgedClientState.read(result.getJSONObject("clientState"))
        if (acknowledged.futureTelemetry !in setOf("disabled_persisted", "restart_required", "sdk_unavailable") ||
            acknowledged.analyticsLocal !in setOf("pending", "reset_requested", "unavailable", "failed") ||
            acknowledged.crashlyticsLocal !in setOf("pending", "restart_required", "delete_queued", "no_unsent_reports_observed", "unavailable", "failed"))
            throw PrivacyFault("invalid_receipt")
        val continuation = PrivacyResponseRules.requireClientContinuation(result.get("clientContinuation"), acknowledged.crashlyticsLocal)
        return PrivacyReceipt(id, analytics.state == "submitted", crashlytics.state == "submitted",
            failures, remoteState, analytics, crashlytics, lastResponseServerTime, acknowledged, continuation)
    }
    private fun signed(method: String, path: String, body: JSONObject?, alias: String, epochId: String?,
        publicJwk: JSONObject?, needsAppCheck: Boolean): JSONObject {
        requireReady()
        val kid = keys.kid(alias)
        val token = if (needsAppCheck) appCheck.token().also {
            if (it.isBlank() || it.length > 8192 || it.any { c -> c.code !in 33..126 }) throw PrivacyFault("app_check_unavailable")
        } else null
        val challengeBody = JSONObject().put("schemaVersion", 1).put("kid", kid).put("method", method).put("path", path)
        if (publicJwk != null) challengeBody.put("publicJwk", publicJwk)
        val challenge = exchange("POST", "/v1/challenges", challengeBody.toString().toByteArray(Charsets.UTF_8),
            mapOf("Ponlet-Privacy-Key" to kid) + if (token == null) emptyMap() else mapOf("X-Firebase-AppCheck" to token))
        if (challenge.text("ownerKey") != kid || challenge.text("method") != method || challenge.text("path") != path)
            throw PrivacyFault("challenge_mismatch")
        val expires = PrivacyHttpTime.challengeExpirySeconds(
            PrivacyResponseRules.requireInteger(challenge.get("expiresAt"), 1, PrivacyResponseRules.MAX_SAFE_INTEGER), lastResponseServerTime)
            ?: throw PrivacyFault("expired_challenge", serverObservedAt = lastResponseServerTime)
        val challengeId = PrivacyResponseRules.requireServiceId(challenge.get("challengeId"), "chg")
        val nonce = PrivacyResponseRules.requireServiceId(challenge.get("nonce"), "nonce")
        val bytes = body?.toString()?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
        val payload = JSONObject().put("aud", config.audience).put("method", method).put("path", path)
            .put("bodySha256", PrivacyJws.sha256(bytes)).put("challengeId", challengeId)
            .put("nonce", nonce).put("exp", expires)
        if (epochId != null) payload.put("epochId", epochId)
        val headers = mutableMapOf("Ponlet-Privacy-Key" to kid,
            "Ponlet-Privacy-Proof" to keys.sign(alias, payload.toString().toByteArray(Charsets.UTF_8)))
        if (token != null) headers["X-Firebase-AppCheck"] = token
        val challengeClock = lastResponseServerTime
        return try { exchange(method, path, bytes, headers) }
        catch (error: PrivacyFault) { throw PrivacyFault(error.code, error.retryAfterMs,
            PrivacySafetyPolicy.advanceServerClock(challengeClock, error.serverObservedAt), error.httpStatus) }
        catch (_: Exception) { throw PrivacyFault("remote_unavailable", serverObservedAt = challengeClock) }
    }
    private fun requireReady() { if (!available) throw PrivacyFault("not_configured") }
    private fun exchange(method: String, path: String, bytes: ByteArray, headers: Map<String, String>): JSONObject {
        requireReady()
        if (bytes.size > 8192 || !path.startsWith("/v1/") || path.contains('?') || path.contains('#')) throw PrivacyFault("invalid_request")
        lastResponseServerTime = null // Never reuse a Date from an unrelated earlier response.
        val deadline = PrivacyResponseRules.Deadline(PrivacyResponseRules.MAX_EXCHANGE_TIMEOUT_MS.toLong())
        val connection = URL(config.apiOrigin + path).openConnection() as HttpsURLConnection
        val cancel = watchdog.schedule(Runnable { connection.disconnect() }, deadline.remainingMillis().toLong(), TimeUnit.MILLISECONDS)
        try {
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.connectTimeout = minOf(10_000, deadline.remainingMillis())
            connection.readTimeout = minOf(15_000, deadline.remainingMillis())
            connection.requestMethod = method
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Cache-Control", "no-store")
            headers.forEach { (k, v) -> connection.setRequestProperty(k, v) }
            if (method != "GET") {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setFixedLengthStreamingMode(bytes.size)
                connection.outputStream.use { deadline.check(); it.write(bytes); deadline.check() }
            }
            deadline.check()
            connection.readTimeout = minOf(15_000, deadline.remainingMillis())
            val code = connection.responseCode
            deadline.check()
            // A 404 after server receipt expiry still carries HTTPS-origin clock evidence.
            // This is not an acknowledgement and does not change provider/client-state facts.
            lastResponseServerTime = PrivacyHttpTime.parseDateMillis(connection.getHeaderField("Date"))
            if (code !in setOf(200, 201, 202)) throw PrivacyFault(when (code) {
                401 -> "invalid_proof"; 403 -> "app_attestation_rejected"; 409 -> "idempotency_conflict"
                404 -> "not_found"; 429 -> "rate_limited"; 503 -> "not_configured"; else -> "remote_unavailable"
            }, PrivacyHttpTime.retryAfterMillis(connection.getHeaderField("Retry-After"), lastResponseServerTime), lastResponseServerTime, code)
            if (!(connection.contentType ?: "").matches(Regex("(?i)application/json(?:\\s*;.*)?")))
                throw PrivacyFault("invalid_response", serverObservedAt = lastResponseServerTime)
            val bytesRead = connection.inputStream.use { stream ->
                PrivacyResponseRules.readBounded(stream, PrivacyResponseRules.MAX_BODY_BYTES, deadline,
                    PrivacyResponseRules.ReadTimeoutSetter { milliseconds -> connection.readTimeout = milliseconds })
            }
            val text = PrivacyResponseRules.decodeUtf8(bytesRead)
            PrivacyResponseRules.requireStrictJsonObject(text)
            deadline.check()
            return JSONObject(text)
        } catch (error: PrivacyFault) { throw error }
        catch (_: java.net.SocketTimeoutException) { throw PrivacyFault("remote_timeout", serverObservedAt = lastResponseServerTime) }
        catch (_: IllegalArgumentException) { throw PrivacyFault("invalid_response", serverObservedAt = lastResponseServerTime) }
        catch (_: org.json.JSONException) { throw PrivacyFault("invalid_response", serverObservedAt = lastResponseServerTime) }
        catch (_: Exception) { throw PrivacyFault("remote_unavailable", serverObservedAt = lastResponseServerTime) }
        finally { cancel.cancel(false); connection.disconnect() }
    }
    companion object {
        private val watchdog = ScheduledThreadPoolExecutor(1) { runnable ->
            Thread(runnable, "ponlet-privacy-deadline").apply { isDaemon = true }
        }.apply { removeOnCancelPolicy = true }
    }
}

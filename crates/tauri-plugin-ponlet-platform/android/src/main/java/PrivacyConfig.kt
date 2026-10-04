package jp.yasagure.ponlet.platform

/** Native build configuration. Never supplied by the WebView or remote response. */
data class PrivacyConfig(
    val featureEnabled: Boolean = false,
    val apiOrigin: String? = null,
    val audience: String? = null,
    val policyVersion: String? = null,
    val receiptRetentionDays: Int? = null,
    val lateArrivalObservationDays: Int? = null,
    val retiredKeyPolicy: String? = null,
    val startupGateVerified: Boolean = false,
    val startupComponentsVerified: Boolean = false,
    val backupExclusionVerified: Boolean = false,
    val protocolIntegrationVerified: Boolean = false,
) {
    fun isConfigured(): Boolean = featureEnabled &&
        PrivacySafetyPolicy.validEndpoint(apiOrigin, audience, policyVersion) &&
        retentionConfigured()
    fun isLocalReady(): Boolean = featureEnabled && backupExclusionVerified && retentionConfigured()
    private fun retentionConfigured(): Boolean =
        PrivacySafetyPolicy.validRetention(receiptRetentionDays, lateArrivalObservationDays, retiredKeyPolicy)
    fun isReady(): Boolean = isConfigured() && startupGateVerified && startupComponentsVerified &&
        backupExclusionVerified && protocolIntegrationVerified
    companion object {
        // No endpoint, retention number or release flag is guessed by this patch.
        val DISABLED = PrivacyConfig()
    }
}

class PrivacyFault(val code: String, val retryAfterMs: Long? = null,
    val serverObservedAt: Long? = null, val httpStatus: Int? = null) : Exception(code)

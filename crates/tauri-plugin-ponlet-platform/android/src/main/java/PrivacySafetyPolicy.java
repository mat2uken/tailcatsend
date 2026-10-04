package jp.yasagure.ponlet.platform;

/** Pure decisions shared by Android code and host-JVM tests; no SDK, I/O or credentials. */
public final class PrivacySafetyPolicy {
    private PrivacySafetyPolicy() {}
    public enum Startup { LEGACY, FRESH_DISABLED, PREVIOUS_RUN_DISABLED, REGISTERED_ENABLED,
        BLOCK_RESTORE, BLOCK_MISSING_KEY, BLOCK_MIGRATION }
    public static Startup startup(boolean feature, boolean restored, boolean freshDisabledWitness,
            boolean disabledInEarlierProcess, boolean registeredEpoch, boolean keyExists,
            boolean boundToBothServices, boolean desiredEnabled) {
        if (!feature) return Startup.LEGACY;
        if (restored) return Startup.BLOCK_RESTORE;
        if (registeredEpoch && !keyExists) return Startup.BLOCK_MISSING_KEY;
        if (disabledInEarlierProcess) return Startup.PREVIOUS_RUN_DISABLED;
        if (desiredEnabled && registeredEpoch && keyExists && boundToBothServices) return Startup.REGISTERED_ENABLED;
        if (freshDisabledWitness) return Startup.FRESH_DISABLED;
        // Includes an upgrade with old SDK collection=true and a crash during opt-out persistence.
        return Startup.BLOCK_MIGRATION;
    }
    public static boolean allowsSdk(Startup result) {
        return result == Startup.LEGACY || result == Startup.FRESH_DISABLED ||
            result == Startup.PREVIOUS_RUN_DISABLED || result == Startup.REGISTERED_ENABLED;
    }
    /** A durable stop intent or restored legacy opt-out always wins an interrupted mirror write. */
    public static boolean effectiveDesired(boolean hasPrimary, boolean primaryDesired, boolean legacyEnabled) {
        return legacyEnabled && (!hasPrimary || primaryDesired);
    }
    public static boolean needsLegacyStopMirror(boolean hasPrimary, boolean primaryDesired, boolean legacyEnabled) {
        return hasPrimary && !primaryDesired && legacyEnabled;
    }
    public static boolean clientStateMatches(String localAnalytics, String localCrash, String serverFuture,
            String serverAnalytics, String serverCrash) {
        return "disabled_persisted".equals(serverFuture) && localAnalytics != null && localCrash != null &&
            localAnalytics.equals(serverAnalytics) && localCrash.equals(serverCrash);
    }
    public static boolean acknowledgedAndSettled(String localAnalytics, String localCrash, String serverFuture,
            String serverAnalytics, String serverCrash, String continuation) {
        return clientStateMatches(localAnalytics, localCrash, serverFuture, serverAnalytics, serverCrash) &&
            "reset_requested".equals(localAnalytics) && "delete_queued".equals(localCrash) && "none".equals(continuation);
    }
    public static boolean needsClientNotification(String localAnalytics, String localCrash, String serverFuture,
            String serverAnalytics, String serverCrash, String continuation) {
        if (!clientStateMatches(localAnalytics, localCrash, serverFuture, serverAnalytics, serverCrash)) return true;
        return "reset_requested".equals(localAnalytics) && "delete_queued".equals(localCrash) && !"none".equals(continuation);
    }
    /** Stable explicit-request identity; legacy fallback uses stored order, never wall-clock time. */
    public static String currentRequest(String persisted, String[] pendingIds, String[] expiredLogicalIds) {
        if (persisted != null) {
            for (String id : pendingIds) if (persisted.equals(id)) return persisted;
            for (String id : expiredLogicalIds) if (persisted.equals(id)) return persisted;
            throw new IllegalArgumentException("missing_current_request");
        }
        if (pendingIds.length > 0) return pendingIds[pendingIds.length - 1];
        if (expiredLogicalIds.length > 0) return expiredLogicalIds[expiredLogicalIds.length - 1];
        return null;
    }
    public static boolean validRetention(Integer receiptDays, Integer observationDays, String keyPolicy) {
        return receiptDays != null && receiptDays >= 1 && receiptDays <= 3650 &&
            observationDays != null && observationDays >= 1 && observationDays <= 3650 &&
            "retain_tombstone".equals(keyPolicy);
    }
    public static boolean workerRetentionMatches(long receiptDays, long mappingDays, String keyPolicy,
            Integer expectedReceiptDays, String expectedKeyPolicy) {
        return expectedReceiptDays != null && receiptDays == expectedReceiptDays &&
            receiptDays >= 1 && receiptDays <= 3650 && mappingDays >= receiptDays && mappingDays <= 3650 &&
            "retain_tombstone".equals(keyPolicy) && keyPolicy.equals(expectedKeyPolicy);
    }
    public static boolean validEndpoint(String origin, String audience, String policy) {
        if (origin == null || !origin.equals(audience) || policy == null || !policy.matches("[a-zA-Z0-9_-]{1,80}")) return false;
        try {
            java.net.URI uri = new java.net.URI(origin);
            String host = uri.getHost();
            int port = uri.getPort();
            if (!"https".equals(uri.getScheme()) || host == null || host.isEmpty() ||
                uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null ||
                !"".equals(uri.getRawPath()) || port == 0 || port > 65535 || port < -1 || host.contains("%")) return false;
            String canonical = "https://" + host.toLowerCase(java.util.Locale.ROOT) +
                (port == -1 || port == 443 ? "" : ":" + port);
            return canonical.equals(origin);
        } catch (java.net.URISyntaxException invalid) { return false; }
    }
    public static boolean retrySnapshot(String snapshot, String analytics) {
        return !"reset_requested".equals(analytics) && ("pending".equals(snapshot) || "unavailable".equals(snapshot));
    }
    public static boolean resolvedStopFailure(String failure) {
        return "collection_change_failed".equals(failure) || "sdk_unavailable".equals(failure) ||
            "component_disable_incomplete".equals(failure);
    }
    public static boolean requiresLocalRetry(String analytics, String crash, boolean hasFailure) {
        return hasFailure || "failed".equals(analytics) || "unavailable".equals(analytics) ||
            "failed".equals(crash) || "unavailable".equals(crash);
    }
    /** Error response time is clock evidence only, never a provider/client-state acknowledgement. */
    public static Long advanceServerClock(Long existing, Long trustedHttpsDate) {
        if (trustedHttpsDate == null || trustedHttpsDate <= 0) return existing;
        return existing == null ? trustedHttpsDate : Math.max(existing, trustedHttpsDate);
    }
    /** ACK causality is established by the serial request/response, not an untrusted device wall clock. */
    public static boolean mayPurge(long now, Integer receiptDays, Integer observationDays,
            boolean serverAccepted, boolean analyticsSubmitted, boolean crashSubmitted,
            boolean analyticsLocalSettled, boolean crashLocalSettled, boolean additionalSubmission,
            boolean operatorAction, long settledEvidenceAt,
            boolean keyReferencedElsewhere, boolean latestLocalAcknowledged) {
        if (receiptDays == null || receiptDays <= 0 || observationDays == null || observationDays <= 0 ||
            !latestLocalAcknowledged || !serverAccepted || !analyticsSubmitted || !crashSubmitted || !analyticsLocalSettled ||
            !crashLocalSettled || additionalSubmission || operatorAction || keyReferencedElsewhere ||
            settledEvidenceAt <= 0)
            return false;
        try {
            long receiptEnd = Math.addExact(settledEvidenceAt, Math.multiplyExact(receiptDays.longValue(), 86_400_000L));
            long observationEnd = Math.addExact(settledEvidenceAt, Math.multiplyExact(observationDays.longValue(), 86_400_000L));
            return now >= Math.max(receiptEnd, observationEnd);
        } catch (ArithmeticException overflow) { return false; }
    }
}

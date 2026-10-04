package jp.yasagure.ponlet.platform;

/** Intent fence at IPC receipt time; the serial executor alone cannot observe a queued opt-out. */
public final class PrivacyEnableGuard {
    private long revision;
    private boolean allowed = true;
    public synchronized long receivedIntent() {
        // Saturation remains closed; it cannot accidentally match an older queued intent.
        if (revision == Long.MAX_VALUE) { allowed = false; return -1; }
        allowed = false;
        return ++revision;
    }
    public synchronized boolean beginIntent(long token, boolean enabled) {
        if (token < 0 || token != revision) return false;
        allowed = enabled;
        return true;
    }
    public synchronized boolean mayEnable() { return allowed; }
}

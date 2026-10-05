package jp.yasagure.ponlet.platform;

/** SharedPreferences may update its process cache even when commit fails.
 *  Once uncertain, this process cannot treat a later cache read as durable evidence.
 */
public final class PrivacySettingPersistence {
    public static final PrivacySettingPersistence PROCESS = new PrivacySettingPersistence();
    @FunctionalInterface public interface Write { boolean commit() throws Exception; }
    private volatile boolean uncertain;

    public boolean isCertain() { return !uncertain; }

    /** Preserve commit's failure result and keep uncertainty sticky until a new process. */
    public boolean commit(Write write) {
        try {
            if (write.commit()) return true;
        } catch (Exception failure) {
            // A thrown write, like a false result, may already have changed the process cache.
        }
        uncertain = true;
        return false;
    }
}

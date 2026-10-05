import jp.yasagure.ponlet.platform.PrivacySettingPersistence;

/** Executes the production guard with explicit cache-before-disk failure fixtures, not Android APIs. */
public class PrivacySettingPersistenceTest {
    static int checks;
    static void check(boolean value, String label) {
        checks++;
        if (!value) throw new AssertionError(label);
    }
    static final class PreferenceFixture {
        boolean cache;
        boolean disk;
        PreferenceFixture(boolean initial) { cache = disk = initial; }
        boolean write(boolean desired, boolean success, boolean throwsAfterCache) throws Exception {
            cache = desired;
            if (throwsAfterCache) throw new Exception("fixture write error");
            if (success) disk = desired;
            return success;
        }
    }
    public static void main(String[] args) {
        for (boolean desired : new boolean[]{false, true}) {
            for (boolean throwsAfterCache : new boolean[]{false, true}) {
                PrivacySettingPersistence guard = new PrivacySettingPersistence();
                PreferenceFixture saved = new PreferenceFixture(!desired);
                check(guard.isCertain(), "fresh process may read its preference");
                check(!guard.commit(() -> saved.write(desired, false, throwsAfterCache)), "false or exception stays a write failure");
                check(saved.cache == desired && saved.disk != desired, "failure fixture changed cache without durable write");
                check(!guard.isCertain(), "cache read cannot be treated as persisted state after failure");
                check(!guard.isCertain(), "repeated reads do not clear uncertainty");
                check(guard.commit(() -> saved.write(desired, true, false)), "a later write can itself succeed");
                check(saved.disk == desired && !guard.isCertain(), "later write still cannot clear process-wide uncertainty");
                PrivacySettingPersistence coldProcess = new PrivacySettingPersistence();
                check(coldProcess.isCertain(), "only a fresh process starts with a clear guard");
            }
            PrivacySettingPersistence guard = new PrivacySettingPersistence();
            PreferenceFixture primary = new PreferenceFixture(!desired);
            PreferenceFixture mirror = new PreferenceFixture(!desired);
            check(guard.commit(() -> primary.write(desired, true, false)), "primary commit succeeds");
            check(!guard.commit(() -> mirror.write(desired, false, false)), "mirror failure is recorded");
            check(primary.disk == desired && mirror.disk != desired, "split-file durable state fixture");
            check(primary.cache == desired && mirror.cache == desired && !guard.isCertain(), "apparently matching caches cannot hide mirror failure");

            PrivacySettingPersistence committed = new PrivacySettingPersistence();
            PreferenceFixture saved = new PreferenceFixture(!desired);
            check(committed.commit(() -> saved.write(desired, true, false)), "durable choice committed before SDK call");
            boolean sdkFailed = false;
            try { throw new Exception("fixture sdk_unavailable"); }
            catch (Exception expected) { sdkFailed = true; }
            check(sdkFailed && committed.isCertain() && saved.disk == desired, "SDK-only failure remains a failure without invalidating persisted choice");
        }
        PrivacySettingPersistence migration = new PrivacySettingPersistence();
        check(!migration.commit(() -> { throw new Exception("cleanup commit failed"); }), "read-time migration failure uses same guard");
        check(!migration.isCertain(), "read-time migration failure stays unknown");
        PrivacySettingPersistence repair = new PrivacySettingPersistence();
        check(!repair.commit(() -> false), "read-time mirror repair failure uses same guard");
        check(!repair.isCertain(), "read-time repair failure stays unknown");
        System.out.println("PASS: " + checks + " executable sticky setting-persistence guard checks; cache/disk fixtures only; Android runtime NOT run");
    }
}

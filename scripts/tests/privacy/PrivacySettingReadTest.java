import jp.yasagure.ponlet.platform.PrivacySafetyPolicy;
import jp.yasagure.ponlet.platform.PrivacyEnableGuard;

/** Pure persisted-choice and intent-fence decisions, not an Android storage/SDK integration test. */
public class PrivacySettingReadTest {
    static int checks;
    static void check(boolean value, String label) {
        checks++;
        if (!value) throw new AssertionError(label);
    }
    public static void main(String[] args) {
        // These are persisted snapshots at each fault point, independent of stale Rust memory.
        check(PrivacySafetyPolicy.effectiveDesired(false, false, true), "fresh default remains ON");
        check(!PrivacySafetyPolicy.effectiveDesired(false, true, false), "saved legacy OFF remains OFF");
        check(!PrivacySafetyPolicy.effectiveDesired(true, false, false), "committed OFF stays OFF after later SDK failure");
        check(PrivacySafetyPolicy.effectiveDesired(true, true, true), "committed ON is desired state, not SDK success evidence");
        check(PrivacySafetyPolicy.effectiveDesired(true, true, true), "failed stop before primary commit reads previous ON");
        check(!PrivacySafetyPolicy.effectiveDesired(true, false, true), "stop primary commit wins if legacy mirror failed");
        check(PrivacySafetyPolicy.needsLegacyStopMirror(true, false, true), "split stop requests existing mirror repair");
        check(!PrivacySafetyPolicy.effectiveDesired(true, true, false), "split enable cannot override saved OFF");
        check(!PrivacySafetyPolicy.needsLegacyStopMirror(true, true, false), "split enable does not overwrite legacy OFF");

        PrivacyEnableGuard guard = new PrivacyEnableGuard();
        long olderOn = guard.receivedIntent();
        check(guard.beginIntent(olderOn, true), "first ON can enter");
        long newerOff = guard.receivedIntent();
        // A desired-state read uses the persisted choice, never grants collection permission.
        check(PrivacySafetyPolicy.effectiveDesired(true, true, true), "pending OFF can still observe old committed ON");
        check(!guard.mayEnable(), "reading saved ON does not bypass pending OFF fence");
        check(!guard.beginIntent(olderOn, true), "old ON remains superseded after read");
        check(guard.beginIntent(newerOff, false), "new OFF still enters");
        check(!PrivacySafetyPolicy.effectiveDesired(true, false, false), "newly persisted OFF is observable");
        check(!guard.mayEnable(), "reading OFF does not change collection fence");
        System.out.println("PASS: " + checks + " executable persisted-setting/intent decisions; no Android storage, SDK, keys or network");
    }
}

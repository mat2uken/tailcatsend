import jp.yasagure.ponlet.platform.PrivacyEnableGuard;
import jp.yasagure.ponlet.platform.PrivacySafetyPolicy;

/** Real shared decisions, including an opt-out queued behind registration I/O. */
public class PrivacyContinuationTest {
    static int checks;
    static void check(boolean result, String label) { checks++; if (!result) throw new AssertionError(label); }
    public static void main(String[] args) throws Exception {
        PrivacyEnableGuard guard = new PrivacyEnableGuard();
        check(guard.mayEnable(), "legacy default desire remains on");
        long off = guard.receivedIntent();
        check(!guard.mayEnable(), "IPC opt-out closes before serial queue drains");
        // Simulate an older network result arriving while the opt-out is still queued.
        check(!guard.mayEnable(), "old enrollment cannot enable on response");
        guard.beginIntent(off, false);
        check(!guard.mayEnable(), "saved opt-out remains closed");
        long on = guard.receivedIntent();
        check(!guard.mayEnable(), "on request does not bypass its queued durable write");
        guard.beginIntent(on, true);
        check(guard.mayEnable(), "latest explicit on can start approved enrollment");
        long staleOn = guard.receivedIntent();
        long newerOff = guard.receivedIntent();
        guard.beginIntent(staleOn, true);
        check(!guard.mayEnable(), "older queued on cannot override newer opt-out");
        guard.beginIntent(newerOff, false);
        check(!guard.mayEnable(), "newest off wins");
        long first = guard.receivedIntent();
        long last = guard.receivedIntent();
        guard.beginIntent(first, false);
        check(!guard.mayEnable(), "older stop cannot make pending on premature");
        guard.beginIntent(last, true);
        check(guard.mayEnable(), "on after stop opens only at execution");
        check(!guard.beginIntent(first, false) && guard.mayEnable(), "stale late stop rejected without changing latest ON");
        Thread incoming = new Thread(guard::receivedIntent);
        incoming.start(); incoming.join();
        check(!guard.mayEnable(), "cross-thread received stop visible after registration");

        check(PrivacySafetyPolicy.retrySnapshot("pending", "pending"), "initial snapshot attempted");
        check(PrivacySafetyPolicy.retrySnapshot("unavailable", "failed"), "null snapshot can recover later");
        check(!PrivacySafetyPolicy.retrySnapshot("captured", "failed"), "captured pre-reset ID never replaced on reset retry");
        check(!PrivacySafetyPolicy.retrySnapshot("unavailable", "reset_requested"), "no post-reset ID substituted");
        for (String code : new String[]{"collection_change_failed", "component_disable_incomplete", "sdk_unavailable"})
            check(PrivacySafetyPolicy.resolvedStopFailure(code), "successful stop clears only its failure: " + code);
        for (String code : new String[]{"old_id_unavailable", "analytics_reset_failed", "crash_local_failed", "invalid_proof", "provider_action_required", "storage_mirror_failed", "snapshot_unavailable"})
            check(!PrivacySafetyPolicy.resolvedStopFailure(code), "unrelated unresolved failure preserved: " + code);

        check(PrivacySafetyPolicy.validRetention(1,3650,"retain_tombstone"), "explicit supported limits accepted");
        for (Integer value : new Integer[]{null,-1,0,3651,Integer.MAX_VALUE}) {
            check(!PrivacySafetyPolicy.validRetention(value,1,"retain_tombstone"), "receipt limit closed");
            check(!PrivacySafetyPolicy.validRetention(1,value,"retain_tombstone"), "observation limit closed");
        }
        check(!PrivacySafetyPolicy.validRetention(1,1,null), "no guessed key-retention policy");
        check(PrivacySafetyPolicy.workerRetentionMatches(30,60,"retain_tombstone",30,"retain_tombstone"), "server snapshot agrees before first bind");
        check(!PrivacySafetyPolicy.workerRetentionMatches(31,60,"retain_tombstone",30,"retain_tombstone"), "same policy name cannot hide receipt mismatch");
        check(!PrivacySafetyPolicy.workerRetentionMatches(30,29,"retain_tombstone",30,"retain_tombstone"), "server mapping cannot expire before receipt");
        check(!PrivacySafetyPolicy.workerRetentionMatches(30,3651,"retain_tombstone",30,"retain_tombstone"), "server range rejected");
        check(!PrivacySafetyPolicy.workerRetentionMatches(30,60,"other",30,"retain_tombstone"), "server key policy mismatch rejected");
        check(!PrivacySafetyPolicy.workerRetentionMatches(30,60,"retain_tombstone",null,"retain_tombstone"), "unknown client config cannot bind");
        String origin="https://privacy.example.test";
        check(PrivacySafetyPolicy.validEndpoint(origin,origin,"policy_1"), "exact origin and valid policy");
        check(PrivacySafetyPolicy.validEndpoint(origin+":8443",origin+":8443","policy-1"), "explicit nondefault port");
        for (String invalid : new String[]{"http://privacy.example.test",origin+"/",origin+"?x=1",origin+"#x",origin+":443",origin+":0443",origin+":0",origin+":65536","https://PRIVACY.example.test","https://user@privacy.example.test","https://privacy.example.test:abc","https://privacy.example.test\r\n"})
            check(!PrivacySafetyPolicy.validEndpoint(invalid,invalid,"policy_1"), "noncanonical origin rejected");
        check(!PrivacySafetyPolicy.validEndpoint(origin,"https://other.example.test","policy_1"), "audience mismatch cannot enable");
        for (String policy : new String[]{null,""," ","a/b","a".repeat(81)})
            check(!PrivacySafetyPolicy.validEndpoint(origin,origin,policy), "invalid policy rejected");
        System.out.println("PASS: "+checks+" executable intent, continuation and configuration checks; no SDK/key/network operations");
    }
}

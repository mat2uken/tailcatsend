import jp.yasagure.ponlet.platform.PrivacySafetyPolicy;
import static jp.yasagure.ponlet.platform.PrivacySafetyPolicy.Startup.*;

/** Executes the same pure startup/retention decisions used by Kotlin. No SDK or external state. */
public class PrivacySafetyPolicyTest {
    static int checks;
    static void check(boolean value, String label) { checks++; if (!value) throw new AssertionError(label); }
    static PrivacySafetyPolicy.Startup startup(boolean restored, boolean fresh, boolean disabledEarlier,
            boolean epoch, boolean key, boolean bound, boolean desired) {
        return PrivacySafetyPolicy.startup(true, restored, fresh, disabledEarlier, epoch, key, bound, desired);
    }
    static boolean purge(long now, Integer receipt, Integer late, boolean accepted, boolean analytics,
            boolean crash, boolean localA, boolean localC, boolean extra, boolean operator, long proof, long local, boolean referenced) {
        return PrivacySafetyPolicy.mayPurge(now, receipt, late, accepted, analytics, crash, localA, localC, extra, operator, proof, referenced, true);
    }
    public static void main(String[] args) {
        check(PrivacySafetyPolicy.startup(false,true,false,false,true,false,false,true)==LEGACY,"disabled feature preserves legacy startup");
        check(startup(false,true,false,false,false,false,true)==FRESH_DISABLED,"fresh SDK defaults disabled");
        check(startup(true,true,true,true,true,true,true)==BLOCK_RESTORE,"restore always blocks despite apparently fresh proof");
        check(startup(false,false,false,false,false,false,true)==BLOCK_MIGRATION,"unknown upgrade with persisted true blocked");
        check(startup(false,false,false,false,false,false,false)==BLOCK_MIGRATION,"legacy opt-out alone is not SDK evidence");
        check(startup(false,false,true,false,false,false,true)==PREVIOUS_RUN_DISABLED,"confirmed previous process disabled can enroll");
        check(startup(false,false,true,true,false,true,true)==BLOCK_MISSING_KEY,"lost registered key cannot re-enroll");
        check(startup(false,false,false,true,true,true,true)==REGISTERED_ENABLED,"old bound IDs can resume when requested");
        check(startup(false,false,false,true,true,false,true)==BLOCK_MIGRATION,"partial bind not enough for SDK auto startup");
        check(startup(false,false,false,true,true,true,false)==BLOCK_MIGRATION,"stop saved but SDK disable evidence absent blocks startup");
        check(startup(false,false,true,true,true,true,false)==PREVIOUS_RUN_DISABLED,"stop SDK proof from older process permits local continuation");
        for (var result : PrivacySafetyPolicy.Startup.values()) {
            check(PrivacySafetyPolicy.allowsSdk(result)==(result==LEGACY||result==FRESH_DISABLED||result==PREVIOUS_RUN_DISABLED||result==REGISTERED_ENABLED),"startup decision "+result);
        }
        for (boolean has : new boolean[]{false,true}) for(boolean primary:new boolean[]{false,true}) for(boolean legacy:new boolean[]{false,true}) {
            check(PrivacySafetyPolicy.effectiveDesired(has,primary,legacy)==(legacy&&(!has||primary)),"cross-file effective stop truth table");
            check(PrivacySafetyPolicy.needsLegacyStopMirror(has,primary,legacy)==(has&&!primary&&legacy),"stop mirror recovery truth table");
        }
        // Fault points: before primary commit, after primary before mirror, after both commits.
        check(PrivacySafetyPolicy.effectiveDesired(false,true,true),"before any stop commit still legacy preference");
        check(!PrivacySafetyPolicy.effectiveDesired(true,false,true),"crash after primary stop wins old true mirror");
        check(PrivacySafetyPolicy.needsLegacyStopMirror(true,false,true),"restart must repair mirror before SDK reset");
        check(!PrivacySafetyPolicy.effectiveDesired(true,false,false),"both stop commits remain off");
        check(!PrivacySafetyPolicy.effectiveDesired(true,true,false),"crash during enable never reverses restored off");
        final long day=86400000L, local=1000, proof=2000, expiry=proof+3*day;
        check(!purge(expiry-1,3,2,true,true,true,true,true,false,false,proof,local,false),"receipt expiry not reached");
        check(purge(expiry,3,2,true,true,true,true,true,false,false,proof,local,false),"both configured windows elapsed");
        check(!purge(expiry,3,4,true,true,true,true,true,false,false,proof,local,false),"late arrival observation controls later expiry");
        check(!purge(expiry,null,2,true,true,true,true,true,false,false,proof,local,false),"unset receipt days closed");
        check(!purge(expiry,3,null,true,true,true,true,true,false,false,proof,local,false),"unset observation days closed");
        check(!purge(expiry,0,2,true,true,true,true,true,false,false,proof,local,false),"zero days never shortcut");
        check(!purge(expiry,3,2,false,true,true,true,true,false,false,proof,local,false),"unaccepted retained");
        check(!purge(expiry,3,2,true,false,true,true,true,false,false,proof,local,false),"analytics unresolved retained");
        check(!purge(expiry,3,2,true,true,false,true,true,false,false,proof,local,false),"crash unresolved retained");
        check(!purge(expiry,3,2,true,true,true,false,true,false,false,proof,local,false),"snapshot/reset incomplete retained");
        check(!purge(expiry,3,2,true,true,true,true,false,false,false,proof,local,false),"restart pending retained");
        check(!purge(expiry,3,2,true,true,true,true,true,true,false,proof,local,false),"additional submission retained");
        check(!purge(expiry,3,2,true,true,true,true,true,false,true,proof,local,false),"operator problem retained");
        check(purge(expiry,3,2,true,true,true,true,true,false,false,proof,Long.MAX_VALUE,false),"untrusted device future time does not block exact acknowledged server-time retention");
        check(!purge(expiry,3,2,true,true,true,true,true,false,false,0,local,false),"missing evidence retained");
        check(!purge(expiry,3,2,true,true,true,true,true,false,false,proof,local,true),"active/pending/shared key retained");
        check(!purge(Long.MAX_VALUE,3,2,true,true,true,true,true,false,false,Long.MAX_VALUE-1,local,false),"timestamp overflow closed");
        System.out.println("PASS: "+checks+" executable Java startup, split-write recovery and retention checks; no SDK/key/network operations");
    }
}

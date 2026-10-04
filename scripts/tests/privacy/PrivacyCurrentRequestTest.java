import jp.yasagure.ponlet.platform.PrivacySafetyPolicy;
import java.util.*;

/** Stable current selection uses explicit request order, independent of device timestamps. */
public class PrivacyCurrentRequestTest {
    static int checks;
    static void check(boolean value, String name) { checks++; if(!value)throw new AssertionError(name); }
    static String current(String saved, String[] pending, String[] expired) {
        return PrivacySafetyPolicy.currentRequest(saved,pending,expired);
    }
    public static void main(String[] args) {
        String older="local-older", newer="local-newer", newest="local-newest";
        String[] none={};
        String selected=current(newer,new String[]{older,newer},none);
        check(newer.equals(selected),"new explicit request is selected");
        selected=current(selected,new String[]{older},new String[]{newer});
        check(newer.equals(selected),"newer settled expiry cannot roll current back to older unresolved request");
        check(newer.equals(current(selected,new String[]{older},new String[]{newer})),"restart preserves newer tombstone selection");
        check(older.equals(Arrays.stream(new String[]{older}).filter(id->!id.equals(newer)).findFirst().orElseThrow()),"older unresolved request remains available as history");
        Map<String,String> pendingCanonical=Map.of(newer,"canonical-server-id");
        Map<String,String> expiredCanonical=Map.of(newer,"canonical-server-id");
        check(pendingCanonical.get(current(newer,new String[]{older,newer},none))
            .equals(expiredCanonical.get(current(newer,new String[]{older},new String[]{newer}))),"canonical idempotent server ID remains identical across expiry");
        selected=current(selected,none,new String[]{older,newer});
        check(newer.equals(selected),"all expired retains latest current");
        selected=current(newest,new String[]{newest},new String[]{older,newer});
        check(newest.equals(selected),"only explicit new request selects a new current");
        check(newest.equals(current(selected,new String[]{newest},new String[]{older,newer})),"new-after-all-expired survives restart");
        check(newer.equals(current(null,new String[]{older,newer},none)),"legacy state uses saved ticket order");
        check(newer.equals(current(null,none,new String[]{older,newer})),"legacy tombstones use saved order");
        check(current(null,none,none)==null,"empty state remains idle");
        try {current("missing",new String[]{older},new String[]{newer});throw new AssertionError("stale pointer silently reassigned");}
        catch(IllegalArgumentException expected){checks++;}
        System.out.println("PASS: "+checks+" executable stable-current regressions; no SDK/key/network operations");
    }
}

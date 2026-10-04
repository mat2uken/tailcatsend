import jp.yasagure.ponlet.platform.PrivacySafetyPolicy;
import jp.yasagure.ponlet.platform.PrivacyComponentActions;
import java.util.*;

/** Regression cases for server-ACK, 404 clock, pinned policy and disable failure ordering. */
public class PrivacyReviewRegressionTest {
    static int checks;
    static final long DAY = 86400000L;
    static void check(boolean value, String name) { checks++; if (!value) throw new AssertionError(name); }
    static boolean ack(String a, String c, String f, String sa, String sc, String continuation) {
        return PrivacySafetyPolicy.acknowledgedAndSettled(a,c,f,sa,sc,continuation);
    }
    static boolean purge(Long serverNow, Integer oldReceiptDays, Integer oldObservationDays, boolean latestAck) {
        return PrivacySafetyPolicy.mayPurge(serverNow == null ? 0 : serverNow, oldReceiptDays, oldObservationDays,
            true,true,true,true,true,false,false,2000,false,latestAck);
    }
    public static void main(String[] args) {
        boolean complete = ack("reset_requested","delete_queued","disabled_persisted","reset_requested","delete_queued","none");
        check(complete,"exact complete local/server state is acknowledged");
        boolean stale = ack("reset_requested","delete_queued","disabled_persisted","reset_requested","restart_required","restart_required");
        check(!stale,"server provider-submitted with restart outstanding is NOT a settled ACK");
        check(!ack("reset_requested","delete_queued","disabled_persisted","reset_requested","delete_queued","restart_required"),"continuation none required");
        check(!ack("reset_requested","delete_queued","sdk_unavailable","reset_requested","delete_queued","none"),"future telemetry stop must be acknowledged");
        check(!ack("reset_requested","delete_queued",null,null,null,null),"old schema with no ACK stays retained");
        check(!ack("unavailable","delete_queued","disabled_persisted","unavailable","delete_queued","none"),"analytics unavailable is not deletion evidence");
        check(!ack("reset_requested","unavailable","disabled_persisted","reset_requested","unavailable","none"),"crash unavailable is not deletion evidence");
        check(PrivacySafetyPolicy.needsClientNotification("reset_requested","delete_queued","disabled_persisted","reset_requested","restart_required","restart_required"),"boot-local continuation triggers status notification");
        check(PrivacySafetyPolicy.needsClientNotification("reset_requested","delete_queued",null,null,null,null),"missing ACK is retried");
        check(PrivacySafetyPolicy.needsClientNotification("reset_requested","delete_queued","disabled_persisted","reset_requested","delete_queued","restart_required"),"non-none continuation retried even if values match");
        check(!PrivacySafetyPolicy.needsClientNotification("reset_requested","delete_queued","disabled_persisted","reset_requested","delete_queued","none"),"acknowledged complete state uses GET refresh");
        check(!PrivacySafetyPolicy.needsClientNotification("reset_requested","restart_required","disabled_persisted","reset_requested","restart_required","restart_required"),"already acknowledged restart does not spam identical state");
        check(PrivacySafetyPolicy.requiresLocalRetry("failed","delete_queued",false),"accepted receipt cannot hide analytics local failure");
        check(PrivacySafetyPolicy.requiresLocalRetry("reset_requested","unavailable",false),"accepted receipt cannot hide unavailable crash SDK");
        check(PrivacySafetyPolicy.requiresLocalRetry("reset_requested","delete_queued",true),"local operation error remains actionable despite prior acceptance");
        check(!PrivacySafetyPolicy.requiresLocalRetry("reset_requested","delete_queued",false),"clean local state does not invent a retry");
        // Worker expires at its earlier server-settled time; native's first receipt observed slightly later.
        Long lastSuccessfulReceiptDate = 2000L;
        check(!purge(lastSuccessfulReceiptDate,3,2,true),"initial receipt not expired locally");
        Long dateFrom404 = 4 * DAY;
        Long laterClock = PrivacySafetyPolicy.advanceServerClock(lastSuccessfulReceiptDate,dateFrom404);
        check(purge(laterClock,3,2,complete),"404 Date advances known settled receipt cleanup without needing impossible post-expiry 200");
        check(!purge(laterClock,3,2,stale),"404 clock cannot supply a missing latest-client-state ACK");
        check(!purge(PrivacySafetyPolicy.advanceServerClock(lastSuccessfulReceiptDate,null),3,2,complete),"no Date means no device-clock fallback");
        check(PrivacySafetyPolicy.advanceServerClock(9000L,1000L)==9000L,"old Date never moves clock backwards");
        check(PrivacySafetyPolicy.advanceServerClock(null,null)==null,"unknown stays unknown");
        check(PrivacySafetyPolicy.advanceServerClock(9000L,-100L)==9000L,"invalid Date ignored");
        // Retention arguments are the immutable per-epoch/per-ticket snapshot, NOT latest settings.
        final int pinnedReceiptDays=30, pinnedObservationDays=20;
        final int changedReceiptDays=1, changedObservationDays=1;
        check(purge(10*DAY,changedReceiptDays,changedObservationDays,complete),"control: shorter replacement config would purge too early");
        check(!purge(10*DAY,pinnedReceiptDays,pinnedObservationDays,complete),"old ticket ignores shorter new config");
        check(purge(31*DAY,pinnedReceiptDays,pinnedObservationDays,complete),"old ticket purges after its own snapshot window");
        check(!purge(100*DAY,null,null,complete),"unknown old policy never guessed from new config");
        check(!purge(31*DAY,30,60,complete),"old longer observation window also pinned");
        List<Integer> attempted=new ArrayList<>();
        PrivacyComponentActions.Action[] actions=new PrivacyComponentActions.Action[5];
        for(int i=0;i<5;i++){final int n=i;actions[i]=()->{attempted.add(n);if(n==1||n==3)throw new Exception("fixture failure");};}
        var result=PrivacyComponentActions.close(()->{throw new Exception("marker full");},actions);
        check(attempted.equals(List.of(0,1,2,3,4)),"marker and per-component failures do not skip any disable");
        check(result.markerFailed,"marker failure reported");
        check(result.failedComponents.equals(List.of(1,3)),"all component failures retained as safe indexes");
        check(!result.succeeded(),"best effort is not false success");
        attempted.clear();
        result=PrivacyComponentActions.close(()->{},new PrivacyComponentActions.Action[]{()->attempted.add(0),()->attempted.add(1)});
        check(result.succeeded()&&attempted.equals(List.of(0,1)),"all success reported only after all attempts");
        result=PrivacyComponentActions.close(()->{throw new Exception();},new PrivacyComponentActions.Action[]{});
        check(!result.succeeded()&&result.markerFailed,"empty inventory cannot hide failed marker");
        System.out.println("PASS: "+checks+" executable review-regression checks; fixed fixtures; no SDK/key/network operations");
    }
}

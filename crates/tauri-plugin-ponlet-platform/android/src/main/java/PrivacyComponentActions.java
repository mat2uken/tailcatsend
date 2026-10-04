package jp.yasagure.ponlet.platform;

import java.util.ArrayList;
import java.util.List;

/** Executes every disable attempt even if the marker or an earlier component fails. */
public final class PrivacyComponentActions {
    private PrivacyComponentActions() {}
    @FunctionalInterface public interface Action { void run() throws Exception; }
    public static final class Result {
        public final boolean markerFailed;
        public final List<Integer> failedComponents;
        Result(boolean markerFailed, List<Integer> failedComponents) {
            this.markerFailed = markerFailed;
            this.failedComponents = List.copyOf(failedComponents);
        }
        public boolean succeeded() { return !markerFailed && failedComponents.isEmpty(); }
    }
    public static Result close(Action marker, Action[] components) {
        boolean markerFailed = false;
        try { marker.run(); } catch (Exception failure) { markerFailed = true; }
        List<Integer> failures = new ArrayList<>();
        for (int i = 0; i < components.length; i++) {
            try { components[i].run(); } catch (Exception failure) { failures.add(i); }
        }
        return new Result(markerFailed, failures);
    }
}

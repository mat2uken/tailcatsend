import jp.yasagure.ponlet.platform.PrivacyResponseRules;
import jp.yasagure.ponlet.platform.PrivacyResponseRules.Deadline;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.SocketTimeoutException;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/** Runs the exact response/reader checks used by Kotlin with fake clocks and in-memory streams. */
public class PrivacyResponseRulesTest {
    private static int checks;
    private interface Checked { void run() throws Exception; }
    private static void check(boolean value, String label) {
        checks++;
        if (!value) throw new AssertionError(label);
    }
    private static void rejects(Class<? extends Exception> type, Checked action, String label) throws Exception {
        checks++;
        try { action.run(); } catch (Exception error) {
            if (type.isInstance(error)) return;
            throw new AssertionError(label + ": wrong error " + error.getClass().getSimpleName(), error);
        }
        throw new AssertionError(label + ": accepted invalid input");
    }
    private static void invalid(Checked action, String label) throws Exception {
        rejects(IllegalArgumentException.class, action, label);
    }
    private static final class Clock implements PrivacyResponseRules.NanoClock {
        long nanos;
        public long nanoTime() { return nanos; }
        void advanceMillis(long millis) { nanos += millis * 1000000L; }
    }
    private static final class Trickle extends InputStream {
        final Clock clock;
        final long millisPerRead;
        int remaining;
        int reads;
        Trickle(Clock clock, long millisPerRead, int remaining) {
            this.clock = clock; this.millisPerRead = millisPerRead; this.remaining = remaining;
        }
        public int read() { throw new AssertionError("buffered reading required"); }
        public int read(byte[] target, int offset, int length) {
            reads++;
            clock.advanceMillis(millisPerRead);
            if (remaining-- == 0) return -1;
            target[offset] = 'x';
            return 1;
        }
    }

    private static void typedValues() throws Exception {
        for (Object value : new Object[]{1, 1L, (short) 1, (byte) 1, 1d, 1f, new BigInteger("1"), new BigDecimal("1.000")}) {
            PrivacyResponseRules.requireSchemaVersion(value);
            check(true, "integral schema number accepted");
        }
        for (Object value : new Object[]{null, "1", true, 0, 2, -1, 1.5, Double.NaN, Double.POSITIVE_INFINITY,
                Double.NEGATIVE_INFINITY, new BigDecimal("1.00000000000000000001"), new BigInteger("18446744073709551617")})
            invalid(() -> PrivacyResponseRules.requireSchemaVersion(value), "schema coercion/overflow refused");
        check(PrivacyResponseRules.requireInteger(253402300799999L, 1, PrivacyResponseRules.MAX_TIMESTAMP_MS)
                == 253402300799999L, "maximum timestamp integer accepted");
        for (Object value : new Object[]{0L, -1L, 253402300800000L, "1730000000000", true, 1730000000000.5,
                Long.MAX_VALUE, Double.MAX_VALUE, 9007199254740992d})
            invalid(() -> PrivacyResponseRules.requireInteger(value, 1, PrivacyResponseRules.MAX_TIMESTAMP_MS),
                    "expiry number type/range checked");
        invalid(() -> PrivacyResponseRules.requireInteger(1, 2, 1), "reversed bounds refused");
        invalid(() -> PrivacyResponseRules.requireInteger(1, Long.MIN_VALUE, Long.MAX_VALUE), "unsafe bounds refused");
        Number liar = new Number() {
            public int intValue() { return 1; } public long longValue() { return 1; }
            public float floatValue() { return 1; } public double doubleValue() { return 1; }
        };
        invalid(() -> PrivacyResponseRules.requireSchemaVersion(liar), "unknown Number conversion refused");
        check("hello".equals(PrivacyResponseRules.requireString("hello")), "typed string accepted");
        for (Object value : new Object[]{null, 1, false, new StringBuilder("hello"), new Object()})
            invalid(() -> PrivacyResponseRules.requireString(value), "non-string never stringified");
        check(PrivacyResponseRules.requireBoolean(true), "typed true");
        check(!PrivacyResponseRules.requireBoolean(false), "typed false");
        for (Object value : new Object[]{null, "true", "false", "TRUE", 0, 1, new Object()})
            invalid(() -> PrivacyResponseRules.requireBoolean(value), "non-boolean never coerced");
    }

    private static void identifiers() throws Exception {
        String uuid = "01234567-89ab-4cde-8fab-0123456789ab";
        check(uuid.equals(PrivacyResponseRules.requireUuid(uuid)), "Worker canonical UUID v4 accepted");
        for (String bad : new String[]{uuid.toUpperCase(), "01234567-89ab-1cde-8fab-0123456789ab",
                "01234567-89ab-4cde-7fab-0123456789ab", "1-1-4-8-1", "------------------------------------",
                uuid + "\n", " " + uuid, uuid.replace("-", "")})
            invalid(() -> PrivacyResponseRules.requireUuid(bad), "malformed or non-v4 UUID refused");
        String suffix = "A".repeat(41) + "_-";
        for (String prefix : new String[]{"epoch", "ga", "crash", "chg", "nonce"}) {
            String valid = prefix + "_" + suffix;
            check(valid.equals(PrivacyResponseRules.requireServiceId(valid, prefix)), "Worker prefixed ID accepted");
            for (String bad : new String[]{valid + "A", valid.substring(0, valid.length() - 1),
                    prefix + "_" + "A".repeat(42) + "=", prefix + "_" + "A".repeat(42) + "/",
                    prefix + "_" + "A".repeat(42) + "+", "wrong_" + suffix, valid + "\n", " " + valid})
                invalid(() -> PrivacyResponseRules.requireServiceId(bad, prefix), "wrong ID prefix/length/alphabet refused");
        }
        invalid(() -> PrivacyResponseRules.requireServiceId("other_" + suffix, "other"), "unknown prefix refused");
        invalid(() -> PrivacyResponseRules.requireServiceId(null, "epoch"), "missing ID refused");
    }

    private static void states() throws Exception {
        String[] states = {"queued", "in_flight", "retry_wait", "submitted", "operator_action_required"};
        for (String a : states) for (String c : states) for (boolean ae : new boolean[]{false, true})
            for (boolean ce : new boolean[]{false, true}) {
                String expected = ae || ce || a.equals("operator_action_required") || c.equals("operator_action_required")
                        ? "operator_action_required" : a.equals("submitted") && c.equals("submitted")
                        ? "provider_submitted" : a.equals("retry_wait") || c.equals("retry_wait") ? "retrying" : "accepted";
                check(expected.equals(PrivacyResponseRules.expectedOverallState(a, ae, c, ce)), "coordinator state precedence");
                check(expected.equals(PrivacyResponseRules.requireOverallState(expected, a, ae, c, ce)), "matching state accepted");
                String wrong = expected.equals("accepted") ? "provider_submitted" : "accepted";
                invalid(() -> PrivacyResponseRules.requireOverallState(wrong, a, ae, c, ce), "contradictory state refused");
                check((a.equals("submitted") || c.equals("submitted") ? "submission_only" : "none")
                        .equals(PrivacyResponseRules.expectedCompletionEvidence(a, c)), "coordinator completion evidence");
            }
        for (Object bad : new Object[]{"unsupported", "completed", "accepted", "retrying", "SUBMITTED", null, 1})
            invalid(() -> PrivacyResponseRules.requireProviderState(bad), "unknown analytics/crash provider state refused");
        for (String bad : new String[]{"queued", "retry_wait", "completed", "unsupported"})
            invalid(() -> PrivacyResponseRules.requireOverallState(bad, "queued", false, "queued", false),
                    "provider-only/unsupported overall states refused");
        for (String local : new String[]{"pending", "restart_required", "failed", "delete_queued", "no_unsent_reports_observed", "unavailable"}) {
            String expected = Arrays.asList("pending", "restart_required", "failed").contains(local) ? "restart_required" : "none";
            check(expected.equals(PrivacyResponseRules.requireClientContinuation(expected, local)), "coordinator continuation");
            invalid(() -> PrivacyResponseRules.requireClientContinuation(expected.equals("none") ? "restart_required" : "none", local),
                    "contradictory continuation refused");
        }
        invalid(() -> PrivacyResponseRules.requireClientContinuation("none", "completed"), "unknown local state refused");
    }

    private static void timestampsAndText() throws Exception {
        for (String good : new String[]{"2026-10-04T00:01:00Z", "2026-10-04T00:01:00.123456789Z",
                "2024-02-29T23:59:59.1+09:00", "2026-10-04T00:01:00+23:59", "2026-10-04T00:01:00-23:59",
                "0001-01-01T00:00:00Z", "9999-12-31T23:59:59.999Z"})
            check(good.equals(PrivacyResponseRules.requireTimestamp(good)), "Worker strict timestamp accepted");
        for (Object bad : new Object[]{null, 123, "2026-02-30T00:01:00Z", "2025-02-29T00:00:00Z", "0000-01-01T00:00:00Z",
                "2026-10-04", "2026-10-04T00:01:00", "2026-10-04t00:01:00z", "2026-10-04T24:00:00Z",
                "2026-10-04T00:60:00Z", "2026-10-04T00:00:60Z", "2026-10-04T00:00:00-00:00",
                "2026-10-04T00:00:00+24:00", "2026-10-04T00:00:00+01:60", "2026-10-04T00:00:00.1234567890Z",
                "0001-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01", "2026-10-04T00:00:00Z\n"})
            invalid(() -> PrivacyResponseRules.requireTimestamp(bad), "invalid/range timestamp refused");
        check(PrivacyResponseRules.timestampMillis("1970-01-01T00:00:00.123456789Z") == 123, "fraction truncation matches Worker");
        check(PrivacyResponseRules.timestampMillis("1969-12-31T23:59:59.999999999Z") == -1, "negative milliseconds match Worker");
        check(PrivacyResponseRules.timestampMillis("1970-01-01T09:00:00+09:00") == 0, "offset interpreted");
        String text = "削除状態 😀";
        check(text.equals(PrivacyResponseRules.decodeUtf8(text.getBytes(StandardCharsets.UTF_8))), "strict UTF-8 round trip");
        for (byte[] bad : new byte[][]{{(byte) 0xC0, (byte) 0xAF}, {(byte) 0xE3, (byte) 0x81},
                {(byte) 0xED, (byte) 0xA0, (byte) 0x80}, {(byte) 0xFF}})
            rejects(CharacterCodingException.class, () -> PrivacyResponseRules.decodeUtf8(bad), "malformed UTF-8 refused");
        invalid(() -> PrivacyResponseRules.decodeUtf8(new byte[8193]), "decode size cap retained");
    }

    private static void boundedReading() throws Exception {
        Clock fast = new Clock();
        List<Integer> timeouts = new ArrayList<>();
        byte[] full = new byte[8192];
        Arrays.fill(full, (byte) 'x');
        check(Arrays.equals(full, PrivacyResponseRules.readBounded(new ByteArrayInputStream(full), 8192,
                new Deadline(15000, fast), timeouts::add)), "exact byte limit accepted");
        check(timeouts.size() == 9 && timeouts.stream().allMatch(t -> t == 15000), "timeout applied before each data/EOF read");
        rejects(IOException.class, () -> PrivacyResponseRules.readBounded(new ByteArrayInputStream(new byte[8193]),
                8192, new Deadline(15000, fast), t -> {}), "first byte beyond limit refused");
        check(PrivacyResponseRules.readBounded(new ByteArrayInputStream(new byte[0]), 0,
                new Deadline(1, fast), t -> {}).length == 0, "empty stream and zero byte cap");
        rejects(IOException.class, () -> PrivacyResponseRules.readBounded(new ByteArrayInputStream(new byte[]{1}), 0,
                new Deadline(1, fast), t -> {}), "zero byte cap refuses data");
        invalid(() -> PrivacyResponseRules.readBounded(new ByteArrayInputStream(new byte[0]), 8193,
                new Deadline(1, fast), t -> {}), "caller cannot increase byte cap");

        Clock trickleClock = new Clock();
        Deadline total = new Deadline(1000, trickleClock);
        trickleClock.advanceMillis(250); // Connection, writing, and response headers consumed this time.
        Trickle trickle = new Trickle(trickleClock, 200, 100);
        List<Integer> remaining = new ArrayList<>();
        rejects(SocketTimeoutException.class, () -> PrivacyResponseRules.readBounded(trickle, 8192, total,
                remaining::add), "trickled response cannot reset total deadline");
        check(remaining.equals(Arrays.asList(750, 550, 350, 150)), "remaining whole-exchange timeout decreases on every read");
        check(trickle.reads == 4, "trickle aborted at total budget rather than individual read timeout");

        Clock slowEofClock = new Clock();
        rejects(SocketTimeoutException.class, () -> PrivacyResponseRules.readBounded(new Trickle(slowEofClock, 100, 0),
                8192, new Deadline(100, slowEofClock), t -> {}), "EOF arriving at deadline cannot turn timeout into success");
        Clock expiredClock = new Clock();
        Deadline expired = new Deadline(100, expiredClock);
        expiredClock.advanceMillis(100);
        Trickle neverRead = new Trickle(expiredClock, 0, 1);
        rejects(SocketTimeoutException.class, () -> PrivacyResponseRules.readBounded(neverRead, 8192, expired, t -> {}),
                "header phase exhausted deadline before first body read");
        check(neverRead.reads == 0, "expired budget never accesses response stream");

        Clock submillisecond = new Clock();
        Deadline small = new Deadline(1, submillisecond);
        submillisecond.nanos = 999999;
        check(small.remainingMillis() == 1, "submillisecond remainder never becomes infinite socket timeout zero");
        submillisecond.nanos++;
        rejects(SocketTimeoutException.class, small::check, "exact monotonic deadline is expired");
        Clock wrap = new Clock();
        wrap.nanos = Long.MAX_VALUE - 500000;
        Deadline wrapping = new Deadline(2, wrap);
        wrap.nanos += 1000000;
        check(wrapping.remainingMillis() == 1, "nanoTime wraparound subtracts safely");
        Clock reversed = new Clock();
        Deadline reversal = new Deadline(10, reversed);
        reversed.nanos = -1;
        rejects(SocketTimeoutException.class, reversal::check, "backwards injected monotonic clock fails closed");
        for (long bad : new long[]{-1, 0, 30001, Long.MAX_VALUE})
            invalid(() -> new Deadline(bad, new Clock()), "deadline numeric cap checked");

        InputStream stalled = new InputStream() {
            public int read() { throw new AssertionError("buffered reading required"); }
            public int read(byte[] target, int offset, int length) { return 0; }
        };
        rejects(IOException.class, () -> PrivacyResponseRules.readBounded(stalled, 8192,
                new Deadline(10, new Clock()), t -> {}), "broken zero-progress stream cannot busy-spin forever");
        Clock setterClock = new Clock();
        Trickle setterNeverRead = new Trickle(setterClock, 0, 1);
        rejects(SocketTimeoutException.class, () -> PrivacyResponseRules.readBounded(setterNeverRead, 8192,
                new Deadline(10, setterClock), t -> setterClock.advanceMillis(10)), "deadline checked after timeout configuration");
        check(setterNeverRead.reads == 0, "timeout setter cannot consume budget then permit a read");
    }

    private static void jsonSyntax() throws Exception {
        for (String valid : new String[]{"{}", " \t\r\n{\"schemaVersion\":1}\n", "{\"a\":-1.2e+3,\"b\":0,\"c\":1E-5}",
                "{\"a\":[true,false,null,{},[]],\"b\":{\"a\":1}}", "{\"a\":\"escaped \\\" \\\\ \\/ \\b \\f \\n \\r \\t\"}",
                "{\"a\":\"削除 😀\"}", "{\"a\":\"\\ud83d\\ude00\"}", "{\"\\u0061\":1,\"b\":2}",
                "{\"a\":{\"same\":1},\"b\":{\"same\":2}}", "{\"a\":1.0,\"b\":-0,\"c\":0.1,\"d\":1e0}"}) {
            PrivacyResponseRules.requireStrictJsonObject(valid);
            check(true, "strict JSON accepted");
        }
        for (String invalid : new String[]{"", "[]", "null", "1", "\"text\"", "{} trailing", "{}{}", "\ufeff{}",
                "{'a':1}", "{a:1}", "{\"a\"=1}", "{\"a\":1;\"b\":2}", "{\"a\":1,}", "{\"a\":[1,]}",
                "{\"a\":[,1]}", "{\"a\":1//comment\n}", "{/*comment*/\"a\":1}", "{\"a\":01}",
                "{\"a\":+1}", "{\"a\":.5}", "{\"a\":1.}", "{\"a\":1e}", "{\"a\":1e+}", "{\"a\":-}",
                "{\"a\":--1}", "{\"a\":0x1}", "{\"a\":NaN}", "{\"a\":Infinity}", "{\"a\":TRUE}",
                "{\"a\":undefined}", "{\"a\":truefalse}", "{\"a\":1\u00a0}", "{\"a\":\"raw\nline\"}",
                "{\"a\":\"\\x00\"}", "{\"a\":\"\\q\"}", "{\"a\":\"\\u12g4\"}", "{\"a\":\"\\u123\"}",
                "{\"a\":\"\\ud800\"}", "{\"a\":\"\\udc00\"}", "{\"a\":\"\\ud800x\"}", "{\"a\":\"\ud800\"}",
                "{\"a\":\"\udc00\"}", "{\"a\":\"unterminated}", "{\"a\":", "{\"a\":1", "{\"a\":[1}",
                "{\"schemaVersion\":1,\"schemaVersion\":2}", "{\"a\":1,\"\\u0061\":2}",
                "{\"a\":[{\"state\":\"submitted\",\"state\":\"queued\"}]}", "{\"😀\":1,\"\\ud83d\\ude00\":2}"})
            invalid(() -> PrivacyResponseRules.requireStrictJsonObject(invalid), "nonstandard/duplicate JSON refused");
        String deepest = "{\"v\":".repeat(32) + "1" + "}".repeat(32);
        PrivacyResponseRules.requireStrictJsonObject(deepest);
        check(true, "32-level JSON accepted");
        invalid(() -> PrivacyResponseRules.requireStrictJsonObject("{\"v\":" + deepest + "}"), "JSON nesting bounded");
        invalid(() -> PrivacyResponseRules.requireStrictJsonObject("{\"a\":\"" + "a".repeat(8192) + "\"}"), "JSON text length bounded");
        invalid(() -> PrivacyResponseRules.requireStrictJsonObject("{\"a\":\"" + "削".repeat(3000) + "\"}"), "JSON UTF-8 byte count bounded");
        invalid(() -> PrivacyResponseRules.requireStrictJsonObject(null), "null JSON text refused");
    }

    static void providerTimestampEvidence() throws Exception {
        String timestamp = "2026-10-04T14:00:00.123Z";
        PrivacyResponseRules.requireProviderTimestamps("analytics", "submitted", timestamp, null);
        check(true, "analytics submission has provider timestamp");
        PrivacyResponseRules.requireProviderTimestamps("crashlytics", "submitted", null, timestamp);
        check(true, "crash submission has target-complete timestamp without claiming erased");
        PrivacyResponseRules.requireProviderTimestamps("analytics", "queued", null, null);
        check(true, "queued provider needs no invented time");
        invalid(() -> PrivacyResponseRules.requireProviderTimestamps("analytics", "submitted", null, timestamp), "wrong provider timestamp cannot prove analytics submission");
        invalid(() -> PrivacyResponseRules.requireProviderTimestamps("crashlytics", "submitted", timestamp, null), "wrong provider timestamp cannot prove crash submission");
        invalid(() -> PrivacyResponseRules.requireProviderTimestamps("analytics", "submitted", 123, null), "numeric timestamp rejected");
        invalid(() -> PrivacyResponseRules.requireProviderTimestamps("crashlytics", "submitted", null, "2026-02-30T12:00:00Z"), "malformed provider date rejected");
        invalid(() -> PrivacyResponseRules.requireProviderTimestamps("analytics", "submitted", null, null), "missing submitted evidence rejected");
        invalid(() -> PrivacyResponseRules.requireProviderTimestamps("crashlytics", "queued", null, "bad"), "invalid optional time rejected too");
    }

    public static void main(String[] args) throws Exception {
        typedValues();
        identifiers();
        states();
        timestampsAndText();
        boundedReading();
        jsonSyntax();
        providerTimestampEvidence();
        System.out.println("PASS: " + checks + " executable Java strict response and whole-exchange deadline checks; no network, SDK or keys");
    }
}

package jp.yasagure.ponlet.platform;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.net.SocketTimeoutException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.time.DateTimeException;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Pure response checks shared by Android and host-JVM tests. Never coerces JSON values. */
public final class PrivacyResponseRules {
    private PrivacyResponseRules() {}

    public static final int MAX_BODY_BYTES = 8192;
    public static final int MAX_EXCHANGE_TIMEOUT_MS = 30000;
    public static final long MAX_SAFE_INTEGER = 9007199254740991L;
    public static final long MAX_TIMESTAMP_MS = 253402300799999L;
    private static final long MIN_TIMESTAMP_MS = -62135596800000L;
    private static final Pattern UUID_V4 = Pattern.compile(
            "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
    private static final Pattern RANDOM_ID_SUFFIX = Pattern.compile("[A-Za-z0-9_-]{43}");
    private static final Pattern TIMESTAMP = Pattern.compile(
            "([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})"
            + "(?:\\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})");

    private static IllegalArgumentException invalid() {
        // Do not include received fields, provider identifiers, or response bodies in errors.
        return new IllegalArgumentException("invalid_response");
    }

    public static String requireString(Object value) {
        if (!(value instanceof String)) throw invalid();
        return (String) value;
    }

    public static boolean requireBoolean(Object value) {
        if (!(value instanceof Boolean)) throw invalid();
        return (Boolean) value;
    }

    /** JSON numbers with an exact integral value are accepted; numeric strings never are. */
    public static long requireInteger(Object value, long minimum, long maximum) {
        if (minimum > maximum || minimum < -MAX_SAFE_INTEGER || maximum > MAX_SAFE_INTEGER)
            throw invalid();
        final long result;
        try {
            if (value instanceof Byte || value instanceof Short || value instanceof Integer || value instanceof Long) {
                result = ((Number) value).longValue();
            } else if (value instanceof BigInteger) {
                result = ((BigInteger) value).longValueExact();
            } else if (value instanceof BigDecimal) {
                result = ((BigDecimal) value).longValueExact();
            } else if (value instanceof Double || value instanceof Float) {
                double number = ((Number) value).doubleValue();
                if (!Double.isFinite(number) || number != Math.rint(number)
                        || number < -MAX_SAFE_INTEGER || number > MAX_SAFE_INTEGER) throw invalid();
                result = (long) number;
            } else {
                // Reject arbitrary Number subclasses rather than trusting lossy conversion methods.
                throw invalid();
            }
        } catch (ArithmeticException error) {
            throw invalid();
        }
        if (result < minimum || result > maximum) throw invalid();
        return result;
    }

    public static void requireSchemaVersion(Object value) {
        requireInteger(value, 1, 1);
    }

    /** The Worker accepts lower-case canonical version-4 UUIDs only. */
    public static String requireUuid(Object value) {
        String result = requireString(value);
        if (!UUID_V4.matcher(result).matches()) throw invalid();
        return result;
    }

    /** prefix is one of the labels used by createRandomIds, without the separator underscore. */
    public static String requireServiceId(Object value, String prefix) {
        if (!"epoch".equals(prefix) && !"ga".equals(prefix) && !"crash".equals(prefix)
                && !"chg".equals(prefix) && !"nonce".equals(prefix)) throw invalid();
        String result = requireString(value);
        String start = prefix + "_";
        if (!result.startsWith(start) || !RANDOM_ID_SUFFIX.matcher(result.substring(start.length())).matches())
            throw invalid();
        return result;
    }

    public static String requireProviderState(Object value) {
        String result = requireString(value);
        if (!"queued".equals(result) && !"in_flight".equals(result) && !"retry_wait".equals(result)
                && !"submitted".equals(result) && !"operator_action_required".equals(result)) throw invalid();
        return result;
    }

    public static String expectedOverallState(String analyticsState, boolean analyticsAdditional,
            String crashlyticsState, boolean crashlyticsAdditional) {
        requireProviderState(analyticsState);
        requireProviderState(crashlyticsState);
        if (analyticsAdditional || crashlyticsAdditional || "operator_action_required".equals(analyticsState)
                || "operator_action_required".equals(crashlyticsState)) return "operator_action_required";
        if ("submitted".equals(analyticsState) && "submitted".equals(crashlyticsState)) return "provider_submitted";
        if ("retry_wait".equals(analyticsState) || "retry_wait".equals(crashlyticsState)) return "retrying";
        return "accepted";
    }

    public static String requireOverallState(Object value, String analyticsState, boolean analyticsAdditional,
            String crashlyticsState, boolean crashlyticsAdditional) {
        String result = requireString(value);
        if (!result.equals(expectedOverallState(analyticsState, analyticsAdditional, crashlyticsState,
                crashlyticsAdditional))) throw invalid();
        return result;
    }

    public static String expectedCompletionEvidence(String analyticsState, String crashlyticsState) {
        requireProviderState(analyticsState);
        requireProviderState(crashlyticsState);
        return "submitted".equals(analyticsState) || "submitted".equals(crashlyticsState)
                ? "submission_only" : "none";
    }

    public static String requireClientContinuation(Object value, String crashlyticsLocal) {
        if (!"pending".equals(crashlyticsLocal) && !"restart_required".equals(crashlyticsLocal)
                && !"delete_queued".equals(crashlyticsLocal) && !"no_unsent_reports_observed".equals(crashlyticsLocal)
                && !"unavailable".equals(crashlyticsLocal) && !"failed".equals(crashlyticsLocal)) throw invalid();
        String result = requireString(value);
        String expected = "pending".equals(crashlyticsLocal) || "restart_required".equals(crashlyticsLocal)
                || "failed".equals(crashlyticsLocal) ? "restart_required" : "none";
        if (!expected.equals(result)) throw invalid();
        return result;
    }

    public static void requireProviderTimestamps(String name, String state, Object deletionRequestTime,
            Object targetCompleteTime) {
        requireProviderState(state);
        if (!"analytics".equals(name) && !"crashlytics".equals(name)) throw invalid();
        if ("submitted".equals(state)) {
            requireTimestamp("analytics".equals(name) ? deletionRequestTime : targetCompleteTime);
        }
        if (deletionRequestTime != null) requireTimestamp(deletionRequestTime);
        if (targetCompleteTime != null) requireTimestamp(targetCompleteTime);
    }

    public static String requireTimestamp(Object value) {
        String result = requireString(value);
        timestampMillis(result);
        return result;
    }

    /** Mirrors providers.mjs isStrictTimestamp, including 1..9 fraction digits and explicit offsets. */
    public static long timestampMillis(Object value) {
        String result = requireString(value);
        Matcher parts = TIMESTAMP.matcher(result);
        if (!parts.matches()) throw invalid();
        try {
            int year = Integer.parseInt(parts.group(1));
            if (year < 1) throw invalid();
            String fraction = parts.group(7);
            int nanos = fraction == null ? 0 : Integer.parseInt((fraction + "000000000").substring(0, 9));
            LocalDateTime local = LocalDateTime.of(year, Integer.parseInt(parts.group(2)),
                    Integer.parseInt(parts.group(3)), Integer.parseInt(parts.group(4)),
                    Integer.parseInt(parts.group(5)), Integer.parseInt(parts.group(6)), nanos);
            String zone = parts.group(8);
            int offsetSeconds = 0;
            if (!"Z".equals(zone)) {
                int hours = Integer.parseInt(zone.substring(1, 3));
                int minutes = Integer.parseInt(zone.substring(4, 6));
                if ("-00:00".equals(zone) || hours > 23 || minutes > 59) throw invalid();
                offsetSeconds = (hours * 3600 + minutes * 60) * (zone.charAt(0) == '-' ? -1 : 1);
            }
            // ZoneOffset itself caps offsets at 18 hours; the Worker explicitly permits 23:59.
            long millis = (local.toEpochSecond(ZoneOffset.UTC) - offsetSeconds) * 1000L + nanos / 1000000;
            if (millis < MIN_TIMESTAMP_MS || millis > MAX_TIMESTAMP_MS) throw invalid();
            return millis;
        } catch (DateTimeException | NumberFormatException error) {
            throw invalid();
        }
    }

    public static String decodeUtf8(byte[] bytes) throws CharacterCodingException {
        if (bytes == null || bytes.length > MAX_BODY_BYTES) throw invalid();
        return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
    }

    /** Validate syntax before Android's permissive JSONObject parser can coerce or overwrite it. */
    public static void requireStrictJsonObject(String text) {
        if (text == null || text.length() > MAX_BODY_BYTES
                || text.getBytes(StandardCharsets.UTF_8).length > MAX_BODY_BYTES) throw invalid();
        new StrictJson(text).objectDocument();
    }

    /** Syntax only: values are still checked by the typed helpers after JSONObject.get. */
    private static final class StrictJson {
        private static final int MAX_DEPTH = 32;
        private final String text;
        private int at;
        StrictJson(String text) { this.text = text; }

        void objectDocument() {
            whitespace();
            if (at == text.length() || text.charAt(at) != '{') throw invalid();
            value(0);
            whitespace();
            if (at != text.length()) throw invalid();
        }

        private void whitespace() {
            while (at < text.length()) {
                char c = text.charAt(at);
                if (c != ' ' && c != '\t' && c != '\n' && c != '\r') return;
                at++;
            }
        }

        private boolean take(char c) {
            if (at < text.length() && text.charAt(at) == c) { at++; return true; }
            return false;
        }

        private void expect(char c) { if (!take(c)) throw invalid(); }

        private void value(int depth) {
            whitespace();
            if (at >= text.length()) throw invalid();
            char c = text.charAt(at);
            if (c == '{') object(depth + 1);
            else if (c == '[') array(depth + 1);
            else if (c == '"') string();
            else if (c == 't') literal("true");
            else if (c == 'f') literal("false");
            else if (c == 'n') literal("null");
            else number();
        }

        private void object(int depth) {
            if (depth > MAX_DEPTH) throw invalid();
            expect('{');
            whitespace();
            if (take('}')) return;
            Set<String> keys = new HashSet<>();
            for (;;) {
                whitespace();
                if (!keys.add(string())) throw invalid();
                whitespace();
                expect(':');
                value(depth);
                whitespace();
                if (take('}')) return;
                expect(',');
            }
        }

        private void array(int depth) {
            if (depth > MAX_DEPTH) throw invalid();
            expect('[');
            whitespace();
            if (take(']')) return;
            for (;;) {
                value(depth);
                whitespace();
                if (take(']')) return;
                expect(',');
            }
        }

        private void literal(String expected) {
            if (!text.startsWith(expected, at)) throw invalid();
            at += expected.length();
        }

        private static boolean digit(char c) { return c >= '0' && c <= '9'; }

        private void digits() {
            int start = at;
            while (at < text.length() && digit(text.charAt(at))) at++;
            if (start == at) throw invalid();
        }

        private void number() {
            take('-');
            if (take('0')) {
                if (at < text.length() && digit(text.charAt(at))) throw invalid();
            } else {
                if (at >= text.length() || text.charAt(at) < '1' || text.charAt(at) > '9') throw invalid();
                digits();
            }
            if (take('.')) digits();
            if (take('e') || take('E')) {
                if (!take('+')) take('-');
                digits();
            }
        }

        private char hexCharacter() {
            if (text.length() - at < 4) throw invalid();
            int result = 0;
            for (int i = 0; i < 4; i++) {
                char c = text.charAt(at++);
                int hex = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10
                        : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
                if (hex < 0) throw invalid();
                result = result * 16 + hex;
            }
            return (char) result;
        }

        private String string() {
            expect('"');
            StringBuilder decoded = new StringBuilder();
            boolean closed = false;
            while (at < text.length()) {
                char c = text.charAt(at++);
                if (c == '"') { closed = true; break; }
                if (c < 0x20) throw invalid();
                if (c == '\\') {
                    if (at >= text.length()) throw invalid();
                    c = text.charAt(at++);
                    switch (c) {
                        case '"': case '\\': case '/': break;
                        case 'b': c = '\b'; break;
                        case 'f': c = '\f'; break;
                        case 'n': c = '\n'; break;
                        case 'r': c = '\r'; break;
                        case 't': c = '\t'; break;
                        case 'u': c = hexCharacter(); break;
                        default: throw invalid();
                    }
                }
                decoded.append(c);
            }
            if (!closed) throw invalid();
            // Reject unpaired surrogate code units instead of accepting replacement characters.
            for (int i = 0; i < decoded.length(); i++) {
                char c = decoded.charAt(i);
                if (Character.isHighSurrogate(c)) {
                    if (++i >= decoded.length() || !Character.isLowSurrogate(decoded.charAt(i))) throw invalid();
                } else if (Character.isLowSurrogate(c)) throw invalid();
            }
            return decoded.toString();
        }
    }

    @FunctionalInterface public interface NanoClock { long nanoTime(); }
    @FunctionalInterface public interface ReadTimeoutSetter { void setReadTimeout(int milliseconds) throws IOException; }

    /** One monotonic budget for the entire exchange, created before connection or output work starts. */
    public static final class Deadline {
        private final NanoClock clock;
        private final long startedAt;
        private final long budgetNanos;

        public Deadline(long budgetMillis) { this(budgetMillis, System::nanoTime); }

        public Deadline(long budgetMillis, NanoClock clock) {
            if (clock == null || budgetMillis < 1 || budgetMillis > MAX_EXCHANGE_TIMEOUT_MS) throw invalid();
            this.clock = clock;
            this.startedAt = clock.nanoTime();
            this.budgetNanos = budgetMillis * 1000000L;
        }

        public int remainingMillis() throws SocketTimeoutException {
            // Subtraction deliberately handles the System.nanoTime wraparound correctly.
            long elapsed = clock.nanoTime() - startedAt;
            if (elapsed < 0 || elapsed >= budgetNanos) throw new SocketTimeoutException("privacy_exchange_deadline");
            long remaining = budgetNanos - elapsed;
            // A socket timeout of zero means unbounded, so round any sub-millisecond remainder up.
            return (int) ((remaining + 999999L) / 1000000L);
        }

        public void check() throws SocketTimeoutException { remainingMillis(); }
    }

    /**
     * Read at most maxBytes plus one overflow-detection byte. The caller owns and closes stream.
     * Reapply the remaining TOTAL budget before every read; receiving trickled bytes never resets it.
     * The setter must update the underlying connection's read timeout. Blocking connection/output
     * operations also need the same Deadline and an exchange-level disconnect watchdog in the caller.
     */
    public static byte[] readBounded(InputStream stream, int maxBytes, Deadline deadline,
            ReadTimeoutSetter timeoutSetter) throws IOException {
        if (stream == null || deadline == null || timeoutSetter == null || maxBytes < 0 || maxBytes > MAX_BODY_BYTES)
            throw invalid();
        ByteArrayOutputStream result = new ByteArrayOutputStream(Math.min(1024, maxBytes));
        byte[] buffer = new byte[1024];
        for (;;) {
            timeoutSetter.setReadTimeout(deadline.remainingMillis());
            deadline.check();
            int count = stream.read(buffer, 0, Math.min(buffer.length, maxBytes - result.size() + 1));
            deadline.check();
            if (count < 0) return result.toByteArray();
            // A non-empty InputStream.read request cannot validly make no progress.
            if (count == 0 || count > maxBytes - result.size()) throw new IOException("invalid_response");
            result.write(buffer, 0, count);
        }
    }
}

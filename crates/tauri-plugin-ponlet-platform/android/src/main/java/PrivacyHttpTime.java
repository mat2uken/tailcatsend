package jp.yasagure.ponlet.platform;

import java.time.DateTimeException;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.ResolverStyle;
import java.util.Locale;
import java.util.regex.Pattern;

/** Pure HTTP time decisions used by Android and fixed host-JVM tests. No wall clock or I/O. */
public final class PrivacyHttpTime {
    private PrivacyHttpTime() {}
    private static final long MAX_JSON_SAFE_INTEGER = 9_007_199_254_740_991L;

    // Accept only the current HTTP wire form. In particular, a numeric offset, UTC,
    // obsolete date syntax, fractional seconds and a mismatched weekday are not evidence.
    private static final Pattern HTTP_DATE = Pattern.compile(
            "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} " +
            "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) " +
            "[0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT");
    private static final DateTimeFormatter HTTP_DATE_FORMAT = DateTimeFormatter
            .ofPattern("EEE, dd MMM uuuu HH:mm:ss 'GMT'", Locale.US)
            .withResolverStyle(ResolverStyle.STRICT);

    /** Strict IMF-fixdate/RFC 1123 GMT parser. Only positive Unix times are useful here. */
    public static Long parseDateMillis(String header) {
        if (header == null || header.length() != 29 || !HTTP_DATE.matcher(header).matches()) return null;
        try {
            long result = LocalDateTime.parse(header, HTTP_DATE_FORMAT).toInstant(ZoneOffset.UTC).toEpochMilli();
            return result > 0 ? result : null;
        } catch (DateTimeException | ArithmeticException invalid) {
            return null;
        }
    }

    /**
     * Delta-seconds need no clock. An absolute Retry-After is relative only to the
     * Date on that SAME HTTP response; a saved Date or device clock is not a substitute.
     * Positive digit strings too large for a millisecond long saturate, never wrap or vanish.
     * Zero and a past absolute date return zero; the caller may apply its minimum backoff.
     */
    public static Long retryAfterMillis(String header, Long sameResponseDateMillis) {
        if (header == null || header.isEmpty()) return null;
        char first = header.charAt(0);
        if (first >= '0' && first <= '9') {
            long seconds = 0;
            boolean saturated = false;
            for (int i = 0; i < header.length(); i++) {
                char digit = header.charAt(i);
                if (digit < '0' || digit > '9') return null;
                int value = digit - '0';
                if (!saturated) {
                    if (seconds > (Long.MAX_VALUE - value) / 10L) saturated = true;
                    else seconds = seconds * 10L + value;
                }
            }
            return saturated || seconds > Long.MAX_VALUE / 1000L ? Long.MAX_VALUE : seconds * 1000L;
        }
        if (!validResponseDate(sameResponseDateMillis)) return null;
        Long retryAt = parseDateMillis(header);
        if (retryAt == null) return null;
        // Both operands are positive, so subtracting the smaller from the larger cannot overflow.
        return retryAt <= sameResponseDateMillis ? 0L : retryAt - sameResponseDateMillis;
    }

    /**
     * Convert the challenge's millisecond expiry to the exact integer seconds put in JWS exp.
     * Validate that truncated exp against the challenge response's Date, never a local clock.
     * Millisecond expiry must also fit the worker's JSON safe-integer validation.
     * A challenge expiring within Date's second is unusable. The server still validates expiry
     * on receipt: a successful local check is not a promise that later signing/networking is timely.
     */
    public static Long challengeExpirySeconds(long expiresAtMillis, Long sameResponseDateMillis) {
        if (expiresAtMillis <= 0 || expiresAtMillis > MAX_JSON_SAFE_INTEGER ||
                !validResponseDate(sameResponseDateMillis)) return null;
        long expiresSeconds = expiresAtMillis / 1000L;
        return expiresSeconds > sameResponseDateMillis / 1000L ? expiresSeconds : null;
    }

    /**
     * A second-precision Date describes [Date, Date+999ms]. Start a settled retention window
     * at its conservative upper end; otherwise purging can occur up to 999ms too early.
     * Use only the Date of an acknowledgement of the latest local state, after checking the ACK.
     * Do NOT use this upper endpoint as observed "now"; elapsed-time evidence uses the Date itself.
     */
    public static Long settledAnchorMillis(Long sameResponseDateMillis) {
        return validResponseDate(sameResponseDateMillis) ? saturatingAdd(sameResponseDateMillis, 999L) : null;
    }

    /** Overflow-safe timestamp addition, including a device clock set before the Unix epoch. */
    public static long saturatingAdd(long value, long delta) {
        if (delta > 0 && value > Long.MAX_VALUE - delta) return Long.MAX_VALUE;
        if (delta < 0 && value < Long.MIN_VALUE - delta) return Long.MIN_VALUE;
        return value + delta;
    }

    private static boolean validResponseDate(Long date) {
        return date != null && date > 0 && date % 1000L == 0;
    }
}

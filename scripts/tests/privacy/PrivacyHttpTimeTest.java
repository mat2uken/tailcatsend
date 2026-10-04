import jp.yasagure.ponlet.platform.PrivacyHttpTime;
import jp.yasagure.ponlet.platform.PrivacySafetyPolicy;
import java.util.Locale;
import java.util.TimeZone;

/** Runs production HTTP time helpers with fixed data only; no SDK, key creation or network. */
public final class PrivacyHttpTimeTest {
    static int checks;
    static final String DATE = "Sun, 04 Oct 2026 12:00:00 GMT";
    static final long DATE_MS = 1_791_115_200_000L;
    static final long DAY = 86_400_000L;
    static void check(boolean value, String label) { checks++; if (!value) throw new AssertionError(label); }
    static void equal(Long actual, long expected, String label) {
        check(actual != null && actual == expected, label + " (actual=" + actual + ", expected=" + expected + ")");
    }
    static void absent(Long actual, String label) { check(actual == null, label + " (actual=" + actual + ")"); }
    static boolean purge(long serverNow, long anchor) {
        return PrivacySafetyPolicy.mayPurge(serverNow, 1, 1, true, true, true, true, true,
                false, false, anchor, false, true);
    }

    public static void main(String[] args) {
        equal(PrivacyHttpTime.parseDateMillis(DATE), DATE_MS, "strict GMT date parsed exactly");
        equal(PrivacyHttpTime.parseDateMillis("Sun, 06 Nov 1994 08:49:37 GMT"), 784111777000L, "HTTP example parsed");
        equal(PrivacyHttpTime.parseDateMillis("Thu, 29 Feb 2024 23:59:59 GMT"), 1709251199000L, "valid leap day");
        equal(PrivacyHttpTime.parseDateMillis("Fri, 31 Dec 9999 23:59:59 GMT"), 253402300799000L, "maximum four-digit year");
        String[] invalidDates = {
            null, "", "Sun, 04 Oct 2026 12:00:00 UTC", "Sun, 04 Oct 2026 12:00:00 +0000",
            "Sun, 04 Oct 2026 12:00:00 PST", "Sun, 04 Oct 2026 12:00:00 gmt",
            "sun, 04 Oct 2026 12:00:00 GMT", "Sun, 4 Oct 2026 12:00:00 GMT",
            "Sunday, 04-Oct-26 12:00:00 GMT", "Sun Oct  4 12:00:00 2026",
            "Mon, 04 Oct 2026 12:00:00 GMT", "Sun, 31 Feb 2026 12:00:00 GMT",
            "Wed, 29 Feb 2023 12:00:00 GMT", "Sun, 04 Oct 2026 24:00:00 GMT",
            "Sun, 04 Oct 2026 12:60:00 GMT", "Sun, 04 Oct 2026 12:00:60 GMT",
            "Sun, 04 Oct 2026 12:00:00.000 GMT", "Sun, 04 Oct 2026 12:00:00 GMT ",
            " Sun, 04 Oct 2026 12:00:00 GMT", "Sun, 04 Oct 2026 12:00:00 GMT\r\n",
            "Sun, 04 Oct 2026 12:00:00 GMT, Sun, 04 Oct 2026 13:00:00 GMT",
            "Sun, ０４ Oct 2026 12:00:00 GMT", "Thu, 01 Jan 1970 00:00:00 GMT",
            "Wed, 31 Dec 1969 23:59:59 GMT"
        };
        for (String invalid : invalidDates) absent(PrivacyHttpTime.parseDateMillis(invalid), "invalid/nonpositive Date rejected: " + invalid);

        equal(PrivacyHttpTime.retryAfterMillis("0", null), 0, "zero backoff independent of Date");
        equal(PrivacyHttpTime.retryAfterMillis("1", null), 1000, "positive seconds independent of Date");
        equal(PrivacyHttpTime.retryAfterMillis("00015", null), 15000, "leading zeros retain numeric meaning");
        equal(PrivacyHttpTime.retryAfterMillis("9223372036854775", null), 9223372036854775000L, "largest whole milliseconds below overflow");
        equal(PrivacyHttpTime.retryAfterMillis("9223372036854776", null), Long.MAX_VALUE, "multiply overflow saturates");
        equal(PrivacyHttpTime.retryAfterMillis("9223372036854775807", null), Long.MAX_VALUE, "max long seconds saturate");
        equal(PrivacyHttpTime.retryAfterMillis("9223372036854775808", null), Long.MAX_VALUE, "seconds parse overflow saturates");
        equal(PrivacyHttpTime.retryAfterMillis("9".repeat(1000), null), Long.MAX_VALUE, "arbitrarily large positive decimal saturates");
        equal(PrivacyHttpTime.retryAfterMillis("0".repeat(1000) + "30", null), 30000L, "long digit string not rejected just for length");
        for (String invalid : new String[]{null, "", "-1", "+1", "1.0", "1e3", " 1", "1 ", "١", "1\n", "9".repeat(1000) + "x"})
            absent(PrivacyHttpTime.retryAfterMillis(invalid, DATE_MS), "invalid seconds rejected: " + invalid);
        equal(PrivacyHttpTime.retryAfterMillis("Sun, 04 Oct 2026 12:00:30 GMT", DATE_MS), 30000, "absolute date uses same response Date");
        equal(PrivacyHttpTime.retryAfterMillis(DATE, DATE_MS), 0, "equal retry date is zero");
        equal(PrivacyHttpTime.retryAfterMillis("Sun, 04 Oct 2026 11:59:00 GMT", DATE_MS), 0, "past retry date does not become negative");
        absent(PrivacyHttpTime.retryAfterMillis("Sun, 04 Oct 2026 12:00:30 GMT", null), "absolute retry without Date has no wall-clock fallback");
        absent(PrivacyHttpTime.retryAfterMillis("Sun, 04 Oct 2026 12:00:30 GMT", 0L), "absolute retry needs positive Date");
        absent(PrivacyHttpTime.retryAfterMillis("Sun, 04 Oct 2026 12:00:30 GMT", DATE_MS + 1), "absolute retry needs whole-second Date");
        absent(PrivacyHttpTime.retryAfterMillis("Mon, 04 Oct 2026 12:00:30 GMT", DATE_MS), "absolute retry mismatched weekday rejected");

        equal(PrivacyHttpTime.challengeExpirySeconds(DATE_MS + 30000, DATE_MS), (DATE_MS + 30000) / 1000, "challenge exp is seconds and uses server Date");
        equal(PrivacyHttpTime.challengeExpirySeconds(DATE_MS + 1000, DATE_MS), DATE_MS / 1000 + 1, "next second is the first usable integer exp");
        equal(PrivacyHttpTime.challengeExpirySeconds(DATE_MS + 1999, DATE_MS), DATE_MS / 1000 + 1, "JWS exp truncates before comparison");
        equal(PrivacyHttpTime.challengeExpirySeconds(9_007_199_254_740_991L, DATE_MS), 9_007_199_254_740L, "safe-integer expiry converts without multiplication overflow");
        for (long invalid : new long[]{Long.MIN_VALUE, -1, 0, DATE_MS - 1, DATE_MS, DATE_MS + 999, 9_007_199_254_740_992L, Long.MAX_VALUE})
            absent(PrivacyHttpTime.challengeExpirySeconds(invalid, DATE_MS), "expired or invalid challenge rejected: " + invalid);
        absent(PrivacyHttpTime.challengeExpirySeconds(DATE_MS + 30000, null), "missing challenge Date rejected");
        absent(PrivacyHttpTime.challengeExpirySeconds(DATE_MS + 30000, -1L), "negative challenge Date rejected");
        absent(PrivacyHttpTime.challengeExpirySeconds(DATE_MS + 30000, DATE_MS + 1), "non-Date challenge clock rejected");

        equal(PrivacyHttpTime.settledAnchorMillis(DATE_MS), DATE_MS + 999, "settled evidence uses Date's upper endpoint");
        absent(PrivacyHttpTime.settledAnchorMillis(null), "no Date means no settled anchor");
        absent(PrivacyHttpTime.settledAnchorMillis(0L), "zero Date means no settled anchor");
        absent(PrivacyHttpTime.settledAnchorMillis(-1000L), "negative Date means no settled anchor");
        absent(PrivacyHttpTime.settledAnchorMillis(DATE_MS + 1), "non-whole-second Date rejected as anchor");
        long anchor = PrivacyHttpTime.settledAnchorMillis(DATE_MS);
        check(!purge(DATE_MS + DAY, anchor), "second precision cannot expire retention 999ms early");
        check(!purge(anchor + DAY - 1, anchor), "retention waits until conservative endpoint");
        check(purge(DATE_MS + DAY + 1000, anchor), "next whole-second server Date proves elapsed window");
        equal(PrivacyHttpTime.settledAnchorMillis(Long.MAX_VALUE - 807), Long.MAX_VALUE, "artificial endpoint overflow saturates");
        check(!purge(Long.MAX_VALUE, PrivacyHttpTime.settledAnchorMillis(Long.MAX_VALUE - 807)), "saturated anchor cannot allow premature retention purge");

        equal(PrivacyHttpTime.saturatingAdd(DATE_MS, 30000), DATE_MS + 30000, "normal retry addition");
        equal(PrivacyHttpTime.saturatingAdd(Long.MAX_VALUE, 1), Long.MAX_VALUE, "positive overflow saturates");
        equal(PrivacyHttpTime.saturatingAdd(Long.MAX_VALUE - 1, 1), Long.MAX_VALUE, "exact maximum preserved");
        equal(PrivacyHttpTime.saturatingAdd(Long.MIN_VALUE, 30000), Long.MIN_VALUE + 30000, "negative device date does not overflow the guard");
        equal(PrivacyHttpTime.saturatingAdd(-1, Long.MAX_VALUE), Long.MAX_VALUE - 1, "large positive delay plus negative clock");
        equal(PrivacyHttpTime.saturatingAdd(1, Long.MAX_VALUE), Long.MAX_VALUE, "huge delay does not become immediately retryable");
        equal(PrivacyHttpTime.saturatingAdd(Long.MIN_VALUE, -1), Long.MIN_VALUE, "negative overflow saturates");
        equal(PrivacyHttpTime.saturatingAdd(0, Long.MIN_VALUE), Long.MIN_VALUE, "exact minimum preserved");
        equal(PrivacyHttpTime.saturatingAdd(Long.MAX_VALUE, Long.MIN_VALUE), -1, "mixed extremes add without overflow");
        equal(PrivacyHttpTime.saturatingAdd(Long.MIN_VALUE, Long.MAX_VALUE), -1, "mixed extremes reverse order");

        Locale oldLocale = Locale.getDefault();
        TimeZone oldZone = TimeZone.getDefault();
        try {
            Locale.setDefault(Locale.JAPAN);
            TimeZone.setDefault(TimeZone.getTimeZone("Pacific/Kiritimati"));
            equal(PrivacyHttpTime.parseDateMillis(DATE), DATE_MS, "date parser independent of device locale/time zone");
            equal(PrivacyHttpTime.retryAfterMillis("Sun, 04 Oct 2026 12:00:30 GMT", DATE_MS), 30000, "retry calculation independent of device settings");
        } finally { Locale.setDefault(oldLocale); TimeZone.setDefault(oldZone); }
        System.out.println("PASS: " + checks + " executable HTTP time checks; fixed data; no SDK/key/network operations");
    }
}

package jp.yasagure.ponlet.platform;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Arrays;
import java.util.Base64;

/** RFC 7515 ES256 serialization only. Signing uses the platform JCA provider. */
public final class PrivacyJws {
    private PrivacyJws() {}
    public static String base64Url(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }
    public static String sha256(byte[] bytes) throws Exception {
        return base64Url(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
    public static String thumbprint(String x, String y) throws Exception {
        if (!x.matches("[A-Za-z0-9_-]{43}") || !y.matches("[A-Za-z0-9_-]{43}"))
            throw new IllegalArgumentException("invalid_public_key");
        // RFC 7638 member order, no whitespace, public members only.
        return sha256(("{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"" + x +
            "\",\"y\":\"" + y + "\"}").getBytes(StandardCharsets.UTF_8));
    }
    public static String sign(String kid, byte[] payload, PrivateKey privateKey) throws Exception {
        if (!kid.matches("[A-Za-z0-9_-]{43}")) throw new IllegalArgumentException("invalid_kid");
        String header = "{\"alg\":\"ES256\",\"typ\":\"ponlet-privacy+jwt\",\"kid\":\"" + kid + "\"}";
        String input = base64Url(header.getBytes(StandardCharsets.UTF_8)) + "." + base64Url(payload);
        Signature signer = Signature.getInstance("SHA256withECDSA");
        signer.initSign(privateKey);
        signer.update(input.getBytes(StandardCharsets.US_ASCII));
        return input + "." + base64Url(derToJose(signer.sign()));
    }
    /** Android returns ASN.1 DER; JWS ES256 requires exactly 32-byte R || 32-byte S. */
    public static byte[] derToJose(byte[] der) {
        if (der == null || der.length < 8 || der.length > 72 || der[0] != 0x30 ||
                (der[1] & 255) != der.length - 2) throw new IllegalArgumentException("invalid_der");
        byte[] out = new byte[64];
        int offset = copyInteger(der, 2, out, 0);
        offset = copyInteger(der, offset, out, 32);
        if (offset != der.length) throw new IllegalArgumentException("invalid_der");
        return out;
    }
    private static int copyInteger(byte[] der, int offset, byte[] out, int dest) {
        if (offset + 2 > der.length || der[offset] != 2) throw new IllegalArgumentException("invalid_der");
        int size = der[offset + 1] & 255;
        int start = offset + 2;
        if (size < 1 || size > 33 || start + size > der.length || (der[start] & 128) != 0)
            throw new IllegalArgumentException("invalid_der");
        if (size > 1 && der[start] == 0) {
            if ((der[start + 1] & 128) == 0) throw new IllegalArgumentException("invalid_der");
            start++; size--;
        }
        if (size > 32) throw new IllegalArgumentException("invalid_der");
        System.arraycopy(der, start, out, dest + 32 - size, size);
        return start + size;
    }
    /** Only used by deterministic fixture verification, not by Android signing. */
    public static byte[] joseToDer(byte[] jose) {
        if (jose.length != 64) throw new IllegalArgumentException("invalid_jose");
        byte[] r = unsignedInteger(Arrays.copyOfRange(jose, 0, 32));
        byte[] s = unsignedInteger(Arrays.copyOfRange(jose, 32, 64));
        byte[] out = new byte[6 + r.length + s.length];
        out[0] = 0x30; out[1] = (byte)(out.length - 2); out[2] = 2; out[3] = (byte)r.length;
        System.arraycopy(r, 0, out, 4, r.length);
        out[4 + r.length] = 2; out[5 + r.length] = (byte)s.length;
        System.arraycopy(s, 0, out, 6 + r.length, s.length);
        return out;
    }
    private static byte[] unsignedInteger(byte[] n) {
        int start = 0;
        while (start < n.length - 1 && n[start] == 0) start++;
        boolean pad = (n[start] & 128) != 0;
        byte[] result = new byte[n.length - start + (pad ? 1 : 0)];
        System.arraycopy(n, start, result, pad ? 1 : 0, n.length - start);
        return result;
    }
}

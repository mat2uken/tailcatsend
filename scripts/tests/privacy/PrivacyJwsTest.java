import jp.yasagure.ponlet.platform.PrivacyJws;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.*;
import java.security.spec.*;
import java.util.*;

/** Uses only the PUBLICLY DOCUMENTED RFC 7515 A.3 test key. Never generates or registers a key. */
public class PrivacyJwsTest {
    static int checks = 0;
    static final String X = "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU";
    static final String Y = "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0";
    static final String D = "jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI";
    static byte[] decode(String text) { return Base64.getUrlDecoder().decode(text); }
    static void check(boolean condition, String label) { checks++; if (!condition) throw new AssertionError(label); }
    static void rejects(byte[] der) { try { PrivacyJws.derToJose(der); throw new AssertionError("accepted malformed DER"); }
        catch (IllegalArgumentException expected) { checks++; } }
    public static void main(String[] args) throws Exception {
        check(PrivacyJws.sha256(new byte[0]).equals("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"), "empty-body hash");
        String rfcSignature = "DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSApmWQxfKTUJqPP3-Kg6NU1Q";
        byte[] jose = decode(rfcSignature);
        check(Arrays.equals(jose, PrivacyJws.derToJose(PrivacyJws.joseToDer(jose))), "RFC R/S sign pad roundtrip");
        byte[] small = new byte[64]; small[31] = 1; small[63] = 2;
        check(Arrays.equals(small, PrivacyJws.derToJose(new byte[]{0x30,6,2,1,1,2,1,2})), "leading zero padding");
        byte[] high = new byte[64]; Arrays.fill(high, (byte)0xff);
        check(PrivacyJws.joseToDer(high).length == 72, "both integer pads");
        check(Arrays.equals(high, PrivacyJws.derToJose(PrivacyJws.joseToDer(high))), "high bit roundtrip");
        rejects(new byte[]{}); rejects(new byte[]{0x30,6,2,1,(byte)0x80,2,1,2});
        rejects(new byte[]{0x30,7,2,2,0,1,2,1,2});
        rejects(new byte[]{0x30,6,2,0,1,2,1,2});
        rejects(new byte[]{0x31,6,2,1,1,2,1,2});
        rejects(new byte[]{0x30,6,2,1,1,2,1,2,0});
        rejects(new byte[]{0x30,6,2,1,1,2,2,2});
        AlgorithmParameters parameters = AlgorithmParameters.getInstance("EC");
        parameters.init(new ECGenParameterSpec("secp256r1"));
        ECParameterSpec ec = parameters.getParameterSpec(ECParameterSpec.class);
        KeyFactory factory = KeyFactory.getInstance("EC");
        PublicKey publicKey = factory.generatePublic(new ECPublicKeySpec(new ECPoint(new BigInteger(1, decode(X)), new BigInteger(1, decode(Y))), ec));
        PrivateKey privateKey = factory.generatePrivate(new ECPrivateKeySpec(new BigInteger(1, decode(D)), ec));
        String rfcInput = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ";
        Signature verifier = Signature.getInstance("SHA256withECDSA");
        verifier.initVerify(publicKey); verifier.update(rfcInput.getBytes(StandardCharsets.US_ASCII));
        check(verifier.verify(PrivacyJws.joseToDer(jose)), "RFC published signature");
        String kid = PrivacyJws.thumbprint(X, Y);
        check(kid.length() == 43 && !kid.contains("="), "thumbprint");
        String body = "{\"schemaVersion\":1}";
        String payload = "{\"aud\":\"https://privacy.example.invalid\",\"method\":\"POST\",\"path\":\"/v1/requests\",\"bodySha256\":\"" +
            PrivacyJws.sha256(body.getBytes(StandardCharsets.UTF_8)) + "\",\"challengeId\":\"chg_fixture\",\"nonce\":\"nonce_fixture\",\"exp\":1791091260,\"epochId\":\"epoch_fixture\"}";
        String proof = PrivacyJws.sign(kid, payload.getBytes(StandardCharsets.UTF_8), privateKey);
        String[] parts = proof.split("\\.");
        check(parts.length == 3 && decode(parts[2]).length == 64, "compact JWS/64-byte signature");
        verifier.initVerify(publicKey); verifier.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
        check(verifier.verify(PrivacyJws.joseToDer(decode(parts[2]))), "production signing method JCA verification");
        verifier.initVerify(publicKey); verifier.update((parts[0] + "." + parts[1] + "x").getBytes(StandardCharsets.US_ASCII));
        check(!verifier.verify(PrivacyJws.joseToDer(decode(parts[2]))), "tamper rejection");
        String fixture = "{\"kid\":\"" + kid + "\",\"proof\":\"" + proof + "\",\"publicJwk\":{\"kty\":\"EC\",\"crv\":\"P-256\",\"x\":\""+X+"\",\"y\":\""+Y+"\"}}";
        Files.writeString(Path.of(args[0]), fixture);
        System.out.println("PASS: " + checks + " Java/JCA checks; RFC fixture only; no key generation or network");
    }
}

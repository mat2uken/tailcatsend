package jp.yasagure.ponlet.platform

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** Deletion-only Android Keystore aliases; never reuse a transfer/authentication key. */
class PrivacyKeystore {
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    private fun checkAlias(alias: String) {
        if (!alias.matches(Regex("ponlet_privacy_[0-9a-f-]{36}"))) throw PrivacyFault("invalid_key_alias")
    }
    fun exists(alias: String): Boolean { checkAlias(alias); return store().containsAlias(alias) }
    /** Call only for a durably recorded pending enrollment; never for a registered epoch. */
    fun createForPendingEnrollment(alias: String) {
        checkAlias(alias)
        if (exists(alias)) return
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setUserAuthenticationRequired(false)
                .build())
        }.generateKeyPair()
    }
    fun publicJwk(alias: String): JSONObject {
        checkAlias(alias)
        val key = store().getCertificate(alias)?.publicKey as? ECPublicKey
            ?: throw PrivacyFault("key_unavailable")
        if (key.params.curve.field.fieldSize != 256) throw PrivacyFault("invalid_key")
        return JSONObject().put("kty", "EC").put("crv", "P-256")
            .put("x", PrivacyJws.base64Url(coordinate(key.w.affineX)))
            .put("y", PrivacyJws.base64Url(coordinate(key.w.affineY)))
    }
    fun kid(alias: String): String = publicJwk(alias).let {
        PrivacyJws.thumbprint(it.getString("x"), it.getString("y"))
    }
    fun sign(alias: String, payload: ByteArray): String {
        checkAlias(alias)
        val key = store().getKey(alias, null) as? PrivateKey ?: throw PrivacyFault("key_unavailable")
        return PrivacyJws.sign(kid(alias), payload, key)
    }
    private fun coordinate(value: BigInteger): ByteArray {
        val bytes = value.toByteArray()
        val unsigned = if (bytes.size == 33 && bytes[0] == 0.toByte()) bytes.copyOfRange(1, 33) else bytes
        if (unsigned.size > 32) throw PrivacyFault("invalid_key")
        return ByteArray(32).also { unsigned.copyInto(it, 32 - unsigned.size) }
    }
    /** Only the coordinator's durably saved cleanup queue may call this after all references are gone. */
    fun deleteRetired(alias: String) { checkAlias(alias); store().deleteEntry(alias) }
}

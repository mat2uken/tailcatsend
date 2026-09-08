package jp.yasagure.ponlet

import android.content.Context
import android.os.Build
import android.os.Bundle
import com.google.firebase.FirebaseApp
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.google.firebase.remoteconfig.FirebaseRemoteConfig
import org.json.JSONObject
import java.util.Locale

/**
 * Rust (JNI) から呼び出されるテレメトリブリッジ。
 *
 * Firebase が初期化されていない場合 (google-services.json 無し / プレース
 * ホルダ設定) は ready フラグが立たず、全メソッドが no-op になる。いかなる
 * 場合も例外を呼び出し元へ伝播させない。
 */
object TelemetryBridge {
    private const val PREFS_NAME = "telemetry_prefs"
    private const val KEY_ENABLED = "telemetry_enabled"

    @Volatile
    private var ready = false
    private var appContext: Context? = null
    private var analytics: FirebaseAnalytics? = null
    private var crashlytics: FirebaseCrashlytics? = null
    private var remoteConfig: FirebaseRemoteConfig? = null

    /** Application.onCreate から一度だけ呼ばれる。 */
    @JvmStatic
    fun bootstrap(context: Context) {
        appContext = context.applicationContext
        try {
            if (FirebaseApp.initializeApp(context) == null) {
                // google-services.json 無し / 設定不良。no-op モードで継続。
                ready = false
                return
            }
            analytics = FirebaseAnalytics.getInstance(context)
            crashlytics = FirebaseCrashlytics.getInstance()
            remoteConfig = FirebaseRemoteConfig.getInstance()
            ready = true
        } catch (_: Throwable) {
            ready = false
        }
    }

    /**
     * 永続化されたオプトイン状態 (既定 true) を読み、SDK レベルの収集設定へ
     * 反映した上で Remote Config の取得を開始する。Rust 側の初期 enabled 値。
     */
    @JvmStatic
    fun initAndEnabled(context: Context): Boolean {
        val enabled = try {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, true)
        } catch (_: Throwable) {
            true
        }
        applyCollectionEnabled(enabled)
        try {
            remoteConfig?.let { config ->
                config.setConfigSettingsAsync(
                    com.google.firebase.remoteconfig.FirebaseRemoteConfigSettings.Builder()
                        .setMinimumFetchIntervalInSeconds(43200)
                        .build()
                )
                config.setDefaultsAsync(
                    mapOf<String, Any>(
                        // Remote Config キーはここに追記する (Rust 側の既定値は
                        // tailsend_telemetry::remote_string の第2引数)
                        "announcement_message" to "",
                    )
                )
                config.fetchAndActivate()
            }
        } catch (_: Throwable) {
        }
        return enabled
    }

    /** jsonParams は `{"key":"value",...}` 形式の JSON 文字列。 */
    @JvmStatic
    fun logEvent(name: String, jsonParams: String) {
        if (!ready) return
        try {
            val bundle = Bundle()
            val json = JSONObject(jsonParams)
            val keys = json.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                bundle.putString(key, json.optString(key))
            }
            analytics?.logEvent(name, bundle)
        } catch (_: Throwable) {
        }
    }

    @JvmStatic
    fun setUserProperty(name: String, value: String) {
        if (!ready) return
        try {
            analytics?.setUserProperty(name, value)
        } catch (_: Throwable) {
        }
    }

    /** 収集の有効/無効を SDK へ反映し、状態を永続化する。 */
    @JvmStatic
    fun setEnabled(enabled: Boolean) {
        applyCollectionEnabled(enabled)
        try {
            appContext?.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                ?.edit()
                ?.putBoolean(KEY_ENABLED, enabled)
                ?.apply()
        } catch (_: Throwable) {
        }
    }

    /** Remote Config の文字列。未設定 / 無効時は null。 */
    @JvmStatic
    fun remoteString(key: String): String? {
        if (!ready) return null
        return try {
            remoteConfig?.getString(key)?.takeIf { it.isNotEmpty() }
        } catch (_: Throwable) {
            null
        }
    }

    @JvmStatic
    fun osVersion(): String = try {
        Build.VERSION.RELEASE ?: ""
    } catch (_: Throwable) {
        ""
    }

    @JvmStatic
    fun language(): String = try {
        Locale.getDefault().language
    } catch (_: Throwable) {
        "en"
    }

    private fun applyCollectionEnabled(enabled: Boolean) {
        try {
            analytics?.setAnalyticsCollectionEnabled(enabled)
            crashlytics?.setCrashlyticsCollectionEnabled(enabled)
        } catch (_: Throwable) {
        }
    }
}

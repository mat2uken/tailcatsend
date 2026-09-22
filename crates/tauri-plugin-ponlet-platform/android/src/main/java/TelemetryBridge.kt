package jp.yasagure.ponlet.platform

import android.content.Context
import android.os.Build
import android.os.Bundle
import com.google.firebase.FirebaseApp
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.crashlytics.FirebaseCrashlytics
import java.util.Locale

/**
 * PonletPlatformPlugin のコマンドから呼び出されるテレメトリ処理。
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

    /** telemetryInit コマンドから初期化する。 */
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
            ready = true
        } catch (_: Throwable) {
            ready = false
        }
    }

    /**
     * 永続化されたオプトイン状態 (既定 true) を読み、SDK レベルの収集設定へ
     * 反映する。Rust 側の初期 enabled 値。
     */
    fun initAndEnabled(context: Context): Boolean {
        val enabled = try {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, true)
        } catch (_: Throwable) {
            true
        }
        applyCollectionEnabled(enabled)
        return enabled
    }

    fun logEvent(name: String, params: Map<String, String>) {
        if (!ready) return
        try {
            val bundle = Bundle()
            params.forEach { (key, value) -> bundle.putString(key, value) }
            analytics?.logEvent(name, bundle)
        } catch (_: Throwable) {
        }
    }

    fun setUserProperty(name: String, value: String) {
        if (!ready) return
        try {
            analytics?.setUserProperty(name, value)
        } catch (_: Throwable) {
        }
    }

    /** 収集の有効/無効を SDK へ反映し、状態を永続化する。 */
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

    fun osVersion(): String = try {
        Build.VERSION.RELEASE ?: ""
    } catch (_: Throwable) {
        ""
    }

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

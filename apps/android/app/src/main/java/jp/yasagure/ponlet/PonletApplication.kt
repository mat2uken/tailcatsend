package jp.yasagure.ponlet

import android.app.Activity
import android.app.Application
import android.os.Bundle

/**
 * Application クラス。NativeActivity のまま Kotlin コードを有効化し、
 * Firebase の初期化だけを行う。google-services.json が無い場合や初期化に
 * 失敗した場合でも例外は TelemetryBridge 内で握りつぶされ、テレメトリは
 * no-op になるためアプリは起動を続行できる。
 */
class PonletApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        TelemetryBridge.bootstrap(this)
        registerActivityLifecycleCallbacks(object : ActivityLifecycleCallbacks {
            override fun onActivityResumed(activity: Activity) {
                FilePickerBridge.onActivityResumed(activity)
                QRScannerBridge.onActivityResumed(activity)
            }

            override fun onActivityPaused(activity: Activity) {
                FilePickerBridge.onActivityPaused(activity)
                QRScannerBridge.onActivityPaused(activity)
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityStarted(activity: Activity) {}
            override fun onActivityStopped(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}

package jp.yasagure.ponlet

import android.app.Application

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
    }
}

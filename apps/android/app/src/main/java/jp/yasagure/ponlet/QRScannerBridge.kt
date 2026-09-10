package jp.yasagure.ponlet

import android.app.Activity
import android.app.Fragment
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * QR カメラスキャナと Rust (NativeActivity) をつなぐブリッジ。
 *
 * android.app.NativeActivity は onActivityResult をオーバーライドしないため、
 * FilePickerBridge と同じヘッドレス Fragment パターンで zxing-android-embedded
 * の CaptureActivity を startActivityForResult し、結果を JSON 文字列として
 * 保持する。Rust 側が JNI 経由で pollResult() をポーリングして取り出す。
 *
 * 期待する JSON 形式:
 *   {"status":"ok","text":"<QR の内容>"}
 *   {"status":"cancelled"}
 *   {"status":"error","msg":"<理由>"}
 */
object QRScannerBridge {
    private const val FRAG_TAG = "ponlet_qr_scanner"
    private const val REQ_SCAN = 4202

    @Volatile
    private var activityRef: WeakReference<Activity>? = null

    @Volatile
    private var resultJson: String? = null

    /** ActivityLifecycleCallbacks の onActivityResumed から呼ばれる。 */
    @JvmStatic
    fun onActivityResumed(activity: Activity) {
        activityRef = WeakReference(activity)
    }

    /** ActivityLifecycleCallbacks の onActivityPaused から呼ばれる。 */
    @JvmStatic
    fun onActivityPaused(activity: Activity) {
        val current = activityRef?.get()
        if (current === activity) {
            activityRef = null
        }
    }

    /**
     * Rust から呼ばれる。カメラスキャナ (CaptureActivity) を起動する。
     * 戻り値は起動に成功したかどうか。
     */
    @JvmStatic
    fun startScan(): Boolean {
        Log.i("PonletKotlin", "QRScannerBridge.startScan called")
        resultJson = null
        val activity = activityRef?.get()
        if (activity == null) {
            Log.w("PonletKotlin", "QRScannerBridge.startScan: no activity")
            return false
        }
        val fm = activity.fragmentManager
        if (fm == null) {
            Log.w("PonletKotlin", "QRScannerBridge.startScan: fragmentManager is null")
            return false
        }
        return try {
            // Rust (android_main スレッド) から呼ばれるため、Fragment 操作と
            // startActivityForResult はメインスレッドへ投稿する。
            activity.runOnUiThread {
                try {
                    val existing = fm.findFragmentByTag(FRAG_TAG) as? ScannerFragment
                    if (existing != null && existing.isAdded) {
                        Log.i("PonletKotlin", "QRScannerBridge.startScan: reusing existing fragment")
                        existing.beginScan()
                    } else {
                        Log.i("PonletKotlin", "QRScannerBridge.startScan: adding new fragment")
                        val frag = ScannerFragment()
                        fm.beginTransaction().add(frag, FRAG_TAG).commitNowAllowingStateLoss()
                        frag.beginScan()
                    }
                } catch (t: Throwable) {
                    Log.e("PonletKotlin", "QRScannerBridge.startScan failed on UI thread", t)
                    setResult(
                        JSONObject().put("status", "error")
                            .put("msg", t.message ?: "camera launch failed").toString()
                    )
                }
            }
            true
        } catch (t: Throwable) {
            Log.e("PonletKotlin", "QRScannerBridge.startScan failed", t)
            false
        }
    }

    /** Rust から呼ばれる。未取得なら null を返し、取得済みならクリアして返す。 */
    @JvmStatic
    fun pollResult(): String? {
        val r = resultJson ?: return null
        resultJson = null
        return r
    }

    internal fun setResult(json: String) {
        resultJson = json
    }

    /** UI を持たないスキャナ実行用 Fragment。 */
    class ScannerFragment : Fragment() {
        companion object {
            private const val ACTION_SCAN = "com.google.zxing.client.android.SCAN"
            private const val CAPTURE_ACTIVITY =
                "com.journeyapps.barcodescanner.CaptureActivity"
        }

        @Volatile
        private var pending = false

        fun beginScan() {
            pending = true
            tryLaunch()
        }

        override fun onResume() {
            super.onResume()
            tryLaunch()
        }

        private fun tryLaunch() {
            Log.i("PonletKotlin", "ScannerFragment.tryLaunch: pending=$pending added=$isAdded")
            if (!pending || !isAdded) return
            pending = false
            try {
                val context = context
                if (context == null) {
                    Log.w("PonletKotlin", "ScannerFragment.tryLaunch: context is null")
                    return
                }
                val intent = Intent(ACTION_SCAN)
                intent.setClassName(context, CAPTURE_ACTIVITY)
                intent.putExtra("SCAN_FORMATS", "QR_CODE")
                intent.putExtra("BEEP_MODE", false)
                Log.i("PonletKotlin", "ScannerFragment.tryLaunch: starting CaptureActivity")
                startActivityForResult(intent, REQ_SCAN)
            } catch (t: Throwable) {
                Log.e("PonletKotlin", "ScannerFragment.tryLaunch threw", t)
                setResult(
                    JSONObject().put("status", "error")
                        .put("msg", t.message ?: "camera launch failed").toString()
                )
            }
        }

        override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
            Log.i("PonletKotlin", "ScannerFragment.onActivityResult: req=$requestCode result=$resultCode")
            if (requestCode != REQ_SCAN) {
                super.onActivityResult(requestCode, resultCode, data)
                return
            }
            if (resultCode != Activity.RESULT_OK) {
                setResult(JSONObject().put("status", "cancelled").toString())
                return
            }
            val text = data?.getStringExtra("SCAN_RESULT")
            if (text.isNullOrBlank()) {
                setResult(
                    JSONObject().put("status", "error").put("msg", "no scan data").toString()
                )
                return
            }
            setResult(
                JSONObject().put("status", "ok").put("text", text).toString()
            )
        }
    }
}

package jp.yasagure.ponlet

import android.app.Activity
import android.app.Fragment
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.OpenableColumns
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicLong

/**
 * SAF ピッカーと Rust (NativeActivity) をつなぐブリッジ。
 *
 * android.app.NativeActivity は onActivityResult をオーバーライドしないため、
 * プラットフォーム製のヘッドレス Fragment を Activity に取り付けて、そこで
 * ACTION_GET_CONTENT の結果を受け取る。結果は JSON 文字列として保持され、
 * Rust 側が JNI 経由で pollResult() をポーリングして取り出す。
 *
 * 期待する JSON 形式:
 *   {"status":"ok","path":"<cacheDir 上の一時ファイル>","name":"<表示名>"}
 *   {"status":"cancelled"}
 *   {"status":"error","msg":"<理由>"}
 */
object FilePickerBridge {
    private const val FRAG_TAG = "ponlet_file_picker"
    private const val TEMP_PREFIX = "picked_"

    private val tempCounter = AtomicLong(0)

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
     * Rust から呼ばれる。ピッカーを起動する。既に Fragment が追加されていれば
     * それを再利用し、無ければヘッドレス Fragment を commitNowAllowStateLoss
     * で同期追加してから起動する。戻り値は起動に成功したかどうか。
     */
    @JvmStatic
    fun pick(): Boolean {
        resultJson = null
        val activity = activityRef?.get() ?: return false
        val fm = activity.fragmentManager ?: return false
        return try {
            // Rust (android_main スレッド) から呼ばれるため、Fragment 操作と
            // startActivityForResult はメインスレッドへ投稿する。
            activity.runOnUiThread {
                try {
                    val existing = fm.findFragmentByTag(FRAG_TAG) as? PickerFragment
                    if (existing != null && existing.isAdded) {
                        existing.beginPick()
                    } else {
                        val frag = PickerFragment()
                        fm.beginTransaction().add(frag, FRAG_TAG).commitNowAllowingStateLoss()
                        frag.beginPick()
                    }
                } catch (t: Throwable) {
                    setResult(
                        JSONObject().put("status", "error")
                            .put("msg", t.message ?: "picker launch failed").toString()
                    )
                }
            }
            true
        } catch (_: Throwable) {
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

    /** UI を持たないピッカー実行用 Fragment。 */
    class PickerFragment : Fragment() {
        companion object {
            private const val REQ_PICK = 4201
        }

        @Volatile
        private var pending = false

        fun beginPick() {
            pending = true
            tryLaunch()
        }

        override fun onResume() {
            super.onResume()
            tryLaunch()
        }

        private fun tryLaunch() {
            if (!pending || !isAdded) return
            pending = false
            try {
                val intent = Intent(Intent.ACTION_GET_CONTENT)
                intent.type = "*/*"
                intent.addCategory(Intent.CATEGORY_OPENABLE)
                startActivityForResult(intent, REQ_PICK)
            } catch (t: Throwable) {
                setResult(JSONObject().put("status", "error").put("msg", t.message ?: "launch failed").toString())
            }
        }

        override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
            if (requestCode != REQ_PICK) {
                super.onActivityResult(requestCode, resultCode, data)
                return
            }
            if (resultCode != Activity.RESULT_OK) {
                setResult(JSONObject().put("status", "cancelled").toString())
                return
            }
            val uri = data?.data
            if (uri == null) {
                setResult(JSONObject().put("status", "error").put("msg", "no uri").toString())
                return
            }
            handlePickedUri(uri)
        }

        private fun handlePickedUri(uri: Uri) {
            val context = context ?: run {
                setResult(JSONObject().put("status", "error").put("msg", "no context").toString())
                return
            }
            try {
                val resolver = context.contentResolver
                val displayName = queryDisplayName(resolver, uri) ?: "unnamed_file"
                val safeBase = displayName.replace(Regex("[/\\\\:]"), "_")
                    .replace(Regex("[\\p{Cntrl}\\x00]"), "_")
                    .ifBlank { "unnamed_file" }
                val tempFile = File(
                    context.cacheDir,
                    "$TEMP_PREFIX${System.currentTimeMillis()}_${tempCounter.incrementAndGet()}_$safeBase"
                )
                resolver.openInputStream(uri)?.use { input ->
                    tempFile.outputStream().use { output ->
                        input.copyTo(output)
                    }
                } ?: throw IllegalStateException("openInputStream returned null")
                setResult(
                    JSONObject()
                        .put("status", "ok")
                        .put("path", tempFile.absolutePath)
                        .put("name", displayName)
                        .toString()
                )
            } catch (t: Throwable) {
                setResult(JSONObject().put("status", "error").put("msg", t.message ?: "read failed").toString())
            }
        }

        /** OpenableColumns.DISPLAY_NAME を取得する。取れなければ null。 */
        private fun queryDisplayName(resolver: android.content.ContentResolver, uri: Uri): String? {
            var cursor: Cursor? = null
            return try {
                cursor = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                if (cursor != null && cursor.moveToFirst()) {
                    val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (idx >= 0) cursor.getString(idx) else null
                } else {
                    null
                }
            } catch (_: Throwable) {
                null
            } finally {
                cursor?.close()
            }
        }
    }
}

package jp.yasagure.ponlet

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** ArrayBuffer WebMessageListener used by the high-speed Ponlet IPC path. */
object PonletPort {
  const val NAME = "ponletbin"
  private const val TAG = "PonletPort"
  private const val MAX_ATTACH_ATTEMPTS = 100
  private const val ATTACH_RETRY_MS = 100L
  private val attempts = AtomicInteger(0)
  private val worker = Executors.newCachedThreadPool()
  private val main = Handler(Looper.getMainLooper())
  @Volatile private var attached = false
  private val origins = setOf("http://tauri.localhost", "https://tauri.localhost")

  init {
    try {
      System.loadLibrary("tailsend_tauri_lib")
    } catch (_: Throwable) {
      // Tauri loads the library before MainActivity. The JNI call reports a
      // missing library as an empty response if a vendor build omits it.
    }
  }

  @JvmStatic
  external fun handleBatch(input: ByteArray): ByteArray?

  fun attachToContentView(activity: Activity) {
    if (attached) return
    val root = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
    val webView = findWebView(root)
    if (webView != null) {
      if (attach(webView)) attached = true
      return
    }
    if (attempts.incrementAndGet() <= MAX_ATTACH_ATTEMPTS) {
      root.postDelayed({ attachToContentView(activity) }, ATTACH_RETRY_MS)
    } else {
      Log.w(TAG, "Tauri WebView not found")
    }
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view is ViewGroup) {
      for (index in 0 until view.childCount) {
        findWebView(view.getChildAt(index))?.let { return it }
      }
    }
    return null
  }

  private fun attach(webView: WebView): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)) {
      Log.w(TAG, "ArrayBuffer WebMessageListener is unavailable")
      return false
    }
    return try {
      WebViewCompat.addWebMessageListener(
        webView,
        NAME,
        origins,
        object : WebViewCompat.WebMessageListener {
          override fun onPostMessage(
            view: WebView,
            message: WebMessageCompat,
            sourceOrigin: android.net.Uri,
            isMainFrame: Boolean,
            replyProxy: JavaScriptReplyProxy,
          ) {
            if (message.type != WebMessageCompat.TYPE_ARRAY_BUFFER) {
              replyProxy.postMessage(ByteArray(0))
              return
            }
            val input = message.arrayBuffer ?: run {
              replyProxy.postMessage(ByteArray(0))
              return
            }
            worker.execute {
              val output = try { handleBatch(input) ?: ByteArray(0) } catch (_: Throwable) { ByteArray(0) }
              main.post {
                try { replyProxy.postMessage(output) } catch (_: Throwable) { }
              }
            }
          }
        },
      )
      Log.i(TAG, "ArrayBuffer IPC listener attached")
      true
    } catch (error: Throwable) {
      Log.w(TAG, "listener attach failed: ${error.message}")
      false
    }
  }
}

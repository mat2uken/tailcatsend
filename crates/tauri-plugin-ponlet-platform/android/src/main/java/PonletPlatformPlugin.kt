package jp.yasagure.ponlet.platform

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import org.json.JSONObject

@InvokeArg class FileArgs { lateinit var path: String }
@InvokeArg class TextArgs { lateinit var text: String }
@InvokeArg class EnabledArgs { var enabled: Boolean = false }
@InvokeArg class TelemetryInitArgs { var optOut: Boolean = false }
@InvokeArg class EventArgs { lateinit var name: String; var params: Map<String, String> = emptyMap() }
@InvokeArg class PropertyArgs { lateinit var name: String; lateinit var value: String }
@InvokeArg class KeyArgs { lateinit var key: String }

@TauriPlugin
class PonletPlatformPlugin(private val activity: Activity) : Plugin(activity) {
    @Command
    fun openReceived(invoke: Invoke) {
        try {
            val file = File(invoke.parseArgs(FileArgs::class.java).path).canonicalFile
            val received = File(activity.filesDir, "received").canonicalFile
            require(file.isFile && file.path.startsWith(received.path + File.separator)) {
                "Received file is unavailable"
            }
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".ponlet.received", file)
            val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(file.extension.lowercase())
                ?: "application/octet-stream"
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, mime)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                clipData = ClipData.newRawUri(file.name, uri)
            }
            try {
                activity.startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                val share = Intent(Intent.ACTION_SEND).apply {
                    type = mime
                    putExtra(Intent.EXTRA_STREAM, uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    clipData = ClipData.newRawUri(file.name, uri)
                }
                activity.startActivity(Intent.createChooser(share, file.name))
            }
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message ?: "Cannot open received file") }
    }

    @Command
    fun shareText(invoke: Invoke) {
        try {
            val text = invoke.parseArgs(TextArgs::class.java).text
            activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }, null))
            invoke.resolve()
        } catch (error: Exception) { invoke.reject(error.message ?: "Cannot share message") }
    }

    @Command
    fun telemetryInit(invoke: Invoke) {
        if (invoke.parseArgs(TelemetryInitArgs::class.java).optOut) {
            activity.getSharedPreferences("telemetry_prefs", android.content.Context.MODE_PRIVATE)
                .edit().putBoolean("telemetry_enabled", false).apply()
        }
        TelemetryBridge.bootstrap(activity)
        val result = JSObject()
        result.put("enabled", TelemetryBridge.initAndEnabled(activity))
        result.put("language", TelemetryBridge.language())
        result.put("osVersion", TelemetryBridge.osVersion())
        invoke.resolve(result)
    }

    @Command
    fun telemetrySetEnabled(invoke: Invoke) {
        TelemetryBridge.setEnabled(invoke.parseArgs(EnabledArgs::class.java).enabled)
        invoke.resolve()
    }

    @Command
    fun telemetryEvent(invoke: Invoke) {
        val args = invoke.parseArgs(EventArgs::class.java)
        TelemetryBridge.logEvent(args.name, JSONObject(args.params).toString())
        invoke.resolve()
    }

    @Command
    fun telemetryProperty(invoke: Invoke) {
        val args = invoke.parseArgs(PropertyArgs::class.java)
        TelemetryBridge.setUserProperty(args.name, args.value)
        invoke.resolve()
    }

    @Command
    fun telemetryRemoteString(invoke: Invoke) {
        val value = TelemetryBridge.remoteString(invoke.parseArgs(KeyArgs::class.java).key)
        val result = JSObject()
        result.put("value", value ?: JSONObject.NULL)
        invoke.resolve(result)
    }
}

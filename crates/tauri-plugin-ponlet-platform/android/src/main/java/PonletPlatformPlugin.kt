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

@InvokeArg class FileArgs { lateinit var path: String }
@InvokeArg class TextArgs { lateinit var text: String }
@InvokeArg class EnabledArgs { var enabled: Boolean = false; var intent: String = "" }
@InvokeArg class TelemetryInitArgs { var optOut: Boolean = false }
@InvokeArg class PrivacyRequest { var scope: String = ""; var confirmed: Boolean = false }
@InvokeArg class PrivacyRequestArgs { lateinit var request: PrivacyRequest }
@InvokeArg class EventArgs { lateinit var name: String; var params: Map<String, String> = emptyMap() }
@InvokeArg class PropertyArgs { lateinit var name: String; lateinit var value: String }

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

    private fun privacyReply(invoke: Invoke, block: () -> org.json.JSONObject) {
        TelemetryBridge.executor.execute {
            try {
                val value = block()
                val result = JSObject()
                value.keys().forEach { key -> result.put(key, value.get(key)) }
                invoke.resolve(result)
            } catch (error: Exception) {
                invoke.reject((error as? PrivacyFault)?.code ?: "native_operation_failed")
            }
        }
    }

    @Command
    fun telemetryInit(invoke: Invoke) {
        val optOut = invoke.parseArgs(TelemetryInitArgs::class.java).optOut
        privacyReply(invoke) {
            org.json.JSONObject().put("enabled", TelemetryBridge.initialize(activity, optOut))
                .put("language", TelemetryBridge.language()).put("osVersion", TelemetryBridge.osVersion())
        }
    }

    @Command
    fun telemetryGetEnabled(invoke: Invoke) = privacyReply(invoke) {
        org.json.JSONObject().put("enabled", TelemetryBridge.getEnabled(activity))
    }

    @Command
    fun telemetryBeginIntent(invoke: Invoke) {
        // No context, SDK, storage or serial wait: preempts an in-flight registration at IPC receipt.
        val result = JSObject()
        result.put("intent", TelemetryBridge.receivePrivacyIntent().toString())
        invoke.resolve(result)
    }

    @Command
    fun telemetrySetEnabled(invoke: Invoke) {
        val args = invoke.parseArgs(EnabledArgs::class.java)
        val enabled = args.enabled
        val intent = args.intent.toLongOrNull() ?: return invoke.reject("invalid_telemetry_intent")
        TelemetryBridge.executor.execute {
            try {
                if (!TelemetryBridge.beginDesiredIntent(intent, enabled)) throw PrivacyFault("telemetry_intent_superseded")
                TelemetryBridge.setEnabled(enabled)
                invoke.resolve()
            }
            catch (error: Exception) { invoke.reject((error as? PrivacyFault)?.code ?: "native_operation_failed") }
        }
    }

    @Command
    fun diagnosticsCapabilities(invoke: Invoke) = privacyReply(invoke) { TelemetryBridge.diagnosticsCapabilities(activity) }
    @Command
    fun diagnosticsStatus(invoke: Invoke) = privacyReply(invoke) { TelemetryBridge.diagnosticsStatus(activity) }
    @Command
    fun diagnosticsRequest(invoke: Invoke) {
        val request = invoke.parseArgs(PrivacyRequestArgs::class.java).request
        if (request.confirmed && request.scope in setOf("local", "bound_remote")) TelemetryBridge.receivePrivacyIntent()
        privacyReply(invoke) { TelemetryBridge.diagnosticsRequest(activity, request.scope, request.confirmed) }
    }
    @Command
    fun diagnosticsRetry(invoke: Invoke) = privacyReply(invoke) { TelemetryBridge.diagnosticsRetry(activity) }
    @Command
    fun diagnosticsContinueAfterRestart(invoke: Invoke) = privacyReply(invoke) { TelemetryBridge.diagnosticsContinue(activity) }

    @Command
    fun telemetryEvent(invoke: Invoke) {
        val args = invoke.parseArgs(EventArgs::class.java)
        TelemetryBridge.logEvent(args.name, args.params)
        invoke.resolve()
    }

    @Command
    fun telemetryProperty(invoke: Invoke) {
        val args = invoke.parseArgs(PropertyArgs::class.java)
        TelemetryBridge.setUserProperty(args.name, args.value)
        invoke.resolve()
    }
}

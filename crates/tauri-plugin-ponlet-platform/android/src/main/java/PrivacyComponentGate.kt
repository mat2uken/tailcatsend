package jp.yasagure.ponlet.platform

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/** Known SDK background entry points. Resolved AAR/merged manifest verification remains required. */
object PrivacyComponentGate {
    private val components = listOf(
        "com.google.android.gms.measurement.AppMeasurementReceiver",
        "com.google.android.gms.measurement.AppMeasurementService",
        "com.google.android.gms.measurement.AppMeasurementJobService",
        "com.google.android.datatransport.runtime.scheduling.jobscheduling.JobInfoSchedulerService",
        "com.google.android.datatransport.runtime.scheduling.jobscheduling.AlarmManagerSchedulerBroadcastReceiver",
    )
    private fun apply(context: Context, state: Int) {
        val packageInfo = context.packageManager.getPackageInfo(context.packageName,
            PackageManager.GET_RECEIVERS or PackageManager.GET_SERVICES or PackageManager.MATCH_DISABLED_COMPONENTS)
        val declared = (packageInfo.receivers?.map { it.name }.orEmpty() + packageInfo.services?.map { it.name }.orEmpty()).toSet()
        components.filter { it in declared }.forEach { name ->
            context.packageManager.setComponentEnabledSetting(ComponentName(context.packageName, name), state, PackageManager.DONT_KILL_APP)
        }
    }
    private fun managed(context: Context) = java.io.File(context.noBackupFilesDir, "ponlet_privacy_components.managed")
    fun close(context: Context) {
        var inventoryFailed = false
        val targets = try {
            val info = context.packageManager.getPackageInfo(context.packageName,
                PackageManager.GET_RECEIVERS or PackageManager.GET_SERVICES or PackageManager.MATCH_DISABLED_COMPONENTS)
            val declared = (info.receivers?.map { it.name }.orEmpty() + info.services?.map { it.name }.orEmpty()).toSet()
            components.filter { it in declared }
        } catch (_: Exception) {
            inventoryFailed = true
            components // Still try every known entry; absent components may fail individually.
        }
        val result = PrivacyComponentActions.close(
            PrivacyComponentActions.Action { managed(context).writeText("1") },
            targets.map { name -> PrivacyComponentActions.Action {
                context.packageManager.setComponentEnabledSetting(ComponentName(context.packageName, name),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED, PackageManager.DONT_KILL_APP)
            } }.toTypedArray())
        if (inventoryFailed || !result.succeeded()) throw PrivacyFault("component_disable_incomplete")
    }
    fun openAfterBind(context: Context) = apply(context, PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
    // DEFAULT restores SDK manifest behavior when the feature is disabled, including an app downgrade.
    fun restoreLegacyDefaults(context: Context) {
        if (!managed(context).exists()) return
        apply(context, PackageManager.COMPONENT_ENABLED_STATE_DEFAULT)
        managed(context).delete()
    }
}

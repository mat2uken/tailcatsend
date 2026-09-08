import Foundation
import FirebaseCore
import FirebaseAnalytics
import FirebaseCrashlytics
import FirebaseRemoteConfig

enum TelemetryBridgeState {
    static var configured = false
}

func telemetryCString(_ ptr: UnsafePointer<CChar>?) -> String {
    guard let ptr = ptr else { return "" }
    return String(cString: ptr)
}

func telemetryCopyToBuffer(_ value: String, outBuf: UnsafeMutablePointer<CChar>?, bufLen: Int32) -> Int32 {
    guard let outBuf = outBuf, bufLen > 0 else { return 0 }
    let utf8 = Array(value.utf8)
    let count = min(utf8.count, Int(bufLen) - 1)
    guard count >= 0 else { return 0 }
    for i in 0..<count {
        outBuf[i] = CChar(bitPattern: utf8[i])
    }
    outBuf[count] = 0
    return Int32(count)
}

@_cdecl("tailsend_telemetry_ios_init")
public func tailsend_telemetry_ios_init() -> Int32 {
    let enabled = UserDefaults.standard.object(forKey: "telemetry_enabled") as? Bool ?? true

    guard let plistPath = Bundle.main.path(forResource: "GoogleService-Info.plist", ofType: nil),
          let options = FirebaseOptions(contentsOfFile: plistPath) else {
        TelemetryBridgeState.configured = false
        return enabled ? 1 : 0
    }

    if FirebaseApp.app() == nil {
        FirebaseApp.configure(options: options)
    }
    TelemetryBridgeState.configured = true

    Analytics.setAnalyticsCollectionEnabled(enabled)
    Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(enabled)

    let remoteConfig = RemoteConfig.remoteConfig()
    remoteConfig.setDefaults(["announcement_text": "" as NSObject])
    let settings = RemoteConfigSettings()
    settings.minimumFetchInterval = 43200
    remoteConfig.configSettings = settings
    if enabled {
        remoteConfig.fetchAndActivate { _, _ in }
    }

    return enabled ? 1 : 0
}

@_cdecl("tailsend_telemetry_ios_log_event")
public func tailsend_telemetry_ios_log_event(
    _ name: UnsafePointer<CChar>?,
    _ jsonParams: UnsafePointer<CChar>?
) {
    guard TelemetryBridgeState.configured else { return }
    let eventName = telemetryCString(name)
    guard !eventName.isEmpty else { return }

    var params: [String: Any] = [:]
    let json = telemetryCString(jsonParams)
    if !json.isEmpty,
       let data = json.data(using: .utf8),
       let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
        for (key, value) in obj where value is NSString || value is NSNumber {
            params[key] = value
        }
    }
    Analytics.logEvent(eventName, parameters: params)
}

@_cdecl("tailsend_telemetry_ios_set_user_property")
public func tailsend_telemetry_ios_set_user_property(
    _ name: UnsafePointer<CChar>?,
    _ value: UnsafePointer<CChar>?
) {
    guard TelemetryBridgeState.configured else { return }
    Analytics.setUserProperty(telemetryCString(value), forName: telemetryCString(name))
}

@_cdecl("tailsend_telemetry_ios_set_enabled")
public func tailsend_telemetry_ios_set_enabled(_ enabled: Int32) {
    let flag = enabled != 0
    UserDefaults.standard.set(flag, forKey: "telemetry_enabled")
    guard TelemetryBridgeState.configured else { return }
    Analytics.setAnalyticsCollectionEnabled(flag)
    Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(flag)
}

@_cdecl("tailsend_telemetry_ios_remote_string")
public func tailsend_telemetry_ios_remote_string(
    _ key: UnsafePointer<CChar>?,
    _ outBuf: UnsafeMutablePointer<CChar>?,
    _ bufLen: Int32
) -> Int32 {
    guard TelemetryBridgeState.configured, let key = key else { return 0 }
    let value = RemoteConfig.remoteConfig().configValue(forKey: String(cString: key)).stringValue ?? ""
    guard !value.isEmpty else { return 0 }
    return telemetryCopyToBuffer(value, outBuf: outBuf, bufLen: bufLen)
}

@_cdecl("tailsend_telemetry_ios_locale_language")
public func tailsend_telemetry_ios_locale_language(
    _ outBuf: UnsafeMutablePointer<CChar>?,
    _ bufLen: Int32
) -> Int32 {
    let language = Locale.preferredLanguages.first ?? "en"
    let code = String(language.prefix(2))
    return telemetryCopyToBuffer(code, outBuf: outBuf, bufLen: bufLen)
}

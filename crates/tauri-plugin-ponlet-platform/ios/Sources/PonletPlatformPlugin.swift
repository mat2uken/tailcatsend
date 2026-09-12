import Foundation
import Tauri
import UIKit
import WebKit
import FirebaseCore
import FirebaseAnalytics
import FirebaseCrashlytics
import FirebaseRemoteConfig

private struct FileArgs: Decodable { let path: String }
private struct TextArgs: Decodable { let text: String }
private struct EnabledArgs: Decodable { let enabled: Bool }
private struct TelemetryInitArgs: Decodable { let optOut: Bool }
private struct EventArgs: Decodable { let name: String; let params: [String: String] }
private struct PropertyArgs: Decodable { let name: String; let value: String }
private struct KeyArgs: Decodable { let key: String }

class PonletPlatformPlugin: Plugin, UIDocumentInteractionControllerDelegate, UIDocumentPickerDelegate {
    private var document: UIDocumentInteractionController?
    private var exportInvoke: Invoke?
    private var exportDirectory: URL?
    private var telemetryConfigured = false

    private func presenter() -> UIViewController? {
        var controller = manager.viewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }

    private func share(_ items: [Any], invoke: Invoke) {
        guard let controller = presenter() else {
            invoke.reject("Cannot present the share sheet")
            return
        }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        // iPad requires a popover anchor even when no physical button is involved.
        sheet.popoverPresentationController?.sourceView = controller.view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: controller.view.bounds.midX, y: controller.view.bounds.midY, width: 1, height: 1)
        sheet.popoverPresentationController?.permittedArrowDirections = []
        controller.present(sheet, animated: true) { invoke.resolve() }
    }

    @objc public func openReceived(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(FileArgs.self)
        let url = URL(fileURLWithPath: args.path).standardizedFileURL.resolvingSymlinksInPath()
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.resolvingSymlinksInPath()
        guard url.path.hasPrefix(home.path + "/"), FileManager.default.fileExists(atPath: url.path) else {
            invoke.reject("Received file is unavailable")
            return
        }
        DispatchQueue.main.async {
            let document = UIDocumentInteractionController(url: url)
            document.delegate = self
            self.document = document
            if document.presentPreview(animated: true) {
                invoke.resolve()
            } else {
                self.share([url], invoke: invoke)
            }
        }
    }

    public func documentInteractionControllerViewControllerForPreview(_ controller: UIDocumentInteractionController) -> UIViewController {
        return presenter() ?? UIViewController()
    }

    @objc public func shareText(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(TextArgs.self)
        DispatchQueue.main.async { self.share([args.text], invoke: invoke) }
    }

    @objc public func saveText(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(TextArgs.self)
        DispatchQueue.main.async {
            guard self.exportInvoke == nil, let controller = self.presenter() else {
                invoke.reject("Another document operation is active")
                return
            }
            do {
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let file = directory.appendingPathComponent("ponlet-message.txt")
                try args.text.write(to: file, atomically: true, encoding: .utf8)
                self.exportDirectory = directory
                self.exportInvoke = invoke
                let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                picker.delegate = self
                controller.present(picker, animated: true)
            } catch { invoke.reject(error.localizedDescription) }
        }
    }

    private func finishExport() {
        exportInvoke?.resolve()
        exportInvoke = nil
        if let directory = exportDirectory { try? FileManager.default.removeItem(at: directory) }
        exportDirectory = nil
    }
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { finishExport() }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finishExport() }

    @objc public func telemetryInit(_ invoke: Invoke) throws {
        if try invoke.parseArgs(TelemetryInitArgs.self).optOut {
            UserDefaults.standard.set(false, forKey: "telemetry_enabled")
        }
        let enabled = UserDefaults.standard.object(forKey: "telemetry_enabled") as? Bool ?? true
        if let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
           let options = FirebaseOptions(contentsOfFile: path) {
            if FirebaseApp.app() == nil { FirebaseApp.configure(options: options) }
            telemetryConfigured = true
            Analytics.setAnalyticsCollectionEnabled(enabled)
            Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(enabled)
            let remote = RemoteConfig.remoteConfig()
            let settings = RemoteConfigSettings()
            settings.minimumFetchInterval = 43200
            remote.configSettings = settings
            remote.setDefaults(["announcement_text": "" as NSObject])
            if enabled { remote.fetchAndActivate { _, _ in } }
        }
        invoke.resolve(["enabled": enabled, "language": Locale.preferredLanguages.first ?? "en", "osVersion": UIDevice.current.systemVersion])
    }

    @objc public func telemetrySetEnabled(_ invoke: Invoke) throws {
        let enabled = try invoke.parseArgs(EnabledArgs.self).enabled
        UserDefaults.standard.set(enabled, forKey: "telemetry_enabled")
        if telemetryConfigured {
            Analytics.setAnalyticsCollectionEnabled(enabled)
            Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(enabled)
        }
        invoke.resolve()
    }
    @objc public func telemetryEvent(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(EventArgs.self)
        if telemetryConfigured { Analytics.logEvent(args.name, parameters: args.params) }
        invoke.resolve()
    }
    @objc public func telemetryProperty(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(PropertyArgs.self)
        if telemetryConfigured { Analytics.setUserProperty(args.value, forName: args.name) }
        invoke.resolve()
    }
    @objc public func telemetryRemoteString(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(KeyArgs.self)
        let value = telemetryConfigured ? RemoteConfig.remoteConfig().configValue(forKey: args.key).stringValue : ""
        invoke.resolve(["value": value])
    }
}

@_cdecl("init_plugin_ponlet_platform")
func initPlugin() -> Plugin { PonletPlatformPlugin() }

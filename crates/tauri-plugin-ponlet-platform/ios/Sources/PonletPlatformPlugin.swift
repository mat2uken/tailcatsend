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
private struct SharedItemArgs: Decodable { let id: String }
private struct SharedManifest: Decodable {
    let id: String
    let kind: String
    let name: String
    let size: UInt64
    let mime: String?
    let payload: String
}
private struct SharedItemReply: Encodable {
    let id: String
    let kind: String
    let name: String
    let size: UInt64
    let mime: String?
    let path: String
}

private let ponletShareGroupIdentifier = "group.jp.yasagure.ponlet"
private let ponletShareInboxDirectory = "PonletShareInbox"

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

    private func sharedInboxURL(create: Bool) throws -> URL? {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: ponletShareGroupIdentifier
        ) else {
            return nil
        }
        let inbox = container.appendingPathComponent(ponletShareInboxDirectory, isDirectory: true)
        if create {
            try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        } else {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: inbox.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else {
                return nil
            }
        }
        return inbox
    }

    private func validSharedItemIdentifier(_ id: String) -> Bool {
        guard !id.isEmpty, id.count <= 128 else { return false }
        return id.unicodeScalars.allSatisfy { scalar in
            let value = scalar.value
            return (value >= 48 && value <= 57)
                || (value >= 65 && value <= 90)
                || (value >= 97 && value <= 122)
                || value == 45
                || value == 95
        }
    }

    @objc public func readSharedItems(_ invoke: Invoke) throws {
        guard let inbox = try sharedInboxURL(create: false) else {
            invoke.resolve([SharedItemReply]())
            return
        }
        let inboxResolved = inbox.standardizedFileURL.resolvingSymlinksInPath()
        let directories = try FileManager.default.contentsOfDirectory(
            at: inbox,
            includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ).sorted { left, right in
            let leftDate = (try? left.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            let rightDate = (try? right.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return leftDate < rightDate
        }

        var items: [SharedItemReply] = []
        for directory in directories {
            guard let directoryValues = try? directory.resourceValues(forKeys: [.isDirectoryKey]),
                  directoryValues.isDirectory == true else {
                continue
            }
            let resolvedDirectory = directory.standardizedFileURL.resolvingSymlinksInPath()
            guard resolvedDirectory.path.hasPrefix(inboxResolved.path + "/") else { continue }
            let manifestURL = directory.appendingPathComponent("manifest.json", isDirectory: false)
            guard let manifestData = try? Data(contentsOf: manifestURL),
                  let manifest = try? JSONDecoder().decode(SharedManifest.self, from: manifestData),
                  validSharedItemIdentifier(manifest.id),
                  manifest.id == directory.lastPathComponent,
                  manifest.kind == "text" || manifest.kind == "file",
                  !manifest.name.isEmpty,
                  manifest.payload == "payload" else {
                continue
            }
            let payloadURL = directory
                .appendingPathComponent(manifest.payload, isDirectory: false)
                .standardizedFileURL
                .resolvingSymlinksInPath()
            guard payloadURL.path.hasPrefix(resolvedDirectory.path + "/"),
                  let payloadValues = try? payloadURL.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
                  payloadValues.isRegularFile == true,
                  let fileSize = payloadValues.fileSize,
                  fileSize >= 0,
                  UInt64(fileSize) == manifest.size else {
                continue
            }
            items.append(SharedItemReply(
                id: manifest.id,
                kind: manifest.kind,
                name: manifest.name,
                size: manifest.size,
                mime: manifest.mime,
                path: payloadURL.path
            ))
        }
        invoke.resolve(items)
    }

    @objc public func acknowledgeSharedItem(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SharedItemArgs.self)
        guard validSharedItemIdentifier(args.id) else {
            invoke.reject("Shared item identifier is invalid")
            return
        }
        guard let inbox = try sharedInboxURL(create: false) else {
            invoke.resolve()
            return
        }
        let inboxResolved = inbox.standardizedFileURL.resolvingSymlinksInPath()
        let directory = inbox.appendingPathComponent(args.id, isDirectory: true)
        let resolvedDirectory = directory.standardizedFileURL.resolvingSymlinksInPath()
        guard resolvedDirectory.path.hasPrefix(inboxResolved.path + "/") else {
            invoke.reject("Shared item path is invalid")
            return
        }
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
        invoke.resolve()
    }

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

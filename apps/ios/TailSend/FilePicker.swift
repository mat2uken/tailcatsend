import UIKit
import UniformTypeIdentifiers

// FilePickerDelegate forwards the document picker result to the Rust
// core: the picked file is copied (security-scoped) into the app's
// temporary directory with its original filename, then reported back
// as (path, name) C strings. Nothing is sent when the user cancels.
class FilePickerDelegate: NSObject, UIDocumentPickerDelegate {
    static let shared = FilePickerDelegate()

    func documentPicker(
        _ controller: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        guard let url = urls.first else { return }

        let accessed = url.startAccessingSecurityScopedResource()
        defer {
            if accessed {
                url.stopAccessingSecurityScopedResource()
            }
        }

        let originalName = url.lastPathComponent
        let tempDir = NSTemporaryDirectory()
        let fileManager = FileManager.default

        var destURL = URL(fileURLWithPath: tempDir).appendingPathComponent(originalName)
        if fileManager.fileExists(atPath: destURL.path) {
            let baseName = (originalName as NSString).deletingPathExtension
            let ext = (originalName as NSString).pathExtension
            var index = 1
            repeat {
                let candidate = ext.isEmpty
                    ? "\(baseName) (\(index))"
                    : "\(baseName) (\(index)).\(ext)"
                destURL = URL(fileURLWithPath: tempDir).appendingPathComponent(candidate)
                index += 1
            } while fileManager.fileExists(atPath: destURL.path)
        }

        do {
            try fileManager.copyItem(at: url, to: destURL)
        } catch {
            return
        }

        originalName.withCString { namePtr in
            destURL.path.withCString { pathPtr in
                tailsend_ios_file_picked(pathPtr, namePtr)
            }
        }
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        // Cancel: no callback to Rust
    }
}

// Global function exported to Rust via C-ABI
@_cdecl("tailsend_swift_pick_file")
public func tailsend_swift_pick_file() {
    DispatchQueue.main.async {
        guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let rootVC = windowScene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
            return
        }

        let picker = UIDocumentPickerViewController(
            forOpeningContentTypes: [.data, .item],
            asCopy: false
        )
        picker.delegate = FilePickerDelegate.shared
        picker.allowsMultipleSelection = false
        rootVC.present(picker, animated: true, completion: nil)
    }
}

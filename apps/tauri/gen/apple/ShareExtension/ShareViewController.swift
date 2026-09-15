import UIKit
import UniformTypeIdentifiers

private let ponletShareGroupIdentifier = "group.jp.yasagure.ponlet"
private let ponletShareInboxDirectory = "PonletShareInbox"

private struct ShareManifest: Encodable {
    let id: String
    let kind: String
    let name: String
    let size: UInt64
    let mime: String?
    let payload: String
}

private enum ShareError: LocalizedError {
    case appGroupUnavailable
    case unsupportedItem
    case invalidFile

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "Ponlet の共有領域を利用できません"
        case .unsupportedItem:
            return "この共有項目には対応していません"
        case .invalidFile:
            return "共有されたファイルを読み取れません"
        }
    }
}

final class ShareViewController: UIViewController {
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.text = "Ponlet に追加中…"
        label.textAlignment = .center
        label.textColor = .label
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true

        let extensionItems = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = extensionItems.flatMap { $0.attachments ?? [] }
        let providerHasText = providers.contains { textType(for: $0) != nil }
        let attributedTexts = providerHasText
            ? []
            : extensionItems.compactMap { $0.attributedContentText?.string }
        processTexts(attributedTexts, index: 0, providers: providers)
    }

    private func processTexts(_ texts: [String], index: Int, providers: [NSItemProvider]) {
        if index < texts.count {
            do {
                try stageText(texts[index])
                processTexts(texts, index: index + 1, providers: providers)
            } catch {
                finish(.failure(error))
            }
            return
        }
        processProviders(providers, index: 0)
    }

    private func processProviders(_ providers: [NSItemProvider], index: Int) {
        guard index < providers.count else {
            finish(.success(()))
            return
        }
        processProvider(providers[index]) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                self.processProviders(providers, index: index + 1)
            case .failure(let error):
                self.finish(.failure(error))
            }
        }
    }

    private func processProvider(
        _ provider: NSItemProvider,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        if let typeIdentifier = textType(for: provider) {
            provider.loadItem(forTypeIdentifier: typeIdentifier, options: nil) { [weak self] item, error in
                guard let self else { return }
                if let text = self.textValue(item) {
                    do {
                        try self.stageText(text)
                        completion(.success(()))
                    } catch {
                        completion(.failure(error))
                    }
                } else {
                    self.processFile(provider, fallbackError: error, completion: completion)
                }
            }
        } else {
            processFile(provider, fallbackError: nil, completion: completion)
        }
    }

    private func processFile(
        _ provider: NSItemProvider,
        fallbackError: Error?,
        completion: @escaping (Result<Void, Error>) -> Void
    ) {
        guard let typeIdentifier = fileType(for: provider) else {
            completion(.failure(fallbackError ?? ShareError.unsupportedItem))
            return
        }
        provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] url, error in
            guard let self else { return }
            if let url {
                do {
                    try self.stageFile(url, name: provider.suggestedName, typeIdentifier: typeIdentifier)
                    completion(.success(()))
                } catch {
                    completion(.failure(error))
                }
                return
            }
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { [weak self] data, dataError in
                guard let self else { return }
                guard let data else {
                    completion(.failure(dataError ?? error ?? ShareError.invalidFile))
                    return
                }
                do {
                    try self.stageData(
                        data,
                        name: provider.suggestedName ?? "shared-file",
                        typeIdentifier: typeIdentifier
                    )
                    completion(.success(()))
                } catch {
                    completion(.failure(error))
                }
            }
        }
    }

    private func textType(for provider: NSItemProvider) -> String? {
        provider.registeredTypeIdentifiers.first { identifier in
            guard let type = UTType(identifier) else {
                return identifier == UTType.text.identifier || identifier == UTType.plainText.identifier
            }
            return type.conforms(to: .text) || type.conforms(to: .url)
        }
    }

    private func fileType(for provider: NSItemProvider) -> String? {
        provider.registeredTypeIdentifiers.first { identifier in
            guard let type = UTType(identifier) else { return true }
            return !type.conforms(to: .text)
                && !type.conforms(to: .url)
                && (type.conforms(to: .fileURL) || type.conforms(to: .data) || type.conforms(to: .item))
        }
    }

    private func textValue(_ item: NSSecureCoding?) -> String? {
        if let value = item as? String { return value }
        if let value = item as? NSString { return value as String }
        if let value = item as? NSAttributedString { return value.string }
        if let value = item as? URL { return value.absoluteString }
        if let value = item as? NSURL { return value.absoluteString }
        if let value = item as? Data { return String(data: value, encoding: .utf8) }
        return nil
    }

    private func inboxURL() throws -> URL {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: ponletShareGroupIdentifier
        ) else {
            throw ShareError.appGroupUnavailable
        }
        let inbox = container.appendingPathComponent(ponletShareInboxDirectory, isDirectory: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        return inbox
    }

    private func stageText(_ text: String) throws {
        try stageData(Data(text.utf8), name: "shared-text.txt", typeIdentifier: UTType.plainText.identifier, kind: "text")
    }

    private func stageFile(_ source: URL, name: String?, typeIdentifier: String) throws {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey])
        guard values.isRegularFile == true else { throw ShareError.invalidFile }
        let id = UUID().uuidString
        let directory = try inboxURL().appendingPathComponent(id, isDirectory: true)
        let payload = directory.appendingPathComponent("payload", isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: payload)
            guard let size = try payload.resourceValues(forKeys: [.fileSizeKey]).fileSize,
                  size >= 0 else {
                throw ShareError.invalidFile
            }
            try writeManifest(
                ShareManifest(
                    id: id,
                    kind: "file",
                    name: name?.isEmpty == false ? name! : source.lastPathComponent,
                    size: UInt64(size),
                    mime: UTType(typeIdentifier)?.preferredMIMEType,
                    payload: "payload"
                ),
                in: directory
            )
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    private func stageData(
        _ data: Data,
        name: String,
        typeIdentifier: String,
        kind: String = "file"
    ) throws {
        let id = UUID().uuidString
        let directory = try inboxURL().appendingPathComponent(id, isDirectory: true)
        let payload = directory.appendingPathComponent("payload", isDirectory: false)
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try data.write(to: payload, options: .atomic)
            try writeManifest(
                ShareManifest(
                    id: id,
                    kind: kind,
                    name: name,
                    size: UInt64(data.count),
                    mime: UTType(typeIdentifier)?.preferredMIMEType,
                    payload: "payload"
                ),
                in: directory
            )
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    private func writeManifest(_ manifest: ShareManifest, in directory: URL) throws {
        let data = try JSONEncoder().encode(manifest)
        try data.write(
            to: directory.appendingPathComponent("manifest.json", isDirectory: false),
            options: .atomic
        )
    }

    private func finish(_ result: Result<Void, Error>) {
        DispatchQueue.main.async { [weak self] in
            guard let self, let context = self.extensionContext else { return }
            switch result {
            case .failure(let error):
                context.cancelRequest(withError: NSError(
                    domain: "jp.yasagure.ponlet.share",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: error.localizedDescription]
                ))
            case .success:
                if let url = URL(string: "ponlet://share") {
                    context.open(url) { _ in
                        context.completeRequest(returningItems: nil)
                    }
                } else {
                    context.completeRequest(returningItems: nil)
                }
            }
        }
    }
}

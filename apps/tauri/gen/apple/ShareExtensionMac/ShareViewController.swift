import AppKit
import CoreImage.CIFilterBuiltins
import UniformTypeIdentifiers

private enum MacShareError: LocalizedError {
    case unsupportedItem, invalidFile, textTooLarge

    var errorDescription: String? {
        switch self {
        case .unsupportedItem: return "この共有項目には対応していません。"
        case .invalidFile: return "共有されたファイルを読み取れません。"
        case .textTooLarge: return "テキストは1 MiB以下にしてください。"
        }
    }
}

final class ShareViewController: NSViewController {
    private var started = false
    private var closing = false
    private var stagingFinished = false
    private var itemsReady = false
    private var session: ShareSession?
    private var timer: Timer?
    private var items: [ShareSendItem] = []
    private var completedIds = Set<String>()
    private var invitation = ""
    private var lastState = "preparing"
    private let staging = FileManager.default.temporaryDirectory
        .appendingPathComponent("PonletShare-\(UUID().uuidString)", isDirectory: true)
    private let stagingQueue = DispatchQueue(label: "jp.yasagure.ponlet.share.mac.staging", qos: .userInitiated)

    private let statusLabel = NSTextField(labelWithString: "共有内容を読み込み中…")
    private let detailLabel = NSTextField(wrappingLabelWithString: "")
    private let itemsLabel = NSTextField(wrappingLabelWithString: "")
    private let itemsButton = NSButton(title: "共有内容をすべて表示", target: nil, action: nil)
    private let qrImage = NSImageView()
    private let copyButton = NSButton(title: "招待URLをコピー", target: nil, action: nil)
    private let joinField = NSTextField()
    private let joinButton = NSButton(title: "この相手に接続", target: nil, action: nil)
    private let retryButton = NSButton(title: "接続をやり直す", target: nil, action: nil)
    private let closeButton = NSButton(title: "キャンセル", target: nil, action: nil)
    private let progress = NSProgressIndicator()
    private let connectionStack = NSStackView()

    override func viewDidLoad() {
        super.viewDidLoad()
        preferredContentSize = NSSize(width: 440, height: 620)
    }

    override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 440, height: 620))
        root.widthAnchor.constraint(greaterThanOrEqualToConstant: 400).isActive = true
        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        root.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: root.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: root.bottomAnchor),
        ])

        let document = NSView()
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 14
        stack.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -20),
        ])

        let title = NSTextField(labelWithString: "Ponletで送信")
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        stack.addArrangedSubview(title)
        statusLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        statusLabel.setAccessibilityIdentifier("share-status")
        detailLabel.textColor = .secondaryLabelColor
        itemsLabel.font = .systemFont(ofSize: 12)
        itemsLabel.setAccessibilityIdentifier("share-items")
        for label in [statusLabel, detailLabel, itemsLabel] {
            label.maximumNumberOfLines = 0
            stack.addArrangedSubview(label)
            label.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        configure(itemsButton, action: #selector(toggleItems))
        itemsButton.isHidden = true
        stack.addArrangedSubview(itemsButton)

        progress.style = .bar
        progress.isIndeterminate = false
        progress.minValue = 0
        progress.maxValue = 1
        progress.isHidden = true
        stack.addArrangedSubview(progress)
        progress.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        connectionStack.orientation = .vertical
        connectionStack.alignment = .leading
        connectionStack.spacing = 10
        qrImage.imageScaling = .scaleProportionallyUpOrDown
        qrImage.setAccessibilityLabel("接続用QRコード")
        qrImage.widthAnchor.constraint(equalToConstant: 190).isActive = true
        qrImage.heightAnchor.constraint(equalToConstant: 190).isActive = true
        connectionStack.addArrangedSubview(qrImage)
        configure(copyButton, action: #selector(copyInvitation))
        connectionStack.addArrangedSubview(copyButton)
        joinField.placeholderString = "相手の招待URLを貼り付け"
        joinField.setAccessibilityLabel("相手の招待URL")
        connectionStack.addArrangedSubview(joinField)
        configure(joinButton, action: #selector(joinPeer))
        connectionStack.addArrangedSubview(joinButton)
        stack.addArrangedSubview(connectionStack)
        joinField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        connectionStack.isHidden = true

        configure(retryButton, action: #selector(retry))
        retryButton.isHidden = true
        stack.addArrangedSubview(retryButton)
        configure(closeButton, action: #selector(closeTapped))
        stack.addArrangedSubview(closeButton)
        view = root
    }

    private func configure(_ button: NSButton, action: Selector) {
        button.bezelStyle = .rounded
        button.target = self
        button.action = action
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard !started else { return }
        started = true
        let extensionItems = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = extensionItems.flatMap { $0.attachments ?? [] }
        let texts = providers.contains { textType(for: $0) != nil } ? []
            : extensionItems.compactMap { $0.attributedContentText?.string }
        stagingQueue.async { [self] in
            do {
                for text in texts { try self.stageText(text) }
                self.processProviders(providers, index: 0)
            } catch { self.finishStaging(.failure(error)) }
        }
    }

    private func processProviders(_ providers: [NSItemProvider], index: Int) {
        guard index < providers.count else { finishStaging(.success(())); return }
        let provider = providers[index]
        let complete: (Result<Void, Error>) -> Void = { [self] result in
            switch result {
            case .success: self.processProviders(providers, index: index + 1)
            case .failure(let error): self.finishStaging(.failure(error))
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [self] item, error in
                do {
                    guard let url = self.fileURL(from: item) else { throw error ?? MacShareError.invalidFile }
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    try self.stageFile(url, name: provider.suggestedName, type: nil)
                    complete(.success(()))
                } catch { complete(.failure(error)) }
            }
        } else if let type = textType(for: provider) {
            provider.loadItem(forTypeIdentifier: type, options: nil) { [self] item, error in
                do {
                    let text: String?
                    switch item {
                    case let value as String: text = value
                    case let value as NSAttributedString: text = value.string
                    case let value as URL: text = value.absoluteString
                    case let value as Data: text = String(data: value, encoding: .utf8)
                    default: text = nil
                    }
                    guard let text else { throw error ?? MacShareError.unsupportedItem }
                    try self.stageText(text)
                    complete(.success(()))
                } catch { complete(.failure(error)) }
            }
        } else if let type = provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .data) == true || UTType($0)?.conforms(to: .item) == true
        }) {
            // The provider owns this temporary file; copy it before the callback returns.
            provider.loadFileRepresentation(forTypeIdentifier: type) { [self] url, error in
                do {
                    guard let url else { throw error ?? MacShareError.invalidFile }
                    try self.stageFile(url, name: provider.suggestedName, type: type)
                    complete(.success(()))
                } catch { complete(.failure(error)) }
            }
        } else { complete(.failure(MacShareError.unsupportedItem)) }
    }

    private func fileURL(from item: NSSecureCoding?) -> URL? {
        if let url = item as? URL { return url.isFileURL ? url : nil }
        let text: String?
        if let data = item as? Data {
            text = String(data: data, encoding: .utf8)
        } else {
            text = item as? String
        }
        guard let text, let url = URL(string: text), url.isFileURL else { return nil }
        return url
    }

    private func textType(for provider: NSItemProvider) -> String? {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) { return nil }
        return provider.registeredTypeIdentifiers.first {
            guard let type = UTType($0) else { return false }
            return type.conforms(to: .text) || (type.conforms(to: .url) && !type.conforms(to: .fileURL))
        }
    }

    private func stageText(_ text: String) throws {
        let data = Data(text.utf8)
        guard data.count <= 1_048_576 else { throw MacShareError.textTooLarge }
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let id = UUID().uuidString
        let path = staging.appendingPathComponent(id)
        try data.write(to: path, options: .atomic)
        items.append(ShareSendItem(id: id, kind: "text", name: "テキスト", size: UInt64(data.count),
            path: path.path, mime: "text/plain", preview: String(text.prefix(120))))
    }

    private func stageFile(_ source: URL, name: String?, type: String?) throws {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey])
        guard values.isRegularFile == true else { throw MacShareError.invalidFile }
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let id = UUID().uuidString
        let path = staging.appendingPathComponent(id)
        try FileManager.default.copyItem(at: source, to: path)
        let size = try path.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        let fileName = name?.isEmpty == false ? name! : source.lastPathComponent
        let mime = type.flatMap { UTType($0)?.preferredMIMEType }
            ?? UTType(filenameExtension: (fileName as NSString).pathExtension)?.preferredMIMEType
        items.append(ShareSendItem(id: id, kind: "file", name: fileName, size: UInt64(size),
            path: path.path, mime: mime, preview: nil))
    }

    private func finishStaging(_ result: Result<Void, Error>) {
        DispatchQueue.main.async { [self] in
            self.stagingFinished = true
            if self.closing { self.cleanStaging(); return }
            switch result {
            case .success:
                guard !self.items.isEmpty else { self.showError(MacShareError.unsupportedItem); return }
                self.itemsReady = true
                self.renderItems()
                self.startSession()
            case .failure(let error): self.showError(error)
            }
        }
    }

    private func renderItems() {
        itemsButton.isHidden = items.count <= 2
        let shown = itemsButton.title == "一覧を折りたたむ" ? items : Array(items.prefix(2))
        itemsLabel.stringValue = shown.map { item in
            let mark = completedIds.contains(item.id) ? "✓ " : ""
            let size = ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)
            let preview = item.preview.map { "\n\($0)" } ?? ""
            return "\(mark)\(item.name) · \(size)\(preview)"
        }.joined(separator: "\n\n")
    }

    private func startSession(invite: String = "") {
        guard !closing else { return }
        stopSession()
        do {
            let pending = items.filter { !completedIds.contains($0.id) }
            guard !pending.isEmpty else { showCompleted(); return }
            session = try ShareSession(items: pending, invitation: invite)
            lastState = "preparing"
            statusLabel.stringValue = "接続を準備中…"
            detailLabel.stringValue = "接続すると自動で送信します。送信が終わるまでこの画面を開いてください。"
            retryButton.isHidden = true
            connectionStack.isHidden = false
            joinButton.isEnabled = true
            qrImage.isHidden = true
            copyButton.isHidden = true
            invitation = ""
            progress.isHidden = true
            timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.updateSession() }
            updateSession()
        } catch { showError(error) }
    }

    private func updateSession() {
        guard let session, !closing else { return }
        do {
            let value = try session.snapshot()
            let previousCount = completedIds.count
            completedIds.formUnion(value.completedIds)
            if completedIds.count != previousCount { renderItems() }
            lastState = value.state
            if let url = value.inviteUrl, url != invitation {
                invitation = url
                let filter = CIFilter.qrCodeGenerator()
                filter.message = Data(url.utf8)
                filter.correctionLevel = "M"
                if let output = filter.outputImage {
                    let scaled = output.transformed(by: CGAffineTransform(scaleX: 5, y: 5))
                    let white = CIImage(color: .white).cropped(to: scaled.extent.insetBy(dx: -20, dy: -20))
                    let padded = scaled.composited(over: white)
                    if let cg = CIContext().createCGImage(padded, from: padded.extent) {
                        qrImage.image = NSImage(cgImage: cg, size: padded.extent.size)
                    }
                }
            }
            qrImage.isHidden = invitation.isEmpty || value.state != "waiting"
            copyButton.isHidden = qrImage.isHidden
            connectionStack.isHidden = value.state == "sending" || value.state == "completed"
            progress.isHidden = value.state != "sending"
            switch value.state {
            case "waiting":
                statusLabel.stringValue = "相手の接続を待っています"
                detailLabel.stringValue = "相手の端末でQRコードを読み取ると、共有内容を自動送信します。相手の招待URLからも接続できます。"
            case "connecting":
                statusLabel.stringValue = "相手に接続中…"
                detailLabel.stringValue = "接続すると自動で送信します。送信が終わるまでこの画面を開いてください。"
            case "sending":
                statusLabel.stringValue = "送信中（\(min(completedIds.count + 1, items.count))/\(items.count)）"
                progress.doubleValue = value.total > 0 ? min(Double(value.done) / Double(value.total), 1) : 0
                detailLabel.stringValue = "\(value.currentName ?? "")\n\(ByteCountFormatter.string(fromByteCount: Int64(value.done), countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: Int64(value.total), countStyle: .file))\nこの画面を開いたままお待ちください。"
            case "completed": showCompleted()
            case "error", "cancelled":
                timer?.invalidate()
                timer = nil
                statusLabel.stringValue = value.state == "cancelled" ? "送信を中断しました" : "接続・送信に失敗しました"
                detailLabel.stringValue = (value.error ?? "") + "\n未送信の項目は、接続をやり直すと再送信できます。"
                connectionStack.isHidden = true
                retryButton.isHidden = false
            default: break
            }
        } catch { stopSession(); showError(error) }
    }

    private func showCompleted() {
        lastState = "completed"
        timer?.invalidate()
        timer = nil
        session = nil
        statusLabel.stringValue = "\(items.count)件を送信しました"
        detailLabel.stringValue = "完了を押すと元のアプリに戻ります。"
        connectionStack.isHidden = true
        progress.isHidden = true
        retryButton.isHidden = true
        closeButton.title = "完了"
    }

    private func showError(_ error: Error) {
        lastState = "error"
        statusLabel.stringValue = "共有内容を送信できません"
        detailLabel.stringValue = error.localizedDescription
        connectionStack.isHidden = true
        progress.isHidden = true
        retryButton.isHidden = !itemsReady
    }

    private func stopSession() {
        timer?.invalidate()
        timer = nil
        session?.cancel()
        if let session, let value = try? session.snapshot() { completedIds.formUnion(value.completedIds) }
        session = nil
        if stagingFinished { renderItems() }
    }

    @objc private func copyInvitation() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(invitation, forType: .string)
    }

    @objc private func joinPeer() {
        let url = joinField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { view.window?.makeFirstResponder(joinField); return }
        startSession(invite: url)
    }

    @objc private func retry() { startSession() }

    @objc private func toggleItems() {
        itemsButton.title = itemsButton.title == "一覧を折りたたむ" ? "共有内容をすべて表示" : "一覧を折りたたむ"
        renderItems()
    }

    @objc private func closeTapped() {
        if lastState == "completed" { closeSheet(); return }
        let alert = NSAlert()
        alert.messageText = "共有を終了しますか？"
        alert.informativeText = "未送信の項目は送信されません。元のファイルは残ります。"
        alert.addButton(withTitle: "戻る")
        alert.addButton(withTitle: "共有を終了")
        if let window = view.window {
            alert.beginSheetModal(for: window) { [weak self] response in
                if response == .alertSecondButtonReturn { self?.closeSheet() }
            }
        } else if alert.runModal() == .alertSecondButtonReturn {
            closeSheet()
        }
    }

    private func closeSheet() {
        closing = true
        stopSession()
        if stagingFinished { cleanStaging() }
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }

    private func cleanStaging() { try? FileManager.default.removeItem(at: staging) }

    deinit {
        timer?.invalidate()
        session?.cancel()
        if stagingFinished { cleanStaging() }
    }
}

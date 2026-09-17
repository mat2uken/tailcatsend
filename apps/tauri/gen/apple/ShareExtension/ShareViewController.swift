import UIKit
import UniformTypeIdentifiers
import CoreImage.CIFilterBuiltins

private enum ShareError: LocalizedError {
    case unsupportedItem, invalidFile, textTooLarge
    var errorDescription: String? {
        switch self {
        case .unsupportedItem: return "この共有項目には対応していません。"
        case .invalidFile: return "共有されたファイルを読み取れません。"
        case .textTooLarge: return "テキストは1 MiB以下にしてください。"
        }
    }
}

final class ShareViewController: UIViewController {
    private var started = false
    private var closing = false
    private var backgrounded = false
    private var session: ShareSession?
    private var timer: Timer?
    private var items: [ShareSendItem] = []
    private var completedIds = Set<String>()
    private var invitation = ""
    private var lastState = "preparing"
    private let staging = FileManager.default.temporaryDirectory
        .appendingPathComponent("PonletShare-\(UUID().uuidString)", isDirectory: true)
    private let stagingQueue = DispatchQueue(label: "jp.yasagure.ponlet.share.staging", qos: .userInitiated)
    private let statusLabel = UILabel()
    private let detailLabel = UILabel()
    private let itemsLabel = UILabel()
    private let itemsButton = UIButton(type: .system)
    private let qrImage = UIImageView()
    private let copyButton = UIButton(type: .system)
    private let joinField = UITextField()
    private let joinButton = UIButton(type: .system)
    private let retryButton = UIButton(type: .system)
    private let closeButton = UIButton(type: .system)
    private let progress = UIProgressView(progressViewStyle: .default)
    private let connectionStack = UIStackView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        isModalInPresentation = true
        preferredContentSize = CGSize(width: 380, height: 660)
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -20),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -40),
        ])
        let title = UILabel()
        title.text = "Ponletで送信"
        title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true
        stack.addArrangedSubview(title)
        for label in [statusLabel, detailLabel, itemsLabel] {
            label.numberOfLines = 0
            label.adjustsFontForContentSizeCategory = true
        }
        statusLabel.font = .preferredFont(forTextStyle: .headline)
        statusLabel.accessibilityIdentifier = "share-status"
        detailLabel.font = .preferredFont(forTextStyle: .subheadline)
        detailLabel.textColor = .secondaryLabel
        itemsLabel.font = .preferredFont(forTextStyle: .footnote)
        itemsLabel.accessibilityIdentifier = "share-items"
        itemsLabel.numberOfLines = 7
        statusLabel.text = "共有内容を読み込み中…"
        stack.addArrangedSubview(statusLabel)
        stack.addArrangedSubview(detailLabel)
        stack.addArrangedSubview(itemsLabel)
        configure(itemsButton, title: "共有内容をすべて表示", action: #selector(toggleItems))
        itemsButton.isHidden = true
        stack.addArrangedSubview(itemsButton)
        stack.addArrangedSubview(progress)
        progress.isHidden = true
        connectionStack.axis = .vertical
        connectionStack.spacing = 12
        qrImage.contentMode = .scaleAspectFit
        qrImage.backgroundColor = .white
        qrImage.layer.magnificationFilter = .nearest
        qrImage.accessibilityLabel = "接続用QRコード"
        qrImage.heightAnchor.constraint(equalToConstant: 200).isActive = true
        connectionStack.addArrangedSubview(qrImage)
        configure(copyButton, title: "招待URLをコピー", action: #selector(copyInvitation))
        connectionStack.addArrangedSubview(copyButton)
        joinField.borderStyle = .roundedRect
        joinField.placeholder = "相手の招待URLを貼り付け"
        joinField.accessibilityLabel = "相手の招待URL"
        joinField.autocapitalizationType = .none
        joinField.autocorrectionType = .no
        joinField.keyboardType = .URL
        connectionStack.addArrangedSubview(joinField)
        configure(joinButton, title: "この相手に接続", action: #selector(joinPeer))
        connectionStack.addArrangedSubview(joinButton)
        stack.addArrangedSubview(connectionStack)
        connectionStack.isHidden = true
        configure(retryButton, title: "接続をやり直す", action: #selector(retry))
        retryButton.isHidden = true
        stack.addArrangedSubview(retryButton)
        configure(closeButton, title: "キャンセル", action: #selector(closeTapped))
        stack.addArrangedSubview(closeButton)
        NotificationCenter.default.addObserver(self, selector: #selector(hostBackgrounded),
            name: NSNotification.Name.NSExtensionHostDidEnterBackground, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(hostForegrounded),
            name: NSNotification.Name.NSExtensionHostWillEnterForeground, object: nil)
    }

    private func configure(_ button: UIButton, title: String, action: Selector) {
        var config = UIButton.Configuration.tinted()
        config.title = title
        button.configuration = config
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
        button.addTarget(self, action: action, for: .touchUpInside)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let extensionItems = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = extensionItems.flatMap { $0.attachments ?? [] }
        let texts = providers.contains { textType(for: $0) != nil } ? []
            : extensionItems.compactMap { $0.attributedContentText?.string }
        stagingQueue.async { [weak self] in
            guard let self else { return }
            do {
                for text in texts { try self.stageText(text) }
                self.processProviders(providers, index: 0)
            } catch { self.finishStaging(.failure(error)) }
        }
    }

    private func processProviders(_ providers: [NSItemProvider], index: Int) {
        guard index < providers.count else { finishStaging(.success(())); return }
        let provider = providers[index]
        let complete: (Result<Void, Error>) -> Void = { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.processProviders(providers, index: index + 1)
            case .failure(let error): self.finishStaging(.failure(error))
            }
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { [weak self] item, error in
                guard let self else { return }
                do {
                    guard let url = item as? URL else { throw error ?? ShareError.invalidFile }
                    let access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    try self.stageFile(url, name: provider.suggestedName, type: nil)
                    complete(.success(()))
                } catch { complete(.failure(error)) }
            }
        } else if let type = textType(for: provider) {
            provider.loadItem(forTypeIdentifier: type, options: nil) { [weak self] item, error in
                guard let self else { return }
                do {
                    let text: String?
                    switch item {
                    case let value as String: text = value
                    case let value as NSAttributedString: text = value.string
                    case let value as URL: text = value.absoluteString
                    case let value as Data: text = String(data: value, encoding: .utf8)
                    default: text = nil
                    }
                    guard let text else { throw error ?? ShareError.unsupportedItem }
                    try self.stageText(text)
                    complete(.success(()))
                } catch { complete(.failure(error)) }
            }
        } else if let type = provider.registeredTypeIdentifiers.first(where: {
            UTType($0)?.conforms(to: .data) == true || UTType($0)?.conforms(to: .item) == true
        }) {
            // Copy before returning: the provider owns the temporary file lifetime.
            provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, error in
                guard let self else { return }
                do {
                    guard let url else { throw error ?? ShareError.invalidFile }
                    try self.stageFile(url, name: provider.suggestedName, type: type)
                    complete(.success(()))
                } catch { complete(.failure(error)) }
            }
        } else { complete(.failure(ShareError.unsupportedItem)) }
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
        guard data.count <= 1_048_576 else { throw ShareError.textTooLarge }
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let id = UUID().uuidString
        let path = staging.appendingPathComponent(id)
        try data.write(to: path, options: .atomic)
        items.append(ShareSendItem(id: id, kind: "text", name: "テキスト", size: UInt64(data.count),
            path: path.path, mime: "text/plain", preview: String(text.prefix(120))))
    }

    private func stageFile(_ source: URL, name: String?, type: String?) throws {
        let values = try source.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true else { throw ShareError.invalidFile }
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let id = UUID().uuidString
        let path = staging.appendingPathComponent(id)
        try FileManager.default.copyItem(at: source, to: path)
        let size = try path.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        let fileName = name?.isEmpty == false ? name! : source.lastPathComponent
        items.append(ShareSendItem(id: id, kind: "file", name: fileName, size: UInt64(size),
            path: path.path, mime: type.flatMap { UTType($0)?.preferredMIMEType }, preview: nil))
    }

    private func finishStaging(_ result: Result<Void, Error>) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.closing { self.cleanStaging(); return }
            switch result {
            case .success:
                guard !self.items.isEmpty else { self.showError(ShareError.unsupportedItem); return }
                self.renderItems()
                if self.backgrounded { self.showInterrupted() }
                else { self.startSession() }
            case .failure(let error): self.showError(error)
            }
        }
    }

    private func renderItems() {
        itemsButton.isHidden = items.count <= 2
        itemsLabel.text = items.map { item in
            let mark = completedIds.contains(item.id) ? "✓ " : ""
            let size = ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)
            let preview = item.preview.map { "\n\($0)" } ?? ""
            return "\(mark)\(item.name) · \(size)\(preview)"
        }.joined(separator: "\n\n")
    }

    private func startSession(invite: String = "") {
        guard !closing, !backgrounded else { return }
        stopSession()
        do {
            let pending = items.filter { !completedIds.contains($0.id) }
            guard !pending.isEmpty else { showCompleted(); return }
            session = try ShareSession(items: pending, invitation: invite)
            lastState = "preparing"
            statusLabel.text = "接続を準備中…"
            detailLabel.text = "接続すると自動で送信します。送信が終わるまでこの画面を開いてください。"
            retryButton.isHidden = true
            connectionStack.isHidden = false
            joinButton.isEnabled = true
            qrImage.isHidden = true
            copyButton.isHidden = true
            invitation = ""
            progress.isHidden = true
            timer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in self?.updateSession() }
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
                        qrImage.image = UIImage(cgImage: cg)
                    }
                }
            }
            qrImage.isHidden = invitation.isEmpty || value.state != "waiting"
            copyButton.isHidden = qrImage.isHidden
            connectionStack.isHidden = value.state == "sending" || value.state == "completed"
            progress.isHidden = value.state != "sending"
            switch value.state {
            case "waiting":
                statusLabel.text = "相手の接続を待っています"
                detailLabel.text = "相手の端末でQRコードを読み取ると、共有内容を自動送信します。相手の招待URLからも接続できます。"
            case "connecting": statusLabel.text = "相手に接続中…"
            case "sending":
                statusLabel.text = "送信中（\(completedIds.count + 1)/\(items.count)）"
                progress.progress = value.total > 0 ? Float(Double(value.done) / Double(value.total)) : 0
                detailLabel.text = "\(value.currentName ?? "")\n\(ByteCountFormatter.string(fromByteCount: Int64(value.done), countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: Int64(value.total), countStyle: .file))\nこの画面を開いたままお待ちください。"
            case "completed": showCompleted()
            case "error", "cancelled":
                timer?.invalidate()
                timer = nil
                statusLabel.text = value.state == "cancelled" ? "送信を中断しました" : "接続・送信に失敗しました"
                detailLabel.text = (value.error ?? "") + "\n未送信の項目は、接続をやり直すと再送信できます。"
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
        statusLabel.text = "\(items.count)件を送信しました"
        detailLabel.text = "完了を押すと元のアプリに戻ります。"
        connectionStack.isHidden = true
        progress.isHidden = true
        retryButton.isHidden = true
        closeButton.configuration?.title = "完了"
    }

    private func showError(_ error: Error) {
        lastState = "error"
        statusLabel.text = "共有内容を送信できません"
        detailLabel.text = error.localizedDescription
        connectionStack.isHidden = true
        progress.isHidden = true
    }

    private func stopSession() {
        timer?.invalidate()
        timer = nil
        session?.cancel()
        if let session, let value = try? session.snapshot() { completedIds.formUnion(value.completedIds) }
        session = nil
    }

    @objc private func copyInvitation() { UIPasteboard.general.string = invitation }
    @objc private func joinPeer() {
        let url = (joinField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { joinField.becomeFirstResponder(); return }
        view.endEditing(true)
        startSession(invite: url)
    }
    @objc private func retry() { startSession() }
    @objc private func toggleItems() {
        let expanded = itemsLabel.numberOfLines == 0
        itemsLabel.numberOfLines = expanded ? 7 : 0
        itemsButton.configuration?.title = expanded ? "共有内容をすべて表示" : "一覧を折りたたむ"
    }
    @objc private func hostForegrounded() { backgrounded = false }
    @objc private func hostBackgrounded() {
        backgrounded = true
        guard session != nil, lastState != "completed" else { return }
        stopSession()
        showInterrupted()
    }
    private func showInterrupted() {
        lastState = "cancelled"
        statusLabel.text = "送信を中断しました"
        detailLabel.text = "送信中はこの画面を開いてください。未送信の項目は接続をやり直すと再送信できます。"
        retryButton.isHidden = false
        connectionStack.isHidden = true
        progress.isHidden = true
    }
    @objc private func closeTapped() {
        if lastState == "completed" { closeSheet(); return }
        let alert = UIAlertController(title: "共有を終了しますか？", message: "未送信の項目は送信されません。元のファイルは残ります。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "戻る", style: .cancel))
        alert.addAction(UIAlertAction(title: "共有を終了", style: .destructive) { [weak self] _ in self?.closeSheet() })
        present(alert, animated: true)
    }
    private func closeSheet() {
        closing = true
        stopSession()
        cleanStaging()
        extensionContext?.completeRequest(returningItems: nil)
    }
    private func cleanStaging() { try? FileManager.default.removeItem(at: staging) }
    deinit {
        timer?.invalidate()
        session?.cancel()
        NotificationCenter.default.removeObserver(self)
    }
}

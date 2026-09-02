import UIKit
import AVFoundation

class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var captureSession: AVCaptureSession?
    var previewLayer: AVCaptureVideoPreviewLayer?
    var didScan = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        setupCamera()
        setupOverlayUI()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        didScan = false
        if let captureSession = captureSession, !captureSession.isRunning {
            DispatchQueue.global(qos: .userInitiated).async {
                captureSession.startRunning()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if let captureSession = captureSession, captureSession.isRunning {
            captureSession.stopRunning()
        }
    }

    func setupCamera() {
        let session = AVCaptureSession()
        guard let videoCaptureDevice = AVCaptureDevice.default(for: .video) else {
            showCameraUnavailableAlert()
            return
        }

        do {
            let videoInput = try AVCaptureDeviceInput(device: videoCaptureDevice)
            if session.canAddInput(videoInput) {
                session.addInput(videoInput)
            } else {
                showCameraUnavailableAlert()
                return
            }

            let metadataOutput = AVCaptureMetadataOutput()
            if session.canAddOutput(metadataOutput) {
                session.addOutput(metadataOutput)
                metadataOutput.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
                metadataOutput.metadataObjectTypes = [.qr]
            } else {
                showCameraUnavailableAlert()
                return
            }

            let preview = AVCaptureVideoPreviewLayer(session: session)
            preview.frame = view.layer.bounds
            preview.videoGravity = .resizeAspectFill
            view.layer.addSublayer(preview)
            self.previewLayer = preview
            self.captureSession = session

            DispatchQueue.global(qos: .userInitiated).async {
                session.startRunning()
            }
        } catch {
            showCameraUnavailableAlert()
        }
    }

    func setupOverlayUI() {
        // Close Button
        let closeButton = UIButton(type: .system)
        closeButton.setTitle("✕ Cancel", for: .normal)
        closeButton.setTitleColor(.white, for: .normal)
        closeButton.titleLabel?.font = UIFont.boldSystemFont(ofSize: 17)
        closeButton.backgroundColor = UIColor(white: 0.2, alpha: 0.8)
        closeButton.layer.cornerRadius = 18
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.addTarget(self, action: #selector(dismissScanner), for: .touchUpInside)
        view.addSubview(closeButton)

        // Guide Title
        let guideLabel = UILabel()
        guideLabel.text = "Point camera at Mac's QR Code"
        guideLabel.textColor = .white
        guideLabel.font = UIFont.systemFont(ofSize: 15, weight: .medium)
        guideLabel.textAlignment = .center
        guideLabel.backgroundColor = UIColor(white: 0.1, alpha: 0.7)
        guideLabel.layer.cornerRadius = 12
        guideLabel.clipsToBounds = true
        guideLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(guideLabel)

        NSLayoutConstraint.activate([
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            closeButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
            closeButton.widthAnchor.constraint(equalToConstant: 90),
            closeButton.heightAnchor.constraint(equalToConstant: 36),

            guideLabel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -40),
            guideLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            guideLabel.widthAnchor.constraint(equalToConstant: 260),
            guideLabel.heightAnchor.constraint(equalToConstant: 40)
        ])
    }

    @objc func dismissScanner() {
        dismiss(animated: true, completion: nil)
    }

    func showCameraUnavailableAlert() {
        let alert = UIAlertController(
            title: "Camera Unavailable",
            message: "Unable to access camera. Please check camera permissions in iOS Settings.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
            self?.dismiss(animated: true, completion: nil)
        })
        DispatchQueue.main.async {
            self.present(alert, animated: true)
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard !didScan,
              let metadataObject = metadataObjects.first,
              let readableObject = metadataObject as? AVMetadataMachineReadableCodeObject,
              let stringValue = readableObject.stringValue else {
            return
        }

        didScan = true
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        captureSession?.stopRunning()

        dismiss(animated: true) {
            stringValue.withCString { cString in
                tailsend_ios_join_session(cString)
            }
        }
    }
}

// Global function exported to Rust via C-ABI
@_cdecl("tailsend_swift_open_camera_scanner")
public func tailsend_swift_open_camera_scanner() {
    DispatchQueue.main.async {
        guard let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
              let rootVC = windowScene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
            return
        }

        let scannerVC = QRScannerViewController()
        scannerVC.modalPresentationStyle = .fullScreen
        rootVC.present(scannerVC, animated: true, completion: nil)
    }
}

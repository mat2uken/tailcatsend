// Copyright 2019-2023 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

import AVFoundation
import Tauri
import UIKit
import WebKit

struct ScanOptions: Decodable {
  var formats: [SupportedFormat]?
  var windowed: Bool?
  var cameraDirection: String?
}

enum SupportedFormat: String, CaseIterable, Decodable {
  // UPC_A not supported
  case UPC_E
  case EAN_8
  case EAN_13
  case CODE_39
  case CODE_93
  case CODE_128
  // CODABAR not supported
  case ITF
  case AZTEC
  case DATA_MATRIX
  case PDF_417
  case QR_CODE
  case GS1_DATA_BAR
  case GS1_DATA_BAR_LIMITED
  case GS1_DATA_BAR_EXPANDED

  var value: AVMetadataObject.ObjectType? {
    switch self {
    case .UPC_E: return AVMetadataObject.ObjectType.upce
    case .EAN_8: return AVMetadataObject.ObjectType.ean8
    case .EAN_13: return AVMetadataObject.ObjectType.ean13
    case .CODE_39: return AVMetadataObject.ObjectType.code39
    case .CODE_93: return AVMetadataObject.ObjectType.code93
    case .CODE_128: return AVMetadataObject.ObjectType.code128
    case .ITF: return AVMetadataObject.ObjectType.interleaved2of5
    case .AZTEC: return AVMetadataObject.ObjectType.aztec
    case .DATA_MATRIX: return AVMetadataObject.ObjectType.dataMatrix
    case .PDF_417: return AVMetadataObject.ObjectType.pdf417
    case .QR_CODE: return AVMetadataObject.ObjectType.qr
    case .GS1_DATA_BAR:
      if #available(iOS 15.4, *) {
        return AVMetadataObject.ObjectType.gs1DataBar
      } else {
        return nil
      }
    case .GS1_DATA_BAR_LIMITED:
      if #available(iOS 15.4, *) {
        return AVMetadataObject.ObjectType.gs1DataBarLimited
      } else {
        return nil
      }
    case .GS1_DATA_BAR_EXPANDED:
      if #available(iOS 15.4, *) {
        return AVMetadataObject.ObjectType.gs1DataBarExpanded
      } else {
        return nil
      }
    }
  }
}

enum CaptureError: Error {
  case backCameraUnavailable
  case frontCameraUnavailable
  case couldNotCaptureInput(error: NSError)
}

class BarcodeScannerPlugin: Plugin, AVCaptureMetadataOutputObjectsDelegate {
  var webView: WKWebView!
  var cameraView: CameraView!
  var captureSession: AVCaptureSession?
  var captureVideoPreviewLayer: AVCaptureVideoPreviewLayer?
  var metaOutput: AVCaptureMetadataOutput?

  var currentCamera = 0
  var frontCamera: AVCaptureDevice?
  var backCamera: AVCaptureDevice?

  var isScanning = false

  var windowed = false
  var previousBackgroundColor: UIColor? = UIColor.white

  var invoke: Invoke? = nil
  private var scanGeneration: UInt64 = 0

  var scanFormats = [AVMetadataObject.ObjectType]()

  public override func load(webview: WKWebView) {
    self.webView = webview
    loadCamera()
  }

  private func loadCamera() {
    cameraView = CameraView(
      frame: CGRect(
        x: 0, y: 0, width: UIScreen.main.bounds.width, height: UIScreen.main.bounds.height))
    cameraView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
  }

  public func metadataOutput(
    _ captureOutput: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    if metadataObjects.count == 0 || !self.isScanning || captureOutput !== self.metaOutput {
      // while nothing is detected, or if scanning is false, do nothing.
      return
    }

    let found = metadataObjects[0] as! AVMetadataMachineReadableCodeObject
    if scanFormats.contains(found.type) {
      var jsObject: JsonObject = [:]

      jsObject["format"] = formatStringFromMetadata(found.type)
      if found.stringValue != nil {
        jsObject["content"] = found.stringValue
      }

      destroy()?.resolve(jsObject)

    }
  }

  private func setupCamera(direction: String, windowed: Bool) -> Bool {
    do {
      var cameraDirection = direction
      cameraView.backgroundColor = UIColor.clear
      if windowed {
        webView.superview?.insertSubview(cameraView, belowSubview: webView)
      } else {
        webView.superview?.insertSubview(cameraView, aboveSubview: webView)
      }

      let availableVideoDevices = discoverCaptureDevices()
      for device in availableVideoDevices {
        if device.position == AVCaptureDevice.Position.back {
          backCamera = device
        } else if device.position == AVCaptureDevice.Position.front {
          frontCamera = device
        }
      }

      // older iPods have no back camera
      if cameraDirection == "back" {
        if backCamera == nil {
          cameraDirection = "front"
        }
      } else {
        if frontCamera == nil {
          cameraDirection = "back"
        }
      }

      let input: AVCaptureDeviceInput
      input = try createCaptureDeviceInput(
        cameraDirection: cameraDirection, backCamera: backCamera, frontCamera: frontCamera)
      captureSession = AVCaptureSession()
      captureSession!.addInput(input)
      metaOutput = AVCaptureMetadataOutput()
      captureSession!.addOutput(metaOutput!)
      metaOutput!.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
      captureVideoPreviewLayer = AVCaptureVideoPreviewLayer(session: captureSession!)
      cameraView.addPreviewLayer(captureVideoPreviewLayer)

      self.windowed = windowed
      if windowed {
        self.previousBackgroundColor = self.webView.backgroundColor
        self.webView.isOpaque = false
        self.webView.backgroundColor = UIColor.clear
        self.webView.scrollView.backgroundColor = UIColor.clear
      }
      return true
    } catch {
      return false
    }
  }

  private func dismantleCamera() {
    self.captureSession?.stopRunning()
    // Preview creation can precede a failed/cancelled capture-session setup.
    self.cameraView?.removePreviewLayer()
    self.cameraView?.removeFromSuperview()
    self.captureVideoPreviewLayer = nil
    self.metaOutput = nil
    self.captureSession = nil
    self.frontCamera = nil
    self.backCamera = nil

    self.isScanning = false
  }

  @discardableResult
  private func destroy() -> Invoke? {
    scanGeneration &+= 1
    let pending = invoke
    invoke = nil
    dismantleCamera()
    if windowed {
      let backgroundColor = previousBackgroundColor ?? UIColor.white
      webView.isOpaque = true
      webView.backgroundColor = backgroundColor
      webView.scrollView.backgroundColor = backgroundColor
    }
    windowed = false
    return pending
  }

  private func getPermissionState() -> String {
    var permissionState: String

    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      permissionState = "granted"
    case .denied:
      permissionState = "denied"
    default:
      permissionState = "prompt"
    }

    return permissionState
  }

  @objc override func checkPermissions(_ invoke: Invoke) {
    let permissionState = getPermissionState()
    invoke.resolve(["camera": permissionState])
  }

  @objc override func requestPermissions(_ invoke: Invoke) {
    let state = getPermissionState()
    if state == "prompt" {
      AVCaptureDevice.requestAccess(for: .video) { (authorized) in
        invoke.resolve(["camera": authorized ? "granted" : "denied"])
      }
    } else {
      invoke.resolve(["camera": state])
    }
  }

  @objc func openAppSettings(_ invoke: Invoke) {
    guard let settingsUrl = URL(string: UIApplication.openSettingsURLString) else {
      return
    }

    DispatchQueue.main.async {
      if UIApplication.shared.canOpenURL(settingsUrl) {
        UIApplication.shared.open(
          settingsUrl,
          completionHandler: { (success) in
            invoke.resolve()
          })
      }
    }
  }

  private func runScanner(_ invoke: Invoke, args: ScanOptions, generation: UInt64) {
    guard generation == scanGeneration, self.invoke === invoke else { return }
    if getPermissionState() != "granted" {
      destroy()?.reject("Camera permission denied or not yet requested")
      return
    }

    scanFormats = [AVMetadataObject.ObjectType]()

    for format in args.formats ?? [] {
      if let formatValue = format.value {
        scanFormats.append(formatValue)
      } else {
        destroy()?.reject("Unsupported barcode format on this iOS version: \(format)")
        return
      }
    }

    if scanFormats.isEmpty {
      for supportedFormat in SupportedFormat.allCases {
        if let formatValue = supportedFormat.value {
          scanFormats.append(formatValue)
        }
      }
    }

    guard let output = self.metaOutput, let session = self.captureSession else {
      destroy()?.reject("Camera capture session is unavailable")
      return
    }
    output.metadataObjectTypes = self.scanFormats.filter { output.availableMetadataObjectTypes.contains($0) }
    DispatchQueue.main.async {
      // cancel can run after setup but before this queued start operation.
      guard self.scanGeneration == generation, self.invoke === invoke,
            self.captureSession === session else { return }
      session.startRunning()
      self.isScanning = true
    }
  }

  @objc private func scan(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScanOptions.self)

    DispatchQueue.main.async { [self] in
      self.destroy()?.reject("cancelled")
      self.invoke = invoke
      let generation = self.scanGeneration
      let entry = Bundle.main.infoDictionary?["NSCameraUsageDescription"] as? String
      guard let entry = entry, !entry.isEmpty else {
        self.destroy()?.reject("NSCameraUsageDescription is not in the app Info.plist")
        return
      }

      // Permission is requested separately. Its late reply must never start a scan.
      guard self.getPermissionState() == "granted" else {
        self.destroy()?.reject("Camera permission denied or not yet requested")
        return
      }
      guard !discoverCaptureDevices().isEmpty else {
        self.destroy()?.reject("No camera available on this device (e.g., iOS Simulator)")
        return
      }
      self.loadCamera()
      guard self.setupCamera(
        direction: args.cameraDirection ?? "back",
        windowed: args.windowed ?? false
      ) else {
        self.destroy()?.reject("Cannot set up the camera capture session")
        return
      }
      self.runScanner(invoke, args: args, generation: generation)
    }
  }

  @objc private func cancel(_ invoke: Invoke) {
    DispatchQueue.main.async {
      self.destroy()?.reject("cancelled")
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_barcode_scanner")
func initPlugin() -> Plugin {
  return BarcodeScannerPlugin()
}

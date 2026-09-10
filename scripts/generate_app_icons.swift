#!/usr/bin/env swift
import Foundation
import AppKit
import CoreGraphics

let repoRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let defaultSrcPath = repoRoot.appendingPathComponent("apps/tauri/icons/icon.png").path
let srcPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : defaultSrcPath

guard let srcImage = NSImage(contentsOfFile: srcPath) else {
    print("❌ Failed to load source image from \(srcPath)")
    exit(1)
}

guard let srcCgImage = srcImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("❌ Failed to extract CGImage from source image")
    exit(1)
}

let srcW = srcCgImage.width
let srcH = srcCgImage.height
print("📷 Source image loaded: \(srcW)x\(srcH)")


// ==============================================================================
// Helper 1: Resize CGImage directly (with alpha)
// ==============================================================================
func resizeCGImage(_ cgImage: CGImage, width: Int, height: Int) -> CGImage? {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let ctx = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    
    ctx.interpolationQuality = .high
    ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))
    return ctx.makeImage()
}

// ==============================================================================
// Helper 2: Save CGImage as PNG
// ==============================================================================
func savePNG(_ cgImage: CGImage, to url: URL) throws {
    let rep = NSBitmapImageRep(cgImage: cgImage)
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "PNGExport", code: 1, userInfo: [NSLocalizedDescriptionKey: "Failed to generate PNG data"])
    }
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url)
    print("  ✓ Saved PNG (\(cgImage.width)x\(cgImage.height)): \(url.path)")
}

// ==============================================================================
// Helper 3: Generate 1024x1024 Opaque Square Image for iOS AppIcon
// ==============================================================================
func generateIOSAppIcon(from src: CGImage, targetSize: Int = 1024) -> NSData? {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    var rgbaData = [UInt8](repeating: 0, count: targetSize * targetSize * 4)
    guard let context = CGContext(
        data: &rgbaData,
        width: targetSize,
        height: targetSize,
        bitsPerComponent: 8,
        bytesPerRow: targetSize * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    // Content bounding box in original 1254x1254 is approx [72, 70, 1110, 1110]
    let cropRect = CGRect(x: 72, y: 70, width: 1110, height: 1110)
    if let croppedCg = src.cropping(to: cropRect) {
        context.interpolationQuality = .high
        context.draw(croppedCg, in: CGRect(x: 0, y: 0, width: targetSize, height: targetSize))
    }

    // Un-premultiply colors
    for i in 0..<(targetSize * targetSize) {
        let a = Double(rgbaData[i * 4 + 3])
        if a > 0 && a < 255 {
            let r = Double(rgbaData[i * 4]) * 255.0 / a
            let g = Double(rgbaData[i * 4 + 1]) * 255.0 / a
            let b = Double(rgbaData[i * 4 + 2]) * 255.0 / a
            rgbaData[i * 4] = UInt8(min(255.0, r))
            rgbaData[i * 4 + 1] = UInt8(min(255.0, g))
            rgbaData[i * 4 + 2] = UInt8(min(255.0, b))
        }
    }

    // Extrapolate colors from opaque regions to transparent corner regions
    var isOpaque = [Bool](repeating: false, count: targetSize * targetSize)
    for i in 0..<(targetSize * targetSize) {
        isOpaque[i] = rgbaData[i * 4 + 3] >= 200
    }

    var nearestX = [Int16](repeating: -1, count: targetSize * targetSize)
    var nearestY = [Int16](repeating: -1, count: targetSize * targetSize)
    var queueX = [Int16]()
    var queueY = [Int16]()
    queueX.reserveCapacity(targetSize * 100)
    queueY.reserveCapacity(targetSize * 100)

    for y in 0..<targetSize {
        for x in 0..<targetSize {
            let idx = y * targetSize + x
            if isOpaque[idx] {
                nearestX[idx] = Int16(x)
                nearestY[idx] = Int16(y)
                var isBorder = false
                for (dx, dy) in [(-1,0),(1,0),(0,-1),(0,1)] {
                    let nx = x + dx
                    let ny = y + dy
                    if nx >= 0 && nx < targetSize && ny >= 0 && ny < targetSize {
                        if !isOpaque[ny * targetSize + nx] {
                            isBorder = true
                            break
                        }
                    }
                }
                if isBorder {
                    queueX.append(Int16(x))
                    queueY.append(Int16(y))
                }
            }
        }
    }

    var head = 0
    while head < queueX.count {
        let cx = Int(queueX[head])
        let cy = Int(queueY[head])
        head += 1
        
        let srcNx = nearestX[cy * targetSize + cx]
        let srcNy = nearestY[cy * targetSize + cx]
        
        for (dx, dy) in [(-1,0),(1,0),(0,-1),(0,1),(-1,-1),(-1,1),(1,-1),(1,1)] {
            let nx = cx + dx
            let ny = cy + dy
            if nx >= 0 && nx < targetSize && ny >= 0 && ny < targetSize {
                let nIdx = ny * targetSize + nx
                if !isOpaque[nIdx] && nearestX[nIdx] == -1 {
                    nearestX[nIdx] = srcNx
                    nearestY[nIdx] = srcNy
                    queueX.append(Int16(nx))
                    queueY.append(Int16(ny))
                }
            }
        }
    }

    for y in 0..<targetSize {
        for x in 0..<targetSize {
            let idx = y * targetSize + x
            if !isOpaque[idx] {
                let nx = Int(nearestX[idx])
                let ny = Int(nearestY[idx])
                if nx >= 0 && ny >= 0 {
                    let nIdx = ny * targetSize + nx
                    rgbaData[idx * 4] = rgbaData[nIdx * 4]
                    rgbaData[idx * 4 + 1] = rgbaData[nIdx * 4 + 1]
                    rgbaData[idx * 4 + 2] = rgbaData[nIdx * 4 + 2]
                }
                rgbaData[idx * 4 + 3] = 255
            }
        }
    }

    // Convert to 24-bit RGB (no alpha)
    var rgbData = [UInt8](repeating: 255, count: targetSize * targetSize * 3)
    for i in 0..<(targetSize * targetSize) {
        rgbData[i * 3] = rgbaData[i * 4]
        rgbData[i * 3 + 1] = rgbaData[i * 4 + 1]
        rgbData[i * 3 + 2] = rgbaData[i * 4 + 2]
    }

    var resultData: NSData? = nil
    rgbData.withUnsafeMutableBufferPointer { ptr in
        var plane = ptr.baseAddress
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: &plane,
            pixelsWide: targetSize,
            pixelsHigh: targetSize,
            bitsPerSample: 8,
            samplesPerPixel: 3,
            hasAlpha: false,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: targetSize * 3,
            bitsPerPixel: 24
        ) else { return }
        
        resultData = rep.representation(using: .png, properties: [:]) as NSData?
    }
    return resultData
}

// ==============================================================================
// Helper 4: Generate Circle Clipped Icon for Android (ic_launcher_round)
// ==============================================================================
func generateRoundIcon(from src: CGImage, targetSize: Int) -> CGImage? {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let context = CGContext(
        data: nil,
        width: targetSize,
        height: targetSize,
        bitsPerComponent: 8,
        bytesPerRow: targetSize * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    // Clip to circle
    let circleRect = CGRect(x: 0, y: 0, width: targetSize, height: targetSize)
    context.addEllipse(in: circleRect)
    context.clip()

    // Crop square inscribed inside the rounded rect [627-550, 625.5-550, 1100, 1100]
    let cropRect = CGRect(x: 627 - 550, y: 625.5 - 550, width: 1100, height: 1100)
    if let cropped = src.cropping(to: cropRect) {
        context.interpolationQuality = .high
        context.draw(cropped, in: CGRect(x: 0, y: 0, width: targetSize, height: targetSize))
    }

    return context.makeImage()
}

// ==============================================================================
// 1. Generate iOS Icons
// ==============================================================================
print("\n📱 [1/5] Generating iOS AppIcon (1024x1024 opaque square)...")
if let iosPngData = generateIOSAppIcon(from: srcCgImage, targetSize: 1024) {
let dest1 = repoRoot.appendingPathComponent("apps/tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
let dest2 = repoRoot.appendingPathComponent("apps/tauri/gen/apple/AppIcon_1024.png")
    try FileManager.default.createDirectory(at: dest1.deletingLastPathComponent(), withIntermediateDirectories: true)
    try (iosPngData as Data).write(to: dest1)
    try (iosPngData as Data).write(to: dest2)
    print("  ✓ Saved iOS icon (1024x1024 no alpha): \(dest1.path)")
    print("  ✓ Saved iOS icon (1024x1024 no alpha): \(dest2.path)")
} else {
    print("❌ Failed to generate iOS AppIcon")
    exit(1)
}

// ==============================================================================
// 2. Generate Android Icons
// ==============================================================================
print("\n🤖 [2/5] Generating Android Icons (Square & Round for all densities)...")
let androidDensities: [(name: String, size: Int)] = [
    ("mipmap-mdpi", 48),
    ("mipmap-hdpi", 72),
    ("mipmap-xhdpi", 96),
    ("mipmap-xxhdpi", 144),
    ("mipmap-xxxhdpi", 192),
]

let androidResDir = repoRoot.appendingPathComponent("apps/tauri/gen/android/app/src/main/res")
for density in androidDensities {
    let folder = androidResDir.appendingPathComponent(density.name)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

    // Square ic_launcher.png (from full image)
    if let squareCg = resizeCGImage(srcCgImage, width: density.size, height: density.size) {
        let squareUrl = folder.appendingPathComponent("ic_launcher.png")
        try savePNG(squareCg, to: squareUrl)
    }

    // Round ic_launcher_round.png
    if let roundCg = generateRoundIcon(from: srcCgImage, targetSize: density.size) {
        let roundUrl = folder.appendingPathComponent("ic_launcher_round.png")
        try savePNG(roundCg, to: roundUrl)
    }
}

// ==============================================================================
// 3. Generate Desktop / macOS Icons
// ==============================================================================
print("\n💻 [3/5] Generating macOS / Desktop Icons...")
let desktopIconDir = repoRoot.appendingPathComponent("apps/desktop")
let tauriIconDir = repoRoot.appendingPathComponent("apps/tauri/icons")

// apps/tauri/icons/icon.png (for the Tauri WebView shell)
if let icon512 = resizeCGImage(srcCgImage, width: 512, height: 512) {
    try savePNG(icon512, to: tauriIconDir.appendingPathComponent("icon.png"))
    try savePNG(icon512, to: desktopIconDir.appendingPathComponent("icon.png"))
}

// macOS .icns generation via iconutil
let tempIconset = FileManager.default.temporaryDirectory.appendingPathComponent("TailSendApp.iconset")
try? FileManager.default.removeItem(at: tempIconset)
try FileManager.default.createDirectory(at: tempIconset, withIntermediateDirectories: true)

let icnsSizes: [(file: String, size: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]

for item in icnsSizes {
    if let img = resizeCGImage(srcCgImage, width: item.size, height: item.size) {
        try savePNG(img, to: tempIconset.appendingPathComponent(item.file))
    }
}

let icnsDest = desktopIconDir.appendingPathComponent("AppIcon.icns")
let process = Process()
process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
process.arguments = ["-c", "icns", tempIconset.path, "-o", icnsDest.path]
try process.run()
process.waitUntilExit()

if process.terminationStatus == 0 {
    print("  ✓ Created macOS AppIcon.icns: \(icnsDest.path)")
} else {
    print("  ⚠️ Warning: iconutil failed with status \(process.terminationStatus)")
}
try? FileManager.default.removeItem(at: tempIconset)

// ==============================================================================
// 4. Generate Web Icons
// ==============================================================================
print("\n🌐 [4/5] Generating Web Favicons and Assets...")
let distDir = repoRoot.appendingPathComponent("dist")
let distAssetsDir = distDir.appendingPathComponent("assets")
try FileManager.default.createDirectory(at: distAssetsDir, withIntermediateDirectories: true)

// 512x512 web icon
if let icon512 = resizeCGImage(srcCgImage, width: 512, height: 512) {
    try savePNG(icon512, to: distAssetsDir.appendingPathComponent("icon_512.png"))
    try savePNG(icon512, to: distAssetsDir.appendingPathComponent("icon.png"))
}

// 180x180 apple-touch-icon
if let icon180 = resizeCGImage(srcCgImage, width: 180, height: 180) {
    try savePNG(icon180, to: distDir.appendingPathComponent("apple-touch-icon.png"))
}

// 32x32 favicon.png & 16x16
if let icon32 = resizeCGImage(srcCgImage, width: 32, height: 32) {
    try savePNG(icon32, to: distDir.appendingPathComponent("favicon.png"))
    try savePNG(icon32, to: distDir.appendingPathComponent("favicon.ico"))
}

print("\n🎉 [5/5] All application icons generated successfully!")

#!/usr/bin/env swift
// desktop / Windows / macOS / Web 用アイコンを、iOS 用 AppIcon（二重リング図柄）から再生成する。
//
//   swift scripts/generate_desktop_icons.swift [元絵 PNG] [--targets=tauri,macos,web]
//
// 出力（--targets 省略時は全部生成）:
//   tauri:
//     apps/tauri/icons/icon.png  512x512（角丸の外側は透過、内側は不透明）
//     apps/tauri/icons/icon.ico  16 / 32 / 48 / 64 / 128 / 256 の複数サイズ
//   macos:
//     apps/tauri/icons/AppIcon.icns  16 / 32 / 64 / 128 / 256 / 512 / 1024
//                                （iconutil で変換。既存 icns と同じ 10 スロット構成）
//   web:
//     dist/favicon.png           32x32
//     dist/favicon.ico           16 / 32 / 48 の複数サイズ ICO
//     dist/apple-touch-icon.png  180x180
//
// 元絵の既定は apps/tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
// （1024x1024 の不透明 PNG、白地に二重リング）。この図柄が正。
// 角丸マスクは旧 icon.png に合わせ、512px グリッドで外側余白 30・角丸半径 109。
// 元絵は角丸マスクの内側（正方形）いっぱいに配置する。
import Foundation
import AppKit
import CoreGraphics

let repoRoot = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let defaultSrcPath = repoRoot
    .appendingPathComponent("apps/tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png")
    .path
var srcPath = defaultSrcPath
var targets = Set(["tauri", "macos", "web"])
for arg in CommandLine.arguments.dropFirst() {
    if arg.hasPrefix("--targets=") {
        targets = Set(arg.dropFirst("--targets=".count).split(separator: ",").map(String.init))
    } else {
        srcPath = arg
    }
}
let supportedTargets = Set(["tauri", "macos", "web"])
guard !targets.isEmpty, targets.isSubset(of: supportedTargets) else {
    print("❌ --targets must contain only tauri, macos, web")
    exit(2)
}

guard let srcImage = NSImage(contentsOfFile: srcPath),
      let srcCgImage = srcImage.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    print("❌ Failed to load source image from \(srcPath)")
    exit(1)
}
print("📷 Source image loaded: \(srcCgImage.width)x\(srcCgImage.height) (\(srcPath))")

// 角丸マスクの形状（512px グリッド基準）
let canvasSize: CGFloat = 512
let inset: CGFloat = 30
let cornerRadius: CGFloat = 109
// 超サンプリング描画サイズ（エッジのアンチエイリアス用）
let masterSize = 2048

// ==============================================================================
// 角丸マスク付きで図柄を描く（premultiplied RGBA を返す）
// ==============================================================================
func renderMasked(size: Int) -> (rgba: [UInt8], size: Int)? {
    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
    guard let ctx = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: size * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    ctx.setShouldAntialias(true)
    ctx.setAllowsAntialiasing(true)
    ctx.interpolationQuality = .high

    let scale = CGFloat(size) / canvasSize
    let contentRect = CGRect(
        x: inset * scale,
        y: inset * scale,
        width: (canvasSize - inset * 2) * scale,
        height: (canvasSize - inset * 2) * scale
    )
    let mask = CGPath(
        roundedRect: contentRect,
        cornerWidth: cornerRadius * scale,
        cornerHeight: cornerRadius * scale,
        transform: nil
    )
    ctx.addPath(mask)
    ctx.clip()

    // 角丸内側を白で塗ってから元絵を重ねる
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: CGFloat(size), height: CGFloat(size)))
    ctx.draw(srcCgImage, in: contentRect)

    guard let data = ctx.data else { return nil }
    let count = size * size * 4
    let rgba = [UInt8](UnsafeBufferPointer(start: data.assumingMemoryBound(to: UInt8.self), count: count))
    return (rgba, size)
}

// ==============================================================================
// 面積平均での縮小（premultiplied RGBA のまま縮小する）
// ==============================================================================
func areaResize(_ src: [UInt8], from: Int, to: Int) -> [UInt8] {
    var dst = [UInt8](repeating: 0, count: to * to * 4)
    for y in 0..<to {
        let sy0 = y * from / to
        let sy1 = max(sy0 + 1, (y + 1) * from / to)
        for x in 0..<to {
            let sx0 = x * from / to
            let sx1 = max(sx0 + 1, (x + 1) * from / to)
            var r = 0, g = 0, b = 0, a = 0
            for sy in sy0..<sy1 {
                for sx in sx0..<sx1 {
                    let i = (sy * from + sx) * 4
                    r += Int(src[i])
                    g += Int(src[i + 1])
                    b += Int(src[i + 2])
                    a += Int(src[i + 3])
                }
            }
            let n = (sy1 - sy0) * (sx1 - sx0)
            let o = (y * to + x) * 4
            dst[o] = UInt8(r / n)
            dst[o + 1] = UInt8(g / n)
            dst[o + 2] = UInt8(b / n)
            dst[o + 3] = UInt8(a / n)
        }
    }
    return dst
}

// premultiplied RGBA を非 premultiplied に変換する
func straightRGBA(_ premultiplied: [UInt8]) -> [UInt8] {
    var out = premultiplied
    for i in 0..<(premultiplied.count / 4) {
        let a = Int(premultiplied[i * 4 + 3])
        guard a > 0, a < 255 else { continue }
        for c in 0..<3 {
            out[i * 4 + c] = UInt8(min(255, Int(premultiplied[i * 4 + c]) * 255 / a))
        }
    }
    return out
}

func cgImage(from rgba: [UInt8], size: Int) -> CGImage? {
    guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
    return CGImage(
        width: size,
        height: size,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: size * 4,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue),
        provider: provider,
        decode: nil,
        shouldInterpolate: true,
        intent: .defaultIntent
    )
}

func pngData(_ cgImage: CGImage) -> Data? {
    let rep = NSBitmapImageRep(cgImage: cgImage)
    return rep.representation(using: .png, properties: [:])
}

// ==============================================================================
// ICO 生成（16/32/48/64/128 は 32bit BMP + AND マスク、256 は PNG）
// ==============================================================================
func appendLE(_ value: UInt16, to data: inout Data) {
    data.append(UInt8(value & 0xff))
    data.append(UInt8((value >> 8) & 0xff))
}

func appendLE(_ value: UInt32, to data: inout Data) {
    data.append(UInt8(value & 0xff))
    data.append(UInt8((value >> 8) & 0xff))
    data.append(UInt8((value >> 16) & 0xff))
    data.append(UInt8((value >> 24) & 0xff))
}

func bmpEntry(width: Int, height: Int, rgba: [UInt8]) -> Data {
    var d = Data()
    // BITMAPINFOHEADER（biHeight は XOR + AND の 2 倍）
    appendLE(UInt32(40), to: &d)                 // biSize
    appendLE(UInt32(width), to: &d)              // biWidth
    appendLE(UInt32(height * 2), to: &d)         // biHeight
    appendLE(UInt16(1), to: &d)                  // biPlanes
    appendLE(UInt16(32), to: &d)                 // biBitCount
    appendLE(UInt32(0), to: &d)                  // biCompression = BI_RGB
    appendLE(UInt32(width * height * 4), to: &d) // biSizeImage
    appendLE(UInt32(2835), to: &d)               // biXPelsPerMeter
    appendLE(UInt32(2835), to: &d)               // biYPelsPerMeter
    appendLE(UInt32(0), to: &d)                  // biClrUsed
    appendLE(UInt32(0), to: &d)                  // biClrImportant
    // XOR ビットマップ（下端からの行順・BGRA）
    for y in stride(from: height - 1, through: 0, by: -1) {
        for x in 0..<width {
            let i = (y * width + x) * 4
            d.append(rgba[i + 2])
            d.append(rgba[i + 1])
            d.append(rgba[i])
            d.append(rgba[i + 3])
        }
    }
    // AND マスク（1 bit per pixel、行は 32bit 境界に padding、1 = 透明）
    let maskRowBytes = ((width + 31) / 32) * 4
    for y in stride(from: height - 1, through: 0, by: -1) {
        var row = [UInt8](repeating: 0, count: maskRowBytes)
        for x in 0..<width {
            if rgba[(y * width + x) * 4 + 3] < 128 {
                row[x / 8] |= UInt8(0x80 >> (x % 8))
            }
        }
        d.append(contentsOf: row)
    }
    return d
}

func buildICO(entries: [(size: Int, payload: Data)]) -> Data {
    var d = Data()
    appendLE(UInt16(0), to: &d) // reserved
    appendLE(UInt16(1), to: &d) // type = icon
    appendLE(UInt16(entries.count), to: &d)
    var offset = 6 + entries.count * 16
    for entry in entries {
        let dim = entry.size >= 256 ? 0 : UInt8(entry.size)
        d.append(dim) // bWidth
        d.append(dim) // bHeight
        d.append(0)   // bColorCount
        d.append(0)   // bReserved
        appendLE(UInt16(1), to: &d)               // wPlanes
        appendLE(UInt16(32), to: &d)              // wBitCount
        appendLE(UInt32(entry.payload.count), to: &d)
        appendLE(UInt32(offset), to: &d)
        offset += entry.payload.count
    }
    for entry in entries {
        d.append(entry.payload)
    }
    return d
}

// ==============================================================================
// 共通: サイズ指定でマスク付き図柄を書き出す
// ==============================================================================
print("\n🎨 Rendering artwork with rounded mask (\(masterSize)x\(masterSize))...")
guard let master = renderMasked(size: masterSize) else {
    print("❌ Failed to render masked artwork")
    exit(1)
}

func pngEntry(size: Int) -> Data? {
    let pixels = straightRGBA(areaResize(master.rgba, from: masterSize, to: size))
    guard let cg = cgImage(from: pixels, size: size) else { return nil }
    return pngData(cg)
}

func bmpICOEntry(size: Int) -> Data {
    let pixels = straightRGBA(areaResize(master.rgba, from: masterSize, to: size))
    return bmpEntry(width: size, height: size, rgba: pixels)
}

func save(_ data: Data, _ relPath: String) throws {
    let url = repoRoot.appendingPathComponent(relPath)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url)
    print("  ✓ Saved \(url.path)")
}

// ==============================================================================
// 1. apps/tauri/icons/ (Tauri desktop / Windows 用)
// ==============================================================================
if targets.contains("tauri") {
    print("\n🖥 [1/3] apps/tauri/icons/icon.png (512x512) + icon.ico (16/32/48/64/128/256)...")
    let icon512 = straightRGBA(areaResize(master.rgba, from: masterSize, to: 512))
    guard let icon512Cg = cgImage(from: icon512, size: 512),
          let icon512Png = pngData(icon512Cg) else {
        print("❌ Failed to encode icon.png")
        exit(1)
    }
    try save(icon512Png, "apps/tauri/icons/icon.png")

    var entries: [(size: Int, payload: Data)] = []
    for size in [16, 32, 48, 64, 128, 256] {
        let payload: Data
        if size == 256 {
            guard let png = pngEntry(size: size) else {
                print("❌ Failed to encode \(size)x\(size) PNG entry")
                exit(1)
            }
            payload = png
        } else {
            payload = bmpICOEntry(size: size)
        }
        entries.append((size, payload))
    }
    try save(buildICO(entries: entries), "apps/tauri/icons/icon.ico")
}

// ==============================================================================
// 2. apps/tauri/icons/ (macOS 用)
//    既存 AppIcon.icns と同じ構成（ic04/ic05 は ARGB、他は PNG、info 付き）にする
//    ため、10 スロットの iconset を作って iconutil に渡す。
// ==============================================================================
if targets.contains("macos") {
    print("\n🍎 [2/3] apps/tauri/icons/AppIcon.icns (16..1024)...")
    let icnsURL = repoRoot.appendingPathComponent("apps/tauri/icons/AppIcon.icns")
    try FileManager.default.createDirectory(at: icnsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let iconsetURL = icnsURL.deletingLastPathComponent()
        .appendingPathComponent("Ponlet-\(UUID().uuidString).iconset")
    try FileManager.default.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

    // (iconset 内のファイル名, 実寸)。同じ実寸のスロットは同じ PNG を使う
    // （既存 icns でも ic08 と ic13、ic09 と ic14 が同一 payload だった）。
    let iconsetFiles: [(name: String, size: Int)] = [
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
    var pngCache: [Int: Data] = [:]
    for item in iconsetFiles {
        if pngCache[item.size] == nil {
            guard let png = pngEntry(size: item.size) else {
                print("❌ Failed to encode \(item.size)x\(item.size)")
                exit(1)
            }
            pngCache[item.size] = png
        }
        try pngCache[item.size]!.write(to: iconsetURL.appendingPathComponent(item.name))
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
    process.arguments = ["-c", "icns", iconsetURL.path, "-o", icnsURL.path]
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        try? FileManager.default.removeItem(at: iconsetURL)
        print("❌ iconutil failed with status \(process.terminationStatus)")
        exit(1)
    }
    try? FileManager.default.removeItem(at: iconsetURL)
    print("  ✓ Saved \(icnsURL.path) (iconutil, 10 slots)")
}

// ==============================================================================
// 3. dist/ (Web 用 favicon 類)
//    favicon.ico は 16/32/48 の複数サイズ ICO（32px は BMP + AND マスク）。
// ==============================================================================
if targets.contains("web") {
    print("\n🌐 [3/3] dist/ web favicons (32 / 180 / ico 16+32+48)...")
    guard let favicon32 = pngEntry(size: 32) else {
        print("❌ Failed to encode favicon.png")
        exit(1)
    }
    try save(favicon32, "dist/favicon.png")

    guard let appleTouch180 = pngEntry(size: 180) else {
        print("❌ Failed to encode apple-touch-icon.png")
        exit(1)
    }
    try save(appleTouch180, "dist/apple-touch-icon.png")

    var entries: [(size: Int, payload: Data)] = []
    for size in [16, 32, 48] {
        entries.append((size, bmpICOEntry(size: size)))
    }
    try save(buildICO(entries: entries), "dist/favicon.ico")

}

print("\n🎉 Application icons regenerated from the double-ring artwork. (targets: \(targets.sorted().joined(separator: ", ")))")

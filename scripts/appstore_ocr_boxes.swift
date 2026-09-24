#!/usr/bin/env swift
// Prints recognized text lines of a PNG with full bounding boxes and tap
// centers, in both normalized and pixel coordinates.
// Usage: appstore_ocr_boxes.swift <image> <image-width-px> <image-height-px> [min-confidence]
// Tap targets are the pixel centers of each text box, so a tap lands on the
// label inside its button or field. Used to verify and drive App Store
// screenshot captures without relying on image preview.

import AppKit
import Vision

let arguments = CommandLine.arguments
guard arguments.count > 3 else {
    FileHandle.standardError.write("usage: appstore_ocr_boxes.swift <image> <width> <height> [min-confidence]\n".data(using: .utf8)!)
    exit(2)
}
let path = arguments[1]
let pixelWidth = Double(arguments[2]) ?? 0
let pixelHeight = Double(arguments[3]) ?? 0
let minConfidence = arguments.count > 4 ? Double(arguments[4]) ?? 0.0 : 0.0

guard let image = NSImage(contentsOfFile: path),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    FileHandle.standardError.write("cannot load \(path)\n".data(using: .utf8)!)
    exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["ja-JP", "en-US"]
request.usesLanguageCorrection = false

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try handler.perform([request])

struct Line {
    let y: CGFloat
    let x: CGFloat
    let w: CGFloat
    let h: CGFloat
    let text: String
}
var lines: [Line] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first,
          Double(candidate.confidence) >= minConfidence else { continue }
    let box = observation.boundingBox
    lines.append(Line(y: 1.0 - box.origin.y - box.height, x: box.origin.x, w: box.width, h: box.height, text: candidate.string))
}
lines.sort {
    if abs($0.y - $1.y) > 0.01 { return $0.y < $1.y }
    return $0.x < $1.x
}
for line in lines {
    let centerX = (line.x + line.w / 2) * pixelWidth
    let centerY = (line.y + line.h / 2) * pixelHeight
    print(String(
        format: "center_px=(%.0f,%.0f) box_px=(%.0f,%.0f,%.0f,%.0f)  %@",
        centerX, centerY,
        line.x * pixelWidth, line.y * pixelHeight, line.w * pixelWidth, line.h * pixelHeight,
        line.text
    ))
}

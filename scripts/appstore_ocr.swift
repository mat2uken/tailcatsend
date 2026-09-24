#!/usr/bin/env swift
// Prints recognized text lines of a PNG top-to-bottom with rough positions.
// Usage: appstore_ocr.swift <image> [min-confidence]
// Used to verify App Store screenshot content without relying on image preview.

import AppKit
import Vision

let arguments = CommandLine.arguments
guard arguments.count > 1 else {
    FileHandle.standardError.write("usage: appstore_ocr.swift <image> [min-confidence]\n".data(using: .utf8)!)
    exit(2)
}
let path = arguments[1]
let minConfidence = arguments.count > 2 ? Double(arguments[2]) ?? 0.0 : 0.0

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
    let text: String
}
var lines: [Line] = []
for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first,
          Double(candidate.confidence) >= minConfidence else { continue }
    let box = observation.boundingBox
    lines.append(Line(y: 1.0 - box.origin.y - box.height, x: box.origin.x, text: candidate.string))
}
lines.sort {
    if abs($0.y - $1.y) > 0.01 { return $0.y < $1.y }
    return $0.x < $1.x
}
for line in lines {
    print(String(format: "y=%.3f x=%.3f  %@", line.y, line.x, line.text))
}

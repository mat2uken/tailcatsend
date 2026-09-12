// swift-tools-version:5.9
import PackageDescription
let package = Package(
    name: "tauri-plugin-ponlet-platform",
    platforms: [.iOS(.v17), .macOS(.v10_15)],
    products: [.library(name: "tauri-plugin-ponlet-platform", type: .static, targets: ["tauri-plugin-ponlet-platform"])],
    dependencies: [
        .package(name: "Tauri", path: "../.tauri/tauri-api"),
        .package(url: "https://github.com/firebase/firebase-ios-sdk", exact: "12.19.1")
    ],
    targets: [.target(name: "tauri-plugin-ponlet-platform", dependencies: [
        .byName(name: "Tauri"),
        .product(name: "FirebaseAnalytics", package: "firebase-ios-sdk"),
        .product(name: "FirebaseCrashlytics", package: "firebase-ios-sdk"),
        .product(name: "FirebaseRemoteConfig", package: "firebase-ios-sdk")
    ], path: "Sources")]
)

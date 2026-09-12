fn main() {
    tauri_build::build();

    // The Go bridge is linked once by the native shell. CI and release
    // scripts set PONLET_TAILCAT_LIB_DIR when they build a fresh archive.
    // Keep the same generated location as the native build script when Cargo
    // is invoked directly, rather than silently selecting a stale archive in
    // the repository root.
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest.join("../..");
    let target = std::env::var("TARGET").unwrap_or_default();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        stage_swift_products(&manifest, &target);
    }
    let target_default = match target.as_str() {
        "aarch64-apple-ios" => Some(repo.join("target/native/tailcat/ios")),
        "aarch64-apple-ios-sim" => Some(repo.join("target/native/tailcat/ios-sim")),
        "aarch64-linux-android" => Some(repo.join("target/native/tailcat/android")),
        _ => Some(repo.join("target/native/tailcat")),
    };
    let lib_dir = std::env::var_os("PONLET_TAILCAT_LIB_DIR")
        .map(std::path::PathBuf::from)
        .or(target_default)
        .expect("native Tailcat library directory must be configured");
    let lib_name = std::env::var("PONLET_TAILCAT_LIB_NAME").unwrap_or_else(|_| "tailcat".into());
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib={lib_name}");
    println!("cargo:rerun-if-env-changed=PONLET_TAILCAT_LIB_DIR");
    println!("cargo:rerun-if-env-changed=PONLET_TAILCAT_LIB_NAME");
    println!("cargo:rerun-if-env-changed=TARGET");

    // `build.rs` itself runs for the host, so a compile-time `cfg(target_os)`
    // would report macOS even when Cargo is building the mobile target. Read
    // Cargo's target setting instead and keep these desktop-only frameworks
    // out of Android and iOS artifacts.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        for framework in ["Security", "CoreFoundation"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}

fn stage_swift_products(manifest: &std::path::Path, target: &str) {
    let products = std::path::PathBuf::from(
        std::env::var_os("DEP_TAURI_PLUGIN_PONLET_PLATFORM_SWIFT_PRODUCTS_PATH")
            .expect("Ponlet's Swift package must expose its selected products"),
    );
    let platform = if target == "aarch64-apple-ios" {
        "iphoneos"
    } else {
        "iphonesimulator"
    };
    let profile = std::env::var("PROFILE").unwrap();
    let destination = manifest
        .join("gen/apple/.swift-products")
        .join(platform)
        .join(profile);
    if destination.exists() {
        std::fs::remove_dir_all(&destination).expect("clear previous Swift products");
    }
    std::fs::create_dir_all(&destination).expect("create Swift products directory");
    let names = std::env::var("DEP_TAURI_PLUGIN_PONLET_PLATFORM_SWIFT_PRODUCT_NAMES")
        .expect("Ponlet's Swift package must expose its selected product names");
    for name in names.split(';').filter(|name| !name.is_empty()) {
        assert!(!name.contains('/') && !name.contains('\\') && !name.contains(".."));
        let source = products.join(name);
        assert!(
            source.is_dir(),
            "missing selected product {}",
            source.display()
        );
        let status = std::process::Command::new("ditto")
            .arg(&source)
            .arg(destination.join(name))
            .status()
            .expect("stage selected Swift product");
        assert!(status.success(), "failed to stage {}", source.display());
    }
    assert!(destination.join("FirebaseAnalytics.framework").is_dir());
    println!("cargo:rerun-if-changed={}", products.display());
    println!("cargo:rerun-if-changed={}", destination.display());
    println!("cargo:rerun-if-env-changed=DEP_TAURI_PLUGIN_PONLET_PLATFORM_SWIFT_PRODUCTS_PATH");
    println!("cargo:rerun-if-env-changed=DEP_TAURI_PLUGIN_PONLET_PLATFORM_SWIFT_PRODUCT_NAMES");
}

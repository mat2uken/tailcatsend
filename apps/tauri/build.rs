fn main() {
    tauri_build::build();

    // The Go bridge is linked once by the native shell.  CI and release
    // scripts set PONLET_TAILCAT_LIB_DIR when they build a fresh archive;
    // local macOS checkouts may use the repository archive produced by the
    // existing native build script.
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest.join("../..");
    let target = std::env::var("TARGET").unwrap_or_default();
    let target_default = match target.as_str() {
        "aarch64-apple-ios" => Some(repo.join("target/native/tailcat/ios")),
        "aarch64-apple-ios-sim" => Some(repo.join("target/native/tailcat/ios-sim")),
        "aarch64-linux-android" => Some(repo.join("target/native/tailcat/android")),
        _ => None,
    };
    let lib_dir = std::env::var_os("PONLET_TAILCAT_LIB_DIR")
        .map(std::path::PathBuf::from)
        .or(target_default)
        .unwrap_or_else(|| repo.clone());
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

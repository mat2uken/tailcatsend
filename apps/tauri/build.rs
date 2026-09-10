fn main() {
    tauri_build::build();

    // The Go bridge is linked once by the native shell.  CI and release
    // scripts set PONLET_TAILCAT_LIB_DIR when they build a fresh archive;
    // local macOS checkouts may use the repository archive produced by the
    // existing native build script.
    let manifest = std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest.join("../..");
    let lib_dir = std::env::var_os("PONLET_TAILCAT_LIB_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| repo.clone());
    let lib_name = std::env::var("PONLET_TAILCAT_LIB_NAME").unwrap_or_else(|_| "tailcat".into());
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib={lib_name}");
    println!("cargo:rerun-if-env-changed=PONLET_TAILCAT_LIB_DIR");
    println!("cargo:rerun-if-env-changed=PONLET_TAILCAT_LIB_NAME");

    #[cfg(target_os = "macos")]
    {
        for framework in ["Security", "CoreFoundation"] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
    }
}

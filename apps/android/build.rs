fn main() {
    slint_build::compile("../../ui/app-window.slint").expect("Slint build failed");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let target_dir = std::path::Path::new(&manifest_dir).join("../../target");
    println!("cargo:rustc-link-search=native={}", target_dir.display());
    println!("cargo:rustc-link-lib=dylib=tailcat_android");
}

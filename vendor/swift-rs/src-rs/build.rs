#![allow(dead_code)]
use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    fmt::Display,
    path::Path,
    path::PathBuf,
    process::Command,
};

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwiftTarget {
    triple: String,
    unversioned_triple: String,
    module_triple: String,
    //pub swift_runtime_compatibility_version: String,
    #[serde(rename = "librariesRequireRPath")]
    libraries_require_rpath: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwiftPaths {
    runtime_library_paths: Vec<String>,
    runtime_library_import_paths: Vec<String>,
    runtime_resource_path: String,
}

#[derive(Deserialize)]
struct SwiftEnv {
    target: SwiftTarget,
    paths: SwiftPaths,
}

impl SwiftEnv {
    fn new(
        minimum_macos_version: &str,
        minimum_ios_version: Option<&str>,
        minimum_visionos_version: Option<&str>,
    ) -> Self {
        let rust_target = RustTarget::from_env();
        let target = rust_target.swift_target_triple(
            minimum_macos_version,
            minimum_ios_version,
            minimum_visionos_version,
        );

        let swift_target_info_str = Command::new("swift")
            .args(["-target", &target, "-print-target-info"])
            .output()
            .unwrap()
            .stdout;

        serde_json::from_slice(&swift_target_info_str).unwrap()
    }
}

#[allow(clippy::upper_case_acronyms)]
enum RustTargetOS {
    MacOS,
    IOS,
    VisionOS,
}

impl RustTargetOS {
    fn from_env() -> Self {
        match env::var("CARGO_CFG_TARGET_OS").unwrap().as_str() {
            "macos" => RustTargetOS::MacOS,
            "ios" => RustTargetOS::IOS,
            "visionos" => RustTargetOS::VisionOS,
            _ => panic!("unexpected target operating system"),
        }
    }

    fn to_swift(&self) -> &'static str {
        match self {
            Self::MacOS => "macosx",
            Self::IOS => "ios",
            Self::VisionOS => "xros",
        }
    }
}

impl Display for RustTargetOS {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MacOS => write!(f, "macos"),
            Self::IOS => write!(f, "ios"),
            Self::VisionOS => write!(f, "visionos"),
        }
    }
}

#[allow(clippy::upper_case_acronyms)]
enum SwiftSDK {
    MacOS,
    IOS,
    IOSSimulator,
    VisionOS,
    VisionOSSimulator,
}

impl SwiftSDK {
    fn from_os(os: &RustTargetOS) -> Self {
        let target = env::var("TARGET").unwrap();
        let simulator = target.ends_with("ios-sim")
            || target.ends_with("visionos-sim")
            || (target.starts_with("x86_64") && target.ends_with("ios"));

        match os {
            RustTargetOS::MacOS => Self::MacOS,
            RustTargetOS::IOS if simulator => Self::IOSSimulator,
            RustTargetOS::IOS => Self::IOS,
            RustTargetOS::VisionOS if simulator => Self::VisionOSSimulator,
            RustTargetOS::VisionOS => Self::VisionOS,
        }
    }

    fn clang_lib_extension(&self) -> &'static str {
        match self {
            Self::MacOS => "osx",
            Self::IOS => "ios",
            Self::IOSSimulator => "iossim",
            Self::VisionOS => "xros",
            Self::VisionOSSimulator => "xrsimulator",
        }
    }
}

impl Display for SwiftSDK {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MacOS => write!(f, "macosx"),
            Self::IOSSimulator => write!(f, "iphonesimulator"),
            Self::IOS => write!(f, "iphoneos"),
            Self::VisionOSSimulator => write!(f, "xrsimulator"),
            Self::VisionOS => write!(f, "xros"),
        }
    }
}

struct RustTarget {
    arch: String,
    os: RustTargetOS,
    sdk: SwiftSDK,
}

impl RustTarget {
    fn from_env() -> Self {
        let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap();
        let os = RustTargetOS::from_env();
        let sdk = SwiftSDK::from_os(&os);

        Self { arch, os, sdk }
    }

    fn swift_target_triple(
        &self,
        minimum_macos_version: &str,
        minimum_ios_version: Option<&str>,
        minimum_visionos_version: Option<&str>,
    ) -> String {
        let unversioned = self.unversioned_swift_target_triple();
        format!(
            "{unversioned}{}{}",
            match &self.os {
                RustTargetOS::MacOS => minimum_macos_version,
                RustTargetOS::IOS => minimum_ios_version.unwrap(),
                RustTargetOS::VisionOS => minimum_visionos_version.unwrap(),
            },
            // simulator suffix
            matches!(
                self.sdk,
                SwiftSDK::IOSSimulator | SwiftSDK::VisionOSSimulator
            )
            .then(|| "-simulator".to_string())
            .unwrap_or_default()
        )
    }

    fn unversioned_swift_target_triple(&self) -> String {
        format!(
            "{}-apple-{}",
            match self.arch.as_str() {
                "aarch64" => "arm64",
                a => a,
            },
            self.os.to_swift(),
        )
    }
}

struct SwiftPackage {
    name: String,
    path: PathBuf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwiftBuildDescription {
    swift_commands: BTreeMap<String, SwiftBuildCommand>,
    target_dependency_map: BTreeMap<String, Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SwiftBuildCommand {
    module_name: String,
    objects: Vec<PathBuf>,
}

impl SwiftBuildDescription {
    fn read(products: &Path) -> Self {
        let path = products.join("description.json");
        let bytes = std::fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "Cannot safely select Swift plugin inputs without {}: {error}. \
                 This SwiftPM product layout is not supported",
                path.display()
            )
        });
        serde_json::from_slice(&bytes)
            .unwrap_or_else(|error| panic!("Invalid {}: {error}", path.display()))
    }

    fn selected_targets(&self, package: &str) -> BTreeSet<String> {
        let module = package.replace('-', "_");
        let dependencies = self
            .target_dependency_map
            .get(&module)
            .unwrap_or_else(|| panic!("SwiftPM description has no dependency list for {module}"));
        let mut selected: BTreeSet<_> = dependencies.iter().cloned().collect();
        selected.insert(module);
        selected
    }

    fn product_names(&self, products: &Path, package: &str) -> Vec<String> {
        let selected = self.selected_targets(package);
        let mut names = Vec::new();
        for entry in std::fs::read_dir(products).expect("Cannot read Swift products") {
            let path = entry.expect("Cannot read Swift product entry").path();
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let target = match path.extension().and_then(|ext| ext.to_str()) {
                Some("framework") => stem.to_owned(),
                Some("bundle") => {
                    let Some((_, target)) = stem.split_once('_') else {
                        continue;
                    };
                    target.replace('-', "_")
                }
                _ => continue,
            };
            if !selected.contains(&target) {
                continue;
            }
            assert!(
                path.is_dir(),
                "Swift product is not a directory: {}",
                path.display()
            );
            let name = path.file_name().unwrap().to_str().unwrap();
            assert!(
                !name.contains(['/', '\\', ';', '\n', '\r']),
                "Invalid Swift product filename: {name:?}"
            );
            names.push(name.to_owned());
        }
        names.sort();
        names
    }

    /// SwiftPM includes Tauri and SwiftRs in each plugin's static product.
    /// The base Tauri crate already links them; -ObjC would load every copy.
    /// Rebuild only the link-time copy from exact object paths, since Tauri
    /// and FirebaseSessions both contain a member named Logger.swift.o.
    fn plugin_link_archive(&self, products: &Path, package: &str) -> PathBuf {
        let selected = self.selected_targets(package);
        let mut shared = BTreeSet::new();
        for module in ["Tauri", "SwiftRs"] {
            assert!(
                selected.contains(module),
                "{package} does not depend on {module}"
            );
            let commands: Vec<_> = self
                .swift_commands
                .values()
                .filter(|command| command.module_name == module)
                .collect();
            assert_eq!(
                commands.len(),
                1,
                "Expected one SwiftPM command for {module}"
            );
            assert!(
                !commands[0].objects.is_empty(),
                "No Swift objects for {module}"
            );
            for object in &commands[0].objects {
                assert!(
                    shared.insert(object.clone()),
                    "Duplicate shared Swift object: {}",
                    object.display()
                );
            }
        }

        let file_list = products
            .join(format!("{package}.product"))
            .join("Objects.LinkFileList");
        let contents = std::fs::read_to_string(&file_list)
            .unwrap_or_else(|error| panic!("Cannot read {}: {error}", file_list.display()));
        let mut retained = Vec::new();
        let mut excluded = BTreeSet::new();
        let mut inputs = BTreeSet::new();
        let canonical_products = products.canonicalize().unwrap();
        for line in contents.lines() {
            assert!(
                !line.is_empty(),
                "Empty Swift object path in {}",
                file_list.display()
            );
            let object = PathBuf::from(line);
            assert!(
                object.is_absolute()
                    && object.extension().is_some_and(|ext| ext == "o")
                    && object.is_file(),
                "Expected an existing SwiftPM object, got {}",
                object.display()
            );
            assert!(
                object
                    .canonicalize()
                    .unwrap()
                    .starts_with(&canonical_products),
                "Swift object is outside the selected products: {}",
                object.display()
            );
            assert!(
                inputs.insert(object.clone()),
                "Duplicate Swift object input: {}",
                object.display()
            );
            if shared.contains(&object) {
                excluded.insert(object);
            } else {
                retained.push(line);
            }
        }
        assert_eq!(
            excluded, shared,
            "The plugin archive must contain every shared Swift object exactly once"
        );
        assert!(
            !retained.is_empty(),
            "No plugin objects remain for {package}"
        );

        let link_dir = PathBuf::from(env::var_os("OUT_DIR").unwrap())
            .join("ponlet-link")
            .join(package);
        std::fs::create_dir_all(&link_dir).unwrap();
        // ld/dsymutil identify archive members by filename and timestamp.
        // Keep every plugin member unique, including same-named Firebase
        // objects and members later merged into the app's static library.
        let objects_dir = link_dir.join("objects");
        if objects_dir.exists() {
            std::fs::remove_dir_all(&objects_dir).unwrap();
        }
        std::fs::create_dir_all(&objects_dir).unwrap();
        let mut member_names = BTreeSet::new();
        let mut link_inputs = Vec::new();
        for source in &retained {
            let source_path = Path::new(source);
            let canonical_source = source_path.canonicalize().unwrap();
            let relative = canonical_source.strip_prefix(&canonical_products).unwrap();
            let suffix = relative
                .components()
                .map(|component| component.as_os_str().to_str().unwrap())
                .collect::<Vec<_>>()
                .join("__");
            let member = format!("{package}__{suffix}");
            assert!(
                member_names.insert(member.to_lowercase()),
                "Swift archive member name collision: {member}"
            );
            let destination = objects_dir.join(member);
            std::fs::copy(source_path, &destination).unwrap_or_else(|error| {
                panic!(
                    "Cannot stage Swift object {}: {error}",
                    destination.display()
                )
            });
            link_inputs.push(destination.to_str().unwrap().to_owned());
        }
        let filtered_list = link_dir.join("Objects.LinkFileList");
        std::fs::write(&filtered_list, format!("{}\n", link_inputs.join("\n"))).unwrap();
        let archive = link_dir.join(format!("lib{package}.a"));
        let temporary_archive = link_dir.join(format!("lib{package}.pending.a"));
        if temporary_archive.exists() {
            std::fs::remove_file(&temporary_archive).unwrap();
        }
        let status = Command::new("xcrun")
            .args(["libtool", "-static", "-o"])
            .arg(&temporary_archive)
            .arg("-filelist")
            .arg(&filtered_list)
            .status()
            .expect("Cannot run libtool for the Swift plugin archive");
        assert!(
            status.success(),
            "Cannot create filtered Swift archive for {package}"
        );
        let status = Command::new("xcrun")
            .arg("ranlib")
            .arg(&temporary_archive)
            .status()
            .expect("Cannot index the Swift plugin archive");
        assert!(
            status.success(),
            "Cannot index filtered Swift archive for {package}"
        );
        std::fs::rename(&temporary_archive, &archive).unwrap();
        println!(
            "cargo:warning=swift-rs: excluded {} shared Tauri/SwiftRs objects from {package}'s link archive",
            excluded.len()
        );
        link_dir
    }
}

/// Builder for linking the Swift runtime and custom packages.
#[cfg(feature = "build")]
pub struct SwiftLinker {
    packages: Vec<SwiftPackage>,
    macos_min_version: String,
    ios_min_version: Option<String>,
    visionos_min_version: Option<String>,
}

impl SwiftLinker {
    /// Creates a new [`SwiftLinker`] with a minimum macOS verison.
    ///
    /// Minimum macOS version must be at least 10.13.
    pub fn new(macos_min_version: &str) -> Self {
        Self {
            packages: vec![],
            macos_min_version: macos_min_version.to_string(),
            ios_min_version: None,
            visionos_min_version: None,
        }
    }

    /// Instructs the [`SwiftLinker`] to also compile for iOS
    /// using the specified minimum iOS version.
    ///
    /// Minimum iOS version must be at least 11.
    pub fn with_ios(mut self, min_version: &str) -> Self {
        self.ios_min_version = Some(min_version.to_string());
        self
    }

    /// Instructs the [`SwiftLinker`] to also compile for visionOS
    /// using the specified minimum visionOS version.
    ///
    /// Minimum visionOS version must be at least 11.
    pub fn with_visionos(mut self, min_version: &str) -> Self {
        self.visionos_min_version = Some(min_version.to_string());
        self
    }

    /// Adds a package to be linked against.
    /// `name` should match the `name` field in your `Package.swift`,
    /// and `path` should point to the root of your Swift package relative
    /// to your crate's root.
    pub fn with_package(mut self, name: &str, path: impl AsRef<Path>) -> Self {
        self.packages.extend([SwiftPackage {
            name: name.to_string(),
            path: path.as_ref().into(),
        }]);

        self
    }

    /// Links the Swift runtime, then builds and links the provided packages.
    /// This does not (yet) automatically rebuild your Swift files when they are modified,
    /// you'll need to modify/save your `build.rs` file for that.
    pub fn link(self) {
        let swift_env = SwiftEnv::new(
            &self.macos_min_version,
            self.ios_min_version.as_deref(),
            self.visionos_min_version.as_deref(),
        );

        #[allow(clippy::uninlined_format_args)]
        for path in swift_env.paths.runtime_library_paths {
            println!("cargo:rustc-link-search=native={path}");
        }

        let debug = env::var("DEBUG").unwrap() == "true";
        let configuration = if debug { "debug" } else { "release" };
        let rust_target = RustTarget::from_env();

        link_clang_rt(&rust_target);

        for package in self.packages {
            let package_path =
                Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join(&package.path);
            let out_path = Path::new(&env::var("OUT_DIR").unwrap())
                .join("swift-rs")
                .join(&package.name);

            let sdk_path_output = Command::new("xcrun")
                .args(["--sdk", &rust_target.sdk.to_string(), "--show-sdk-path"])
                .output()
                .unwrap();
            if !sdk_path_output.status.success() {
                panic!(
                    "Failed to get SDK path with `xcrun --sdk {} --show-sdk-path`",
                    rust_target.sdk
                );
            }

            let sdk_path = String::from_utf8_lossy(&sdk_path_output.stdout);

            let mut command = Command::new("swift");
            command.current_dir(&package.path);

            let arch = match std::env::consts::ARCH {
                "aarch64" => "arm64",
                arch => arch,
            };

            let mut swift_target_triple = rust_target.swift_target_triple(
                &self.macos_min_version,
                self.ios_min_version.as_deref(),
                self.visionos_min_version.as_deref(),
            );

            // SwiftPM must select binary XCFramework slices for the destination,
            // including on Xcode 26. Compiler-only -target flags still make its
            // package planner choose macOS frameworks for an iOS build.
            let xcode27 = xcode_major_version().map(|v| v >= 27).unwrap_or(false);
            let cross_compiling = !matches!(rust_target.os, RustTargetOS::MacOS);
            let use_triple = cross_compiling;

            // Xcode 27 SDKs reject iOS deployment targets below 15
            // ("supported deployment target versions is 15.0 to 27.0.x") and
            // consumers commonly pass lower minimums (tauri passes ios13.0).
            if xcode27 {
                clamp_ios_deployment_target(&mut swift_target_triple, 15);
            }

            command
                // Build the package (duh)
                .arg("build")
                // SDK path for regular compilation (idk)
                .args(["--sdk", sdk_path.trim()])
                // Release/Debug configuration
                .args(["-c", configuration]);

            if use_triple {
                command.args(["--triple", &swift_target_triple]);
            } else {
                command.args(["--arch", arch]);
            }

            // Where the artifacts will be generated to
            command.args(["--build-path", &out_path.display().to_string()]);

            if !use_triple {
                // Override the SDK and target on each swiftc instance.
                command
                    .args(["-Xswiftc", "-sdk"])
                    .args(["-Xswiftc", sdk_path.trim()])
                    .args(["-Xswiftc", "-target"])
                    .args(["-Xswiftc", &swift_target_triple]);
            }

            command
                .args(["-Xcc", &format!("--target={swift_target_triple}")])
                .args(["-Xcxx", &format!("--target={swift_target_triple}")]);

            println!("Command `{command:?}`");

            if !command.status().unwrap().success() {
                panic!("Failed to compile swift package {}", package.name);
            }

            let search_path = if use_triple && !xcode27 {
                // Cross-compilation changes SwiftPM's output directory too.
                // Ask the same configured build command for its product path.
                let output = command.arg("--show-bin-path").output().unwrap();
                assert!(output.status.success(), "Failed to locate Swift products");
                let path = PathBuf::from(String::from_utf8(output.stdout).unwrap().trim());
                assert!(
                    path.join(format!("lib{}.a", package.name)).is_file(),
                    "Swift static library is missing from {}",
                    path.display()
                );
                path
            } else if xcode27 {
                // Xcode 27 SwiftPM layouts vary by beta. Trust no path unless it
                // actually CONTAINS the archive: the legacy `<configuration>` dir
                // can exist yet be empty, while the real products live under
                // [out/]Products/<Configuration>-<platform>
                // (e.g. out/Products/Release-iphoneos on 27A5218g).
                let lib_file = format!("lib{}.a", package.name);
                let direct = out_path.join(configuration);
                if direct.join(&lib_file).exists() {
                    direct
                } else {
                    xcode27_products_dir(&out_path, configuration, &lib_file).unwrap_or(direct)
                }
            } else {
                out_path
                    .join(format!("{}-apple-macosx", arch))
                    .join(configuration)
            };

            let plugin_description = package
                .name
                .starts_with("tauri-plugin-")
                .then(|| SwiftBuildDescription::read(&search_path));
            let link_path = plugin_description
                .as_ref()
                .map(|description| description.plugin_link_archive(&search_path, &package.name))
                .unwrap_or_else(|| search_path.clone());

            if xcode27 {
                // Xcode 27's SwiftPM internalizes @_cdecl exports in static
                // products (they show as local 't' in nm), so consumers fail to
                // link with "undefined symbols". Promote them back to global.
                globalize_cdecl_symbols(
                    &link_path.join(format!("lib{}.a", package.name)),
                    &package.name,
                );
            }

            println!("cargo:rerun-if-changed={}", package_path.display());
            println!("cargo:rustc-link-search=native={}", link_path.display());
            println!("cargo:rustc-link-lib=static={}", package.name);
            // Binary targets are copied beside the SwiftPM product, but are
            // not included in its static archive. Pass the selected slices to
            // Rust's linker and expose the exact product directory to the
            // consuming app so its final Xcode link uses the same files.
            println!("cargo:swift_products_path={}", search_path.display());
            let product_names = plugin_description
                .as_ref()
                .map(|description| description.product_names(&search_path, &package.name))
                .unwrap_or_default();
            println!("cargo:swift_product_names={}", product_names.join(";"));
            let frameworks: Vec<_> = product_names
                .iter()
                .filter_map(|name| name.strip_suffix(".framework"))
                .collect();
            if !frameworks.is_empty() {
                println!(
                    "cargo:rustc-link-search=framework={}",
                    search_path.display()
                );
            }
            for framework in frameworks {
                println!("cargo:rustc-link-lib=framework={}", framework);
            }
        }
    }
}

fn link_clang_rt(rust_target: &RustTarget) {
    println!(
        "cargo:rustc-link-lib=clang_rt.{}",
        rust_target.sdk.clang_lib_extension()
    );
    println!("cargo:rustc-link-search={}", clang_link_search_path());
}

fn clang_link_search_path() -> String {
    let output = std::process::Command::new(
        std::env::var("SWIFT_RS_CLANG").unwrap_or_else(|_| "/usr/bin/clang".to_string()),
    )
    .arg("--print-search-dirs")
    .output()
    .unwrap();
    if !output.status.success() {
        panic!("Can't get search paths from clang");
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("libraries: =") {
            let path = line.split('=').nth(1).unwrap();
            return format!("{}/lib/darwin", path);
        }
    }
    panic!("clang is missing search paths");
}

/// Major version of the active Xcode (e.g. `27`), or `None` if undetectable.
fn xcode_major_version() -> Option<u32> {
    let output = Command::new("xcrun")
        .args(["xcodebuild", "-version"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    // e.g. "Xcode 27.0"
    let first_line = stdout.lines().next()?;
    let version = first_line.strip_prefix("Xcode ")?.trim();
    version.split('.').next()?.parse().ok()
}

/// Raise the iOS version embedded in a swift target triple (e.g.
/// `arm64-apple-ios13.0[-simulator]`) to `min_major` if it is lower.
/// Xcode 27 SDKs hard-reject deployment targets below iOS 15.
fn clamp_ios_deployment_target(triple: &mut String, min_major: u32) {
    let Some(idx) = triple.find("apple-ios") else {
        return;
    };
    let head_end = idx + "apple-ios".len();
    let rest = &triple[head_end..];
    let (ver, suffix) = match rest.find('-') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let major = ver.split('.').next().and_then(|m| m.parse::<u32>().ok());
    if matches!(major, Some(m) if m > 0 && m < min_major) {
        *triple = format!("{}{}.0{}", &triple[..head_end], min_major, suffix);
    }
}

/// Xcode 27 SwiftPM puts static products under [out/]Products/<Config>-<platform>
/// (e.g. out/Products/Release-iphoneos). Find the dir that really contains the
/// archive, matching the configuration case-insensitively by prefix.
fn xcode27_products_dir(
    out_path: &std::path::Path,
    configuration: &str,
    lib_file: &str,
) -> Option<std::path::PathBuf> {
    for base in [
        out_path.join("Products"),
        out_path.join("out").join("Products"),
    ] {
        let Ok(entries) = std::fs::read_dir(&base) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with(&configuration.to_lowercase())
                && entry.path().join(lib_file).exists()
            {
                return Some(entry.path());
            }
        }
    }
    None
}

/// Xcode 27's SwiftPM internalizes @_cdecl exports in static products (nm shows
/// them as local 't'), so Rust consumers fail to link. Promote them back to
/// global with llvm-objcopy (rustup's llvm-tools component — Apple ships none).
///
/// Guards, each learned from a distinct linker failure:
/// - only symbols from the package's OWN object member (archives embed copies
///   of dependency modules; promoting those in every archive duplicates globals)
/// - only plain C names not starting with '_' (compiler helpers like
///   ___swift_closure_destructor repeat)
/// - only names unique within the archive
/// Violating any of these crashes Xcode 27's ld with "malformed atom files with
/// duplicate names" (AtomSymbolTable.cpp:242) — and -ld_classic is removed.
fn globalize_cdecl_symbols(archive: &std::path::Path, package_name: &str) {
    if !archive.exists() {
        return;
    }
    let Ok(nm) = Command::new("nm").arg(archive).output() else {
        return;
    };
    let norm = |s: &str| {
        s.to_lowercase()
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .collect::<String>()
    };
    let pkg = norm(package_name);
    let mut in_own_member = false;
    let mut candidates: Vec<String> = Vec::new();
    let mut occurrences: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    for line in String::from_utf8_lossy(&nm.stdout).lines() {
        if line.ends_with(':') {
            // Member header — "Tauri.o:" (Xcode 27 nm) or "…/lib.a(Tauri.o):"
            let header = line.trim_end_matches(':').trim_end_matches(')');
            let member = header.rsplit('(').next().unwrap_or(header);
            // Plugin link copies prefix the original basename with their
            // package and relative object directory for unique dSYM members.
            let member = member.rsplit("__").next().unwrap_or(member);
            if let Some(module) = member.strip_suffix(".o") {
                in_own_member = norm(module) == pkg;
                continue;
            }
        }
        let mut it = line.split_whitespace();
        let (Some(_addr), Some(kind), Some(name), None) =
            (it.next(), it.next(), it.next(), it.next())
        else {
            continue;
        };
        *occurrences.entry(name.to_string()).or_insert(0) += 1;
        if !in_own_member || kind != "t" || !name.starts_with('_') {
            continue;
        }
        let bare = &name[1..];
        // A @_cdecl export is a plain C identifier NOT starting with '_'.
        let c_named = !bare.is_empty()
            && !bare.starts_with('_')
            && bare.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !bare.contains("block_copy_helper")
            && !bare.contains("block_destroy_helper");
        if c_named && !candidates.iter().any(|s| s == name) {
            candidates.push(name.to_string());
        }
    }
    let syms: Vec<String> = candidates
        .into_iter()
        .filter(|s| occurrences.get(s).copied().unwrap_or(0) <= 1)
        .collect();
    if syms.is_empty() {
        return;
    }
    let Some(objcopy) = rustup_llvm_objcopy() else {
        println!(
            "cargo:warning=swift-rs: llvm-objcopy not found (run `rustup component add \
             llvm-tools`); @_cdecl symbols stay internalized on Xcode 27"
        );
        return;
    };
    let mut cmd = Command::new(objcopy);
    for s in &syms {
        cmd.arg(format!("--globalize-symbol={s}"));
    }
    cmd.arg(archive);
    let _ = cmd.status();
}

/// llvm-objcopy shipped with rustup's llvm-tools component.
fn rustup_llvm_objcopy() -> Option<std::path::PathBuf> {
    let sysroot = Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
        .ok()?;
    let sysroot = String::from_utf8_lossy(&sysroot.stdout).trim().to_string();
    let host = format!("{}-apple-darwin", std::env::consts::ARCH);
    let p = std::path::Path::new(&sysroot)
        .join("lib/rustlib")
        .join(&host)
        .join("bin/llvm-objcopy");
    p.exists().then_some(p)
}

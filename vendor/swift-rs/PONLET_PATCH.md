# iOS SwiftPM destination selection

Upstream: swift-rs 1.0.8, https://crates.io/crates/swift-rs/1.0.8
Published crate SHA-256: `e45c444e496845d3f2a351146bff59aae4975b2280238df1dfaa0c7d1846f38e`.
The upstream MIT and Apache-2.0 licenses and source are retained.

SwiftPM on Xcode 26 received only compiler-level iOS target flags. Its package
planner consequently selected macOS slices from Firebase XCFrameworks, then
compiled their Cocoa headers with the iOS SDK. Pass `--triple` for every mobile
cross build, and obtain the matching product directory with `--show-bin-path`.
The upstream Xcode 27 product lookup and symbol handling are retained. Plugin
link filtering requires the selected product's SwiftPM `description.json` and
`Objects.LinkFileList`; an unsupported layout fails explicitly rather than
reusing an unrelated product directory.
Cargo's registry and unrelated projects are not modified.

SwiftPM does not fold binary framework dependencies into its static library.
The patch also forwards the plugin's selected framework directory and framework
names to Cargo. It filters immediate frameworks and bundles against the current
plugin module's `targetDependencyMap` entry, including the module itself, so
unused dependencies left in the output directory are not included. Framework
stems match target names directly; bundle stems use SwiftPM's
`Package_Target.bundle` convention, normalizing target hyphens to underscores.
`swift_products_path` metadata remains the original selected products directory;
`swift_product_names` is the sorted, semicolon-separated list of selected
framework/bundle filenames. Ponlet stages only that list for Xcode's final link
and copies the bundles into the app.

With `-ObjC`, linking multiple SwiftPM plugin archives also loads their duplicate
Tauri and SwiftRs definitions. For package names beginning with `tauri-plugin-`,
the patch reads the exact Tauri/SwiftRs object paths from `swiftCommands` and
excludes them from the current product's `Objects.LinkFileList`. Every shared
object must appear exactly once; every input must be an existing object in the
selected products directory. It then uses `xcrun libtool -static -filelist` and
`ranlib` to write a separate `OUT_DIR/ponlet-link/<package>/lib<package>.a` for
Cargo. The current debug build excludes nine objects. This uses full paths
because FirebaseSessions and Tauri both contain `Logger.swift.o`; deleting
archive members by basename would remove the wrong implementation. SwiftPM's
original archive and objects are never altered. The base Tauri package keeps
its original archive, including the shared definitions. Xcode 27 symbol
promotion, if applicable, operates on the filtered plugin copy.

Retained objects are copied byte-for-byte into that link directory's `objects`
subdirectory with deterministic names prefixed by the plugin name and the
object's relative path within the selected products. The generated file list
uses only those copies. Name collisions, including on a case-insensitive
filesystem, fail explicitly. This also distinguishes repeated Firebase accessor
filenames and FirebaseSessions' `Logger.swift.o` from the base Tauri member when
the final app archive is assembled. Without unique member names, `dsymutil`
skips objects with duplicate names and timestamps, omitting their debug
information. Object contents and embedded debug information are unchanged;
the linker records the new archive member names for dSYM generation. Xcode 27
symbol promotion strips this naming prefix before identifying the plugin's
own module member.

# Ponlet barcode scanner cancellation patch

This directory vendors the build inputs of `tauri-plugin-barcode-scanner` **2.4.4**.
The workspace `[patch.crates-io]` selects this copy while preserving the public
plugin name, commands, permissions and crate version.

## Provenance

- Upstream: <https://github.com/tauri-apps/plugins-workspace/tree/50b159f668a5fcf42d6356e2af1dc549632b413d/plugins/barcode-scanner>
- Published crate: <https://crates.io/crates/tauri-plugin-barcode-scanner/2.4.4>
- Original `.crate` SHA-256: `485cbcf227f04117e930be748ea71d835900466dcd1d455d5ec284d36107a305`
- Licenses: `Apache-2.0 OR MIT`; the original `LICENSE_APACHE-2.0`, `LICENSE_MIT`
  and `LICENSE.spdx` files are retained.

Files were extracted from the published crate archive. Rust sources, Cargo
manifest, build script, the global API script, default permissions, Android
build/main sources and iOS package/sources are included. Example applications,
JavaScript development tooling, screenshots, upstream placeholder tests and
build caches are omitted. The plugin build regenerates command permissions and
their schema/documentation. Nothing in the Cargo registry is edited.

## Local changes

Android 2.4.4 created preview views before `ProcessCameraProvider` was ready.
Cancellation removed those views only when the provider was already available,
and its later callback could bind the camera after cancellation. `cancel` also
cleared `savedInvoke` before rejecting it, leaving the scan Promise pending.

`ScanSession.kt` now identifies each scan. Provider, binding and analysis
callbacks check that scan before acting. Scan/cancel and camera state changes
run on the UI thread. Cleanup invalidates callbacks, removes preview/overlay
views even before provider readiness, unbinds the camera and closes ML Kit.
The pending invocation is taken before cleanup and completed exactly once.
No-camera, permission and provider/binding failures now reject the scan.
Image analysis closes `ImageProxy` without also closing its underlying image.

The iOS scanner now serializes scan/cancel state on the main queue. A queued
`startRunning` checks the generation, invocation and captured session before
starting, and metadata callbacks check their output identity. Cleanup removes
partially prepared views as well as completed sessions and takes the pending
invocation before resolving/rejecting it. Camera setup failures no longer reach
force-unwrapped missing sessions. Permissions remain a separate request; a late
permission reply does not start a scan. Ponlet's frontend also rejects stale
permission responses before invoking the native scanner.

`android/src/test/java/ScanSessionTest.kt` covers cancellation before provider
readiness, stale callbacks after another scan starts, and single completion.
Run it through the generated Tauri Android project after regenerating its plugin
paths, so Gradle selects this directory rather than the Cargo registry:

```sh
cd apps/tauri/gen/android
./gradlew :tauri-plugin-barcode-scanner:testDebugUnitTest
```

Physical camera/permission/preview checks on Android and iOS remain separate
from these state tests. When updating the plugin, compare the upstream changes
against these fixes before removing the workspace patch.

# Third-Party Licenses and Attributions

This project incorporates or links to the following third-party software components.

## 1. Tailcat

- **Repository**: [tailscale/tailcat](https://github.com/tailscale/tailcat)
- **License**: BSD 3-Clause License
- **Copyright**: Copyright (c) 2020 Tailscale Inc & contributors.

```
BSD 3-Clause License

Copyright (c) 2020 Tailscale Inc & contributors.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 2. Go standard library and modules

- `tailscale.com`: BSD 3-Clause License (Tailscale Inc.)
- `github.com/tailscale/wireguard-go`: MIT License
- `gvisor.dev/gvisor`: Apache License 2.0

The exact [Tailcat BSD 3-Clause text](https://ponlet.mat2uken.app/licenses/tailcat-LICENSE.txt),
[Go standard library BSD text](https://ponlet.mat2uken.app/licenses/go-stdlib-LICENSE.txt), and
[gVisor license text](https://ponlet.mat2uken.app/licenses/gvisor-LICENSE.txt) are also available with
the public notices. The gVisor file includes additional MIT and BSD terms for
files covered by those terms. The 52 other external modules identified for
the 1.0.14 native bridge have their original root license files in
[Go module notices](https://ponlet.mat2uken.app/licenses/go-modules-NOTICES.txt). This covers the
module-level license files for that dependency graph, not a file-by-file review
of embedded code or every module named in the current `go.mod`. Tailcat has since
been updated; the current Go dependency graph needs a new comparison.

## 3. Rust crates

- `tokio`: MIT License
- `serde` / `serde_json`: MIT / Apache-2.0
- `ciborium`: Apache License 2.0
- `sha2` / `hmac`: MIT / Apache-2.0
- `qrcode`: MIT / Apache-2.0
- `tauri`, `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-opener`,
  `tauri-plugin-barcode-scanner` 2.4.4, `tauri-plugin-clipboard-manager` 2.3.3: MIT / Apache-2.0
- `@tauri-apps/api` 2.11.1: MIT OR Apache-2.0. The installed package's
  [MIT text](https://ponlet.mat2uken.app/licenses/tauri-api-LICENSE-MIT.txt) is reproduced; the
  [Apache-2.0 text](https://ponlet.mat2uken.app/licenses/jsqr-LICENSE.txt) is also available.
- `vanjs-core` 1.6.1: [MIT text](https://ponlet.mat2uken.app/licenses/vanjs-core-LICENSE.txt)
- ICU4X crates (including `icu_normalizer` 2.3.0):
  [Unicode-3.0 text](https://ponlet.mat2uken.app/licenses/icu4x-LICENSE-Unicode.txt).
- `option-ext` 0.2.0 (via `dirs-sys`):
  [MPL-2.0 text](https://ponlet.mat2uken.app/licenses/option-ext-LICENSE-MPL.txt).
  Its unmodified source is available as the exact
  [0.2.0 source archive](https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate).
- `swift-rs` 1.0.8 (locally modified): MIT OR Apache-2.0.
  Copyright (c) 2023 The swift-rs Developers. The retained upstream license
  texts are [MIT](https://ponlet.mat2uken.app/licenses/swift-rs-LICENSE-MIT.txt) and
  [Apache-2.0](https://ponlet.mat2uken.app/licenses/swift-rs-LICENSE-APACHE.txt); see
  [PONLET_PATCH.md](https://github.com/mat2uken/tailcatsend/blob/main/vendor/swift-rs/PONLET_PATCH.md) for the changes.
  Source: https://github.com/Brendonovich/swift-rs.

Dependency versions are recorded in the package manager lockfiles. The completeness
of notices for all transitive dependencies has not been verified here.

## 4. QR decoding and native SDKs

- `jsqr` 1.4.0: Apache-2.0. The distributed license is included at
  [jsqr-LICENSE.txt](https://ponlet.mat2uken.app/licenses/jsqr-LICENSE.txt).
  Source: https://github.com/cozmo/jsQR.
- The mobile barcode scanner uses Android ML Kit and iOS AVFoundation through
  the Tauri barcode scanner plugin. Native package notices still need verification.
- Firebase Analytics and Crashlytics are restored from the
  previous mobile integration. Source and SDK notices:
  https://github.com/firebase/firebase-ios-sdk and
  https://github.com/firebase/firebase-android-sdk.

The resolved iOS Firebase SDK is 12.19.1. Its upstream
[CoreOnly/NOTICES](https://ponlet.mat2uken.app/licenses/firebase-ios-CoreOnly-NOTICES.txt) is reproduced
verbatim; this file covers more Firebase products than this app selects.
The 1.0.14 Swift package resolution also included GoogleUtilities 8.1.3
([license, including an additional MIT notice](https://ponlet.mat2uken.app/licenses/googleutilities-LICENSE.txt)),
LevelDB 1.22.5 ([BSD license](https://ponlet.mat2uken.app/licenses/leveldb-LICENSE.txt)), and
nanopb 2.30910.1 ([license](https://ponlet.mat2uken.app/licenses/nanopb-LICENSE.txt)).
The 1.0.14 build's untracked Swift package resolution also recorded
`abseil-cpp-binary` 1.2024072200.0, `app-check` 11.3.1,
`google-ads-on-device-conversion-ios-sdk` 3.7.0,
`GoogleAppMeasurement` 12.19.0, `GoogleDataTransport` 10.1.1,
`grpc-binary` 1.69.1, `gtm-session-fetcher` 5.3.1,
`interop-ios-for-google-sdks` 101.0.0, and `promises` 2.4.1;
their checkout root `LICENSE` files contain the
[Apache-2.0 terms](https://ponlet.mat2uken.app/licenses/jsqr-LICENSE.txt). The pin for `swift-rs`
1.0.7 in that resolution is separate from the locally modified Rust crate 1.0.8.
There is no committed `Package.resolved` for the current build; verify its
resolved packages again when preparing an Apple distribution.
The final iOS bundle and all resolved Swift products have not yet been checked
for additional notices; this list does not establish completeness.

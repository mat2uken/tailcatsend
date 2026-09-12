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

## 3. Rust crates

- `tokio`: MIT License
- `serde` / `serde_json`: MIT / Apache-2.0
- `ciborium`: Apache License 2.0
- `sha2` / `hmac`: MIT / Apache-2.0
- `qrcode`: MIT / Apache-2.0
- `tauri`, `tauri-plugin-dialog`, `tauri-plugin-fs`, `tauri-plugin-opener`,
  `tauri-plugin-barcode-scanner` 2.4.4, `tauri-plugin-clipboard-manager` 2.3.3: MIT / Apache-2.0
- `vanjs-core`: MIT License

The complete notices shipped by each dependency remain available through the package manager lockfiles and the generated application notices.

## 4. QR decoding and native SDKs

- `jsqr` 1.4.0: Apache-2.0. The distributed license is included at
  [dist/licenses/jsqr-LICENSE.txt](dist/licenses/jsqr-LICENSE.txt).
  Source: https://github.com/cozmo/jsQR.
- The mobile barcode scanner uses Android ML Kit and iOS AVFoundation through
  the Tauri barcode scanner plugin. SDK notices accompany the native packages.
- Firebase Analytics, Crashlytics, and Remote Config are restored from the
  previous mobile integration. Source and SDK notices:
  https://github.com/firebase/firebase-ios-sdk and
  https://github.com/firebase/firebase-android-sdk.

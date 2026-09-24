# Notes for App Review — English version

Archived notes for the 1.0.14 submission on 2026-09-24. The current 1.0.17 source no longer uses Remote Config; recheck the text before any new submission.

- App: Ponlet 1.0.14 (bundle ID `jp.yasagure.ponlet`)
- Requirements: iOS 17.0 or later, iPhone and iPad
- App Store languages: Japanese (ja) and English (en-US)
- Japanese version of these notes: `app_review_notes_ja.md`

This document was prepared for the "Notes for App Review" field in App Store Connect for 1.0.14.

---

## 1. No account, login, or in-app purchases

- There is no account creation, login, or password authentication of any kind. The app is ready to use as soon as it is launched.
- There are no in-app purchases, subscriptions, ads, or external purchase links. No demo user or password is required, and no features are locked.
- Because accounts simply do not exist in this app, there is no account deletion feature.

## 2. How to verify a connection and a transfer (two devices)

For review, you can pair the iOS app with the web client at https://ponlet.mat2uken.app/ and use the browser as the second device.

1. Launch Ponlet on the iPhone and display the invitation QR code. The invitation URL looks like `https://ponlet.mat2uken.app/#i=...` and is valid for 10 minutes.
2. Connect from the other side:
   - Web client: open https://ponlet.mat2uken.app/ and either paste the invitation URL or scan the invitation QR code.
   - iOS app: scan the other device's invitation QR code with the camera, or paste the invitation URL.
3. Once connected, the app displays the connection route determined for this device. A direct device-to-device route is preferred, and the route is selected automatically depending on conditions.
4. Select multiple files and send them. File name, byte count, percentage, and speed are displayed, and the transfer can be cancelled at any time.
5. On the receiving side, the received file list lets you open a file or copy its save location. Files with the same name are both kept, with `(1)` appended to the new one.
6. The two-way text chat is on the same screen. Messages can be copied, shared, saved, or the history cleared.

## 3. Displaying and scanning the invitation QR code (permission prompts)

- Users can connect by displaying their invitation QR code, scanning the other device's QR code, or pasting the invitation URL.
- When connecting, iOS asks for permission to use the local network.
  - Purpose: direct device-to-device connection and file transfer only (`NSLocalNetworkUsageDescription`).
- When scanning the other device's invitation QR code, iOS asks for permission to use the camera.
  - Purpose: scanning invitation QR codes only (`NSCameraUsageDescription`). The app does not access the photo library, microphone, Bluetooth, or location.

## 4. Sending from the iOS share sheet ("Ponletで送信")

1. In a source app such as Photos, select photos, videos, files, text, or URLs and open the share sheet (up to 20 files, 20 images, 20 videos, and 20 text or URL items; text is limited to 1 MiB).
2. Choose "Ponlet" in the share sheet (the share screen it opens is titled 「Ponletで送信」 in the current build). The main app does not need to be launched.
3. Connect to the other device in the screen that appears, then send the items.

Known limitations (by design):

- Keep the share sheet open until the transfer completes. If the source app moves to the background, the transfer is interrupted and reconnects when you return.
- There is no save-confirmation response yet, so a resend right before disconnection may result in duplicated content.

## 5. Use of WireGuard (not subject to App Review Guideline 2.25)

- The app uses a WireGuard-based protocol (UDP) for direct device-to-device transfer, but it does not provide VPN or proxy functionality.
- The app does not use the NetworkExtension framework and does not install a VPN configuration profile. It does not intercept, modify, or relay traffic from other apps.
- Therefore, the app is not a VPN or proxy app that hides or restricts communications under Guideline 2.25.
- When a direct connection is not possible, traffic may be relayed through a DERP relay (a Tailscale-style relay at tailcat.dev). Transfer contents are end-to-end encrypted, and the relay cannot decrypt them.

## 6. Telemetry (Firebase Analytics / Crashlytics / Remote Config)

- Usage telemetry is opt-out and enabled by default. Users can turn it off in settings.
- Turning it off stops Analytics collection and Remote Config fetches. Later crashes are not reported.
- App-provided events cover launch/termination, connection route, transfer counts, bytes, and duration.
- They also cover text-length and error categories, plus app, OS, and language information.
- The Firebase SDK handles pseudonymous device or installation IDs and crash reports.
- The app omits file names, paths, transfer contents, and message bodies from its telemetry events.
- The app does not track users. It does not use IDFA or App Tracking Transparency (ATT) and contains no advertising SDKs.

## 7. Web content reachable from the app

- The only external pages opened from the app are the following, and both open in the system browser (Safari):
  - Privacy policy: https://ponlet.mat2uken.app/privacy_en.html (Japanese: https://ponlet.mat2uken.app/privacy_ja.html )
  - OSS licenses: https://ponlet.mat2uken.app/licenses.html
- There is no in-app (embedded) browser, and users cannot browse arbitrary web pages within the app.

## 8. Contact

- Support: https://github.com/mat2uken/tailcatsend/issues
- Reviewer contact details are entered in the App Review Information section of App Store Connect.

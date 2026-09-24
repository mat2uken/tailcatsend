#!/usr/bin/env bash
# Reproduces the iPad 13-inch (2064x2752) App Store screenshot flow used for
# fastlane/screenshots/<locale>/ipad-*.png. Read the steps before running: the
# paste-consent alert and the invite's ~10 minute validity make the order of
# the calls matter, and each step is meant to be run with verification
# (appstore_ocr_boxes.swift / appstore_png_probe.py) between them.
#
# Devices used at capture time:
#   hero = Ponlet-Shot-iPad   (iPad Pro 13-inch (M4), 2064x2752 @2x)
#   peer = Ponlet-Shot-iPhone (the counterpart; never screenshotted)
#
# Shots:
#   ipad-01-*  waiting screen with the invitation QR and the join pane side by side
#   ipad-02-*  connected while receiving IMG_4821.MOV (catch mid-transfer with a burst)
#   ipad-03-*  messages tab with one received and one sent message
#
# Notes learned while capturing:
#   * `xcrun simctl pbcopy` and the app's clipboard read get out of sync on the
#     simulator ("Clipboard is empty"); enter URLs and messages with
#     `idb ui text` instead. The app's copy button + `simctl pbpaste` works and
#     is the way to recover the invitation URL from the hero.
#   * The paste-consent alert is modal and can appear in Japanese
#     ("ペーストを許可") or English ("Allow Paste"); detect and allow it before
#     touching the app again.
#   * The hero is the receiving side: seed the peer's share inbox with
#     appstore_seed_share_inbox.sh before connecting and the items auto-send in
#     order on connect.
#   * Status bar: `xcrun simctl status_bar <hero> override --time 9:41 ...`.
#     For an English UI with "9:41" (not "9:41 AM") set NSGlobalDomain
#     AppleLanguages=en and AppleLocale=ja_JP and reboot the device once.
set -euo pipefail

hero_udid="${HERO_UDID:-72DAF301-0E20-4E32-AB8A-ED8E2378440F}"
peer_udid="${PEER_UDID:-157DD728-06EE-43A9-81B3-DC1CB48C0E9E}"
bundle_id="jp.yasagure.ponlet"
locale="${1:?usage: appstore_ipad_capture.sh <ja|en> <setup|shot1|join|burst|messages|all>}"
step="${2:?usage: appstore_ipad_capture.sh <ja|en> <setup|shot1|join|burst|messages|all>}"
app="$(dirname "$0")/../apps/tauri/gen/apple/build/arm64-sim/Ponlet.app"
payloads="${TMPDIR:-/tmp}/ponlet-share-payloads"

setup() {
  # Fresh install on both devices with the right app language, a 9:41 status
  # bar on the hero, and three queued share items on the peer (320 MB + 3 MB +
  # 780 KB) so the transfer is long enough to photograph.
  local languages="ja" locale_id="ja_JP"
  if [[ "${locale}" == "en" ]]; then languages="en"; locale_id="en_US"; fi
  xcrun simctl terminate "${hero_udid}" "${bundle_id}" 2>/dev/null || true
  xcrun simctl terminate "${peer_udid}" "${bundle_id}" 2>/dev/null || true
  xcrun simctl uninstall "${hero_udid}" "${bundle_id}"
  xcrun simctl uninstall "${peer_udid}" "${bundle_id}"
  xcrun simctl install "${hero_udid}" "${app}"
  xcrun simctl install "${peer_udid}" "${app}"
  for udid in "${hero_udid}" "${peer_udid}"; do
    xcrun simctl spawn "${udid}" defaults write "${bundle_id}" AppleLanguages -array "${languages}"
    xcrun simctl spawn "${udid}" defaults write NSGlobalDomain AppleLanguages -array "${languages}"
    xcrun simctl spawn "${udid}" defaults write NSGlobalDomain AppleLocale -string "${locale_id}"
  done
  xcrun simctl status_bar "${hero_udid}" clear
  xcrun simctl status_bar "${hero_udid}" override --time "9:41" --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
  "$(dirname "$0")/appstore_seed_share_inbox.sh" "${peer_udid}" clear
  "$(dirname "$0")/appstore_seed_share_inbox.sh" "${peer_udid}" file IMG_4821.MOV "${payloads}/IMG_4821.MOV" video/quicktime
  "$(dirname "$0")/appstore_seed_share_inbox.sh" "${peer_udid}" file IMG_2031.HEIC "${payloads}/IMG_2031.HEIC" image/heic
  "$(dirname "$0")/appstore_seed_share_inbox.sh" "${peer_udid}" file Travel-Itinerary.pdf "${payloads}/Travel-Itinerary.pdf" application/pdf
  xcrun simctl launch "${hero_udid}" "${bundle_id}"
  xcrun simctl launch "${peer_udid}" "${bundle_id}"
  sleep 10
}

shot1() {
  # The waiting screen: QR pane and join pane sit side by side at >=768px and
  # the hero auto-creates an invite on launch (or after Disconnect).
  xcrun simctl io "${hero_udid}" screenshot "${locale}-01.png"
}

copy_invite() {
  # Tap "Copy invitation" / 「招待URLをコピー」 and read the URL back from the
  # hero's pasteboard. Prints the URL on stdout.
  local tap_x="${1:?tap x in points}" tap_y="${2:?tap y in points}"
  idb ui tap --udid "${hero_udid}" "${tap_x}" "${tap_y}"
  sleep 2
  xcrun simctl pbpaste "${hero_udid}"
}

join() {
  # Type the invitation URL (argument 2) into the peer's join field and press
  # Connect. The button positions shift with the locale and with any error
  # card, so take them from appstore_ocr_boxes.swift output.
  local url="${1:?invitation URL}" input_x="${2:?input tap x}" input_y="${3:?input tap y}" \
        connect_x="${4:?connect tap x}" connect_y="${5:?connect tap y}"
  idb ui tap --udid "${peer_udid}" "${input_x}" "${input_y}"
  sleep 2
  idb ui text --udid "${peer_udid}" "${url}"
  sleep 2
  idb ui tap --udid "${peer_udid}" "${connect_x}" "${connect_y}"
}

burst() {
  # Rapid screenshots of the hero; scan them afterwards for a mid-transfer
  # frame (25-80%) with appstore_ocr.swift and keep that one.
  local out="${1:?output directory}" frames="${2:-50}"
  mkdir -p "${out}"
  local index=0
  while (( index < frames )); do
    xcrun simctl io "${hero_udid}" screenshot "${out}/f$(printf '%03d' "${index}").png" >/dev/null 2>&1
    index=$((index + 1))
    sleep 0.3
  done
}

messages() {
  # Type the conversation in with idb ui text (verify each string with OCR
  # before sending; the composer enables autocorrect):
  #   peer: "Sent you the Okinawa photos and video!" / 「沖縄の写真と動画を送ったよ！」
  #   hero: "Got them, thanks!" / 「ありがとう！受け取りました」
  # Then blur the keyboard by tapping the active workspace tab again and shoot.
  echo "see comments: tap Messages tab, focus composer, idb ui text <message>, tap send, retap tab, screenshot"
}

case "${step}" in
  setup) setup ;;
  shot1) shot1 ;;
  join) join "$@" ;;
  burst) burst "$@" ;;
  messages) messages ;;
  all) setup; shot1; echo "now: copy_invite -> join -> burst -> messages" ;;
  *) exit 2 ;;
esac

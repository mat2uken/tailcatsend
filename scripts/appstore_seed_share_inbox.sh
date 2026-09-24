#!/usr/bin/env bash
set -euo pipefail

# Places items into a simulator's Ponlet share inbox (App Group
# group.jp.yasagure.ponlet.k7vnga9k78/PonletShareInbox) so the main app shows
# them as "送信待ち" and sends them automatically once a peer connects. This is
# the same layout the Share Extension writes (manifest.json + payload).
#
# Usage:
#   appstore_seed_share_inbox.sh <udid> file <display-name> <source-path> [mime]
#   appstore_seed_share_inbox.sh <udid> text <display-name> <text> [mime]
#   appstore_seed_share_inbox.sh <udid> clear
#
# Items are queued in the order they are seeded (directory timestamps decide
# the send order).

udid="${1:?udid required}"
action="${2:?action required: file|text|clear}"

app_container_groups="$(xcrun simctl get_app_container "${udid}" jp.yasagure.ponlet groups)"
container="${app_container_groups##*$'\t'}"
inbox="${container}/PonletShareInbox"

if [[ "${action}" == "clear" ]]; then
  rm -rf "${inbox}"
  echo "cleared ${inbox}"
  exit 0
fi

kind="${action}"
name="${3:?display name required}"
payload_source="${4:?source path or text required}"
mime="${5:-}"

case "${kind}" in
  file|text) ;;
  *) echo "action must be file, text or clear" >&2; exit 2 ;;
esac

mkdir -p "${inbox}"
sequence="$(find "${inbox}" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')"
id="$(printf 'seed-%02d-%s' "${sequence}" "${kind}")"
item="${inbox}/${id}"
mkdir -p "${item}"

if [[ "${kind}" == "file" ]]; then
  cp "${payload_source}" "${item}/payload"
else
  printf '%s' "${payload_source}" > "${item}/payload"
fi
size="$(stat -f%z "${item}/payload")"

python3 - "${item}/manifest.json" "${id}" "${kind}" "${name}" "${size}" "${mime}" <<'PY'
import json
import sys

target, item_id, kind, name, size, mime = sys.argv[1:]
entry = {"id": item_id, "kind": kind, "name": name, "size": int(size), "payload": "payload"}
if mime:
    entry["mime"] = mime
with open(target, "w", encoding="utf-8") as handle:
    json.dump(entry, handle, ensure_ascii=False, separators=(",", ": "))
PY

# Keep the queue order stable: one item per minute, oldest first.
touch -t "$(date -v+"${sequence}"M +%Y%m%d%H%M.00)" "${item}"
echo "seeded ${item} (${kind}: ${name}, ${size} bytes)"

#!/usr/bin/env bash
set -euo pipefail

# Cargo stages only the SwiftPM products selected for this SDK/configuration.
# Bundle.module accessors expect their bundles beside the app executable.
products="${PROJECT_DIR:?}/.swift-products/${PLATFORM_NAME:?}/${CONFIGURATION:?}"
destination="${TARGET_BUILD_DIR:?}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}"
test -d "${products}/FirebaseAnalytics.framework"
mkdir -p "${destination}"
shopt -s nullglob
bundles=("${products}"/*.bundle "${products}"/*.framework/*.bundle)
for bundle in "${bundles[@]}"; do
  target="${destination}/$(basename "${bundle}")"
  rm -rf -- "${target}"
  ditto "${bundle}" "${target}"
done

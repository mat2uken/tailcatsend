#!/usr/bin/env bash
set -euo pipefail

# This is a build entry point, never an install/run/deploy or a release gate.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
mode="${1:-}"
case "$mode" in
  default-off|feature-on-closed) ;;
  *) echo 'usage: build_android_privacy_verify.sh default-off|feature-on-closed' >&2; exit 2 ;;
esac

# Refuse conflicting settings before the build. Do not silently reuse a local
# production endpoint, gate, or retention policy. The merged and compiled
# manifests are checked again after the real build.
for key in ${!ORG_GRADLE_PROJECT_ponletPrivacy@}; do
  unset "$key"
done
for key in GRADLE_OPTS JAVA_OPTS JAVA_TOOL_OPTIONS JDK_JAVA_OPTIONS _JAVA_OPTIONS; do
  if [[ "${!key:-}" == *ponletPrivacy* ]]; then
    echo 'Privacy properties in JVM options are not accepted for verification' >&2
    exit 2
  fi
done
python3 - "$repo_dir" "${GRADLE_USER_HOME:-$HOME/.gradle}" <<'PY'
from pathlib import Path
import sys
root, user_home = map(Path, sys.argv[1:])
for folder in (root, root / 'apps/tauri', root / 'apps/tauri/gen/android',
               root / 'apps/tauri/gen/android/app', user_home):
    file = folder / 'gradle.properties'
    if file.is_file():
        for line in file.read_text().splitlines():
            if not line.lstrip().startswith(('#', '!')) and 'ponletPrivacy' in line:
                raise SystemExit('Remove privacy property overrides before verification')
PY
if [[ "$mode" == feature-on-closed ]]; then
  export ORG_GRADLE_PROJECT_ponletPrivacyFeatureEnabled=true
fi
# Leave the feature property absent for default-off, exercising the real default.
export ORG_GRADLE_PROJECT_ponletPrivacyComponentsVerified=false
export ORG_GRADLE_PROJECT_ponletPrivacyProtocolVerified=false
for name in ApiOrigin Audience PolicyVersion ReceiptDays ObservationDays RetiredKeyPolicy; do
  export "ORG_GRADLE_PROJECT_ponletPrivacy${name}="
done
# The existing web build already runs npm ci --ignore-scripts. Keep that rule
# even for nested npm invocations and do not offer ambient registry tokens.
unset NPM_TOKEN NODE_AUTH_TOKEN NPM_CONFIG_TOKEN npm_config_token
export NPM_CONFIG_IGNORE_SCRIPTS=true
export NPM_CONFIG_USERCONFIG=/dev/null
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org
export NPM_CONFIG_AUDIT=false NPM_CONFIG_FUND=false
bash "${script_dir}/build_android_verify.sh"

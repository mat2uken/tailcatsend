#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/ponlet-privacy-pure.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
java_source=crates/tauri-plugin-ponlet-platform/android/src/main/java
tests=scripts/tests/privacy
# These shared Java classes are the exact ones compiled into Android, not copies
# of the implementation. RFC public test keys only; no key generation/registration.
java -m jdk.compiler/com.sun.tools.javac.Main -source 17 -target 17 -d "$scratch/classes" \
  "$java_source"/Privacy*.java "$tests"/Privacy*Test.java
for test in "$tests"/Privacy*Test.java; do
  class="$(basename "$test" .java)"
  java -cp "$scratch/classes" "$class" "$scratch/jws-fixture-output.json"
done
node --require "./$tests/deny-network.cjs" "$tests/verify-worker-interop.mjs" "$scratch/jws-fixture-output.json"
node --require "./$tests/deny-network.cjs" --test services/diagnostics-deletion/tests/*.test.mjs

#!/usr/bin/env bash
set -euo pipefail

test -n "$ANDROID_KEYSTORE_BASE64"
test -n "$ANDROID_KEYSTORE_PASSWORD"
test -n "$ANDROID_KEY_ALIAS"
test -n "$ANDROID_KEY_PASSWORD"
KEYSTORE_PATH="$RUNNER_TEMP/ponlet-release.keystore"
echo "$ANDROID_KEYSTORE_BASE64" | base64 --decode > "$KEYSTORE_PATH"
STORE_PASSWORD=""
for candidate in "$ANDROID_KEYSTORE_PASSWORD" "$ANDROID_KEY_PASSWORD" android changeit; do
  if [ -n "$candidate" ] && keytool -list -keystore "$KEYSTORE_PATH" -storepass "$candidate" >/dev/null 2>&1; then
    STORE_PASSWORD="$candidate"
    break
  fi
done
test -n "$STORE_PASSWORD"
KEY_ALIAS="$ANDROID_KEY_ALIAS"
if ! keytool -list -keystore "$KEYSTORE_PATH" -storepass "$STORE_PASSWORD" -alias "$KEY_ALIAS" >/dev/null 2>&1; then
  KEY_ALIAS=$(keytool -list -v -keystore "$KEYSTORE_PATH" -storepass "$STORE_PASSWORD" | awk -F': ' '/^Alias name:/{print $2; exit}')
fi
test -n "$KEY_ALIAS"
KEY_PASSWORD="$ANDROID_KEY_PASSWORD"
if ! keytool -exportcert -rfc -alias "$KEY_ALIAS" -keystore "$KEYSTORE_PATH" -storepass "$STORE_PASSWORD" -keypass "$KEY_PASSWORD" -file "$RUNNER_TEMP/ponlet-cert.pem" >/dev/null 2>&1; then
  KEY_PASSWORD="$STORE_PASSWORD"
fi
{
  echo "PONLET_ANDROID_KEYSTORE=$KEYSTORE_PATH"
  echo "ANDROID_KEYSTORE_PASSWORD=$STORE_PASSWORD"
  echo "ANDROID_KEY_ALIAS=$KEY_ALIAS"
  echo "ANDROID_KEY_PASSWORD=$KEY_PASSWORD"
} >> "$GITHUB_ENV"

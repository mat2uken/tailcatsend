#!/usr/bin/env python3
"""Verify the uploaded iOS build, independently of altool upload success.

Apple API references:
https://developer.apple.com/documentation/appstoreconnectapi/get-v1-builds
https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps
https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
"""

import argparse
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


class ProcessingError(Exception):
    pass


class AppStoreConnect:
    def __init__(self):
        names = (
            "APP_STORE_CONNECT_KEY_ID",
            "APP_STORE_CONNECT_ISSUER_ID",
            "APP_STORE_CONNECT_PRIVATE_KEY",
        )
        if any(not os.environ.get(name) for name in names):
            raise ProcessingError("Missing App Store Connect API credentials")
        self.key_id, self.issuer, self.private_key = (os.environ[name] for name in names)

    def get(self, path, params, timeout):
        import jwt

        now = int(time.time())
        try:
            token = jwt.encode(
                {"iss": self.issuer, "iat": now, "exp": now + 120, "aud": "appstoreconnect-v1"},
                self.private_key,
                algorithm="ES256",
                headers={"kid": self.key_id, "typ": "JWT"},
            )
        except Exception:
            raise ProcessingError("Cannot sign App Store Connect API token") from None
        request = Request(
            "https://api.appstoreconnect.apple.com/v1/" + path + "?" + urlencode(params),
            headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=timeout) as response:
                payload = json.load(response)
        except HTTPError as error:
            # Do not log request headers, tokens, keys, or response bodies.
            raise ProcessingError(f"App Store Connect API {path}: HTTP {error.code}") from None
        except (URLError, TimeoutError, OSError):
            raise ProcessingError(f"App Store Connect API {path}: network unavailable or timed out") from None
        except (ValueError, UnicodeError):
            raise ProcessingError(f"App Store Connect API {path}: invalid JSON response") from None
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise ProcessingError(f"App Store Connect API {path}: invalid collection response")
        return payload


def build_state(payload, app_id, bundle_id, version, build_number):
    builds = payload["data"]
    if not builds:
        return "NOT_VISIBLE"
    if len(builds) != 1 or payload.get("links", {}).get("next"):
        raise ProcessingError("App Store Connect returned multiple matching builds")
    build = builds[0]
    related = {(item["type"], item["id"]): item for item in payload.get("included", [])}
    try:
        app = build["relationships"]["app"]["data"]
        prerelease = build["relationships"]["preReleaseVersion"]["data"]
        app_attributes = related[("apps", app["id"])]["attributes"]
        version_attributes = related[("preReleaseVersions", prerelease["id"])]["attributes"]
        attributes = build["attributes"]
        if (
            app["id"] != app_id
            or app_attributes["bundleId"] != bundle_id
            or attributes["version"] != build_number
            or version_attributes["version"] != version
            or version_attributes["platform"] != "IOS"
        ):
            raise ProcessingError("App Store Connect build identity does not match the uploaded version/build")
        state = attributes["processingState"]
    except (KeyError, TypeError):
        raise ProcessingError("App Store Connect build response is missing identity or processing state") from None
    if state not in {"PROCESSING", "VALID", "FAILED", "INVALID"}:
        raise ProcessingError("App Store Connect returned an unknown processing state")
    return state


def wait_for_processing(api, bundle_id, version, build_number, *, timeout=1200,
                        clock=time.monotonic, sleep=time.sleep, log=print):
    deadline = clock() + timeout

    def fetch(path, params):
        remaining = deadline - clock()
        if remaining <= 0:
            raise ProcessingError("Timed out waiting for App Store Connect processing")
        return api.get(path, params, min(30, remaining))

    apps = fetch("apps", {"filter[bundleId]": bundle_id, "fields[apps]": "bundleId", "limit": 2})
    if len(apps["data"]) != 1 or apps["data"][0].get("attributes", {}).get("bundleId") != bundle_id:
        raise ProcessingError("App Store Connect did not return exactly one app with the expected bundle ID")
    app_id = apps["data"][0]["id"]
    params = {
        "filter[app]": app_id,
        "filter[version]": build_number,
        "filter[preReleaseVersion.version]": version,
        "filter[preReleaseVersion.platform]": "IOS",
        "include": "app,preReleaseVersion",
        "fields[builds]": "version,processingState,app,preReleaseVersion",
        "fields[apps]": "bundleId",
        "fields[preReleaseVersions]": "version,platform",
        "limit": 2,
    }
    last_state = None
    while clock() < deadline:
        state = build_state(fetch("builds", params), app_id, bundle_id, version, build_number)
        if state != last_state:
            log(f"TestFlight processing: {bundle_id} {version} ({build_number}) {state}", flush=True)
            last_state = state
        if state == "VALID":
            return
        if state in {"FAILED", "INVALID"}:
            raise ProcessingError(f"TestFlight processing failed: {state}")
        sleep(min(30, max(0, deadline - clock())))
    raise ProcessingError(f"TestFlight processing did not reach VALID within {timeout}s (last state: {last_state})")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version-config", type=Path, required=True)
    parser.add_argument("--build-number", required=True)
    args = parser.parse_args()
    try:
        version = json.loads(args.version_config.read_text())["version"]
        if not version or not args.build_number:
            raise ProcessingError("Marketing version and build number must be nonempty")
        wait_for_processing(AppStoreConnect(), "jp.yasagure.ponlet", version, args.build_number)
    except (ProcessingError, OSError, ValueError, KeyError) as error:
        print(f"::error::Processing verification failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

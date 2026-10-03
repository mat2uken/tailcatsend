#!/usr/bin/env python3
"""Allocate Android CI codes and fail closed against the Console's maximum."""
import argparse
from pathlib import Path

BASE = 2_030_000_000
LEGACY_MAX = 2_026_093_037
PLAY_MAX = 2_100_000_000
ATTEMPTS_PER_RUN = 100


def validate_code(value: str) -> int:
    if not value.isascii() or not value.isdecimal() or value.startswith("0"):
        raise ValueError("versionCode must be a positive decimal integer without leading zeroes")
    code = int(value)
    if not 1 <= code <= PLAY_MAX:
        raise ValueError(f"versionCode must be within 1..{PLAY_MAX}")
    return code


def require_newer(candidate: int, previous: int) -> int:
    if candidate <= max(previous, LEGACY_MAX):
        raise ValueError(f"versionCode {candidate} must exceed Console maximum {previous} and legacy maximum {LEGACY_MAX}")
    return candidate


def build_number(run: int, attempt: int, previous: int) -> int:
    if run < 1 or not 1 <= attempt < ATTEMPTS_PER_RUN:
        raise ValueError("run number must be positive and run attempt must be within 1..99; no wrap is allowed")
    candidate = max(
        BASE + (run - 1) * ATTEMPTS_PER_RUN + attempt,
        max(previous, LEGACY_MAX) + 1,
    )
    return require_newer(validate_code(str(candidate)), previous)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-number", type=int)
    parser.add_argument("--attempt", type=int)
    parser.add_argument("--candidate", help="Recheck an already built code immediately before Play upload")
    parser.add_argument("--previous", required=True, help="Current highest versionCode in Play Console, across all tracks")
    parser.add_argument("--github-env", type=Path)
    args = parser.parse_args()
    try:
        previous = validate_code(args.previous)
        if args.candidate is not None:
            if args.run_number is not None or args.attempt is not None:
                raise ValueError("candidate cannot be combined with run number or attempt")
            code = require_newer(validate_code(args.candidate), previous)
        else:
            if args.run_number is None or args.attempt is None:
                raise ValueError("run number and attempt are required when candidate is absent")
            code = build_number(args.run_number, args.attempt, previous)
        if args.github_env:
            with args.github_env.open("a", encoding="utf-8") as output:
                output.write(f"PONLET_ANDROID_VERSION_CODE={code}\n")
        print(code)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Read the highest versionCode Google Play has ever accepted for one package.

Read-only. The Android Publisher API has no endpoint that lists builds without an
edit, so an edit is inserted, listed from, and always deleted. It is never committed,
so published state does not change. This is the provider readback that lets a legacy
app initialize its release-version ledger without guessing a baseline.

Output carries package name, version codes, and track names only — no credentials and
no provider error text.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import re
import sys
from pathlib import Path

from google_play_client import (
    MAX_VERSION_CODE,
    PublicFailure,
    execute,
    fail,
    make_publisher,
    non_negative_int,
    positive_int,
)


PACKAGE_NAME_PATTERN = re.compile(
    r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$"
)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-name", required=True)
    parser.add_argument("--api-timeout-seconds", type=positive_int, default=300)
    parser.add_argument("--api-retries", type=non_negative_int, default=5)
    parser.add_argument("--out", default="")
    return parser.parse_args(argv)


def version_codes(entries: list[dict[str, object]]) -> list[int]:
    codes: list[int] = []
    for entry in entries or []:
        code = entry.get("versionCode")
        if isinstance(code, int) and 0 < code <= MAX_VERSION_CODE:
            codes.append(code)
    return sorted(set(codes))


def read(args: argparse.Namespace) -> dict[str, object]:
    package_name = args.package_name
    if not PACKAGE_NAME_PATTERN.fullmatch(package_name):
        fail("GOOGLE_PLAY_PACKAGE_NAME_INVALID")

    publisher = make_publisher(args.api_timeout_seconds)
    edits = publisher.edits()
    edit = execute(
        edits.insert(packageName=package_name, body={}),
        args.api_retries,
        "GOOGLE_PLAY_EDIT_CREATE_FAILED",
    )
    edit_id = edit["id"]
    try:
        bundles = execute(
            edits.bundles().list(packageName=package_name, editId=edit_id),
            args.api_retries,
            "GOOGLE_PLAY_BUNDLE_LIST_FAILED",
        )
        # 구 APK 업로드 이력이 있는 앱은 bundle 목록만으로 최대값을 놓친다.
        apks = execute(
            edits.apks().list(packageName=package_name, editId=edit_id),
            args.api_retries,
            "GOOGLE_PLAY_APK_LIST_FAILED",
        )
        tracks = execute(
            edits.tracks().list(packageName=package_name, editId=edit_id),
            args.api_retries,
            "GOOGLE_PLAY_TRACK_LIST_FAILED",
        )
    finally:
        # 정리하지 못한 edit을 남긴 채 성공으로 보고하지 않는다.
        try:
            edits.delete(packageName=package_name, editId=edit_id).execute(
                num_retries=args.api_retries
            )
        except Exception as error:  # noqa: BLE001 - 코드만 노출한다
            raise PublicFailure("GOOGLE_PLAY_EDIT_CLEANUP_FAILED") from error

    bundle_codes = version_codes(bundles.get("bundles", []))
    apk_codes = version_codes(apks.get("apks", []))
    observed = bundle_codes + apk_codes

    return {
        "schemaVersion": 1,
        "kind": "google-play-version-code-readback",
        "packageName": package_name,
        "observedAt": datetime.datetime.now(datetime.UTC)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z"),
        "source": "androidpublisher-v3-edits",
        "maxVersionCode": max(observed) if observed else None,
        "bundleVersionCodes": bundle_codes,
        "apkVersionCodes": apk_codes,
        "tracks": [
            {
                "track": track.get("track"),
                "versionCodes": sorted(
                    {
                        int(code)
                        for release in track.get("releases", []) or []
                        for code in release.get("versionCodes", []) or []
                    }
                ),
            }
            for track in tracks.get("tracks", []) or []
        ],
        "status": "READY",
    }


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        report = read(args)
    except PublicFailure as failure:
        sys.stderr.write(f"{failure.code}\n")
        return 1

    serialized = json.dumps(report, indent=2, sort_keys=False, ensure_ascii=False)
    report["evidenceDigest"] = hashlib.sha256(serialized.encode("utf-8")).hexdigest()
    serialized = json.dumps(report, indent=2, sort_keys=False, ensure_ascii=False) + "\n"
    if args.out:
        Path(args.out).write_text(serialized, encoding="utf-8")
    sys.stdout.write(serialized)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

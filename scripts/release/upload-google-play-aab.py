#!/usr/bin/env python3
"""Upload one verified AAB, or promote one already-uploaded build between tracks.

Neither mode consults repository-local version/config files. The caller supplies the
package name, and the build to act on is named explicitly — promotion never takes
"whatever is newest" on the source track.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path


ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher"
PACKAGE_NAME_PATTERN = re.compile(
    r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$"
)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
TRACK_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
LOCALE_PATTERN = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$")
MAX_VERSION_CODE = 2_100_000_000
MAX_NOTES_BYTES = 256 * 1024
MAX_RELEASE_NOTE_LENGTH = 500


class PublicFailure(RuntimeError):
    """An allowlisted, secret-free failure suitable for CI output."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise PublicFailure(code)


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def non_negative_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be an integer") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("must not be negative")
    return parsed


def rollout_fraction(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a number") from error
    if not 0.0 < parsed <= 1.0:
        raise argparse.ArgumentTypeError("must be within (0, 1]")
    return parsed


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path: Path, missing_code: str, unsafe_code: str) -> Path:
    try:
        if path.is_symlink():
            fail(unsafe_code)
        stat = path.stat()
    except FileNotFoundError:
        fail(missing_code)
    if not path.is_file() or stat.st_size <= 0:
        fail(missing_code)
    return path.resolve(strict=True)


def load_release_notes(path_value: str) -> list[dict[str, str]]:
    if not path_value:
        return []
    path = regular_file(
        Path(path_value),
        "RELEASE_NOTES_NOT_FOUND",
        "RELEASE_NOTES_PATH_UNSAFE",
    )
    if path.stat().st_size > MAX_NOTES_BYTES:
        fail("RELEASE_NOTES_TOO_LARGE")
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        fail("RELEASE_NOTES_INVALID")
    notes = document.get("notes") if isinstance(document, dict) else None
    if not isinstance(notes, dict):
        fail("RELEASE_NOTES_INVALID")

    result: list[dict[str, str]] = []
    for locale, text in sorted(notes.items()):
        if (
            not isinstance(locale, str)
            or not LOCALE_PATTERN.fullmatch(locale)
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > MAX_RELEASE_NOTE_LENGTH
        ):
            fail("RELEASE_NOTES_INVALID")
        result.append({"language": locale, "text": text})
    return result


def validate_upload(args: argparse.Namespace) -> dict[str, object]:
    if not PACKAGE_NAME_PATTERN.fullmatch(args.package_name):
        fail("PACKAGE_NAME_INVALID")
    if not TRACK_PATTERN.fullmatch(args.track):
        fail("TRACK_INVALID")
    if not args.release_name or len(args.release_name) > 50:
        fail("RELEASE_NAME_INVALID")
    if not 1 <= args.expected_version_code <= MAX_VERSION_CODE:
        fail("VERSION_CODE_INVALID")
    if not SHA256_PATTERN.fullmatch(args.expected_aab_sha256):
        fail("AAB_DIGEST_INVALID")

    aab_path = regular_file(
        Path(args.aab_path),
        "AAB_NOT_FOUND",
        "AAB_PATH_UNSAFE",
    )
    if sha256_file(aab_path) != args.expected_aab_sha256:
        fail("AAB_DIGEST_MISMATCH")

    return {
        "packageName": args.package_name,
        "track": args.track,
        "releaseName": args.release_name,
        "releaseStatus": args.release_status,
        "expectedVersionCode": args.expected_version_code,
        "aabPath": aab_path,
        "releaseNotes": load_release_notes(args.release_notes_json),
    }


def validate_promote(args: argparse.Namespace) -> dict[str, object]:
    if not PACKAGE_NAME_PATTERN.fullmatch(args.package_name):
        fail("PACKAGE_NAME_INVALID")
    if not TRACK_PATTERN.fullmatch(args.promote_from_track):
        fail("TRACK_INVALID")
    if not TRACK_PATTERN.fullmatch(args.promote_to_track):
        fail("TRACK_INVALID")
    if args.promote_from_track == args.promote_to_track:
        fail("PROMOTE_TRACKS_IDENTICAL")
    if not args.release_name or len(args.release_name) > 50:
        fail("RELEASE_NAME_INVALID")
    if not 1 <= args.promote_version_code <= MAX_VERSION_CODE:
        fail("VERSION_CODE_INVALID")

    # rollout 을 주면 부분 공개다. Play 는 그 상태를 inProgress 로만 받는다.
    status = "inProgress" if args.rollout is not None else args.release_status
    return {
        "packageName": args.package_name,
        "fromTrack": args.promote_from_track,
        "toTrack": args.promote_to_track,
        "versionCode": args.promote_version_code,
        "releaseName": args.release_name,
        "releaseStatus": status,
        "userFraction": args.rollout,
        "releaseNotes": load_release_notes(args.release_notes_json),
    }


def source_track_contains(track: dict[str, object], version_code: int) -> bool:
    """승격 대상이 원본 트랙에 실제로 있는지.

    트랙의 최신 release 를 그대로 올리지 않는다. 태그가 정한 build 하나만 승격한다.
    이 확인이 없으면 internal 에 더 새 build 가 있을 때 의도하지 않은 것이 심사로 나간다.
    """
    releases = track.get("releases") if isinstance(track, dict) else None
    if not isinstance(releases, list):
        return False
    wanted = str(version_code)
    for release in releases:
        if not isinstance(release, dict):
            continue
        codes = release.get("versionCodes")
        if isinstance(codes, list) and any(str(code) == wanted for code in codes):
            return True
    return False


def promote(args: argparse.Namespace) -> dict[str, object]:
    validated = validate_promote(args)
    package_name = str(validated["packageName"])
    version_code = int(validated["versionCode"])
    publisher = make_publisher(args.api_timeout_seconds)
    edit_id: str | None = None

    try:
        edit = execute(
            publisher.edits().insert(packageName=package_name, body={}),
            args.api_retries,
            "GOOGLE_PLAY_EDIT_CREATE_FAILED",
        )
        edit_id = edit.get("id") if isinstance(edit, dict) else None
        if not isinstance(edit_id, str) or not edit_id:
            fail("GOOGLE_PLAY_EDIT_RESPONSE_INVALID")

        source = execute(
            publisher.edits().tracks().get(
                packageName=package_name,
                editId=edit_id,
                track=validated["fromTrack"],
            ),
            args.api_retries,
            "GOOGLE_PLAY_SOURCE_TRACK_READ_FAILED",
        )
        if not source_track_contains(source, version_code):
            fail("GOOGLE_PLAY_SOURCE_TRACK_MISSING_VERSION_CODE")

        release: dict[str, object] = {
            "name": validated["releaseName"],
            "versionCodes": [str(version_code)],
            "status": validated["releaseStatus"],
        }
        if validated["releaseNotes"]:
            release["releaseNotes"] = validated["releaseNotes"]
        if validated["userFraction"] is not None:
            release["userFraction"] = validated["userFraction"]
        execute(
            publisher.edits().tracks().update(
                packageName=package_name,
                editId=edit_id,
                track=validated["toTrack"],
                body={"track": validated["toTrack"], "releases": [release]},
            ),
            args.api_retries,
            "GOOGLE_PLAY_TRACK_UPDATE_FAILED",
        )
        execute(
            publisher.edits().commit(packageName=package_name, editId=edit_id),
            args.api_retries,
            "GOOGLE_PLAY_EDIT_COMMIT_FAILED",
        )
        edit_id = None
        result: dict[str, object] = {
            "packageName": package_name,
            "fromTrack": validated["fromTrack"],
            "toTrack": validated["toTrack"],
            "releaseStatus": validated["releaseStatus"],
            "versionCode": version_code,
        }
        if validated["userFraction"] is not None:
            result["userFraction"] = validated["userFraction"]
        return result
    except Exception:
        if edit_id is not None:
            try:
                publisher.edits().delete(
                    packageName=package_name,
                    editId=edit_id,
                ).execute(num_retries=args.api_retries)
            except Exception:
                print("GOOGLE_PLAY_EDIT_CLEANUP_FAILED", file=sys.stderr)
        raise


def make_publisher(timeout_seconds: int):
    try:
        import google.auth
        import google_auth_httplib2
        import httplib2
        from googleapiclient.discovery import build
    except ImportError:
        fail("GOOGLE_PLAY_CLIENT_UNAVAILABLE")

    try:
        credentials, _project_id = google.auth.default(scopes=[ANDROID_PUBLISHER_SCOPE])
        base_http = httplib2.Http(timeout=timeout_seconds)
        try:
            base_http.redirect_codes = base_http.redirect_codes - {308}
        except AttributeError:
            pass
        http = google_auth_httplib2.AuthorizedHttp(credentials, http=base_http)
        return build("androidpublisher", "v3", http=http, cache_discovery=False)
    except Exception:
        fail("GOOGLE_PLAY_AUTH_FAILED")


def execute(request, retries: int, failure_code: str):
    try:
        return request.execute(num_retries=retries)
    except Exception as error:
        raise PublicFailure(failure_code) from error


def changes_not_sent_for_review_rejected(error: Exception) -> bool:
    cursor: BaseException | None = error
    while cursor is not None:
        if "changesNotSentForReview must not be set" in str(cursor):
            return True
        cursor = cursor.__cause__
    return False


def upload(args: argparse.Namespace) -> dict[str, object]:
    validated = validate_upload(args)
    package_name = str(validated["packageName"])
    publisher = make_publisher(args.api_timeout_seconds)
    edit_id: str | None = None

    try:
        edit = execute(
            publisher.edits().insert(packageName=package_name, body={}),
            args.api_retries,
            "GOOGLE_PLAY_EDIT_CREATE_FAILED",
        )
        edit_id = edit.get("id") if isinstance(edit, dict) else None
        if not isinstance(edit_id, str) or not edit_id:
            fail("GOOGLE_PLAY_EDIT_RESPONSE_INVALID")

        try:
            from googleapiclient.http import MediaFileUpload
        except ImportError:
            fail("GOOGLE_PLAY_CLIENT_UNAVAILABLE")
        media = MediaFileUpload(
            str(validated["aabPath"]),
            mimetype="application/octet-stream",
            chunksize=16 * 1024 * 1024,
            resumable=True,
        )
        bundle = execute(
            publisher.edits().bundles().upload(
                packageName=package_name,
                editId=edit_id,
                media_body=media,
            ),
            args.api_retries,
            "GOOGLE_PLAY_BUNDLE_UPLOAD_FAILED",
        )
        try:
            uploaded_version_code = int(bundle["versionCode"])
        except (KeyError, TypeError, ValueError):
            fail("GOOGLE_PLAY_BUNDLE_RESPONSE_INVALID")
        if uploaded_version_code != validated["expectedVersionCode"]:
            fail("GOOGLE_PLAY_VERSION_CODE_MISMATCH")

        release: dict[str, object] = {
            "name": validated["releaseName"],
            "versionCodes": [str(uploaded_version_code)],
            "status": validated["releaseStatus"],
        }
        if validated["releaseNotes"]:
            release["releaseNotes"] = validated["releaseNotes"]
        execute(
            publisher.edits().tracks().update(
                packageName=package_name,
                editId=edit_id,
                track=validated["track"],
                body={"track": validated["track"], "releases": [release]},
            ),
            args.api_retries,
            "GOOGLE_PLAY_TRACK_UPDATE_FAILED",
        )

        commit_args: dict[str, object] = {
            "packageName": package_name,
            "editId": edit_id,
        }
        if args.changes_not_sent_for_review:
            commit_args["changesNotSentForReview"] = True
        try:
            execute(
                publisher.edits().commit(**commit_args),
                args.api_retries,
                "GOOGLE_PLAY_EDIT_COMMIT_FAILED",
            )
        except PublicFailure as error:
            if not args.changes_not_sent_for_review or not changes_not_sent_for_review_rejected(error):
                raise
            commit_args.pop("changesNotSentForReview", None)
            execute(
                publisher.edits().commit(**commit_args),
                args.api_retries,
                "GOOGLE_PLAY_EDIT_COMMIT_FAILED",
            )
        edit_id = None
        return {
            "packageName": package_name,
            "track": validated["track"],
            "releaseStatus": validated["releaseStatus"],
            "versionCode": uploaded_version_code,
        }
    except Exception:
        if edit_id is not None:
            try:
                publisher.edits().delete(
                    packageName=package_name,
                    editId=edit_id,
                ).execute(num_retries=args.api_retries)
            except Exception:
                print("GOOGLE_PLAY_EDIT_CLEANUP_FAILED", file=sys.stderr)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Upload one centrally verified AAB to a Google Play track, "
            "or promote one already-uploaded build between tracks."
        )
    )
    parser.add_argument("--package-name", required=True)
    # 업로드에만 필요한 셋이다. 승격은 이미 올라간 build 를 옮기므로 AAB 를 보지 않는다.
    parser.add_argument("--aab-path", default="")
    parser.add_argument("--expected-aab-sha256", default="")
    parser.add_argument("--expected-version-code", default=None, type=positive_int)
    parser.add_argument("--track", default="internal")
    parser.add_argument("--release-name", required=True)
    parser.add_argument(
        "--release-status",
        choices=["draft", "completed"],
        default="draft",
    )
    parser.add_argument(
        "--release-notes-json",
        default=os.environ.get("RELEASE_NOTES_JSON") or "",
    )
    parser.add_argument(
        "--promote",
        action="store_true",
        help="Move an already-uploaded build from one track to another.",
    )
    parser.add_argument("--promote-from-track", default="internal")
    parser.add_argument("--promote-to-track", default="production")
    parser.add_argument("--promote-version-code", default=None, type=positive_int)
    parser.add_argument(
        "--rollout",
        default=None,
        type=rollout_fraction,
        help="Staged rollout fraction in (0, 1]. Promotion only.",
    )
    parser.add_argument("--changes-not-sent-for-review", action="store_true")
    parser.add_argument(
        "--api-timeout-seconds",
        type=positive_int,
        default=positive_int(os.environ.get("GOOGLE_PLAY_API_TIMEOUT_SECONDS", "300")),
    )
    parser.add_argument(
        "--api-retries",
        type=non_negative_int,
        default=non_negative_int(os.environ.get("GOOGLE_PLAY_API_RETRIES", "5")),
    )
    args = parser.parse_args()

    # 모드마다 필수 인자가 다르다. argparse 의 required 로는 갈라낼 수 없어 여기서 본다.
    if args.promote:
        if args.promote_version_code is None:
            parser.error("--promote requires --promote-version-code")
        for name in ("aab_path", "expected_aab_sha256"):
            if getattr(args, name):
                parser.error(f"--{name.replace('_', '-')} is not valid with --promote")
        if args.expected_version_code is not None:
            parser.error("--expected-version-code is not valid with --promote")
    else:
        if args.rollout is not None:
            parser.error("--rollout requires --promote")
        for name in ("aab_path", "expected_aab_sha256"):
            if not getattr(args, name):
                parser.error(f"--{name.replace('_', '-')} is required without --promote")
        if args.expected_version_code is None:
            parser.error("--expected-version-code is required without --promote")
    return args


def main() -> int:
    args = parse_args()
    try:
        result = promote(args) if args.promote else upload(args)
    except PublicFailure as error:
        print(error.code, file=sys.stderr)
        return 1
    except Exception:
        print(
            "GOOGLE_PLAY_PROMOTE_FAILED" if args.promote else "GOOGLE_PLAY_UPLOAD_FAILED",
            file=sys.stderr,
        )
        return 1
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())

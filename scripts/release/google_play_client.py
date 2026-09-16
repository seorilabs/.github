#!/usr/bin/env python3
"""Shared, secret-free Android Publisher client construction.

Extracted so the uploader and the read-only version-code readback use exactly one
credential resolution path. Application Default Credentials only: this module never
learns a key path, never opens one, and never prints provider error text — only the
allowlisted failure codes below reach CI output.
"""

from __future__ import annotations

import argparse


ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher"
MAX_VERSION_CODE = 2_100_000_000


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

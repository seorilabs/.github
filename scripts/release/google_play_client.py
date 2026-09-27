#!/usr/bin/env python3
"""Shared, secret-free Android Publisher client construction.

Extracted so the uploader and the read-only version-code readback use exactly one
credential resolution path. Application Default Credentials only: this module never
learns a key path, never opens one, and never prints provider error text — only failure codes, numeric HTTP statuses and fixed diagnostic labels reach CI output.
"""

from __future__ import annotations

import argparse
import json


ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher"
MAX_VERSION_CODE = 2_100_000_000


class PublicFailure(RuntimeError):
    """An allowlisted, secret-free failure suitable for CI output."""

    def __init__(self, code: str, diagnostic: str = ""):
        super().__init__(f"{code} [{diagnostic}]" if diagnostic else code)
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
    except Exception as error:
        raise PublicFailure("GOOGLE_PLAY_AUTH_FAILED", safe_diagnostic(error)) from error



def safe_diagnostic(error: Exception) -> str:
    """Only fixed labels and numeric HTTP status escape; provider messages never do."""
    labels = []
    status = getattr(getattr(error, "resp", None), "status", None)
    if type(status) is int and 400 <= status <= 599:
        labels.append(f"HTTP_{status}")
    # RefreshError can contain a token response, IAM error, URL or bearer token.
    # Inspect it only to select constant categories; never echo any source text.
    message = str(error)
    if "iam.serviceAccounts.getAccessToken" in message and "denied" in message.lower():
        labels.append("IAM_GET_ACCESS_TOKEN_DENIED")
    if "ACCESS_TOKEN_SCOPE_INSUFFICIENT" in message:
        labels.append("ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    if type(error).__name__ == "RefreshError" and type(error).__module__.startswith("google.auth"):
        labels.append("AUTH_REFRESH_FAILED")
    content = getattr(error, "content", None)
    if isinstance(content, (bytes, str)):
        try:
            parsed = json.loads(content)
            payload = parsed.get("error", {}) if isinstance(parsed, dict) else {}
            if isinstance(payload, dict):
                for item in payload.get("errors", []):
                    if isinstance(item, dict):
                        reason = item.get("reason")
                        if reason in {"authError", "forbidden", "insufficientPermissions", "accessNotConfigured", "notFound", "rateLimitExceeded", "userRateLimitExceeded", "backendError"}:
                            labels.append(reason)
        except (ValueError, TypeError):
            pass
    return ",".join(dict.fromkeys(labels))


def execute(request, retries: int, failure_code: str):
    try:
        return request.execute(num_retries=retries)
    except Exception as error:
        raise PublicFailure(failure_code, safe_diagnostic(error)) from error

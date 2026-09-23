#!/usr/bin/env python3
"""Add portfolio-approved testers to the shared Seorilabs Play test group.

The private CSV is an execution input, never a repository manifest. Google Groups
for Business and a credential scoped to this group's membership are required.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import stat
import sys
from pathlib import Path

from google_play_client import PublicFailure, fail


GROUP = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+%-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
SCOPE = "https://www.googleapis.com/auth/cloud-identity.groups"
BASE = "https://cloudidentity.googleapis.com/v1"
CONSENT_SCOPE = "seorilabs-play-portfolio"
REQUIRED = {"email", "consentScope", "consentedAt", "approvedAt", "status"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--group-email", required=True)
    parser.add_argument("--approved-csv", required=True)
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args(argv)


def approved_emails(path: Path) -> set[str]:
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        fail("TESTER_ROSTER_FILE_UNSAFE")
    try:
        with path.open(newline="", encoding="utf-8-sig") as stream:
            reader = csv.DictReader(stream)
            if not reader.fieldnames or not REQUIRED.issubset(reader.fieldnames):
                fail("TESTER_ROSTER_COLUMNS_INVALID")
            rows = list(reader)
    except (OSError, UnicodeError, csv.Error):
        fail("TESTER_ROSTER_READ_FAILED")
    emails: set[str] = set()
    for row in rows:
        if row["status"] != "approved":
            continue
        if row["consentScope"] != CONSENT_SCOPE:
            fail("TESTER_ROSTER_SCOPE_INVALID")
        email = row["email"].strip().lower()
        if not GROUP.fullmatch(email) or not row["consentedAt"].strip() or not row["approvedAt"].strip():
            fail("TESTER_ROSTER_APPROVAL_INVALID")
        try:
            consented = dt.date.fromisoformat(row["consentedAt"].strip())
            approved = dt.date.fromisoformat(row["approvedAt"].strip())
        except ValueError:
            fail("TESTER_ROSTER_APPROVAL_INVALID")
        if approved < consented or approved > dt.datetime.now(dt.UTC).date():
            fail("TESTER_ROSTER_APPROVAL_INVALID")
        emails.add(email)
    return emails


def request_json(session, method: str, url: str, code: str, **kwargs) -> dict:
    try:
        response = session.request(method, url, timeout=30, **kwargs)
        response.raise_for_status()
        data = response.json()
        if not isinstance(data, dict):
            fail(code)
        return data
    except PublicFailure:
        raise
    except Exception as error:
        raise PublicFailure(code) from error


def group_members(session, group_name: str) -> set[str]:
    members: set[str] = set()
    token = ""
    while True:
        params = {"pageSize": 1000}
        if token:
            params["pageToken"] = token
        data = request_json(session, "GET", f"{BASE}/{group_name}/memberships", "WORKSPACE_GROUP_MEMBERS_READ_FAILED", params=params)
        page = data.get("memberships", [])
        if not isinstance(page, list):
            fail("WORKSPACE_GROUP_MEMBERS_RESPONSE_INVALID")
        for member in page:
            key = member.get("preferredMemberKey") if isinstance(member, dict) else None
            email = key.get("id") if isinstance(key, dict) else None
            if not isinstance(email, str) or not GROUP.fullmatch(email):
                fail("WORKSPACE_GROUP_MEMBERS_RESPONSE_INVALID")
            members.add(email.lower())
        token = data.get("nextPageToken", "")
        if token and not isinstance(token, str):
            fail("WORKSPACE_GROUP_MEMBERS_RESPONSE_INVALID")
        if not token:
            return members


def sync(args: argparse.Namespace, session=None) -> dict[str, object]:
    if not GROUP.fullmatch(args.group_email):
        fail("WORKSPACE_GROUP_EMAIL_INVALID")
    approved = approved_emails(Path(args.approved_csv))
    if session is None:
        try:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession
            credentials, _ = google.auth.default(scopes=[SCOPE])
            session = AuthorizedSession(credentials)
        except Exception as error:
            raise PublicFailure("WORKSPACE_GROUP_AUTH_FAILED") from error
    group = request_json(session, "GET", f"{BASE}/groups:lookup", "WORKSPACE_GROUP_LOOKUP_FAILED", params={"groupKey.id": args.group_email})
    name = group.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"groups/[A-Za-z0-9_-]+", name):
        fail("WORKSPACE_GROUP_LOOKUP_INVALID")
    existing = group_members(session, name)
    missing = sorted(approved - existing)
    if args.apply:
        for email in missing:
            request_json(session, "POST", f"{BASE}/{name}/memberships", "WORKSPACE_GROUP_MEMBER_ADD_FAILED", json={"preferredMemberKey": {"id": email}, "roles": [{"name": "MEMBER"}]})
        if not approved.issubset(group_members(session, name)):
            fail("WORKSPACE_GROUP_READBACK_MISMATCH")
    # Personal addresses and exact roster membership stay out of CI output.
    return {"consentScope": CONSENT_SCOPE, "groupEmail": args.group_email, "approvedCount": len(approved), "alreadyMemberCount": len(approved & existing), "pendingCount": len(missing), "applied": args.apply and bool(missing)}


def main(argv: list[str]) -> int:
    try:
        print(json.dumps(sync(parse_args(argv)), ensure_ascii=False))
        return 0
    except PublicFailure as error:
        sys.stderr.write(f"{error.code}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

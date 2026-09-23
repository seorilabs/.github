#!/usr/bin/env python3
"""Read or add one Google Group to an existing Play closed-testing track.

This manages track access only. It cannot observe individual opt-ins or certify
the 12-tester/14-day production-access requirement.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

from google_play_client import PublicFailure, execute, fail, make_publisher, non_negative_int, positive_int


PACKAGE = re.compile(r"^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$")
TRACK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$")
GROUP = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+%-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--package-name", required=True)
    parser.add_argument("--track", default="closed")
    parser.add_argument("--group-email", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--api-timeout-seconds", type=positive_int, default=300)
    parser.add_argument("--api-retries", type=non_negative_int, default=5)
    return parser.parse_args(argv)


def desired_groups(current: object, group: str) -> list[str]:
    if not isinstance(current, list) or any(not isinstance(item, str) for item in current):
        fail("GOOGLE_PLAY_TESTERS_RESPONSE_INVALID")
    return sorted(set(current) | {group})


def manage(args: argparse.Namespace) -> dict[str, object]:
    if not PACKAGE.fullmatch(args.package_name):
        fail("GOOGLE_PLAY_PACKAGE_NAME_INVALID")
    if not TRACK.fullmatch(args.track) or args.track in {"internal", "open", "production"}:
        fail("GOOGLE_PLAY_CLOSED_TRACK_INVALID")
    if not GROUP.fullmatch(args.group_email):
        fail("GOOGLE_PLAY_GROUP_EMAIL_INVALID")

    publisher = make_publisher(args.api_timeout_seconds)
    edits = publisher.edits()
    edit = execute(edits.insert(packageName=args.package_name, body={}), args.api_retries, "GOOGLE_PLAY_EDIT_CREATE_FAILED")
    edit_id = edit.get("id") if isinstance(edit, dict) else None
    if not isinstance(edit_id, str) or not edit_id:
        fail("GOOGLE_PLAY_EDIT_RESPONSE_INVALID")
    committed = False
    try:
        testers = edits.testers()
        observed = execute(testers.get(packageName=args.package_name, editId=edit_id, track=args.track), args.api_retries, "GOOGLE_PLAY_TESTERS_READ_FAILED")
        if not isinstance(observed, dict):
            fail("GOOGLE_PLAY_TESTERS_RESPONSE_INVALID")
        current = observed.get("googleGroups", [])
        wanted = desired_groups(current, args.group_email)
        changed = wanted != sorted(set(current))
        if args.apply and changed:
            execute(testers.update(packageName=args.package_name, editId=edit_id, track=args.track, body={"googleGroups": wanted}), args.api_retries, "GOOGLE_PLAY_TESTERS_UPDATE_FAILED")
            execute(edits.commit(packageName=args.package_name, editId=edit_id), args.api_retries, "GOOGLE_PLAY_EDIT_COMMIT_FAILED")
            committed = True
        result = {"packageName": args.package_name, "track": args.track, "groupEmail": args.group_email, "changed": changed, "applied": bool(args.apply and changed), "googleGroups": wanted if args.apply else current}
    finally:
        if not committed:
            execute(edits.delete(packageName=args.package_name, editId=edit_id), args.api_retries, "GOOGLE_PLAY_EDIT_CLEANUP_FAILED")

    if result["applied"]:
        # A fresh edit is the API readback; Console state and tester opt-ins still need checking.
        verify = execute(edits.insert(packageName=args.package_name, body={}), args.api_retries, "GOOGLE_PLAY_EDIT_CREATE_FAILED")
        verify_id = verify.get("id") if isinstance(verify, dict) else None
        if not isinstance(verify_id, str) or not verify_id:
            fail("GOOGLE_PLAY_EDIT_RESPONSE_INVALID")
        try:
            readback = execute(edits.testers().get(packageName=args.package_name, editId=verify_id, track=args.track), args.api_retries, "GOOGLE_PLAY_TESTERS_READ_FAILED")
            if not isinstance(readback, dict) or args.group_email not in readback.get("googleGroups", []):
                fail("GOOGLE_PLAY_TESTERS_READBACK_MISMATCH")
            result["googleGroups"] = readback["googleGroups"]
        finally:
            execute(edits.delete(packageName=args.package_name, editId=verify_id), args.api_retries, "GOOGLE_PLAY_EDIT_CLEANUP_FAILED")
    return result


def main(argv: list[str]) -> int:
    try:
        print(json.dumps(manage(parse_args(argv)), ensure_ascii=False))
        return 0
    except PublicFailure as error:
        sys.stderr.write(f"{error.code}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

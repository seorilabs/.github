#!/usr/bin/env python3
"""Summarize private, manually verified Play closed-test opt-in observations.

This is an operator aid, not a Play Console eligibility decision. Never derive
opt-in from Google Group membership or infer missing dates as zero.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import stat
import sys
from pathlib import Path

from google_play_client import PublicFailure, fail


REQUIRED = {"appId", "personId", "accountType", "optedInAt", "optedOutAt", "consoleVerifiedAt", "feedbackRecordedAt"}


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app-id", required=True)
    parser.add_argument("--observations-csv", required=True)
    parser.add_argument("--as-of", default=dt.datetime.now(dt.UTC).date().isoformat())
    return parser.parse_args(argv)


def read_date(value: str) -> dt.date | None:
    if not value:
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        fail("PLAY_OPTIN_DATE_INVALID")


def audit(args: argparse.Namespace) -> dict[str, object]:
    path = Path(args.observations_csv)
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & (stat.S_IRWXG | stat.S_IRWXO):
        fail("PLAY_OPTIN_FILE_UNSAFE")
    as_of = read_date(args.as_of)
    if as_of is None:
        fail("PLAY_OPTIN_DATE_INVALID")
    try:
        with path.open(newline="", encoding="utf-8-sig") as stream:
            reader = csv.DictReader(stream)
            if not reader.fieldnames or not REQUIRED.issubset(reader.fieldnames):
                fail("PLAY_OPTIN_COLUMNS_INVALID")
            rows = [row for row in reader if row["appId"] == args.app_id]
    except (OSError, UnicodeError, csv.Error):
        fail("PLAY_OPTIN_READ_FAILED")

    eligible_people: set[str] = set()
    active_people: set[str] = set()
    feedback_people: set[str] = set()
    for row in rows:
        person = row["personId"].strip()
        if not person or row["accountType"] not in {"independent", "owner-qa"}:
            fail("PLAY_OPTIN_ROW_INVALID")
        start = read_date(row["optedInAt"].strip())
        end = read_date(row["optedOutAt"].strip())
        verified = read_date(row["consoleVerifiedAt"].strip())
        feedback = read_date(row["feedbackRecordedAt"].strip())
        if end and (not start or end < start):
            fail("PLAY_OPTIN_ROW_INVALID")
        if row["accountType"] == "owner-qa" or not start or not verified or verified > as_of or end:
            continue
        active_people.add(person)
        if (as_of - start).days >= 14:
            eligible_people.add(person)
        if feedback and feedback <= as_of:
            feedback_people.add(person)
    return {
        "appId": args.app_id,
        "asOf": as_of.isoformat(),
        "observedIndependentActivePeople": len(active_people),
        "observedIndependentPeopleAt14Days": len(eligible_people),
        "peopleWithRecordedFeedback": len(feedback_people),
        "candidateForConsoleReview": len(eligible_people) >= 12,
        "productionAccessVerified": False,
        "source": "operator-entered-console-observations",
    }


def main(argv: list[str]) -> int:
    try:
        print(json.dumps(audit(parse_args(argv)), ensure_ascii=False))
        return 0
    except PublicFailure as error:
        sys.stderr.write(f"{error.code}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

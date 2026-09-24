"""Safety checks for closed-test access and eligibility observations."""

import argparse
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts" / "release"


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


import sys
sys.path.insert(0, str(SCRIPTS))
play = load("manage_google_play_testers", "manage-google-play-testers.py")
workspace = load("sync_workspace_testers", "sync-workspace-testers.py")
audit = load("audit_google_play_closed_test", "audit-google-play-closed-test.py")


class FakeRequest:
    def __init__(self, value):
        self.value = value

    def execute(self, num_retries=0):
        return self.value


class FakeTesters:
    def __init__(self, groups):
        self.groups = groups
        self.updates = 0

    def get(self, **_):
        return FakeRequest({"googleGroups": list(self.groups)})

    def update(self, body, **_):
        self.updates += 1
        self.groups = body["googleGroups"]
        return FakeRequest({"googleGroups": list(self.groups)})


class FakeEdits:
    def __init__(self, groups):
        self.testers_api = FakeTesters(groups)
        self.commits = 0
        self.deletes = 0

    def insert(self, **_):
        return FakeRequest({"id": "edit-1"})

    def testers(self):
        return self.testers_api

    def commit(self, **_):
        self.commits += 1
        return FakeRequest({})

    def delete(self, **_):
        self.deletes += 1
        return FakeRequest({})


class FakePublisher:
    def __init__(self, groups):
        self.edits_api = FakeEdits(groups)

    def edits(self):
        return self.edits_api


class FakeSession:
    def __init__(self):
        self.members = {"existing@example.com"}
        self.posts = 0

    def request(self, method, url, **kwargs):
        if url.endswith("groups:lookup"):
            value = {"name": "groups/123"}
        elif method == "GET":
            value = {"memberships": [{"preferredMemberKey": {"id": address}} for address in self.members]}
        elif method == "POST":
            self.posts += 1
            self.members.add(kwargs["json"]["preferredMemberKey"]["id"])
            value = {"done": True}
        return type("Response", (), {"raise_for_status": lambda self: None, "json": lambda self: value})()


class ClosedTestingTests(unittest.TestCase):
    def test_play_group_update_preserves_existing_and_is_idempotent(self):
        publisher = FakePublisher(["old@example.com"])
        args = argparse.Namespace(package_name="com.seorilabs.example", track="closed", group_email="new@example.com", apply=True, api_timeout_seconds=30, api_retries=0)
        with patch.object(play, "make_publisher", return_value=publisher):
            first = play.manage(args)
            second = play.manage(args)
        self.assertTrue(first["applied"])
        self.assertFalse(second["changed"])
        self.assertEqual(publisher.edits_api.testers_api.groups, ["new@example.com", "old@example.com"])
        self.assertEqual(publisher.edits_api.commits, 1)

    def test_workspace_only_adds_approved_consented_rows_once(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "roster.csv"
            path.write_text("email,consentScope,consentedAt,approvedAt,status\nnew@example.com,seorilabs-play-portfolio,2026-09-01,2026-09-02,approved\nignored@example.com,,,,pending\n", encoding="utf-8")
            os.chmod(path, 0o600)
            session = FakeSession()
            args = argparse.Namespace(group_email="test@example.com", group_kind="portfolio", app_id=None, approved_csv=str(path), apply=True)
            self.assertTrue(workspace.sync(args, session)["applied"])
            self.assertFalse(workspace.sync(args, session)["applied"])
            self.assertEqual(session.posts, 1)
            self.assertNotIn("ignored@example.com", session.members)

    def test_app_group_requires_both_consents_and_isolates_other_apps(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "roster.csv"
            path.write_text("email,consentScope,consentedAt,approvedAt,status\napp@example.com,seorilabs-play-portfolio,2026-09-01,2026-09-02,approved\napp@example.com,app:com.seorilabs.first,2026-09-03,2026-09-04,approved\nother@example.com,seorilabs-play-portfolio,2026-09-01,2026-09-02,approved\nother@example.com,app:com.seorilabs.second,2026-09-03,2026-09-04,approved\n", encoding="utf-8")
            os.chmod(path, 0o600)
            session = FakeSession()
            args = argparse.Namespace(group_email="first@example.com", group_kind="app", app_id="com.seorilabs.first", approved_csv=str(path), apply=True)
            self.assertTrue(workspace.sync(args, session)["applied"])
            self.assertFalse(workspace.sync(args, session)["applied"])
            self.assertIn("app@example.com", session.members)
            self.assertNotIn("other@example.com", session.members)
            self.assertEqual(session.posts, 1)

    def test_app_only_consent_cannot_join_either_group(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "roster.csv"
            path.write_text("email,consentScope,consentedAt,approvedAt,status\napp@example.com,app:com.seorilabs.first,2026-09-01,2026-09-02,approved\n", encoding="utf-8")
            os.chmod(path, 0o600)
            self.assertEqual(workspace.approved_emails(path, "portfolio", None), set())
            with self.assertRaisesRegex(Exception, "TESTER_ROSTER_PORTFOLIO_CONSENT_MISSING"):
                workspace.approved_emails(path, "app", "com.seorilabs.first")

    def test_withdrawn_portfolio_consent_blocks_app_group(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "roster.csv"
            path.write_text("email,consentScope,consentedAt,approvedAt,status\napp@example.com,seorilabs-play-portfolio,2026-09-01,2026-09-02,withdrawn\napp@example.com,app:com.seorilabs.first,2026-09-03,2026-09-04,approved\n", encoding="utf-8")
            os.chmod(path, 0o600)
            with self.assertRaisesRegex(Exception, "TESTER_ROSTER_PORTFOLIO_CONSENT_MISSING"):
                workspace.approved_emails(path, "app", "com.seorilabs.first")

    def test_qa_accounts_and_group_membership_do_not_satisfy_requirement(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "optins.csv"
            path.write_text("appId,personId,accountType,optedInAt,optedOutAt,consoleVerifiedAt,feedbackRecordedAt\nexample,p1,independent,2026-09-01,,2026-09-15,2026-09-05\nexample,p1,independent,2026-09-01,,2026-09-15,\nexample,owner,owner-qa,2026-09-01,,2026-09-15,\nexample,p2,independent,2026-09-01,2026-09-10,2026-09-15,\n", encoding="utf-8")
            os.chmod(path, 0o600)
            report = audit.audit(argparse.Namespace(app_id="example", observations_csv=str(path), as_of="2026-09-16"))
        self.assertEqual(report["observedIndependentPeopleAt14Days"], 1)
        self.assertFalse(report["candidateForConsoleReview"])
        self.assertFalse(report["productionAccessVerified"])


if __name__ == "__main__":
    unittest.main()

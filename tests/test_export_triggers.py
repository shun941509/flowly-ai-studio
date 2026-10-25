"""Trigger security/durability tests. Runner responses are mocked; HTTP is loopback only."""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import hmac
from http.client import HTTPConnection
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("flowly_trigger_tests", ROOT / "export-runtime" / "flowly_triggers.py")
triggers = importlib.util.module_from_spec(spec)
spec.loader.exec_module(triggers)

# Synthetic fixture only. No real env file, model or MCP connection is read or called.
SECRET = b"synthetic-test-trigger-secret-32-characters"


class MockLauncher(triggers.Launcher):
    """Exercise real receipts/dispatch code with an explicitly mocked CLI boundary."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls = []
        self.inputs = []
        self.result = {"id": "mock-run-1", "status": "succeeded"}
        self.status_result = {"id": "mock-run-1", "status": "succeeded"}
        self.failure = None

    def cli(self, args):
        self.assert_package()
        self.calls.append(list(args))
        if args[0] == "status":
            return self.status_result.copy()
        self.inputs.append(Path(args[2]).read_text(encoding="utf-8"))
        if self.failure:
            raise self.failure
        return self.result.copy()


class FakeClock:
    def __init__(self, now=1_800_000_000.0):
        self.now = now
        self.sleeps = []

    def time(self):
        return self.now

    def sleep(self, duration):
        self.sleeps.append(duration)
        self.now += duration


class TriggerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="flowly-triggers-test-")
        self.root = Path(self.temp.name)
        self.package_path = self.root / "workflow.json"
        self.env_path = self.root / ".env"
        self.env_path.write_text("FLOWLY_TRIGGER_SECRET=" + SECRET.decode(), encoding="utf-8")
        self.state = self.root / ".triggers"
        self.write_package()

    def tearDown(self):
        self.temp.cleanup()

    def write_package(self, kind="event", **config):
        self.package = {
            "format": "flowly-executable-export", "version": 1, "language": "python",
            "owner": {"userId": "fixture", "email": "fixture@example.test", "displayName": "테스트"},
            "limits": {"maxDurationMs": 120000},
            "workflow": {"definition": {"schemaVersion": 5, "nodes": [
                {"id": "start", "type": "trigger", "trigger": {
                    "kind": kind, "intervalSeconds": 10, "eventType": "test.created", **config,
                }},
                {"id": "out", "type": "output"},
            ], "edges": [{"id": "edge", "source": "start", "target": "out"}]}},
            "resources": [], "connections": [],
        }
        self.save_package()

    def save_package(self):
        self.package_path.write_text(json.dumps(self.package, ensure_ascii=False), encoding="utf-8")

    def test_supplementary_form_is_not_an_extra_trigger_entry(self):
        self.package["workflow"]["definition"]["nodes"].insert(1, {"id": "more", "type": "form", "form": {"mode": "request", "fields": [{"key": "note", "type": "text", "label": "확인", "required": True}]}})
        self.save_package()
        _, config, _ = triggers.read_package(self.package_path)
        self.assertEqual(config["kind"], "event")

    def launcher(self, cls=MockLauncher):
        return cls(self.package_path, self.env_path, self.state)

    def signed(self, raw, stamp=None, secret=SECRET):
        stamp = str(int(time.time())) if stamp is None else stamp
        return {
            "Content-Type": "application/json",
            "X-Flowly-Timestamp": stamp,
            "X-Flowly-Signature": hmac.new(secret, stamp.encode() + b"." + raw, hashlib.sha256).hexdigest(),
        }

    def event(self, event_id="event-1", **changes):
        return json.dumps({"eventId": event_id, "type": "test.created", "input": {"text": "안녕하세요"}, **changes}, ensure_ascii=False).encode()

    @contextmanager
    def listening(self, launcher):
        listener = triggers.server(launcher, 0, SECRET)
        thread = threading.Thread(target=listener.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        try:
            self.assertEqual(listener.server_address[0], "127.0.0.1")
            yield listener.server_address[1]
        finally:
            listener.shutdown()
            listener.server_close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())

    def post(self, port, raw, headers=None, path="/events"):
        connection = HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            connection.request("POST", path, body=raw, headers=self.signed(raw) if headers is None else headers)
            response = connection.getresponse()
            value = json.loads(response.read())
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            return response.status, value
        finally:
            connection.close()

    def metadata(self, launcher, key):
        with launcher.db() as db:
            row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
        return row[0] if row else None

    def test_hmac_covers_timestamp_and_exact_raw_body(self):
        body = self.event()
        stamp = "1800000000"
        signature = self.signed(body, stamp)["X-Flowly-Signature"]
        self.assertTrue(triggers.authenticate(SECRET, stamp, signature, body, now=1_800_000_000))
        for other_body, other_stamp, other_secret in ((body + b" ", stamp, SECRET), (body, "1800000001", SECRET), (body, stamp, b"different-test-secret")):
            self.assertFalse(triggers.authenticate(other_secret, other_stamp, signature, other_body, now=1_800_000_000))

    def test_hmac_expiry_and_invalid_header_formats(self):
        body, stamp = b"{}", "1800000000"
        signature = self.signed(body, stamp)["X-Flowly-Signature"]
        for difference in (-300, 300):
            self.assertTrue(triggers.authenticate(SECRET, stamp, signature, body, now=1_800_000_000 + difference))
        for difference in (-301, 301):
            self.assertFalse(triggers.authenticate(SECRET, stamp, signature, body, now=1_800_000_000 + difference))
        for invalid in (None, 1800000000, "-1800000000", "1.8e9", "1800000000 ", "999"):
            self.assertFalse(triggers.authenticate(SECRET, invalid, signature, body, now=1_800_000_000))
        for invalid in (None, 123, signature.upper(), "g" * 64, signature[:-1]):
            self.assertFalse(triggers.authenticate(SECRET, stamp, invalid, body, now=1_800_000_000))

    def test_secret_is_read_from_explicit_file_and_requires_length(self):
        self.env_path.write_text("\ufeffexport FLOWLY_TRIGGER_SECRET='" + SECRET.decode() + "'\n", encoding="utf-8")
        self.assertEqual(triggers.load_secret(self.env_path), SECRET)
        with patch.dict(os.environ, {"FLOWLY_TRIGGER_SECRET": SECRET.decode()}):
            self.env_path.write_text("OTHER_VALUE=fixture", encoding="utf-8")
            with self.assertRaises(triggers.TriggerFault): triggers.load_secret(self.env_path)
            with self.assertRaises(triggers.TriggerFault): triggers.load_secret(self.root / "missing.env")
        self.env_path.write_text("FLOWLY_TRIGGER_SECRET=short", encoding="utf-8")
        with self.assertRaises(triggers.TriggerFault): triggers.load_secret(self.env_path)

    def test_package_rejects_wrong_entry_and_interval_types(self):
        for invalid in (True, 0, 86401, "10"):
            self.write_package(intervalSeconds=invalid)
            with self.assertRaises(triggers.TriggerFault): triggers.read_package(self.package_path)
        self.write_package()
        self.package["workflow"]["definition"]["nodes"].append({"id": "other", "type": "input"})
        self.save_package()
        with self.assertRaises(triggers.TriggerFault): triggers.read_package(self.package_path)

    def test_dispatch_deduplicates_and_rejects_changed_payload(self):
        launcher = self.launcher()
        first = launcher.dispatch("event-1", {"text": "자료"})
        self.assertFalse(first["duplicate"])
        duplicate = launcher.dispatch("event-1", {"text": "자료"})
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(len(launcher.calls), 1)
        self.assertEqual(json.loads(launcher.inputs[0]), {"text": "자료"})
        with self.assertRaisesRegex(triggers.TriggerFault, "내용이 달라"):
            launcher.dispatch("event-1", {"text": "변경"})
        self.assertEqual(len(launcher.calls), 1)
        self.assertEqual(list(self.state.glob("input-*.json")), [])

    def test_completed_receipts_survive_restart(self):
        launcher = self.launcher()
        result = launcher.dispatch("event-1", "one")
        restarted = self.launcher()
        duplicate = restarted.dispatch("event-1", "one")
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["runId"], result["runId"])
        self.assertEqual(restarted.calls, [])
        self.assertEqual(restarted.receipts()[0]["status"], "succeeded")

    def test_unknown_outcome_is_persisted_and_never_automatically_retried(self):
        launcher = self.launcher()
        launcher.failure = triggers.TriggerFault("mock runner response lost")
        with self.assertRaises(triggers.TriggerFault): launcher.dispatch("event-1", "one")
        restarted = self.launcher()
        duplicate = restarted.dispatch("event-1", "one")
        self.assertEqual(duplicate["status"], "unknown_outcome")
        self.assertTrue(duplicate["duplicate"])
        with self.assertRaisesRegex(triggers.TriggerFault, "결과 확인"):
            restarted.dispatch("event-2", "two")
        self.assertEqual(restarted.calls, [])
        self.assertEqual(list(self.state.glob("input-*.json")), [])

    def test_interrupted_dispatch_marker_blocks_further_execution(self):
        launcher = self.launcher()
        with launcher.db() as db:
            db.execute("INSERT INTO receipts VALUES ('interrupted','digest','dispatching',NULL,?)", (time.time(),))
            db.commit()
        restarted = self.launcher()
        with self.assertRaises(triggers.TriggerFault): restarted.dispatch("event-2", "two")
        self.assertEqual(restarted.calls, [])
        self.assertEqual(restarted.receipts()[0]["status"], "dispatching")

    def test_approval_review_and_input_waits_poll_status_only_until_terminal(self):
        for status in ("waiting_approval", "waiting_review", "waiting_input"):
            with self.subTest(status=status):
                self.state = self.root / status
                launcher = self.launcher()
                launcher.result["status"] = status
                launcher.dispatch("first", "one")
                launcher.status_result["status"] = status
                with self.assertRaises(triggers.TriggerFault): launcher.dispatch("second", "two")
                self.assertEqual([args[0] for args in launcher.calls], ["run", "status"])
                launcher.status_result["status"] = "succeeded"
                launcher.result["status"] = "succeeded"
                launcher.dispatch("second", "two")
                self.assertEqual([args[0] for args in launcher.calls], ["run", "status", "status", "run"])

    def test_invalid_event_ids_and_oversize_input_never_dispatch(self):
        launcher = self.launcher()
        for invalid in (None, 1, "", "../escape", "안녕", "a" * 161):
            with self.assertRaises(triggers.TriggerFault): launcher.dispatch(invalid, "one")
        with self.assertRaises(triggers.TriggerFault): launcher.dispatch("large", "한" * 26667)
        with self.assertRaises(ValueError): launcher.dispatch("nan", {"value": float("nan")})
        self.assertEqual(launcher.calls, [])
        self.assertEqual(launcher.receipts(), [])

    def test_changed_package_is_rejected_before_cli_and_on_restart(self):
        launcher = self.launcher(triggers.Launcher)
        self.package_path.write_bytes(self.package_path.read_bytes() + b" ")
        with patch.object(triggers.subprocess, "run") as run:
            with self.assertRaises(triggers.TriggerFault): launcher.cli(["status", "fixture"])
            run.assert_not_called()
        with self.assertRaises(triggers.TriggerFault): self.launcher()

    def test_cli_does_not_inherit_provider_or_trigger_secrets(self):
        launcher = self.launcher(triggers.Launcher)
        result = subprocess.CompletedProcess([], 0, b'{"id":"mock-run-1","status":"succeeded"}', b"")
        with patch.dict(os.environ, {"OPENAI_API_KEY": "synthetic-never-real", "FLOWLY_TRIGGER_SECRET": "synthetic-never-inherited", "FLOWLY_MCP_TOKEN_TEST": "synthetic-mcp"}):
            with patch.object(triggers.subprocess, "run", return_value=result) as run:
                self.assertEqual(launcher.dispatch("one", "input")["status"], "succeeded")
                args, kwargs = run.call_args
                for key in ("OPENAI_API_KEY", "FLOWLY_TRIGGER_SECRET", "FLOWLY_MCP_TOKEN_TEST"):
                    self.assertNotIn(key, kwargs["env"])
                self.assertEqual(args[0][-2:], ["--env", str(self.env_path)])
                self.assertEqual(kwargs["cwd"], self.root)

    def test_malformed_cli_result_is_unknown_and_blocks_new_run(self):
        launcher = self.launcher(triggers.Launcher)
        result = subprocess.CompletedProcess([], 1, b"not JSON", b"sensitive-mock-stderr")
        with patch.object(triggers.subprocess, "run", return_value=result) as run:
            with self.assertRaises(triggers.TriggerFault) as failure: launcher.dispatch("one", "input")
            self.assertNotIn("sensitive-mock", str(failure.exception))
            with self.assertRaises(triggers.TriggerFault): launcher.dispatch("two", "input")
            self.assertEqual(run.call_count, 1)
        self.assertEqual(launcher.receipts()[0]["status"], "unknown_outcome")

    def test_loopback_hmac_failure_expiry_wrong_type_and_bad_schema(self):
        launcher = self.launcher()
        with self.listening(launcher) as port:
            raw = self.event()
            self.assertEqual(self.post(port, raw, {"Content-Type": "application/json"})[0], 401)
            self.assertEqual(self.post(port, raw, self.signed(raw, str(int(time.time()) - 301)))[0], 401)
            self.assertEqual(self.post(port, raw + b" ", self.signed(raw))[0], 401)
            self.assertEqual(self.post(port, self.event(type="wrong.type"))[0], 422)
            self.assertEqual(self.post(port, self.event(type=42))[0], 400)
            self.assertEqual(self.post(port, self.event(extra="forbidden"))[0], 400)
            self.assertEqual(self.post(port, b"[]")[0], 400)
            self.assertEqual(self.post(port, b"{bad")[0], 400)
        self.assertEqual(launcher.calls, [])
        self.assertEqual(launcher.receipts(), [])

    def test_loopback_accepts_valid_and_deduplicates_after_server_restart(self):
        launcher = self.launcher()
        raw = self.event()
        with self.listening(launcher) as port:
            code, first = self.post(port, raw)
            self.assertEqual(code, 202)
            self.assertFalse(first["duplicate"])
            self.assertEqual(self.post(port, raw)[0], 200)
            self.assertEqual(self.post(port, self.event(input="changed"))[0], 409)
            self.assertEqual(self.post(port, raw + b" ")[0], 409)
        self.assertEqual(len(launcher.calls), 1)
        restarted = self.launcher()
        with self.listening(restarted) as port:
            code, duplicate = self.post(port, raw)
            self.assertEqual(code, 200)
            self.assertTrue(duplicate["duplicate"])
            self.assertEqual(duplicate["runId"], first["runId"])
        self.assertEqual(restarted.calls, [])

    def test_loopback_unknown_blocks_new_event_without_retry(self):
        launcher = self.launcher()
        launcher.failure = triggers.TriggerFault("mock result unavailable")
        with self.listening(launcher) as port:
            self.assertEqual(self.post(port, self.event())[0], 409)
            code, duplicate = self.post(port, self.event())
            self.assertEqual(code, 200)
            self.assertEqual(duplicate["status"], "unknown_outcome")
            self.assertEqual(self.post(port, self.event("new-event"))[0], 409)
        self.assertEqual(len(launcher.calls), 1)

    def test_loopback_content_type_transfer_encoding_path_and_size(self):
        launcher = self.launcher()
        with self.listening(launcher) as port:
            raw = self.event()
            self.assertEqual(self.post(port, raw, path="/wrong")[0], 404)
            self.assertEqual(self.post(port, raw, {**self.signed(raw), "Content-Type": "text/plain"})[0], 415)
            self.assertEqual(self.post(port, raw, {**self.signed(raw), "Transfer-Encoding": "chunked"})[0], 415)
            self.assertEqual(self.post(port, b"")[0], 413)
            self.assertEqual(self.post(port, raw, {**self.signed(raw), "Content-Length": "100001"})[0], 413)
            self.assertEqual(self.post(port, self.event(input="a" * 80001))[0], 409)
        self.assertEqual(launcher.calls, [])

    def test_rejected_headers_preserve_status_when_small_body_arrives_later(self):
        launcher = self.launcher()
        with self.listening(launcher) as port:
            raw = self.event()
            for path, extra, expected in (("/wrong", {}, 404), ("/events", {"Content-Type": "text/plain"}, 415), ("/events", {"Content-Length": "100001"}, 413)):
                with self.subTest(status=expected):
                    connection = HTTPConnection("127.0.0.1", port, timeout=3)
                    try:
                        connection.putrequest("POST", path)
                        for key, value in {**self.signed(raw), "Content-Length": str(len(raw)), **extra}.items():
                            connection.putheader(key, value)
                        connection.endheaders()
                        time.sleep(.02)
                        connection.send(raw)
                        response = connection.getresponse()
                        self.assertEqual(response.status, expected)
                        self.assertIn("error", json.loads(response.read()))
                    finally:
                        connection.close()
        self.assertEqual(launcher.calls, [])
        self.assertEqual(launcher.receipts(), [])

    def test_oversize_rejection_does_not_block_following_event_on_missing_body(self):
        launcher = self.launcher()
        with self.listening(launcher) as port:
            connection = HTTPConnection("127.0.0.1", port, timeout=2)
            try:
                raw = self.event()
                started = time.monotonic()
                connection.request("POST", "/events", b"", {**self.signed(raw), "Content-Length": "100001"})
                response = connection.getresponse()
                self.assertEqual(response.status, 413)
                self.assertIn("error", json.loads(response.read()))
                # Keep the rejected sender open. The single-threaded listener
                # must finish its bounded discard and accept the next event.
                self.assertEqual(self.post(port, raw)[0], 202)
                self.assertLess(time.monotonic() - started, 1)
            finally:
                connection.close()
        self.assertEqual(len(launcher.calls), 1)

    def test_webhook_accepts_signed_custom_event_type(self):
        self.write_package("webhook")
        launcher = self.launcher()
        with self.listening(launcher) as port:
            self.assertEqual(self.post(port, self.event(type="custom.created"))[0], 202)
        self.assertEqual(len(launcher.calls), 1)

    def test_schedule_preserves_next_tick_across_normal_restart(self):
        self.write_package("schedule")
        clock = FakeClock()
        launcher = self.launcher()
        with patch.object(triggers, "time", clock):
            first = list(triggers.schedule(launcher, "scheduled", 2))
            self.assertEqual([r["eventId"] for r in first], ["schedule:1800000000000", "schedule:1800000010000"])
            self.assertEqual(float(self.metadata(launcher, "next_due")), 1_800_000_020)
            restarted = self.launcher()
            following = list(triggers.schedule(restarted, "scheduled", 1))
            self.assertEqual(following[0]["eventId"], "schedule:1800000020000")
            self.assertEqual(float(self.metadata(restarted, "next_due")), 1_800_000_030)
            self.assertEqual(len(restarted.calls), 1)

    def test_schedule_persists_next_tick_before_exposing_completed_receipt(self):
        self.write_package("schedule")
        launcher = self.launcher()
        clock = FakeClock()
        with patch.object(triggers, "time", clock):
            iterator = triggers.schedule(launcher, "scheduled", 5)
            first = next(iterator)
            iterator.close()  # Simulates interruption immediately after emitting the first receipt.
            self.assertEqual(first["eventId"], "schedule:1800000000000")
            self.assertIsNotNone(self.metadata(launcher, "next_due"))
            clock.now += 1
            restarted = self.launcher()
            following = list(triggers.schedule(restarted, "scheduled", 1))
            self.assertEqual(following[0]["eventId"], "schedule:1800000010000")

    def test_schedule_unknown_outcome_does_not_restart_at_new_current_time(self):
        self.write_package("schedule")
        launcher = self.launcher()
        launcher.failure = triggers.TriggerFault("mock runner lost")
        clock = FakeClock()
        with patch.object(triggers, "time", clock):
            with self.assertRaises(triggers.TriggerFault): list(triggers.schedule(launcher, "scheduled", 1))
            clock.now += 1
            restarted = self.launcher()
            duplicate = list(triggers.schedule(restarted, "scheduled", 1))[0]
            self.assertTrue(duplicate["duplicate"])
            self.assertEqual(duplicate["status"], "unknown_outcome")
            with self.assertRaises(triggers.TriggerFault): list(triggers.schedule(restarted, "scheduled", 1))
            self.assertEqual(restarted.calls, [])
            self.assertEqual(restarted.receipts()[0]["status"], "unknown_outcome")

    def test_schedule_stops_during_future_wait_without_dispatch(self):
        clock = FakeClock()
        start = datetime.fromtimestamp(clock.now + 60, timezone.utc).isoformat()
        self.write_package("schedule", startAt=start)
        launcher = self.launcher()
        with patch.object(triggers, "time", clock):
            self.assertEqual(list(triggers.schedule(launcher, "scheduled", 1, lambda: len(clock.sleeps) >= 2)), [])
        self.assertEqual(launcher.calls, [])
        self.assertEqual(launcher.receipts(), [])

    def test_schedule_skips_backlog_and_rejects_naive_time(self):
        clock = FakeClock()
        self.write_package("schedule", startAt="2020-01-01T00:00:00Z")
        launcher = self.launcher()
        with patch.object(triggers, "time", clock):
            receipts = list(triggers.schedule(launcher, "scheduled", 2))
            self.assertEqual(receipts[0]["eventId"], "schedule:1577836800000")
            self.assertEqual(receipts[1]["eventId"], "schedule:1800000010000")
            self.assertEqual(len(launcher.calls), 2)
        self.write_package("schedule", startAt="2025-01-01T00:00:00")
        self.state = self.root / "naive"
        with self.assertRaisesRegex(triggers.TriggerFault, "시간대"):
            list(triggers.schedule(self.launcher(), "scheduled", 1))


if __name__ == "__main__":
    unittest.main()

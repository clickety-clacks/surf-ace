#!/usr/bin/env python3
"""Pure local source test: synthetic files only, no Surf Ace or registry process."""
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time
import unittest

ROOT = pathlib.Path("/tmp/surf-ace-private-crash-fixture-inputs")
SOURCE = pathlib.Path(__file__).resolve().parent
HOOK = pathlib.Path("/tmp/surf-ace-private-binding-selector-hook.so")
vehicle_spec = importlib.util.spec_from_file_location(
    "binding_vehicle", SOURCE / "surf-ace-private-binding-crash-vehicle.py")
vehicle_module = importlib.util.module_from_spec(vehicle_spec)
vehicle_spec.loader.exec_module(vehicle_module)
CLIENT = "a" * 64
BINDING = {"allocatorId": "alloc_private_owner", "clientId": CLIENT,
           "fleetId": "fixture_private_owner"}


def encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def sha(value):
    return hashlib.sha256(value).hexdigest()


def state(bound):
    return {"registryBinding": BINDING if bound else None,
            "surfaces": [{"surfaceId": "sf_fixture_1234", "windowLabel": "d",
                "windowLabelConfirmed": True,
                "panes": [{"paneId": 2, "paneLabel": 3,
                    "paneLineageId": "pl_fixture_1234",
                    "snapshot": {"bounds": {"x": 0, "y": 0, "width": 100, "height": 100},
                        "geometryRevision": 2, "selection": None, "surfaceEpoch": 3,
                        "topologyRevision": 4, "viewport": {"width": 100, "height": 100}},
                    "history": [{"type": "text", "value": "preserved"}]}]}],
            "lockless": {"tombstones": []}}


def baseline():
    claim = {"surfaceId": "sf_fixture_1234", "windowLabel": "d",
             "panes": [{"paneId": "2", "paneLabel": 3,
                        "paneLineageId": "pl_fixture_1234"}]}
    snapshot = {"geometryRevision": 2, "selection": None,
                "surfaceEpoch": 3, "topologyRevision": 4}
    content = {"snapshot": snapshot,
               "history": [{"type": "text", "value": "preserved"}]}
    return {"clientId": CLIENT, "confirmedClaims": [claim],
            "contentDigests": [{"surfaceId": "sf_fixture_1234", "paneId": "2",
                                "sha256": sha(encoded(content))}]}


FAKE_WRITER = r'''
import ctypes, hashlib, json, os, pathlib, sys
home, phase, mode = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
data = home / "user-data"
(home / "browser.pid").write_text(str(os.getpid() + (1 if mode == "wrong_pid" else 0)) + "\n")
primary, selector = data / "surface-core-state.json", data / "surface-core-state.json.selector"
backup = data / "surface-core-state.json.bak"
def move(source, destination):
    if mode not in ("renameat", "renameat2"):
        os.rename(source, destination)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if mode == "renameat":
        result = libc.renameat(-100, os.fsencode(source), -100, os.fsencode(destination))
    else:
        result = libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(destination), 0)
    if result:
        raise OSError(ctypes.get_errno(), mode)
def write_cycle(bound, serial):
    obj = json.loads(primary.read_text())
    obj["registryBinding"] = json.loads((home / "binding.json").read_text()) if bound else None
    candidate = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode()
    current = primary.read_bytes()
    backup.write_bytes(current)
    pending = {"version":1,"phase":"pending","acceptedSha256":hashlib.sha256(current).hexdigest(),
               "candidateSha256":hashlib.sha256(candidate).hexdigest()}
    if mode == "bad_hash" and serial == 1:
        pending["candidateSha256"] = "c" * 64
    pending_tmp = data / ("surface-core-state.json.selector.%s.tmp" % serial)
    with open(pending_tmp, "wb") as out:
        out.write(json.dumps(pending, separators=(",", ":")).encode()); out.flush(); os.fsync(out.fileno())
    if mode != "unpaired" or serial != 1:
        move(pending_tmp, selector)
    candidate_tmp = data / ("surface-core-state.json.%s.2.abcdef.tmp" % serial)
    with open(candidate_tmp, "wb") as out:
        out.write(candidate); out.flush(); os.fsync(out.fileno())
    move(candidate_tmp, primary)
    committed = {"version":1,"phase":"committed","acceptedSha256":pending["candidateSha256"]}
    if mode == "bad_commit" and bound:
        committed["acceptedSha256"] = "d" * 64
    committed_tmp = data / ("surface-core-state.json.selector.%s.commit.tmp" % serial)
    with open(committed_tmp, "wb") as out:
        out.write(json.dumps(committed, separators=(",", ":")).encode()); out.flush(); os.fsync(out.fileno())
    move(committed_tmp, selector)
    backup.write_bytes(candidate)
write_cycle(False, 1)
write_cycle(True, 2)
if mode == "two_bound":
    (home / "second-bound-started").write_text("1\n")
    write_cycle(True, 3)
sys.exit(70)
'''


class BindingHookSourceTests(unittest.TestCase):
    def run_phase(self, phase, mode="normal"):
        ROOT.mkdir(mode=0o700, exist_ok=True)
        home = pathlib.Path(tempfile.mkdtemp(prefix="binding-source-test-", dir=ROOT))
        verifier = None
        try:
            user_data = home / "user-data"
            user_data.mkdir(mode=0o700)
            initial = encoded(state(False))
            (user_data / "surface-core-state.json").write_bytes(initial)
            (user_data / "surface-core-state.json.selector").write_bytes(encoded({
                "version": 1, "phase": "committed", "acceptedSha256": sha(initial)}))
            manifest = baseline()
            (home / "baseline-manifest.json").write_bytes(encoded(manifest))
            provisioned = {"binding": BINDING, "confirmedClaims": manifest["confirmedClaims"]}
            (user_data / "registry-binding.provisioned.json").write_bytes(encoded(provisioned))
            (home / "binding.json").write_bytes(encoded(BINDING))
            trace = home / "binding-trace.log"
            trace.touch(mode=0o600)
            socket = home / "binding-verifier.sock"
            verifier = subprocess.Popen(["node", str(SOURCE / "surf-ace-private-binding-verifier.mjs"),
                str(socket), str(user_data), str(home / "baseline-manifest.json"),
                str(user_data / "registry-binding.provisioned.json")],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            for _ in range(100):
                if socket.exists():
                    break
                if verifier.poll() is not None:
                    self.fail("verifier_exited:" + verifier.stderr.read().decode()[-400:])
                time.sleep(0.02)
            else:
                self.fail("verifier_socket_absent")
            env = dict(os.environ)
            env.update({"LD_PRELOAD": str(HOOK), "SURF_ACE_BINDING_USER_DATA": str(user_data),
                "SURF_ACE_BINDING_SOCKET": str(socket), "SURF_ACE_BINDING_PHASE": phase,
                "SURF_ACE_BINDING_MARKER": str(home / "binding-marker"),
                "SURF_ACE_BINDING_TRACE": str(trace),
                "SURF_ACE_BINDING_BROWSER_PID_FILE": str(home / "browser.pid")})
            child = subprocess.run(["python3", "-c", FAKE_WRITER, str(home), phase, mode], env=env,
                                   capture_output=True, timeout=8, check=False)
            if mode not in ("normal", "renameat", "renameat2", "two_bound"):
                self.assertNotEqual(child.returncode, -signal.SIGKILL)
                self.assertFalse((home / "binding-marker").exists())
                if mode != "wrong_pid":
                    self.assertIn("ordering_or_verifier_invalid", trace.read_text())
                if mode == "bad_commit":
                    self.assertEqual(trace.read_text().count("event=binding_candidate "), 1)
                    self.assertNotIn("event=stop ", trace.read_text())
                    self.assertEqual(json.loads((user_data / "surface-core-state.json").read_text())["registryBinding"], BINDING)
                    self.assertEqual(json.loads((user_data / "surface-core-state.json.selector").read_text())["phase"], "pending")
                return
            self.assertEqual(child.returncode, -signal.SIGKILL, child.stderr.decode()[-200:])
            marker = (home / "binding-marker").read_text()
            self.assertIn(f"phase={phase}\n", marker)
            self.assertIn("candidateSha256=", marker)
            self.assertIn("event=binding_free", trace.read_text())
            self.assertIn("event=binding_candidate", trace.read_text())
            self.assertNotIn("ordering_or_verifier_invalid", trace.read_text())
            self.assertEqual(trace.read_text().count("event=binding_candidate "), 1)
            self.assertFalse((home / "second-bound-started").exists())
            candidate = dict(line.split("=", 1) for line in marker.splitlines())["candidateSha256"]
            record = vehicle_module.profile_state_record(user_data)
            self.assertIsNone(vehicle_module.crash_state_failure(record, phase, candidate), record)
            if phase == "before_candidate_primary_rename":
                self.assertIsNone(json.loads((user_data / "surface-core-state.json").read_text())["registryBinding"])
                self.assertEqual(json.loads((user_data / "surface-core-state.json.selector").read_text())["phase"], "pending")
            else:
                self.assertEqual(json.loads((user_data / "surface-core-state.json").read_text())["registryBinding"], BINDING)
                self.assertEqual(json.loads((user_data / "surface-core-state.json.selector").read_text())["phase"], "committed")
        finally:
            if verifier is not None:
                verifier.terminate()
                try:
                    verifier.communicate(timeout=3)
                except subprocess.TimeoutExpired:
                    verifier.kill()
                    verifier.communicate(timeout=3)
            shutil.rmtree(home)

    def test_before_candidate(self):
        self.run_phase("before_candidate_primary_rename")

    def test_after_committed(self):
        self.run_phase("after_committed_selector_rename")

    def test_renameat_before_candidate(self):
        self.run_phase("before_candidate_primary_rename", "renameat")

    def test_renameat2_after_committed(self):
        self.run_phase("after_committed_selector_rename", "renameat2")

    def test_unpaired_primary_refused(self):
        self.run_phase("before_candidate_primary_rename", "unpaired")

    def test_committed_selector_mismatch_refused(self):
        self.run_phase("after_committed_selector_rename", "bad_commit")

    def test_second_binding_cycle_unreachable_before_candidate(self):
        self.run_phase("before_candidate_primary_rename", "two_bound")

    def test_second_binding_cycle_unreachable_after_committed(self):
        self.run_phase("after_committed_selector_rename", "two_bound")

    def test_phase_record_counts_second_binding_candidate(self):
        ROOT.mkdir(mode=0o700, exist_ok=True)
        home = pathlib.Path(tempfile.mkdtemp(prefix="binding-source-test-", dir=ROOT))
        try:
            marker, trace = home / "marker", home / "trace"
            marker.write_text("phase=after_committed_selector_rename\npid=7\n"
                              + "candidateSha256=" + "b" * 64
                              + "\ndestination=/tmp/x/surface-core-state.json.selector\n")
            first, second = "a" * 64, "b" * 64
            trace.write_text(f"pid=7 event=pending sha={first}\npid=7 event=binding_candidate sha={first}\n"
                             f"pid=7 event=committed sha={first}\npid=7 event=pending sha={second}\n"
                             f"pid=7 event=binding_candidate sha={second}\npid=7 event=committed sha={second}\n"
                             f"pid=7 event=stop sha={second}\n")
            with self.assertRaisesRegex(RuntimeError, "crash_trace_invalid"):
                vehicle_module.phase_record(marker, trace, 7, "after_committed_selector_rename")
        finally:
            shutil.rmtree(home)

    def test_crash_state_rejects_disk_state_that_contradicts_phase(self):
        old, new = "1" * 64, "2" * 64
        before = {"selector": {"sha256": "3" * 64, "phase": "pending", "acceptedSha256": old,
                               "candidateSha256": new},
                  "primarySha256": old, "backupSha256": old,
                  "temporaryFiles": [{"name": "surface-core-state.json.1.2.ab.tmp", "sha256": new}]}
        after = {"selector": {"sha256": "3" * 64, "phase": "committed", "acceptedSha256": new,
                              "candidateSha256": None},
                 "primarySha256": new, "backupSha256": old, "temporaryFiles": []}
        check = vehicle_module.crash_state_failure
        self.assertIsNone(check(before, "before_candidate_primary_rename", new))
        self.assertIsNone(check(after, "after_committed_selector_rename", new))
        cases = [
            (before, "before_candidate_primary_rename", {"selector": dict(before["selector"], phase="committed")},
             "crash_state_selector_not_pending_candidate"),
            (before, "before_candidate_primary_rename", {"selector": dict(before["selector"], candidateSha256=old)},
             "crash_state_selector_not_pending_candidate"),
            (before, "before_candidate_primary_rename", {"primarySha256": new}, "crash_state_primary_changed"),
            (before, "before_candidate_primary_rename", {"temporaryFiles": []},
             "crash_state_candidate_temporary_missing"),
            (before, "before_candidate_primary_rename", {"primarySha256": "linked"}, "crash_state_file_invalid"),
            (after, "after_committed_selector_rename", {"primarySha256": old}, "crash_state_primary_not_candidate"),
            (after, "after_committed_selector_rename", {"selector": dict(after["selector"], phase="pending")},
             "crash_state_selector_not_committed_candidate"),
            (after, "after_committed_selector_rename", {"backupSha256": new}, "crash_state_backup_not_lagging"),
            (after, "after_committed_selector_rename", {"backupSha256": None}, "crash_state_backup_not_lagging"),
            (after, "after_committed_selector_rename", {"selector": {"sha256": "3" * 64, "parseFailed": True}},
             "crash_state_file_invalid"),
        ]
        for record, phase, change, code in cases:
            with self.subTest(code=code, change=change):
                self.assertEqual(check(dict(record, **change), phase, new), code)

    def test_pre_crash_protocol_predicate(self):
        identity = (f"response op=fleet.topology ok=true fleetId={vehicle_module.base.OWNER_FLEET} "
                    f"allocatorId={vehicle_module.base.OWNER_ALLOC}")
        good_log = "2026-10-08T00:00:00.000Z request op=fleet.topology\n2026-10-08T00:00:00.001Z " + identity + "\n"
        good_diag = "event=app_ready state_dir=/tmp/x server=ws://127.0.0.1:1/ws\n"
        check = vehicle_module.pre_crash_protocol_failure
        self.assertIsNone(check(good_log, good_diag))
        owner = "pre_crash_owner_protocol_invalid"
        route = "crash_app_discovery_or_route_invalid"
        cases = [
            ("absent proxy identity", "2026-10-08T00:00:00.000Z request op=fleet.topology\n", good_diag, owner),
            ("foreign identity", good_log.replace(vehicle_module.base.OWNER_FLEET, "fixture_private_foreign"),
             good_diag, owner),
            ("topology refused", good_log + "response op=fleet.topology ok=false\n", good_diag, owner),
            ("register before stop", good_log + "request op=client.register\n", good_diag, owner),
            ("claim before stop", good_log + "request op=pane.claim\n", good_diag, owner),
            ("configured timeout", good_log, good_diag + 'server_registration_failed error_message='
             '"registry unavailable: controller_wire_timeout:fleet.topology"\n', route),
            ("DNS-SD fallback", good_log, good_diag + "DNS-SD registry fallback selected\n", route),
            ("client bonjour", good_log, good_diag + "bonjour_publish name=surf-ace\n", route),
            ("non-loopback route", good_log, good_diag + "server=ws://192.168.1.4:1/ws\n", route),
        ]
        for name, log, diag, code in cases:
            with self.subTest(name):
                self.assertEqual(check(log, diag), code)

    def test_selector_hash_mismatch_refused(self):
        self.run_phase("before_candidate_primary_rename", "bad_hash")

    def test_wrong_browser_pid_cannot_claim_stop(self):
        self.run_phase("before_candidate_primary_rename", "wrong_pid")

    def test_phase_record_rejects_pid_mismatch(self):
        ROOT.mkdir(mode=0o700, exist_ok=True)
        home = pathlib.Path(tempfile.mkdtemp(prefix="binding-source-test-", dir=ROOT))
        try:
            marker, trace = home / "marker", home / "trace"
            marker.write_text("phase=before_candidate_primary_rename\npid=7\n"
                              + "candidateSha256=" + "a" * 64
                              + "\ndestination=/tmp/x/surface-core-state.json\n")
            trace.write_text("event=binding_free \nevent=binding_candidate \nevent=stop \n")
            self.assertEqual(vehicle_module.phase_record(marker, trace, 7,
                "before_candidate_primary_rename")["pid"], 7)
            with self.assertRaisesRegex(RuntimeError, "crash_marker_identity_invalid"):
                vehicle_module.phase_record(marker, trace, 8, "before_candidate_primary_rename")
        finally:
            shutil.rmtree(home)

    def test_vehicle_cleanup_writes_failed_receipt_without_children(self):
        ROOT.mkdir(mode=0o700, exist_ok=True)
        home = pathlib.Path(tempfile.mkdtemp(prefix="binding-source-test-", dir=ROOT))
        try:
            vehicle = vehicle_module.BindingCrashVehicle("before_candidate_primary_rename",
                                                         "/no/node", "/no/pg")
            vehicle.home = home
            self.assertEqual(vehicle.cleanup(), [])
            receipt = json.loads((home / "binding-crash-receipt.json").read_text())
            self.assertEqual(receipt["status"], "failed")
            self.assertFalse(receipt["bindingCrashQualified"])
        finally:
            shutil.rmtree(home)

    def test_source_manifest_pins_every_reviewed_byte(self):
        manifest_sha, observed = vehicle_module.verified_source_manifest(SOURCE)
        self.assertRegex(manifest_sha, r"^[0-9a-f]{64}$")
        self.assertEqual(set(observed), set(vehicle_module.SOURCE_FILES))
        ROOT.mkdir(mode=0o700, exist_ok=True)
        home = pathlib.Path(tempfile.mkdtemp(prefix="binding-source-test-", dir=ROOT))
        try:
            for name in vehicle_module.SOURCE_FILES:
                shutil.copyfile(SOURCE / name, home / name)
            shutil.copyfile(SOURCE / vehicle_module.MANIFEST_NAME,
                            home / vehicle_module.MANIFEST_NAME)
            with open(home / vehicle_module.SOURCE_FILES[0], "ab") as stream:
                stream.write(b"\n")
            with self.assertRaisesRegex(RuntimeError, "source_hash_mismatch"):
                vehicle_module.verified_source_manifest(home)
        finally:
            shutil.rmtree(home)


if __name__ == "__main__":
    unittest.main()

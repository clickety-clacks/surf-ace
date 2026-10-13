#!/usr/bin/env python3
"""UNRUN private binding-bearing process-crash vehicle; exact source review required.

Run only after independent approval in a disposable lo-only/no-default-route
namespace with a fresh copied profile. This script never uses a live fleet.
"""
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

SOURCE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("foreign_baseline", SOURCE / "surf-ace-private-foreign-first-vehicle.py")
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)

PHASES = {"before_candidate_primary_rename", "after_committed_selector_rename"}
SOURCE_FILES = (
    "surf-ace-private-binding-crash-vehicle.py",
    "surf-ace-private-binding-candidate.mjs",
    "surf-ace-private-binding-verifier.mjs",
    "surf-ace-private-binding-selector-hook.c",
    "surf-ace-private-binding-crash-proxy.mjs",
    "surf-ace-private-binding-candidate.test.mjs",
    "surf-ace-private-binding-selector-hook.test.py",
    "surf-ace-private-foreign-first-vehicle.py",
    "surf-ace-private-foreign-first-claims.mjs",
    "surf-ace-private-foreign-first-seed-owner.mjs",
    "surf-ace-private-foreign-first-topology.mjs",
    "surf-ace-private-packaged-crash-guard.sh",
)
MANIFEST_NAME = "surf-ace-private-binding-source-manifest.json"


def verified_source_manifest(directory):
    manifest_path = directory / MANIFEST_NAME
    if manifest_path.is_symlink() or not manifest_path.is_file():
        base.fail("source_manifest_missing_or_linked")
    manifest = json.loads(manifest_path.read_text(encoding="utf8"))
    if not isinstance(manifest, dict) or manifest.get("version") != 1 or \
       not isinstance(manifest.get("files"), dict) or set(manifest["files"]) != set(SOURCE_FILES):
        base.fail("source_manifest_shape_invalid")
    observed = {}
    for file in SOURCE_FILES:
        target = directory / file
        expected = manifest["files"][file]
        if target.is_symlink() or not target.is_file() or \
           not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
            base.fail(f"source_invalid_{file}")
        actual = base.digest(target)
        if actual != expected:
            base.fail(f"source_hash_mismatch_{file}")
        observed[file] = actual
    return base.digest(manifest_path), observed


def phase_record(marker, trace, app_pid, phase):
    text = marker.read_text(encoding="utf8")
    fields = dict(line.split("=", 1) for line in text.splitlines())
    if fields.get("phase") != phase or fields.get("pid") != str(app_pid) or \
       not re.fullmatch(r"[0-9a-f]{64}", fields.get("candidateSha256", "")):
        base.fail("crash_marker_identity_invalid")
    events = trace.read_text(encoding="utf8")
    if events.count("event=binding_candidate ") != 1 or events.count("event=stop ") != 1 or \
       "event=ordering_or_verifier_invalid" in events or "event=phase_invalid" in events:
        base.fail("crash_trace_invalid")
    if not fields.get("destination", "").endswith(
            "surface-core-state.json" if phase.startswith("before_") else "surface-core-state.json.selector"):
        base.fail("crash_destination_invalid")
    return {"phase": phase, "pid": app_pid, "candidateSha256": fields["candidateSha256"],
            "traceSha256": base.digest(trace)}


def pre_crash_protocol_failure(owner_log, diagnostics):
    """Failure code for the owner proxy log and crash-app diagnostics, or None."""
    expected_topology = ("response op=fleet.topology ok=true "
                         f"fleetId={base.OWNER_FLEET} allocatorId={base.OWNER_ALLOC}")
    if expected_topology not in owner_log or "request op=client.register" in owner_log or \
       "request op=pane.claim" in owner_log or "response op=fleet.topology ok=false" in owner_log:
        return "pre_crash_owner_protocol_invalid"
    if "bonjour_publish" in diagnostics or "DNS-SD" in diagnostics or \
       "controller_wire_timeout" in diagnostics or re.search(r"ws://(?!127\.0\.0\.1)[^ ]+", diagnostics):
        return "crash_app_discovery_or_route_invalid"
    return None


def profile_state_record(user_data):
    """Read-only record of the persistent-state files: nothing here opens for write."""
    def file_sha(path):
        if path.is_symlink():
            return "linked"
        return base.digest(path) if path.is_file() else None
    selector_path = user_data / "surface-core-state.json.selector"
    selector = {"sha256": file_sha(selector_path)}
    if selector["sha256"] not in (None, "linked"):
        try:
            parsed = json.loads(selector_path.read_text(encoding="utf8"))
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            selector.update({"phase": parsed.get("phase"), "acceptedSha256": parsed.get("acceptedSha256"),
                             "candidateSha256": parsed.get("candidateSha256")})
        else:
            selector["parseFailed"] = True
    return {"selector": selector,
            "primarySha256": file_sha(user_data / "surface-core-state.json"),
            "backupSha256": file_sha(user_data / "surface-core-state.json.bak"),
            "temporaryFiles": [{"name": entry.name, "sha256": file_sha(entry)}
                               for entry in sorted(user_data.glob("surface-core-state.json.*.tmp"))]}


def crash_state_failure(record, phase, candidate_sha):
    """Failure code when the files a stop left disagree with its phase, or None."""
    selector = record["selector"]
    shas = [record["primarySha256"], record["backupSha256"], selector["sha256"]] + \
           [entry["sha256"] for entry in record["temporaryFiles"]]
    if "linked" in shas or selector.get("parseFailed"):
        return "crash_state_file_invalid"
    if phase.startswith("before_"):
        if selector.get("phase") != "pending" or selector.get("candidateSha256") != candidate_sha:
            return "crash_state_selector_not_pending_candidate"
        if record["primarySha256"] != selector.get("acceptedSha256") or record["primarySha256"] == candidate_sha:
            return "crash_state_primary_changed"
        if not any(entry["sha256"] == candidate_sha for entry in record["temporaryFiles"]):
            return "crash_state_candidate_temporary_missing"
        return None
    if record["primarySha256"] != candidate_sha:
        return "crash_state_primary_not_candidate"
    if selector.get("phase") != "committed" or selector.get("acceptedSha256") != candidate_sha:
        return "crash_state_selector_not_committed_candidate"
    if record["backupSha256"] is None or record["backupSha256"] == candidate_sha:
        return "crash_state_backup_not_lagging"
    return None


class BindingCrashVehicle(base.Vehicle):
    def __init__(self, phase, node, pg_bin):
        super().__init__(node, pg_bin)
        self.phase = phase
        self.result = {"status": "failed", "scope": "private_binding_bearing_process_crash_only",
                       "phase": phase, "bindingCrashQualified": False,
                       "afterPendingQualified": False, "powerLossQualified": False,
                       "liveFleetQualified": False, "iosQualified": False,
                       "upgradeRollbackQualified": False}

    def app(self, binary, user_data, url, phase):
        if phase != "restart-foreign":
            return super().app(binary, user_data, url, phase)
        log = self.home / "restart-foreign-app-diagnostic.log"
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "TMPDIR": str(self.home / "tmp"),
               "XDG_RUNTIME_DIR": str(self.home / "runtime"), "XDG_CONFIG_HOME": str(self.home / "config"),
               "XDG_CACHE_HOME": str(self.home / "cache"), "XDG_DATA_HOME": str(self.home / "data"),
               "XDG_STATE_HOME": str(self.home / "state"), "WAYLAND_DISPLAY": "surf-ace-private-foreign",
               "ELECTRON_OZONE_PLATFORM_HINT": "wayland", "SURF_ACE_BIND": "127.0.0.1",
               "SURF_ACE_PORT": str(base.CLIENT_PORT), "SURF_ACE_DISABLE_ADVERTISING": "1",
               "SURF_ACE_DISABLE_GPU": "1", "SURF_ACE_SERVER": url,
               "SURF_ACE_CLIENT_DIAGNOSTIC_LOG": str(log)}
        child = self.start([str(binary), f"--user-data-dir={user_data}", "--ozone-platform=wayland",
                            "--enable-features=UseOzonePlatform", "--disable-gpu", "--disable-dev-shm-usage"],
                           self.home / "restart-foreign-app-stdout.log", env)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if child.poll() is not None:
                base.fail("restart_foreign_app_exited_early")
            text = log.read_text(errors="replace") if log.exists() else ""
            if "registry_provisioning_invalid" in text or "bonjour_publish" in text or \
               re.search(r"ws://(?!127\.0\.0\.1)[^ ]+", text):
                base.fail("restart_foreign_unsafe_diagnostic")
            if "foreign_registry_identity" in text and "event=app_ready" in text and \
               f"state_dir={user_data}" in text:
                break
            time.sleep(0.1)
        else:
            base.fail("restart_foreign_diagnostic_timeout")
        self.wait_tcp(base.CLIENT_PORT, child)
        base.safety("after_restart_foreign_app")
        return child, log

    def proxy(self, mode, local_port, target_port):
        log = self.home / f"{mode}-requests.log"
        child = self.start([str(self.node), str(SOURCE / "surf-ace-private-binding-crash-proxy.mjs"),
                            mode, str(local_port), str(target_port), str(log)],
                           self.home / f"{mode}-proxy-stdout.log",
                           {"PATH": "/usr/bin:/bin", "HOME": str(self.home)})
        self.wait_tcp(local_port, child)
        return child, log

    def verifier(self, user_data):
        socket = self.home / "binding-verifier.sock"
        child = self.start([str(self.node), str(SOURCE / "surf-ace-private-binding-verifier.mjs"),
                            str(socket), str(user_data), str(self.home / "baseline-manifest.json"),
                            str(user_data / "registry-binding.provisioned.json")],
                           self.home / "binding-verifier.log",
                           {"PATH": "/usr/bin:/bin", "HOME": str(self.home)})
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline:
            if child.poll() is not None:
                base.fail("binding_verifier_exited")
            if socket.is_socket():
                return child, socket
            time.sleep(0.05)
        base.fail("binding_verifier_socket_missing")

    def compiled_hook(self):
        hook = self.home / "binding-selector-hook.so"
        compiler = shutil.which("cc")
        if not compiler or not os.access(compiler, os.X_OK):
            base.fail("compiler_unavailable")
        self.result["compiler"] = str(pathlib.Path(compiler).resolve())
        base.command([compiler, "-std=c11", "-Wall", "-Wextra", "-Werror", "-fPIC", "-shared",
                      str(SOURCE / "surf-ace-private-binding-selector-hook.c"),
                      "-o", str(hook), "-ldl", "-pthread"], timeout=30,
                     log=self.home / "binding-hook-build.log")
        if not hook.is_file() or hook.is_symlink():
            base.fail("compiled_hook_missing")
        return hook

    def crash_app(self, binary, user_data, owner_url, hook, socket):
        marker = self.home / "binding-marker"
        trace = self.home / "binding-trace.log"
        trace.touch(mode=0o600, exist_ok=False)
        pidfile = self.home / "binding-browser.pid"
        if marker.exists() or pidfile.exists():
            base.fail("crash_marker_or_pid_preexists")
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "TMPDIR": str(self.home / "tmp"),
               "XDG_RUNTIME_DIR": str(self.home / "runtime"), "XDG_CONFIG_HOME": str(self.home / "config"),
               "XDG_CACHE_HOME": str(self.home / "cache"), "XDG_DATA_HOME": str(self.home / "data"),
               "XDG_STATE_HOME": str(self.home / "state"), "WAYLAND_DISPLAY": "surf-ace-private-foreign",
               "ELECTRON_OZONE_PLATFORM_HINT": "wayland", "SURF_ACE_BIND": "127.0.0.1",
               "SURF_ACE_PORT": str(base.CLIENT_PORT), "SURF_ACE_DISABLE_ADVERTISING": "1",
               "SURF_ACE_DISABLE_GPU": "1", "SURF_ACE_SERVER": owner_url,
               "SURF_ACE_CLIENT_DIAGNOSTIC_LOG": str(self.home / "crash-app-diagnostic.log"),
               "LD_PRELOAD": str(hook), "SURF_ACE_BINDING_USER_DATA": str(user_data),
               "SURF_ACE_BINDING_SOCKET": str(socket), "SURF_ACE_BINDING_PHASE": self.phase,
               "SURF_ACE_BINDING_MARKER": str(marker), "SURF_ACE_BINDING_TRACE": str(trace),
               "SURF_ACE_BINDING_BROWSER_PID_FILE": str(pidfile)}
        # The shell writes its own PID before exec; exec preserves that PID.
        argv = ["/bin/sh", "-c",
                'printf "%s\\n" "$$" > "$SURF_ACE_BINDING_BROWSER_PID_FILE"; exec "$@"',
                "binding-browser", str(binary), f"--user-data-dir={user_data}",
                "--ozone-platform=wayland", "--enable-features=UseOzonePlatform",
                "--disable-gpu", "--disable-dev-shm-usage"]
        child = self.start(argv, self.home / "crash-app-stdout.log", env)
        deadline = time.monotonic() + 25
        while time.monotonic() < deadline:
            if marker.exists() and child.poll() is not None:
                break
            if child.poll() is not None:
                base.fail(f"crash_app_exited_without_marker_{child.returncode}")
            base.safety("crash_app_poll")
            time.sleep(0.1)
        else:
            base.fail("crash_marker_timeout")
        if child.returncode != -signal.SIGKILL or pidfile.read_text().strip() != str(child.pid):
            base.fail("crash_signal_or_main_pid_invalid")
        record = phase_record(marker, trace, child.pid, self.phase)
        if base.digest(binary) != self.binary_sha:
            base.fail("package_changed_during_crash")
        self.stop(child, expected_clean=False)
        return record

    def run(self):
        base.safety("entry")
        if self.phase not in PHASES or len(sys.argv) != 4:
            base.fail("phase_or_usage_invalid")
        manifest_sha, sources = verified_source_manifest(SOURCE)
        self.result["sourceManifestSha256"] = manifest_sha
        self.result["sourceSha256"] = sources
        for name, sha in base.ARCHIVES.items():
            archive = base.ROOT / name
            if archive.is_symlink() or base.digest(archive) != sha:
                base.fail(f"archive_hash_mismatch_{name}")
        if not self.node.is_file() or not os.access(self.node, os.X_OK) or \
           not base.command([str(self.node), "--version"]).startswith("v24."):
            base.fail("node24_missing")
        for name in ("initdb", "pg_ctl", "psql", "pg_basebackup"):
            self.pg(name)
        self.home = pathlib.Path(tempfile.mkdtemp(prefix="binding-crash-", dir=base.ROOT))
        self.home.chmod(0o700)
        (self.home / "tmp").mkdir(mode=0o700)
        user_data = base.copy_profile(self.home, self.identity_sha)
        baseline = self.node_json("surf-ace-private-foreign-first-claims.mjs",
                                  ["inspect", user_data], self.home / "baseline-manifest.json")
        expected_claim = [{"surfaceId": "sf_0019da33b612", "windowLabel": "d",
                           "panes": [{"paneId": "68655", "paneLabel": 3,
                                      "paneLineageId": "pl_8d3f840cbc274081b479bae5ee45c6cb"}]}]
        if baseline["confirmedClaims"] != expected_claim:
            base.fail("profile_claims_changed")
        self.result["clientId"] = baseline["clientId"]
        self.result["confirmedClaim"] = baseline["confirmedClaims"][0]
        runtime = self.home / "runtime"
        runtime.mkdir(mode=0o700)
        weston = self.start(["/usr/bin/weston", "--backend=headless", "--renderer=pixman",
                             "--socket=surf-ace-private-foreign", "--idle-time=0", "--no-config",
                             f"--log={self.home / 'weston.log'}"], self.home / "weston-stdout.log",
                            {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "XDG_RUNTIME_DIR": str(runtime)})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not (runtime / "surf-ace-private-foreign").is_socket():
            if weston.poll() is not None:
                base.fail("private_weston_exited")
            time.sleep(0.1)
        if not (runtime / "surf-ace-private-foreign").is_socket():
            base.fail("private_weston_socket_missing")
        guard = base.command(["/bin/bash", str(SOURCE / "surf-ace-private-packaged-crash-guard.sh"),
                              str(self.home), str(runtime), "surf-ace-private-foreign"], timeout=40,
                             log=self.home / "guard.log")
        if "guard_passed=true" not in guard:
            base.fail("reviewed_archive_guard_failed")
        binary = self.home / "package-pr61" / "Surf Ace" / "surf-ace"
        self.binary_sha = base.digest(binary)
        self.result["packageBinarySha256"] = self.binary_sha
        server_pkg = self.home / "package-server"
        cli_pkg = self.home / "package-cli"
        base.extract_tar(base.ROOT / "surf-ace-server-linux-x86_64-v0.2.6.tar.gz", server_pkg)
        base.extract_tar(base.ROOT / "surf-ace-cli-linux-x86_64-v0.2.6.tar.gz", cli_pkg)
        base.safety("pre_postgres")
        cluster_id = self.postgres(server_pkg / "surf-ace-server" / "schemas" / "allocator")
        self.initialize_fleet(base.OWNER_FLEET, base.OWNER_ALLOC)
        self.initialize_fleet(base.FOREIGN_FLEET, base.FOREIGN_ALLOC)
        owner_server = self.server(base.OWNER_FLEET, base.OWNER_ALLOC, base.OWNER_PORT, cluster_id, server_pkg)
        foreign_server = self.server(base.FOREIGN_FLEET, base.FOREIGN_ALLOC, base.FOREIGN_PORT, cluster_id, server_pkg)
        foreign_before = self.accepted(base.FOREIGN_FLEET, self.home / "foreign-before.json")
        owner_before = self.accepted(base.OWNER_FLEET, self.home / "owner-before.json")
        if (owner_before["fleetId"], owner_before["allocatorId"]) == \
           (foreign_before["fleetId"], foreign_before["allocatorId"]):
            base.fail("owner_foreign_identity_equal")
        for name, port, accepted in (("owner", base.OWNER_PORT, owner_before),
                                     ("foreign", base.FOREIGN_PORT, foreign_before)):
            topology = self.node_json("surf-ace-private-foreign-first-topology.mjs",
                                      [f"ws://127.0.0.1:{port}/ws"],
                                      self.home / f"{name}-topology-before.json")
            if topology.get("registryIdentity") != {"fleetId": accepted["fleetId"],
                                                    "allocatorId": accepted["allocatorId"]}:
                base.fail(f"{name}_topology_identity_mismatch")
        self.node_json("surf-ace-private-foreign-first-seed-owner.mjs",
                       [f"ws://127.0.0.1:{base.OWNER_PORT}/ws", self.home / "baseline-manifest.json"],
                       self.home / "owner-seed.json")
        owner_seeded = self.accepted(base.OWNER_FLEET, self.home / "owner-seeded.json")
        self.node_json("surf-ace-private-foreign-first-claims.mjs",
                       ["provision", user_data, self.home / "owner-seeded.json"],
                       self.home / "owner-provisioning-proof.json")
        foreign_proxy, foreign_log = self.proxy("foreign", base.FOREIGN_PROXY_PORT, base.FOREIGN_PORT)
        if base.digest(binary) != self.binary_sha:
            base.fail("package_changed_before_foreign")
        foreign_app, _ = self.app(binary, user_data,
                                  f"ws://127.0.0.1:{base.FOREIGN_PROXY_PORT}/ws", "foreign")
        self.stop(foreign_app)
        foreign_after = self.accepted(base.FOREIGN_FLEET, self.home / "foreign-after.json")
        if (foreign_before["headHash"], foreign_before["headSeq"], foreign_before["mappings"],
            foreign_before["paneMappings"]) != (foreign_after["headHash"], foreign_after["headSeq"],
                foreign_after["mappings"], foreign_after["paneMappings"]):
            base.fail("foreign_accepted_state_changed")
        foreign_requests = foreign_log.read_text(errors="replace")
        if "request op=fleet.topology" not in foreign_requests or "forbidden_request" in foreign_requests or \
           re.search(r"request op=(?!fleet\.topology)", foreign_requests):
            base.fail("foreign_requests_not_read_only")
        foreign_local = self.node_json("surf-ace-private-foreign-first-claims.mjs",
                                       ["inspect", user_data], self.home / "foreign-local.json")
        for field in ("clientId", "confirmedClaims", "contentDigests", "claimsSha256"):
            if foreign_local[field] != baseline[field]:
                base.fail(f"foreign_local_{field}_changed")
        owner_proxy, owner_log = self.proxy("owner", base.OWNER_PROXY_PORT, base.OWNER_PORT)
        verifier, socket = self.verifier(user_data)
        hook = self.compiled_hook()
        self.result["compiledHookSha256"] = base.digest(hook)
        base.safety("pre_crash")
        if base.digest(binary) != self.binary_sha:
            base.fail("package_changed_before_crash")
        crash = self.crash_app(binary, user_data,
                               f"ws://127.0.0.1:{base.OWNER_PROXY_PORT}/ws", hook, socket)
        self.result["crash"] = crash
        protocol_failure = pre_crash_protocol_failure(
            owner_log.read_text(errors="replace"),
            (self.home / "crash-app-diagnostic.log").read_text(errors="replace"))
        if protocol_failure:
            base.fail(protocol_failure)
        self.stop(verifier)
        self.stop(owner_proxy)
        self.stop(foreign_proxy)
        # The hook-free launch below recovers from these bytes and rewrites
        # them, so record what the stop left first, reading only.
        crash_state = profile_state_record(user_data)
        self.result["crashState"] = crash_state
        state_failure = crash_state_failure(crash_state, self.phase, crash["candidateSha256"])
        if state_failure:
            base.fail(state_failure)
        if not self.phase.startswith("before_"):
            self.result["backupLagsCandidate"] = True
        foreign_proxy, restart_foreign_log = self.proxy("foreign", base.FOREIGN_PROXY_PORT, base.FOREIGN_PORT)
        if base.digest(binary) != self.binary_sha:
            base.fail("package_changed_before_hook_free_restart")
        restart_foreign_app, _ = self.app(binary, user_data,
                                         f"ws://127.0.0.1:{base.FOREIGN_PROXY_PORT}/ws", "restart-foreign")
        self.stop(restart_foreign_app)
        self.stop(foreign_proxy)
        foreign_restart = self.accepted(base.FOREIGN_FLEET, self.home / "foreign-restart.json")
        if (foreign_before["headSeq"], foreign_before["headHash"], foreign_before["mappings"],
            foreign_before["paneMappings"]) != (foreign_restart["headSeq"], foreign_restart["headHash"],
                foreign_restart["mappings"], foreign_restart["paneMappings"]):
            base.fail("foreign_changed_after_crash")
        restart_requests = restart_foreign_log.read_text(errors="replace")
        if "request op=fleet.topology" not in restart_requests or \
           re.search(r"request op=(?!fleet\.topology)", restart_requests):
            base.fail("foreign_restart_request_invalid")
        foreign_bound = self.node_json("surf-ace-private-foreign-first-claims.mjs",
                                       ["inspect-bound", user_data], self.home / "foreign-restart-local.json")
        expected_binding = {"clientId": baseline["clientId"],
                            "allocatorId": base.OWNER_ALLOC, "fleetId": base.OWNER_FLEET}
        wanted_binding = None if self.phase.startswith("before_") else expected_binding
        if foreign_bound["registryBinding"] != wanted_binding:
            base.fail("foreign_restart_binding_mismatch")
        for field in ("clientId", "confirmedClaims", "contentDigests", "claimsSha256"):
            if foreign_bound[field] != baseline[field]:
                base.fail(f"foreign_restart_{field}_changed")
        owner_proxy, restart_owner_log = self.proxy("owner", base.OWNER_PROXY_PORT, base.OWNER_PORT)
        restart_owner_app, _ = self.app(binary, user_data,
                                       f"ws://127.0.0.1:{base.OWNER_PROXY_PORT}/ws", "restart-owner")
        self.stop(restart_owner_app)
        self.stop(owner_proxy)
        owner_after = self.accepted(base.OWNER_FLEET, self.home / "owner-after.json")
        if (owner_seeded["headSeq"], owner_seeded["headHash"], owner_seeded["mappings"],
            owner_seeded["paneMappings"]) != (owner_after["headSeq"], owner_after["headHash"],
                owner_after["mappings"], owner_after["paneMappings"]):
            base.fail("owner_allocation_changed_after_crash")
        if "response op=client.register ok=true" not in restart_owner_log.read_text(errors="replace"):
            base.fail("owner_restart_registration_unproven")
        owner_local = self.node_json("surf-ace-private-foreign-first-claims.mjs",
                                     ["inspect-bound", user_data], self.home / "owner-local.json")
        if owner_local["registryBinding"] != expected_binding:
            base.fail("owner_binding_not_exact")
        for field in ("clientId", "confirmedClaims", "contentDigests", "claimsSha256"):
            if owner_local[field] != baseline[field]:
                base.fail(f"owner_local_{field}_changed")
        self.result["ownerRestartState"] = profile_state_record(user_data)
        server_publish_counts = {}
        for name in ("owner", "foreign"):
            output = (self.home / f"{name}-server-stdout.log").read_text(errors="replace")
            count = output.count("event=publish_start")
            if count < 1:
                base.fail(f"{name}_private_server_publish_unobserved")
            server_publish_counts[name] = count
        for name in ("foreign", "crash", "restart-foreign", "restart-owner"):
            output = (self.home / f"{name}-app-stdout.log").read_text(errors="replace")
            if "event=publish_start" in output or "event=publish_attempt" in output:
                base.fail(f"{name}_client_published_bonjour")
        base.safety("after_phases")
        self.stop(owner_server)
        self.stop(foreign_server)
        self.stop(weston)
        self.result.update({"status": "passed", "scope": "private_binding_bearing_process_crash_only",
            "bindingCrashQualified": True, "foreignHeadBefore": [foreign_before["headSeq"], foreign_before["headHash"]],
            "foreignHeadAfter": [foreign_restart["headSeq"], foreign_restart["headHash"]],
            "ownerHeadBefore": [owner_seeded["headSeq"], owner_seeded["headHash"]],
            "ownerHeadAfter": [owner_after["headSeq"], owner_after["headHash"]],
            "baselineClaimsSha256": baseline["claimsSha256"],
            "ownerRegistrationAccepted": True, "clientBonjourPublished": False,
            "serverBonjourPrivateLoOnly": True, "serverBonjourPublishStartCounts": server_publish_counts})

    def cleanup(self):
        failures = super().cleanup()
        if self.home:
            old = self.home / "foreign-first-receipt.json"
            new = self.home / "binding-crash-receipt.json"
            if old.exists():
                old.rename(new)
        return failures


def main():
    if len(sys.argv) != 4 or sys.argv[1] not in PHASES:
        base.fail("usage: VEHICLE PHASE NODE24_PATH POSTGRES16_BIN_DIR")
    vehicle = BindingCrashVehicle(sys.argv[1], sys.argv[2], sys.argv[3])
    try:
        vehicle.run()
    except Exception as error:
        vehicle.result["failure"] = type(error).__name__ + ":" + str(error)
        raise
    finally:
        failures = vehicle.cleanup()
    if failures:
        base.fail("vehicle_cleanup_failed")
    print(json.dumps({"fixtureHome": str(vehicle.home), **vehicle.result}, sort_keys=True))


if __name__ == "__main__":
    main()

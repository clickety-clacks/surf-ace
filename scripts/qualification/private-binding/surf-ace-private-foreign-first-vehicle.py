#!/usr/bin/env python3
"""Unrun private no-crash foreign-first binding qualification vehicle.

Source review is required before any invocation. Invoke as user mike from an
already-created network namespace with only lo, no default route, and no
global address. This script creates only a fresh /tmp fixture home. It never
uses an installed profile, serving registry, host service, or live LAN.
"""
import hashlib
import json
import os
import pathlib
import pwd
import re
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time

ROOT = pathlib.Path("/tmp/surf-ace-private-crash-fixture-inputs")
SOURCE = pathlib.Path(__file__).resolve().parent
STATE_SHA = "257be94a336af7710af4997248f9d24410bbde74cd10565cb01d064e6838b723"
SELECTOR_SHA = "4e41a483ef5f755832c000e6b0d2eb95a98cdd49a4c94730edd6b701bfa474f7"
IDENTITY_SHA = "232513c484c54744f495e3b4023a5f49a12b95264a064c048d70bf0fb569275d"
ARCHIVES = {
    "surf-ace-electron-linux-x86_64-v0.2.6.zip": "b96e22f184a041b99901484fd09ea0f19e6427017d7112598f948f8ca1d51398",
    "surf-ace-tightbeam-electron-linux-x86_64-v0.2.5.zip": "f0623c165a90ed2c93a8c61b17243cab5907e70e3fe5e93531d1b887ca5094f3",
    "surf-ace-cli-linux-x86_64-v0.2.6.tar.gz": "b080804ec1e01c5651c9b23b0826934f7b9fa40ea9c453387f74083fcedd5d56",
    "surf-ace-server-linux-x86_64-v0.2.6.tar.gz": "2650c700f77d7df3da4ba660a019474f8c1e273a602f00fe7423622163bfbf1a",
}
PG_PORT, WITNESS_PORT = 29501, 29502
OWNER_PORT, FOREIGN_PORT = 29601, 29602
OWNER_PROXY_PORT, FOREIGN_PROXY_PORT = 29701, 29702
CLIENT_PORT = 29801
IP = shutil.which("ip") or "/usr/bin/ip"
SS = shutil.which("ss") or "/usr/bin/ss"
OWNER_FLEET, FOREIGN_FLEET = "fixture_owner_foreign_first", "fixture_foreign_foreign_first"
OWNER_ALLOC, FOREIGN_ALLOC = "alloc_fixture_owner_foreign_first", "alloc_fixture_foreign_foreign_first"
CHROMIUM_SINGLETON_LINKS = {"SingletonCookie", "SingletonLock", "SingletonSocket"}


def fail(code):
    raise RuntimeError(code)


def digest(file):
    h = hashlib.sha256()
    with open(file, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def command(argv, *, timeout=45, env=None, log=None):
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout, env=env, check=False)
    if log:
        with open(log, "a", encoding="utf8") as stream:
            stream.write(f"command={pathlib.Path(argv[0]).name} exit={result.returncode}\n")
            stream.write(result.stdout[-16000:] + result.stderr[-16000:])
    if result.returncode:
        fail(f"command_failed_{pathlib.Path(argv[0]).name}_{result.returncode}")
    return result.stdout.strip()


def safety(stage):
    if pwd.getpwuid(os.getuid()).pw_name != "mike":
        fail(f"{stage}_wrong_user")
    links = command([IP, "-o", "link", "show"]).splitlines()
    names = {line.split(":", 2)[1].strip().split("@", 1)[0] for line in links}
    if names != {"lo"}:
        fail(f"{stage}_interfaces_not_loopback_only")
    for family in ("-4", "-6"):
        if command([IP, family, "route", "show", "default"]):
            fail(f"{stage}_default_route")
        if command([IP, "-o", family, "addr", "show", "scope", "global"]):
            fail(f"{stage}_global_address")
    # Route lookup emits no packet. No application request is sent to Gibson.
    probe = subprocess.run([IP, "route", "get", "192.168.50.216"],
                           capture_output=True, timeout=3, check=False)
    if probe.returncode == 0:
        fail(f"{stage}_serving_route_available")
    sockets = command([SS, "-ltnH"])
    for line in sockets.splitlines():
        fields = line.split()
        if len(fields) < 4:
            fail(f"{stage}_socket_parse_failed")
        endpoint = fields[3]
        if endpoint.startswith(("0.0.0.0:", "[::]:", "*:", ":::") ):
            fail(f"{stage}_wildcard_listener")
        match = re.search(r":([0-9]+)$", endpoint)
        if match and 19001 <= int(match.group(1)) <= 19011:
            fail(f"{stage}_production_client_port")


def copy_profile(home, identity_sha):
    source = ROOT / "profile-copy"
    if not source.is_dir() or source.is_symlink() or source.resolve() != ROOT / "profile-copy":
        fail("profile_source_not_private_copy")
    ignored_links = set()
    for entry in source.rglob("*"):
        if entry.is_symlink() and entry.parent == source and entry.name in CHROMIUM_SINGLETON_LINKS:
            ignored_links.add(entry.name)
            continue
        if entry.is_symlink() or not (entry.is_file() or entry.is_dir()):
            fail("profile_source_has_link_or_special_file")
    expected = {"surface-core-state.json": STATE_SHA,
                "surface-core-state.json.selector": SELECTOR_SHA,
                "surface-identity.json": identity_sha}
    for name, sha in expected.items():
        if digest(source / name) != sha:
            fail(f"profile_source_{name}_hash_mismatch")
    target = home / "user-data"
    # Chromium's Singleton* links point to a prior process/socket, not profile
    # content. Leave the source copy untouched and omit only these root links.
    shutil.copytree(source, target, symlinks=False,
                    ignore=lambda directory, names: ignored_links if pathlib.Path(directory) == source else set())
    target.chmod(0o700)
    if any(entry.is_symlink() for entry in target.rglob("*")):
        fail("profile_copy_contains_link")
    for name, sha in expected.items():
        if digest(target / name) != sha:
            fail(f"profile_copy_{name}_hash_mismatch")
    if (target / "registry-binding.provisioned.json").exists():
        fail("profile_already_provisioned")
    return target


def extract_tar(archive, target):
    if target.exists():
        fail("package_tree_not_fresh")
    target.mkdir(mode=0o700)
    with tarfile.open(archive, "r:gz") as package:
        for member in package.getmembers():
            target_path = target / member.name
            if member.name.startswith("/") or ".." in pathlib.PurePosixPath(member.name).parts or \
               not target_path.resolve().is_relative_to(target.resolve()) or \
               not (member.isfile() or member.isdir()):
                fail("package_archive_member_invalid")
        for member in package.getmembers():
            output = target / member.name
            if member.isdir():
                output.mkdir(parents=True, exist_ok=True)
            else:
                output.parent.mkdir(parents=True, exist_ok=True)
                with package.extractfile(member) as source_stream, open(output, "xb") as target_stream:
                    shutil.copyfileobj(source_stream, target_stream)
                output.chmod(member.mode & 0o777)


class Vehicle:
    def __init__(self, node, pg_bin):
        self.node = pathlib.Path(node)
        self.pg_bin = pathlib.Path(pg_bin)
        self.identity_sha = IDENTITY_SHA
        self.home = None
        self.children = []
        self.primary = None
        self.witness = None
        self.result = {"status": "failed", "scope": "private_no_crash_foreign_first_only"}

    def pg(self, binary):
        path = self.pg_bin / binary
        if not path.is_file() or not os.access(path, os.X_OK):
            fail(f"postgres_binary_missing_{binary}")
        return str(path)

    def start(self, argv, log, env=None):
        safety(f"pre_{pathlib.Path(argv[0]).name}")
        out = open(log, "ab", buffering=0)
        child = subprocess.Popen(argv, env=env, stdout=out, stderr=subprocess.STDOUT,
                                 start_new_session=True, close_fds=True)
        self.children.append((child, out))
        return child

    def stop(self, child, *, expected_clean=True):
        if child.poll() is None:
            try:
                os.kill(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        try:
            code = child.wait(timeout=6)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait(timeout=4)
            fail("child_required_forced_kill")
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        for _ in range(20):
            try:
                os.killpg(child.pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.1)
        else:
            fail("child_process_group_survived_reap")
        if expected_clean and code != 0:
            fail(f"child_nonzero_exit_{code}")
        return code

    def wait_tcp(self, port, child, timeout=12):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if child.poll() is not None:
                fail("child_exited_before_socket")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                    return
            except OSError:
                time.sleep(0.1)
        fail("loopback_socket_timeout")

    def psql(self, sql, *, user="postgres", port=PG_PORT):
        env = {"PATH": str(self.pg_bin) + ":/usr/bin:/bin", "HOME": str(self.home),
               "PGPASSWORD": "", "PGCONNECT_TIMEOUT": "3"}
        return command([self.pg("psql"), "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1",
                        "-U", user, "-h", "127.0.0.1", "-p", str(port), "-d", "postgres", "-c", sql],
                       timeout=20, env=env, log=self.home / "postgres-commands.log")

    def postgres(self, server_schema):
        pg_root = self.home / "postgres"
        primary, witness = pg_root / "primary", pg_root / "witness"
        pg_root.mkdir(mode=0o700)
        command([self.pg("initdb"), "-D", str(primary), "--auth=trust", "--username=postgres", "--no-instructions"], timeout=30)
        with open(primary / "postgresql.conf", "a", encoding="utf8") as conf:
            conf.write(f"\nlisten_addresses='127.0.0.1'\nport={PG_PORT}\nunix_socket_directories=''\n"
                       "wal_level=replica\nmax_wal_senders=10\nmax_replication_slots=10\n"
                       "synchronous_standby_names='FIRST 1 (surf_ace_witness)'\n"
                       "synchronous_commit=local\nfsync=on\n")
        command([self.pg("pg_ctl"), "-D", str(primary), "-l", str(self.home / "primary.log"), "start"], timeout=15)
        self.primary = primary
        self.psql("SELECT 1")
        for schema in ("001_allocator.sql", "002_fleet_panes.sql"):
            command([self.pg("psql"), "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-h", "127.0.0.1",
                     "-p", str(PG_PORT), "-d", "postgres", "-f", str(server_schema / schema)], timeout=30,
                    log=self.home / "postgres-commands.log")
        self.psql("CREATE ROLE allocator_writer LOGIN IN ROLE surf_ace_allocator_writer;"
                  "CREATE ROLE allocator_recovery LOGIN IN ROLE surf_ace_allocator_recovery;"
                  "CREATE ROLE allocator_witness LOGIN IN ROLE surf_ace_allocator_witness;"
                  "SELECT pg_create_physical_replication_slot('surf_ace_witness_slot');")
        command([self.pg("pg_basebackup"), "-D", str(witness), "-d",
                 f"host=127.0.0.1 port={PG_PORT} user=postgres application_name=surf_ace_witness",
                 "-R", "-X", "stream",
                 "-S", "surf_ace_witness_slot"], timeout=30, log=self.home / "postgres-commands.log")
        # -R writes primary_conninfo to postgresql.auto.conf, which overrides
        # postgresql.conf. Require the exact standby name there before launch.
        recovery_conf = (witness / "postgresql.auto.conf").read_text(encoding="utf8")
        if recovery_conf.count("primary_conninfo =") != 1 or \
           "application_name=surf_ace_witness" not in recovery_conf or \
           "primary_slot_name = 'surf_ace_witness_slot'" not in recovery_conf:
            fail("witness_recovery_config_missing")
        with open(witness / "postgresql.conf", "a", encoding="utf8") as conf:
            conf.write(f"\nlisten_addresses='127.0.0.1'\nport={WITNESS_PORT}\nunix_socket_directories=''\n"
                       "hot_standby=on\n"
                       "surf_ace.witness_server_id='witness-private'\n")
        command([self.pg("pg_ctl"), "-D", str(witness), "-l", str(self.home / "witness.log"), "start"], timeout=15)
        self.witness = witness
        self.psql("ALTER SYSTEM SET synchronous_commit='remote_apply';")
        self.psql("SELECT pg_reload_conf();")
        for _ in range(60):
            if self.psql("SELECT sync_state FROM pg_stat_replication WHERE application_name='surf_ace_witness';") == "sync":
                break
            time.sleep(0.2)
        else:
            fail("witness_not_synchronous")
        return self.psql("SELECT (pg_control_system()).system_identifier::text;")

    def initialize_fleet(self, fleet, allocator):
        # All interpolated identifiers below are fixed source constants.
        lease = "lease_" + hashlib.sha256(fleet.encode("utf8")).hexdigest()[:22]
        sql = ("BEGIN ISOLATION LEVEL SERIALIZABLE; SET LOCAL synchronous_commit='remote_apply'; "
               "SET ROLE allocator_recovery; "
               "DO $$ BEGIN IF NOT (SELECT pg_try_advisory_lock(key1,key2) FROM surf_ace_allocator.advisory_keys('" + fleet + "')) "
               "THEN RAISE EXCEPTION 'advisory lock unavailable'; END IF; END $$; "
               "SELECT * FROM surf_ace_allocator.initialize_fleet('" + fleet + "','" + allocator +
               "','generation_fixture','" + lease + "'); "
               "SELECT surf_ace_allocator.release_lease('" + fleet + "',1,'" + lease + "','recovery'); COMMIT;")
        self.psql(sql)

    def accepted(self, fleet, file):
        data = self.psql("SELECT surf_ace_allocator.read_accepted_state('" + fleet + "')::text;", user="allocator_recovery")
        value = json.loads(data)
        file.write_text(json.dumps(value, sort_keys=True), encoding="utf8")
        file.chmod(0o600)
        return value

    def server(self, fleet, allocator, port, cluster_id, package):
        name = "owner" if fleet == OWNER_FLEET else "foreign"
        config = {"custody": {"expectedClusterSystemId": cluster_id, "fleetId": fleet,
                  "primaryUrl": f"postgresql://allocator_writer@127.0.0.1:{PG_PORT}/postgres",
                  "recoveryUrl": f"postgresql://allocator_recovery@127.0.0.1:{PG_PORT}/postgres",
                  "witnessApplicationName": "surf_ace_witness", "witnessPhysicalSlot": "surf_ace_witness_slot",
                  "witnessServerId": "witness-private",
                  "witnessUrl": f"postgresql://allocator_witness@127.0.0.1:{WITNESS_PORT}/postgres"},
                  "hostLockPath": str(self.home / f"{name}.lock"), "listenHost": "127.0.0.1", "listenPort": port,
                  "name": f"Private {name} fixture"}
        file = self.home / f"{name}-server-config.json"
        file.write_text(json.dumps(config), encoding="utf8")
        file.chmod(0o600)
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "TMPDIR": str(self.home / "tmp"),
               "SURF_ACE_CLIENT_DIAGNOSTIC_LOG": str(self.home / f"{name}-server-diagnostic.log")}
        binary = package / "surf-ace-server" / "bin" / "surf-ace-server"
        child = self.start([str(self.node), str(binary), "start", "--config", str(file)],
                           self.home / f"{name}-server-stdout.log", env)
        self.wait_tcp(port, child)
        return child

    def node_json(self, script, argv, output):
        data = command([str(self.node), str(SOURCE / script), *map(str, argv)], timeout=20,
                       log=self.home / "node-commands.log")
        value = json.loads(data)
        output.write_text(json.dumps(value, sort_keys=True), encoding="utf8")
        output.chmod(0o600)
        return value

    def proxy(self, mode, local_port, target_port):
        log = self.home / f"{mode}-requests.log"
        child = self.start([str(self.node), str(SOURCE / "surf-ace-private-foreign-first-proxy.mjs"),
                            mode, str(local_port), str(target_port), str(log)],
                           self.home / f"{mode}-proxy-stdout.log",
                           {"PATH": "/usr/bin:/bin", "HOME": str(self.home)})
        self.wait_tcp(local_port, child)
        return child, log

    def app(self, binary, user_data, url, phase):
        log = self.home / f"{phase}-app-diagnostic.log"
        stdout = self.home / f"{phase}-app-stdout.log"
        env = {"PATH": "/usr/bin:/bin", "HOME": str(self.home), "TMPDIR": str(self.home / "tmp"),
               "XDG_RUNTIME_DIR": str(self.home / "runtime"), "XDG_CONFIG_HOME": str(self.home / "config"),
               "XDG_CACHE_HOME": str(self.home / "cache"), "XDG_DATA_HOME": str(self.home / "data"),
               "XDG_STATE_HOME": str(self.home / "state"), "WAYLAND_DISPLAY": "surf-ace-private-foreign",
               "ELECTRON_OZONE_PLATFORM_HINT": "wayland", "SURF_ACE_BIND": "127.0.0.1",
               "SURF_ACE_PORT": str(CLIENT_PORT), "SURF_ACE_DISABLE_ADVERTISING": "1",
               "SURF_ACE_DISABLE_GPU": "1", "SURF_ACE_SERVER": url,
               "SURF_ACE_CLIENT_DIAGNOSTIC_LOG": str(log)}
        child = self.start([str(binary), f"--user-data-dir={user_data}", "--ozone-platform=wayland",
                            "--enable-features=UseOzonePlatform", "--disable-gpu", "--disable-dev-shm-usage"], stdout, env)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if child.poll() is not None:
                fail(f"{phase}_app_exited_early")
            text = log.read_text(errors="replace") if log.exists() else ""
            if "registry_provisioning_invalid" in text or "bonjour_publish" in text or \
               re.search(r"ws://(?!127\.0\.0\.1)[^ ]+", text):
                fail(f"{phase}_unsafe_diagnostic")
            if phase == "foreign":
                observed = "foreign_registry_identity" in text
            else:
                requests = self.home / "owner-requests.log"
                claim = self.result["confirmedClaim"]
                pane = claim["panes"][0]
                accepted_response = ("response op=client.register ok=true "
                    f"clientId={self.result['clientId']} surfaceId={claim['surfaceId']} "
                    f"windowLabel={claim['windowLabel']} paneId={pane['paneId']} "
                    f"paneLabel={pane['paneLabel']} paneLineageId={pane['paneLineageId']}")
                observed = requests.exists() and accepted_response in requests.read_text(errors="replace")
                if observed:
                    try:
                        state = json.loads((user_data / "surface-core-state.json").read_text())
                        observed = state.get("registryBinding") == {
                            "clientId": self.result["clientId"], "allocatorId": OWNER_ALLOC, "fleetId": OWNER_FLEET}
                    except (OSError, json.JSONDecodeError):
                        observed = False
            if "event=app_ready" in text and f"state_dir={user_data}" in text and observed:
                break
            time.sleep(0.1)
        else:
            fail(f"{phase}_registration_diagnostic_timeout")
        self.wait_tcp(CLIENT_PORT, child)
        safety(f"after_{phase}_app")
        return child, log

    def run(self):
        safety("entry")
        if not re.fullmatch(r"[0-9a-f]{64}", self.identity_sha):
            fail("identity_hash_required")
        if not ROOT.is_dir() or ROOT.is_symlink() or ROOT.stat().st_mode & 0o077:
            fail("fixture_root_invalid")
        for name, sha in ARCHIVES.items():
            archive = ROOT / name
            if archive.is_symlink() or digest(archive) != sha:
                fail(f"archive_hash_mismatch_{name}")
        if not self.node.is_file() or not os.access(self.node, os.X_OK) or \
           not command([str(self.node), "--version"]).startswith("v24."):
            fail("node24_missing")
        for name in ("initdb", "pg_ctl", "psql", "pg_basebackup"):
            self.pg(name)
        self.home = pathlib.Path(tempfile.mkdtemp(prefix="foreign-first-", dir=ROOT))
        self.home.chmod(0o700)
        (self.home / "tmp").mkdir(mode=0o700)
        user_data = copy_profile(self.home, self.identity_sha)
        baseline = self.node_json("surf-ace-private-foreign-first-claims.mjs",
                                  ["inspect", user_data], self.home / "baseline-manifest.json")
        self.result["clientId"] = baseline["clientId"]
        if baseline["confirmedClaims"] != [{"surfaceId": "sf_0019da33b612", "windowLabel": "d",
            "panes": [{"paneId": "68655", "paneLabel": 3,
                       "paneLineageId": "pl_8d3f840cbc274081b479bae5ee45c6cb"}]}]:
            fail("profile_claims_changed")
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
                fail("private_weston_exited")
            time.sleep(0.1)
        if not (runtime / "surf-ace-private-foreign").is_socket():
            fail("private_weston_socket_missing")
        guard = command(["/bin/bash", str(SOURCE / "surf-ace-private-packaged-crash-guard.sh"),
                         str(self.home), str(runtime), "surf-ace-private-foreign"], timeout=40,
                        log=self.home / "guard.log")
        if "guard_passed=true" not in guard:
            fail("reviewed_archive_guard_failed")
        binary = self.home / "package-pr61" / "Surf Ace" / "surf-ace"
        binary_sha = digest(binary)
        server_pkg = self.home / "package-server"
        cli_pkg = self.home / "package-cli"
        extract_tar(ROOT / "surf-ace-server-linux-x86_64-v0.2.6.tar.gz", server_pkg)
        extract_tar(ROOT / "surf-ace-cli-linux-x86_64-v0.2.6.tar.gz", cli_pkg)
        safety("pre_postgres")
        cluster_id = self.postgres(server_pkg / "surf-ace-server" / "schemas" / "allocator")
        self.initialize_fleet(OWNER_FLEET, OWNER_ALLOC)
        self.initialize_fleet(FOREIGN_FLEET, FOREIGN_ALLOC)
        owner_server = self.server(OWNER_FLEET, OWNER_ALLOC, OWNER_PORT, cluster_id, server_pkg)
        foreign_server = self.server(FOREIGN_FLEET, FOREIGN_ALLOC, FOREIGN_PORT, cluster_id, server_pkg)
        foreign_before = self.accepted(FOREIGN_FLEET, self.home / "foreign-before.json")
        owner_before = self.accepted(OWNER_FLEET, self.home / "owner-before.json")
        if (owner_before["fleetId"], owner_before["allocatorId"]) == \
           (foreign_before["fleetId"], foreign_before["allocatorId"]):
            fail("authority_identity_not_distinct")
        for name, port, accepted in (("owner", OWNER_PORT, owner_before),
                                     ("foreign", FOREIGN_PORT, foreign_before)):
            topology = self.node_json("surf-ace-private-foreign-first-topology.mjs",
                                      [f"ws://127.0.0.1:{port}/ws"],
                                      self.home / f"{name}-topology-before.json")
            if topology.get("registryIdentity") != {"fleetId": accepted["fleetId"],
                                                    "allocatorId": accepted["allocatorId"]}:
                fail(f"{name}_topology_identity_mismatch")
        self.node_json("surf-ace-private-foreign-first-seed-owner.mjs",
                       [f"ws://127.0.0.1:{OWNER_PORT}/ws", self.home / "baseline-manifest.json"],
                       self.home / "owner-seed.json")
        owner_seeded = self.accepted(OWNER_FLEET, self.home / "owner-seeded.json")
        self.node_json("surf-ace-private-foreign-first-claims.mjs",
                       ["provision", user_data, self.home / "owner-seeded.json"],
                       self.home / "owner-provisioning-proof.json")
        foreign_proxy, foreign_log = self.proxy("foreign", FOREIGN_PROXY_PORT, FOREIGN_PORT)
        if digest(binary) != binary_sha:
            fail("packaged_binary_changed_before_foreign")
        foreign_app, _ = self.app(binary, user_data, f"ws://127.0.0.1:{FOREIGN_PROXY_PORT}/ws", "foreign")
        self.stop(foreign_app)
        self.stop(foreign_proxy)
        foreign_after = self.accepted(FOREIGN_FLEET, self.home / "foreign-after.json")
        if (foreign_before["headHash"], foreign_before["headSeq"], foreign_before["mappings"],
            foreign_before["paneMappings"]) != (foreign_after["headHash"], foreign_after["headSeq"],
                foreign_after["mappings"], foreign_after["paneMappings"]):
            fail("foreign_accepted_state_changed")
        foreign_requests = foreign_log.read_text(errors="replace")
        if "request op=fleet.topology" not in foreign_requests or "forbidden_request" in foreign_requests or \
           re.search(r"request op=(?!fleet\.topology)", foreign_requests):
            fail("foreign_requests_not_read_only")
        foreign_local = self.node_json("surf-ace-private-foreign-first-claims.mjs",
                                       ["inspect", user_data], self.home / "foreign-local.json")
        for field in ("clientId", "confirmedClaims", "contentDigests", "claimsSha256"):
            if foreign_local[field] != baseline[field]:
                fail(f"foreign_local_{field}_changed")
        self.stop(foreign_server)
        owner_proxy, owner_log = self.proxy("owner", OWNER_PROXY_PORT, OWNER_PORT)
        safety("pre_owner_app")
        if digest(binary) != binary_sha:
            fail("packaged_binary_changed_before_owner")
        owner_app, _ = self.app(binary, user_data, f"ws://127.0.0.1:{OWNER_PROXY_PORT}/ws", "owner")
        owner_topology = self.node_json("surf-ace-private-foreign-first-topology.mjs",
                                        [f"ws://127.0.0.1:{OWNER_PORT}/ws"],
                                        self.home / "owner-topology-after.json")
        if owner_topology.get("registryIdentity") != {"fleetId": OWNER_FLEET, "allocatorId": OWNER_ALLOC} or \
           not any(client.get("clientId") == baseline["clientId"] for client in owner_topology.get("clients", [])) or \
           owner_topology.get("registrationReady") is not True:
            fail("owner_client_not_ready_in_topology")
        self.stop(owner_app)
        self.stop(owner_proxy)
        owner_after = self.accepted(OWNER_FLEET, self.home / "owner-after.json")
        if owner_seeded["mappings"] != owner_after["mappings"] or \
           owner_seeded["paneMappings"] != owner_after["paneMappings"]:
            fail("owner_allocation_changed")
        if "response op=client.register ok=true" not in owner_log.read_text(errors="replace"):
            fail("owner_registration_acceptance_not_observed")
        owner_local = self.node_json("surf-ace-private-foreign-first-claims.mjs",
                                     ["inspect-bound", user_data], self.home / "owner-local.json")
        for field in ("clientId", "confirmedClaims", "contentDigests", "claimsSha256"):
            if owner_local[field] != baseline[field]:
                fail(f"owner_local_{field}_changed")
        expected = {"clientId": baseline["clientId"], "allocatorId": OWNER_ALLOC, "fleetId": OWNER_FLEET}
        if owner_local["registryBinding"] != expected or foreign_local["registryBinding"] is not None:
            fail("binding_phase_mismatch")
        if digest(binary) != binary_sha:
            fail("packaged_binary_changed_after_phases")
        safety("after_phases")
        self.result = {"status": "passed", "scope": "private_no_crash_foreign_first_only",
                       "baselineClaimsSha256": baseline["claimsSha256"], "clientId": baseline["clientId"],
                       "foreignDisplayGeometryChanged":
                           foreign_local["displayGeometryDigests"] != baseline["displayGeometryDigests"],
                       "ownerDisplayGeometryChanged":
                           owner_local["displayGeometryDigests"] != baseline["displayGeometryDigests"],
                       "foreignHeadBefore": [foreign_before["headSeq"], foreign_before["headHash"]],
                       "foreignHeadAfter": [foreign_after["headSeq"], foreign_after["headHash"]],
                       "ownerHeadBefore": [owner_seeded["headSeq"], owner_seeded["headHash"]],
                       "ownerHeadAfter": [owner_after["headSeq"], owner_after["headHash"]],
                       "packageBinarySha256": binary_sha, "ownerRegistrationAccepted": True,
                       "bindingCrashQualified": False,
                       "liveFleetQualified": False, "iosQualified": False, "upgradeRollbackQualified": False}
        self.stop(owner_server)
        self.stop(weston)

    def cleanup(self):
        failures = []
        for child, stream in reversed(self.children):
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=3)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    try:
                        os.killpg(child.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        failures.append("child_survived_cleanup")
            stream.close()
        for cluster in (self.witness, self.primary):
            if cluster is not None:
                try:
                    result = subprocess.run([self.pg("pg_ctl"), "-D", str(cluster), "stop", "-m", "fast"],
                                            capture_output=True, timeout=12, check=False)
                    if result.returncode:
                        failures.append(f"postgres_stop_failed_{cluster.name}")
                except (OSError, subprocess.TimeoutExpired):
                    failures.append(f"postgres_stop_unconfirmed_{cluster.name}")
        if failures:
            self.result["status"] = "failed"
            self.result["cleanupFailures"] = failures
        if self.home:
            receipt = self.home / "foreign-first-receipt.json"
            receipt.write_text(json.dumps(self.result, indent=2, sort_keys=True), encoding="utf8")
            receipt.chmod(0o600)
        return failures


def main():
    if len(sys.argv) != 3:
        fail("usage: VEHICLE NODE24_PATH POSTGRES16_BIN_DIR")
    vehicle = Vehicle(sys.argv[1], sys.argv[2])
    try:
        vehicle.run()
    except Exception as error:
        vehicle.result["failure"] = type(error).__name__ + ":" + str(error)
        raise
    finally:
        failures = vehicle.cleanup()
    if failures:
        fail("vehicle_cleanup_failed")
    print(json.dumps({"fixtureHome": str(vehicle.home), **vehicle.result}, sort_keys=True))


if __name__ == "__main__":
    main()
